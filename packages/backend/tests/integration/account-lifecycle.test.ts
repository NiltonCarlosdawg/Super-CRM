// Fase 1, Task 16: ciclo de vida das contas WhatsApp (docs/04 §6) contra
// Postgres real — transições, ban por suspeita, janela de falhas e migração
// de telefone entre contas. Relógio controlado; fixtures sintéticas.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountsRepository } from '../../src/adapters/db/accounts.js';
import { createAuditAdapter } from '../../src/adapters/db/audit-adapter.js';
import * as base from '../../src/adapters/db/schema/index.js';
import { auditLog } from '../../src/adapters/db/schema/audit.schema.js';
import { createAccountLifecycle } from '../../src/application/account-lifecycle.js';
import type { NotifyEvent } from '../../src/ports/notify.js';
import type { MessagingProvider } from '../../src/ports/messaging-provider.js';
import { migratedDb } from '../helpers/db.js';

const now = (): Date => new Date('2026-10-15T10:00:00.000Z');

/** Provider falso: getSession devolve o telefone mapeado por sessão. */
function fakeProvider(phones: Record<string, string | undefined>): MessagingProvider {
  return {
    name: 'fake-wa',
    health: async () => ({ ok: true }),
    createSession: async () => ({ sessionId: 'unused' }),
    getSession: async (sid) => {
      const phone = phones[sid];
      return phone === undefined ? { status: 'connected' as const } : { status: 'connected' as const, phone };
    },
    getQr: async () => null,
    logout: async () => {},
    sendText: async () => ({ providerMessageId: null, outcome: 'unknown' as const }),
    sendMedia: async () => ({ providerMessageId: null, outcome: 'unknown' as const }),
    verifyAndParseWebhook: () => [],
  };
}

test('logged_out inesperado (connected) → suspected_ban; após logout de admin → no-op', async () => {
  const db = await migratedDb();
  const accounts = createAccountsRepository({ db });
  const notified: NotifyEvent[] = [];
  const life = createAccountLifecycle({
    accounts,
    provider: fakeProvider({}),
    notifySink: async (e) => {
      notified.push(e);
    },
    audit: createAuditAdapter({ db }),
    cfg: { failWindow: 20, failRatio: 0.3 },
    now,
  });
  const audits = async (): Promise<Array<{ action: string }>> => db.select().from(auditLog);

  const acc = await accounts.create({ label: 'A1', purpose: 'support', providerSessionId: 'sess1', now: now() });
  await accounts.setStatus(acc.id, 'connected', now());
  await life.onSessionStatus({ sessionId: 'sess1', status: 'logged_out', at: now() });
  assert.equal((await accounts.get(acc.id))?.status, 'suspected_ban');
  assert.equal((await audits()).filter((a) => a.action === 'account.suspected_ban').length, 1);
  assert.ok(notified.some((n) => n.type === 'account' && n.status === 'suspected_ban'));

  // cenário 2: admin fez logout primeiro (estado já 'disconnected') → continua
  // 'disconnected', sem audit novo (o logged_out do webhook é no-op)
  const acc2 = await accounts.create({ label: 'A2', purpose: 'sales', providerSessionId: 'sess2', now: now() });
  await accounts.setStatus(acc2.id, 'disconnected', now());
  const auditsBefore = (await audits()).length;
  await life.onSessionStatus({ sessionId: 'sess2', status: 'logged_out', at: now() });
  assert.equal((await accounts.get(acc2.id))?.status, 'disconnected');
  assert.equal((await audits()).length, auditsBefore, 'sem audit novo no no-op');
});

test('pico de falhas: 7 de 20 (35% > 30%) → suspected_ban; 6 de 20 (30%) e janela incompleta não mudam', async () => {
  const db = await migratedDb();
  const accounts = createAccountsRepository({ db });
  const life = createAccountLifecycle({
    accounts,
    provider: fakeProvider({}),
    notifySink: async () => {},
    audit: createAuditAdapter({ db }),
    cfg: { failWindow: 20, failRatio: 0.3 },
    now,
  });

  /** Cria contact+conversa e a janela de outbox da conta: `failed` falhas de 20. */
  const seedWindow = async (accountId: string, phone: string, failed: number, total = 20): Promise<void> => {
    const contact = (await db
      .insert(base.contacts)
      .values({ phoneE164: phone, name: 'Cliente' })
      .returning({ id: base.contacts.id }))[0]!;
    const conv = (await db
      .insert(base.conversations)
      .values({ accountId, contactId: contact.id })
      .returning({ id: base.conversations.id }))[0]!;
    for (let i = 0; i < total; i++) {
      const status = i < failed ? 'failed' : 'sent';
      const msg = (await db
        .insert(base.messages)
        .values({ conversationId: conv.id, accountId, direction: 'outbound', sender: 'ai', body: 'x', status })
        .returning({ id: base.messages.id }))[0]!;
      await db.insert(base.outboxMessages).values({
        messageId: msg.id,
        accountId,
        idempotencyKey: `k-${accountId}-${i}`,
        status,
      });
    }
  };

  const accBan = await accounts.create({ label: 'B1', purpose: 'campaigns', providerSessionId: 's-ban', now: now() });
  await accounts.setStatus(accBan.id, 'connected', now());
  await seedWindow(accBan.id, '+244923600001', 7);
  await life.recordSendResult({ accountId: accBan.id, ok: false, at: now() });
  assert.equal((await accounts.get(accBan.id))?.status, 'suspected_ban', '35% > 30% → ban');

  const accOk = await accounts.create({ label: 'B2', purpose: 'campaigns', providerSessionId: 's-ok', now: now() });
  await accounts.setStatus(accOk.id, 'connected', now());
  await seedWindow(accOk.id, '+244923600002', 6);
  await life.recordSendResult({ accountId: accOk.id, ok: false, at: now() });
  assert.equal((await accounts.get(accOk.id))?.status, 'connected', '30% não ultrapassa o limiar');

  const accFew = await accounts.create({ label: 'B3', purpose: 'campaigns', providerSessionId: 's-few', now: now() });
  await accounts.setStatus(accFew.id, 'connected', now());
  await seedWindow(accFew.id, '+244923600003', 3, 3);
  await life.recordSendResult({ accountId: accFew.id, ok: false, at: now() });
  assert.equal((await accounts.get(accFew.id))?.status, 'connected', 'janela incompleta nunca ban');
});

test('connected: telefone associa-se; reconexão migra o telefone da conta antiga desconectada', async () => {
  const db = await migratedDb();
  const accounts = createAccountsRepository({ db });
  const notified: NotifyEvent[] = [];
  const life = createAccountLifecycle({
    accounts,
    provider: fakeProvider({ 'sess-new': '+244923111222' }),
    notifySink: async (e) => {
      notified.push(e);
    },
    audit: createAuditAdapter({ db }),
    cfg: { failWindow: 20, failRatio: 0.3 },
    now,
  });
  const audits = async (): Promise<Array<{ action: string }>> => db.select().from(auditLog);

  const oldAcc = await accounts.create({ label: 'Old', purpose: 'support', providerSessionId: 'sess-old', now: now() });
  await accounts.setStatus(oldAcc.id, 'disconnected', now());
  await accounts.setPhone(oldAcc.id, '+244923111222');

  const newAcc = await accounts.create({ label: 'New', purpose: 'support', providerSessionId: 'sess-new', now: now() });
  await life.onSessionStatus({ sessionId: 'sess-new', status: 'connected', at: now() });

  assert.equal((await accounts.get(newAcc.id))?.phoneE164, '+244923111222');
  assert.equal((await accounts.get(oldAcc.id))?.phoneE164, null, 'conta antiga perdeu o telefone');
  assert.ok((await audits()).some((a) => a.action === 'account.phone_reassigned'));
  assert.ok(notified.some((n) => n.type === 'account' && n.status === 'connected'), 'transição notificada');
});
