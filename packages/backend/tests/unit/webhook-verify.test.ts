// Fase 1, Task 12: verificação de webhook do WA-AKG sobre o corpo bruto.
// Corpos sintéticos com a FORMA REAL do envelope e dos payloads
// (fork `src/lib/webhook.ts` — WebhookPayload {event, sessionId, timestamp, data};
// ver docs/wa-akg-audit.md §B e src/adapters/wa-akg/README.md).

import assert from 'node:assert/strict';
import test from 'node:test';
import { createWaAkgAdapter } from '../../src/adapters/wa-akg/index.js';
import { signWebhook } from '../helpers/webhook.js';

const SECRET = 's'.repeat(32);
const TS = '2026-10-15T09:30:00.000Z';

const cfg = {
  baseUrl: 'http://wa.test',
  apiKey: 'chave-teste',
  webhookSecret: SECRET,
  sendTimeoutMs: 15_000,
  cbThreshold: 5,
  cbCooldownMs: 30_000,
};

/** Captura real de message.received (webhook.ts:560-579), campos sintéticos. */
const receivedPayload = {
  event: 'message.received',
  sessionId: 'sess-test-1',
  timestamp: TS,
  data: {
    key: { id: 'wamid.EVT1', remoteJid: '244923111222@s.whatsapp.net', fromMe: false, participant: null },
    pushName: 'Maria',
    messageTimestamp: 1760511000,
    from: '244923111222@s.whatsapp.net',
    receiver: '244990000111@s.whatsapp.net',
    sender: '244923111222@s.whatsapp.net',
    isGroup: false,
    chatType: 'PERSONAL',
    type: 'TEXT',
    content: 'olá do cliente',
    fileUrl: null,
    caption: null,
    quoted: null,
  },
};

test('assinatura válida → eventos normalizados; corpo alterado ou assinatura errada → lança', () => {
  const raw = Buffer.from(JSON.stringify(receivedPayload));
  const headers = signWebhook(raw, SECRET);
  const adapter = createWaAkgAdapter(cfg);

  const events = adapter.verifyAndParseWebhook(headers, raw);
  assert.equal(events.length, 1);
  const ev = events[0];
  assert.ok(ev);
  assert.equal(ev.type, 'message.received');
  assert.equal(ev.sessionId, 'sess-test-1');
  if (ev.type !== 'message.received') assert.fail('narrowing');
  // 'from' normalizado a E.164 pela função única (jd → dígitos → +)
  assert.equal(ev.from, '+244923111222');
  assert.equal(ev.providerMessageId, 'wamid.EVT1');
  assert.equal(ev.message.kind, 'text');
  assert.equal(ev.message.text, 'olá do cliente');
  assert.ok(ev.timestamp instanceof Date);
  assert.equal(ev.timestamp.toISOString(), TS, 'timestamp do envelope em Date UTC');

  // redelivery idêntico → mesmo providerEventId (dedup do job)
  const again = adapter.verifyAndParseWebhook(headers, raw);
  assert.equal(again[0]?.providerEventId, ev.providerEventId);

  // corpo alterado → assinatura não bate
  const tampered = Buffer.concat([raw, Buffer.from(' ')]);
  assert.throws(() => adapter.verifyAndParseWebhook(headers, tampered), /invalid_signature/);

  // valor errado no header EXACTO do esquema → inválido
  assert.throws(
    () => adapter.verifyAndParseWebhook({ ...headers, 'x-webhook-signature': `sha256=${'0'.repeat(64)}` }, raw),
    /invalid_signature/,
  );
  // header em falta → inválido
  assert.throws(() => adapter.verifyAndParseWebhook({}, raw), /invalid_signature/);
});

test('payload válido mas desconhecido (evento novo do WA-AKG) é ignorado sem lançar', () => {
  const warns: Array<{ obj: object; msg: string }> = [];
  const raw = Buffer.from(
    JSON.stringify({
      event: 'future.event',
      sessionId: 'sess-test-1',
      timestamp: TS,
      data: { anything: true },
    }),
  );
  const headers = signWebhook(raw, SECRET);
  const adapter = createWaAkgAdapter({
    ...cfg,
    logger: { warn: (obj: object, msg: string) => { warns.push({ obj, msg }); } },
  });
  assert.deepEqual(adapter.verifyAndParseWebhook(headers, raw), []);
  assert.equal(warns.length, 1, 'evento desconhecido registado e ignorado');
});

test('connection.update e message.status mapeados; PENDING/JSON inválido nunca adivinhados', () => {
  const warns: Array<{ obj: object; msg: string }> = [];
  const a = createWaAkgAdapter({
    ...cfg,
    logger: { warn: (obj: object, msg: string) => { warns.push({ obj, msg }); } },
  });
  const sign = (payload: unknown): { headers: Record<string, string>; raw: Buffer } => {
    const raw = Buffer.from(JSON.stringify(payload));
    return { headers: signWebhook(raw, SECRET), raw };
  };

  // connection.update com QR → session.status (qr_pending) + session.qr
  const c1 = sign({ event: 'connection.update', sessionId: 'sess-test-1', timestamp: TS,
    data: { status: 'SCAN_QR', qr: 'QR-NOVO' } });
  const evs = a.verifyAndParseWebhook(c1.headers, c1.raw);
  assert.equal(evs.length, 2);
  assert.equal(evs[0]?.type, 'session.status');
  if (evs[0]?.type !== 'session.status') assert.fail('narrowing');
  assert.equal(evs[0].status, 'qr_pending');
  assert.equal(evs[1]?.type, 'session.qr');
  if (evs[1]?.type !== 'session.qr') assert.fail('narrowing');
  assert.equal(evs[1].qr, 'QR-NOVO');

  // connection.update ligado, sem QR → só session.status connected
  const c2 = sign({ event: 'connection.update', sessionId: 'sess-test-1', timestamp: TS,
    data: { status: 'CONNECTED', qr: null } });
  const evs2 = a.verifyAndParseWebhook(c2.headers, c2.raw);
  assert.equal(evs2.length, 1);
  assert.equal(evs2[0]?.type, 'session.status');
  if (evs2[0]?.type !== 'session.status') assert.fail('narrowing');
  assert.equal(evs2[0].status, 'connected');

  // message.status DELIVERED → delivered
  const s1 = sign({ event: 'message.status', sessionId: 'sess-test-1', timestamp: TS,
    data: { keyId: 'wamid.S1', remoteJid: '244923111222@s.whatsapp.net', status: 'DELIVERED' } });
  const evs3 = a.verifyAndParseWebhook(s1.headers, s1.raw);
  assert.equal(evs3.length, 1);
  assert.equal(evs3[0]?.type, 'message.status');
  if (evs3[0]?.type !== 'message.status') assert.fail('narrowing');
  assert.equal(evs3[0].status, 'delivered');
  assert.equal(evs3[0].providerMessageId, 'wamid.S1');

  // PENDING não existe no union do port → ignorado com log, nunca mapeado à força
  const s2 = sign({ event: 'message.status', sessionId: 'sess-test-1', timestamp: TS,
    data: { keyId: 'wamid.S2', remoteJid: '244923111222@s.whatsapp.net', status: 'PENDING' } });
  assert.deepEqual(a.verifyAndParseWebhook(s2.headers, s2.raw), []);
  assert.ok(warns.some((w) => w.msg.includes('estado de mensagem')), 'PENDING registado');

  // 'from' que não normaliza a E.164 → payload_invalid
  const bad = sign({ ...receivedPayload, data: { ...receivedPayload.data, from: '999@s.whatsapp.net' } });
  assert.throws(() => a.verifyAndParseWebhook(bad.headers, bad.raw), /payload_invalid/);

  // JSON malformado com assinatura válida → payload_invalid
  const junk = Buffer.from('{nao-e-json');
  assert.throws(() => a.verifyAndParseWebhook(signWebhook(junk, SECRET), junk), /payload_invalid/);
});
