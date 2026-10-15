// Fase 1, Task 11: adaptador WA-AKG — fetch injetado, sem rede.
// Envelopes EXATOS aos do código real (commit c7dd01a0) — ver
// src/adapters/wa-akg/README.md. O port (docs/04 §5) é o único contrato externo.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createWaAkgAdapter } from '../../src/adapters/wa-akg/index.js';
import { CircuitOpenError, ProviderUnavailableError } from '../../src/ports/messaging-provider.js';

const cfg = {
  baseUrl: 'http://wa.test',
  apiKey: 'chave-teste',
  webhookSecret: 'segredo-teste',
  sendTimeoutMs: 15_000,
  cbThreshold: 5,
  cbCooldownMs: 30_000,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('mapeamento de resultados: 200 com id → accepted; 422 → rejected; AbortError → unknown sem retry', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const okAdapter = createWaAkgAdapter({ ...cfg, fetchImpl: (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return json({ status: true, message: 'ok', data: { key: { id: 'wamid.ABC' } } });
  }) as typeof fetch });
  const r = await okAdapter.sendText({ sessionId: 's1', to: '+244923111222', text: 'olá', idempotencyKey: 'k1' });
  assert.deepEqual(r, { providerMessageId: 'wamid.ABC', outcome: 'accepted' });
  // header de auth e campos do corpo EXATAMENTE como documentados no README
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'http://wa.test/api/messages/s1/244923111222%40s.whatsapp.net/send');
  assert.equal((calls[0]?.init.headers as Record<string, string>)['x-api-key'], cfg.apiKey);
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { message: 'olá' });

  const rejected = createWaAkgAdapter({ ...cfg, fetchImpl: (async () =>
    json({ status: false, message: 'invalid number', error: 'invalid number' }, 422)) as typeof fetch });
  const rr = await rejected.sendText({ sessionId: 's1', to: '+244923111222', text: 'olá', idempotencyKey: 'k1' });
  assert.equal(rr.outcome, 'rejected');
  assert.ok(rr.error);

  const slow = createWaAkgAdapter({ ...cfg, sendTimeoutMs: 5, fetchImpl: (async (_u: string, init: { signal: AbortSignal }) =>
    new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))))) as typeof fetch });
  const ur = await slow.sendText({ sessionId: 's1', to: '+244923111222', text: 'olá', idempotencyKey: 'k1' });
  assert.deepEqual(ur, { providerMessageId: null, outcome: 'unknown' });
});

test('circuit breaker: cbThreshold falhas consecutivas abrem; após cbCooldownMs volta a meia-abertura', async () => {
  let t = 0; const now = () => new Date(t);
  let n = 0;
  const a = createWaAkgAdapter({ ...cfg, cbThreshold: 2, cbCooldownMs: 30000, now,
    fetchImpl: (async () => { n++; throw new TypeError('fetch failed'); }) as typeof fetch });
  await assert.rejects(() => a.health());
  await assert.rejects(() => a.health());
  await assert.rejects(() => a.health());            // 3.ª: breaker aberto → CircuitOpenError
  assert.equal(n, 2, 'não chamou a rede com o breaker aberto');
  t += 30_001;
  // meia-abertura: a chamada de teste acontece (n=3) e a falha reabre o breaker.
  // O plano escrevia `await a.health()`; como o fetch falha sempre, aqui rejeita
  // (ruling registado no ledger — a asserção de intenção, n=3, mantém-se).
  await assert.rejects(() => a.health());
  assert.equal(n, 3);
  await assert.rejects(() => a.health(), CircuitOpenError); // reaberto: sem rede
  assert.equal(n, 3);
});

test('envelopes reais das restantes operações: sessões, QR, logout, saúde e mídia', async () => {
  let sessionStatus = 'SCAN_QR';
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const a = createWaAkgAdapter({ ...cfg, fetchImpl: (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/api/sessions') && init.method === 'POST') {
      assert.deepEqual(JSON.parse(String(init.body)), { name: 'Suporte' });
      return json({ status: true, message: 'Session created successfully', data: { sessionId: 'abc123', status: 'STOPPED' } });
    }
    if (url.endsWith('/api/sessions') && init.method === 'GET') {
      return json({ status: true, message: 'Sessions retrieved successfully', data: [] });
    }
    if (url.endsWith('/qr')) {
      return json({ success: true, qr: 'conteudo-do-qr', base64: 'data:image/png;base64,xxx' });
    }
    if (url.endsWith('/logout')) {
      return json({ status: true, message: 'Session loggedOuted successfully' });
    }
    if (url.endsWith('/api/sessions/abc123')) {
      return json({ status: true, message: 'ok', data: { sessionId: 'abc123', status: sessionStatus, qr: null } });
    }
    throw new Error(`chamada inesperada: ${init.method} ${url}`);
  }) as typeof fetch });

  assert.deepEqual(await a.health(), { ok: true });

  const created = await a.createSession({ label: 'Suporte' });
  assert.deepEqual(created, { sessionId: 'abc123' });

  assert.deepEqual(await a.getSession('abc123'), { status: 'qr_pending' });
  sessionStatus = 'CONNECTED';
  assert.deepEqual(await a.getSession('abc123'), { status: 'connected' });
  sessionStatus = 'QUALQUER_COISA';
  assert.deepEqual(await a.getSession('abc123'), { status: 'unknown' }, 'estado não mapeado nunca é adivinhado');

  // sem expiresAt: o WA-AKG não tem TTL de QR (README/auditoria A4)
  assert.deepEqual(await a.getQr('abc123'), { qr: 'conteudo-do-qr' });
  assert.equal(await a.logout('abc123'), undefined);

  // telefone fora de E.164 → rejected sem chamada de rede
  const before = calls.length;
  const bad = await a.sendText({ sessionId: 's1', to: '923111', text: 'olá', idempotencyKey: 'k1' });
  assert.equal(bad.outcome, 'rejected');
  assert.equal(calls.length, before, 'sem rede para número inválido');

  // 5xx e 401 (nossa chave) → ProviderUnavailableError (transitório)
  const failing = createWaAkgAdapter({ ...cfg, fetchImpl: (async () =>
    json({ status: false, message: 'boom', error: 'boom' }, 503)) as typeof fetch });
  await assert.rejects(() => failing.health(), ProviderUnavailableError);
  const unauthorized = createWaAkgAdapter({ ...cfg, fetchImpl: (async () =>
    json({ status: false, message: 'Unauthorized' }, 401)) as typeof fetch });
  await assert.rejects(() => unauthorized.health(), ProviderUnavailableError);
});

test('sendMedia: descarrega a mediaUrl SEM a nossa chave e envia multipart file/type/caption', async () => {
  const queue: Response[] = [
    new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    json({ status: true, message: 'Operation successful', data: { key: { id: 'wamid.M1' } } }),
  ];
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const a = createWaAkgAdapter({ ...cfg, fetchImpl: (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const next = queue.shift();
    if (next === undefined) throw new Error('fila vazia');
    return next;
  }) as typeof fetch });

  const r = await a.sendMedia({
    sessionId: 's1',
    to: '+244923111222',
    mediaUrl: 'https://cdn.test/fotos/foto.jpg',
    caption: 'vejam isto',
    mimeType: 'image/jpeg',
    idempotencyKey: 'k1',
  });
  assert.deepEqual(r, { providerMessageId: 'wamid.M1', outcome: 'accepted' });
  assert.equal(seen.length, 2, 'download + envio');

  // 1.ª chamada: download da mediaUrl, SEM header da nossa API key (não vazá-la)
  assert.equal(seen[0]?.url, 'https://cdn.test/fotos/foto.jpg');
  const dlHeaders = seen[0]?.init.headers as Record<string, string> | undefined;
  assert.equal(dlHeaders?.['x-api-key'], undefined, 'a chave não sai daqui para o CDN');

  // 2.ª chamada: multipart para o endpoint real com auth
  assert.ok(seen[1]?.url.endsWith('/api/messages/s1/244923111222%40s.whatsapp.net/media'));
  assert.equal((seen[1]?.init.headers as Record<string, string>)['x-api-key'], cfg.apiKey);
  const form = seen[1]?.init.body;
  assert.ok(form instanceof FormData, 'corpo multipart');
  assert.equal((form as FormData).get('type'), 'image', 'type derivado do mimeType');
  assert.equal((form as FormData).get('caption'), 'vejam isto');
  assert.ok((form as FormData).get('file') instanceof Blob);
});
