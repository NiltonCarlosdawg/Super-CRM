// Fase 1, Task 13: testes de contrato do adaptador contra o mock fiel à
// auditoria (docs/wa-akg-audit.md §A + errata §Errata). Sem rede externa:
// node:http efémero em 127.0.0.1.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createWaAkgAdapter } from '../../src/adapters/wa-akg/index.js';
import { ProviderUnavailableError } from '../../src/ports/messaging-provider.js';
import { startMockWaAkg } from './mock-wa-akg.js';

/** Header exacto da auditoria A1 (`src/lib/api-auth.ts:15`). */
const AUTH = 'x-api-key';
const SECRET = 's'.repeat(32);

const cfgFromMock = (baseUrl: string, extra?: { sendTimeoutMs?: number }) => ({
  baseUrl,
  apiKey: 'test-key',
  webhookSecret: SECRET,
  sendTimeoutMs: extra?.sendTimeoutMs ?? 5_000,
  cbThreshold: 5,
  cbCooldownMs: 30_000,
});

const textInput = (idempotencyKey: string) => ({
  sessionId: 's1',
  to: '+244923111222',
  text: 'olá',
  idempotencyKey,
});

test('sucesso: os 7 métodos do port falam com caminhos, auth e formatos da auditoria', async () => {
  const mock = await startMockWaAkg();
  try {
    const a = createWaAkgAdapter(cfgFromMock(mock.baseUrl));

    assert.deepEqual(await a.health(), { ok: true });
    assert.deepEqual(await a.createSession({ label: 'Contrato' }), { sessionId: 'mock-created-1' });
    assert.deepEqual(await a.getSession('s1'), { status: 'connected' });
    assert.deepEqual(await a.getQr('s1'), { qr: 'QR-MOCK' });
    assert.equal(await a.logout('s1'), undefined);

    const r = await a.sendText(textInput('k-1'));
    assert.equal(r.outcome, 'accepted');

    const m = await a.sendMedia({
      sessionId: 's1',
      to: '+244923111222',
      mediaUrl: `${mock.baseUrl}/fixtures/foto.jpg`,
      caption: 'vejam',
      mimeType: 'image/jpeg',
      idempotencyKey: 'k-2',
    });
    assert.equal(m.outcome, 'accepted');

    // Caminho EXACTO do envio de texto (…/send — errata da auditoria §A2(5))
    const send = mock.received.find(
      (x) => x.method === 'POST' && x.path === '/api/messages/s1/244923111222%40s.whatsapp.net/send',
    );
    assert.ok(send, 'rota …/send documentada');
    assert.equal(send.headers[AUTH], 'test-key');
    // corpo real do fork: { message } — o destinatário vive no caminho, não no corpo
    assert.deepEqual(send.body, { message: 'olá' });

    const media = mock.received.find((x) => x.method === 'POST' && x.path.endsWith('/media'));
    assert.ok(media, 'rota …/media documentada');
    assert.equal(media.headers[AUTH], 'test-key');
    assert.ok(String(media.headers['content-type']).startsWith('multipart/form-data'), 'multipart');

    // download da mediaUrl: SEM a nossa chave (não vaza a terceiros)
    const dl = mock.received.find((x) => x.path === '/fixtures/foto.jpg');
    assert.ok(dl, 'download da mídia feito');
    assert.equal(dl.headers[AUTH], undefined);

    const create = mock.received.find((x) => x.method === 'POST' && x.path === '/api/sessions');
    assert.deepEqual(create?.body, { name: 'Contrato' });
    assert.equal(create?.headers[AUTH], 'test-key');
  } finally {
    await mock.close();
  }
});

test('contrato: timeout → unknown e a MESMA chamada não se repete', async () => {
  const mock = await startMockWaAkg({ slow: true });
  try {
    // sendTimeoutMs 500: ≫ chegada do pedido (~1-100ms; sob carga o event loop
    // atrasa timers/I/O) e ≪ SLOW_DELAY_MS (1500) — o abort acontece sempre
    // depois do pedido chegar e antes da resposta. As asserções mantêm-se:
    // unknown + exatamente 1 pedido.
    const a = createWaAkgAdapter(cfgFromMock(mock.baseUrl, { sendTimeoutMs: 500 }));
    const r = await a.sendText(textInput('k-1'));
    assert.deepEqual(r, { providerMessageId: null, outcome: 'unknown' });
    // janela de settle: um retry (nosso ou do undici) seria imediato; 200ms apanca-o
    await new Promise((done) => setTimeout(done, 200));
    const sends = mock.received.filter((x) => x.path.endsWith('/send'));
    assert.equal(sends.length, 1, 'sem retry automático da nossa parte');
  } finally {
    await mock.close();
  }
});

test('contrato: resposta inesperada é rejeitada (nunca adivinha)', async () => {
  const mock = await startMockWaAkg({ malformed: true });
  try {
    const a = createWaAkgAdapter(cfgFromMock(mock.baseUrl));
    // consulta com envelope errado → erro, nunca um estado inventado
    await assert.rejects(() => a.getSession('s1'), ProviderUnavailableError);
    // envio com envelope errado → unknown com providerMessageId null (nunca um id inventado, nunca retry);
    // traz `error` diagnóstico (o de timeout vem sem, não há corpo para diagnosticar)
    const r = await a.sendText(textInput('k-1'));
    assert.deepEqual(r, {
      providerMessageId: null,
      outcome: 'unknown',
      error: 'resposta inesperada do wa-akg (sem id)',
    });
  } finally {
    await mock.close();
  }
});

test('contrato: autenticação errada → 401 ⇒ ProviderUnavailableError', async () => {
  const mock = await startMockWaAkg({ failAuth: true });
  try {
    const a = createWaAkgAdapter(cfgFromMock(mock.baseUrl));
    await assert.rejects(() => a.health(), ProviderUnavailableError);
    await assert.rejects(() => a.sendText(textInput('k-1')), ProviderUnavailableError);
  } finally {
    await mock.close();
  }
});

test('contrato: 400 de validação do provider → não é transitório', async () => {
  const mock = await startMockWaAkg();
  try {
    const a = createWaAkgAdapter(cfgFromMock(mock.baseUrl));
    await assert.rejects(() => a.createSession({ label: '' }), /name required/);
  } finally {
    await mock.close();
  }
});
