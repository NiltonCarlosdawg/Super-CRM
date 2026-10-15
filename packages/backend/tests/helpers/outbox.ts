// Harness do worker da outbox (Task 18): BD migrada, relógio INJETADO e
// controlável (advance), conta 'connected' pronta, fixtures sintéticas e
// coletores de eventos/logs. Só cenários sintéticos — as20 conversas reais
// nunca são tocadas (AGENTS.md §13).

import { eq } from 'drizzle-orm';
import { createAccountsRepository } from '../../src/adapters/db/accounts.js';
import { createAuditAdapter } from '../../src/adapters/db/audit-adapter.js';
import { createOutbox } from '../../src/adapters/db/outbox.js';
import * as base from '../../src/adapters/db/schema/index.js';
import { createAccountLifecycle } from '../../src/application/account-lifecycle.js';
import { runOutboxTick, type OutboxWorkerDeps } from '../../src/application/outbox-worker.js';
import type { AccountRow, AccountsRepository } from '../../src/ports/accounts.js';
import type { NotifyEvent } from '../../src/ports/notify.js';
import { createFakeMessaging } from './fake-messaging.js';
import { migratedDb } from './db.js';

type Db = Awaited<ReturnType<typeof migratedDb>>;
type OutboxRow = typeof base.outboxMessages.$inferSelect;
type MessageRow = typeof base.messages.$inferSelect;

/** logs() do plano: `{ level, ...obj }` achatado (l.reason, l.deadLetter...). */
export interface LogEntry {
  level: 'info' | 'warn' | 'error';
  [k: string]: unknown;
}

export interface OutboxHarness {
  db: Db;
  accounts: AccountsRepository;
  acc: AccountRow;
  /** Fake do provider: sendTextCalls, queueResult(...). */
  fake: ReturnType<typeof createFakeMessaging>;
  now(): Date;
  /** Avança o relógio injetado (backoff/fila vencida entre runs). */
  advance(ms: number): void;
  notified: NotifyEvent[];
  logs(): LogEntry[];
  enqueueFixture(input: {
    sender: 'ai' | 'human' | 'campaign';
    text?: string;
    idempotencyKey?: string;
    scheduledAt?: Date;
  }): Promise<{ outboxId: string; conversationId: string; contactId: string }>;
  /** Linha única por omissão; passa a chave quando há várias. */
  getOutboxRow(idempotencyKey?: string): Promise<OutboxRow>;
  getMessageRow(idempotencyKey?: string): Promise<MessageRow>;
  runOutboxWorker(overrides?: Partial<OutboxWorkerDeps>): Promise<{ claimed: number; sent: number }>;
}

export async function createOutboxHarness(): Promise<OutboxHarness> {
  const db = await migratedDb();
  let clock = new Date('2026-10-07T10:00:00.000Z');
  const now = (): Date => new Date(clock.getTime());
  const advance = (ms: number): void => {
    clock = new Date(clock.getTime() + ms);
  };

  const notified: NotifyEvent[] = [];
  const logEntries: LogEntry[] = [];
  const logger = {
    info: (o: object): void => {
      logEntries.push({ level: 'info', ...o });
    },
    warn: (o: object): void => {
      logEntries.push({ level: 'warn', ...o });
    },
    error: (o: object): void => {
      logEntries.push({ level: 'error', ...o });
    },
  };

  const accounts = createAccountsRepository({ db });
  const audit = createAuditAdapter({ db });
  const fake = createFakeMessaging();
  const { id: accId } = await accounts.create({
    label: 'T18-account',
    purpose: 'support',
    providerSessionId: 'sess-t18',
    now: now(),
  });
  await accounts.setStatus(accId, 'connected', now());
  const acc = (await accounts.get(accId))!;

  const outbox = createOutbox({
    db,
    notifySink: async (e) => {
      notified.push(e);
    },
    now,
    random: () => 0,
    replyDelay: { min: 1000, max: 5000 },
  });

  const lifecycle = createAccountLifecycle({
    accounts,
    provider: fake.provider,
    notifySink: async (e) => {
      notified.push(e);
    },
    audit,
    cfg: { failWindow: 20, failRatio: 0.3 },
    now,
    log: { error: (obj) => { logEntries.push({ level: 'error', ...(obj as object) }); } },
  });

  let fixtureCounter = 0;
  const harness: OutboxHarness = {
    db,
    accounts,
    acc,
    fake,
    now,
    advance,
    notified,
    logs: () => logEntries.slice(),

    async enqueueFixture(input) {
      fixtureCounter += 1;
      const contact = (
        await db
          .insert(base.contacts)
          .values({
            phoneE164: `+244923777${String(fixtureCounter).padStart(4, '0')}`,
            name: `Cliente T18-${fixtureCounter}`,
          })
          .returning({ id: base.contacts.id })
      )[0]!;
      const conversation = (
        await db
          .insert(base.conversations)
          .values({ accountId: acc.id, contactId: contact.id })
          .returning({ id: base.conversations.id })
      )[0]!;
      const { outboxId } = await outbox.enqueue({
        accountId: acc.id,
        contactId: contact.id,
        conversationId: conversation.id,
        sender: input.sender,
        text: input.text ?? 'olá',
        idempotencyKey: input.idempotencyKey ?? `fx:${fixtureCounter}`,
        scheduledAt: input.scheduledAt ?? new Date(now().getTime() - 10_000), // já devida
      });
      return { outboxId, conversationId: conversation.id, contactId: contact.id };
    },

    async getOutboxRow(idempotencyKey) {
      const rows =
        idempotencyKey === undefined
          ? await db.select().from(base.outboxMessages)
          : await db
              .select()
              .from(base.outboxMessages)
              .where(eq(base.outboxMessages.idempotencyKey, idempotencyKey));
      if (rows.length !== 1) {
        throw new Error(`esperava 1 linha de outbox, encontrei ${rows.length}`);
      }
      return rows[0]!;
    },

    async getMessageRow(idempotencyKey) {
      const outboxRow = await harness.getOutboxRow(idempotencyKey);
      const [msg] = await db
        .select()
        .from(base.messages)
        .where(eq(base.messages.id, outboxRow.messageId));
      if (msg === undefined) throw new Error('mensagem da outbox não encontrada');
      return msg;
    },

    async runOutboxWorker(overrides) {
      const deps: OutboxWorkerDeps = {
        db,
        provider: fake.provider,
        accounts: lifecycle,
        notifySink: async (e) => {
          notified.push(e);
        },
        audit,
        now,
        random: () => 0,
        logger,
        cfg: { sendTimeoutMs: 15_000, maxAttempts: 5, retryDelayMs: 30_000 },
        ...overrides,
      };
      return runOutboxTick(deps);
    },
  };
  return harness;
}
