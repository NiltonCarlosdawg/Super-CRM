// Handler de eventos recebidos (Task 19; docs/05 §3.1): fronteira do job de
// inbound — revalidação do payload, guarda idempotente (contacto/conversa/
// lead/mensagem), seam de efeitos (Fase 4) e orquestração, com claim e
// processed_at. Sem IA configurada (createUnavailableAiProvider): ai_active →
// failSafe com handoff; ai_suggest → nada enviado (D13).
// Fixtures sintéticas — as 20 conversas reais nunca são tocadas (AGENTS.md §13).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { createAccountsRepository } from '../../src/adapters/db/accounts.js';
import { createOrchestratorPorts } from '../../src/adapters/db/orchestrator-ports.js';
import { createOutbox } from '../../src/adapters/db/outbox.js';
import * as base from '../../src/adapters/db/schema/index.js';
import { createUnavailableAiProvider } from '../../src/adapters/ai/unavailable.js';
import {
  handleInboundEvent,
  type HandleInboundDeps,
} from '../../src/application/handle-inbound.js';
import { handleInbound } from '../../src/application/orchestrator.js';
import { normalizePhoneE164 } from '../../src/domain/phone.js';
import { handoffs } from '../../src/modules/knowledge/knowledge.schema.js';
import type { AiMode } from '../../src/ports/ai-provider.js';
import type { NotifyEvent } from '../../src/ports/notify.js';
import { migratedDb } from '../helpers/db.js';

type Db = Awaited<ReturnType<typeof migratedDb>>;

interface LogEntry {
  level: string;
  [k: string]: unknown;
}

interface InboundHarness {
  db: Db;
  now(): Date;
  phone: string;
  deps: HandleInboundDeps;
  notified: NotifyEvent[];
  logs(): LogEntry[];
  insertEvent(input?: { from?: string; text?: string }): Promise<{ id: string }>;
  precreateContactAndConversation(): Promise<void>;
  setConversationAiMode(mode: AiMode): Promise<void>;
  claimEvent(eventId: string, at: Date): Promise<void>;
  countMessages(): Promise<number>;
  countOutbox(): Promise<number>;
  countHandoffs(): Promise<number>;
  getLead(): Promise<{ stage: string; conversationLinked: boolean }>;
  getEvent(eventId: string): Promise<{ processedAt: Date | null }>;
  getOutboxRow(): Promise<{ sender: string; idempotencyKey: string }>;
}

const PHONE = '+2449236660000';

async function createInboundHarness(): Promise<InboundHarness> {
  const db = await migratedDb();
  const clock = new Date('2026-10-07T11:00:00.000Z');
  const now = (): Date => new Date(clock.getTime());
  const notified: NotifyEvent[] = [];
  const logEntries: LogEntry[] = [];
  const logger = {
    info: (o: object) => logEntries.push({ level: 'info', ...o }),
    warn: (o: object) => logEntries.push({ level: 'warn', ...o }),
    error: (o: object) => logEntries.push({ level: 'error', ...o }),
  };
  const notifySink = async (e: NotifyEvent): Promise<void> => {
    notified.push(e);
  };

  const accounts = createAccountsRepository({ db });
  const { id: accId } = await accounts.create({
    label: 'T19-account',
    purpose: 'support',
    providerSessionId: 'sess-19',
    now: now(),
  });
  const ports = createOrchestratorPorts({ db, notifySink, claimTtlMs: 60_000, now });
  const outbox = createOutbox({
    db,
    notifySink,
    now,
    random: () => 0,
    replyDelay: { min: 1000, max: 5000 },
  });

  let conversationId: string | null = null;
  let evCounter = 0;

  const harness: InboundHarness = {
    db,
    now,
    phone: PHONE,
    notified,
    logs: () => logEntries.slice(),
    deps: {
      db,
      ports,
      orchestrate: (m) => handleInbound(ports, createUnavailableAiProvider(), m),
      outbox,
      notifySink,
      cfg: { claimTtlMs: 60_000 },
      now,
      logger,
    },

    async insertEvent(input) {
      evCounter += 1;
      const payload = {
        type: 'message.received',
        providerEventId: `pe-${evCounter}`,
        sessionId: 'sess-19',
        providerMessageId: `pm-in-${evCounter}`,
        from: input?.from ?? PHONE,
        timestamp: new Date(clock.getTime()).toISOString(), // jsonb → string; handler reidrata
        message: { kind: 'text', text: input?.text ?? 'olá' },
      };
      const [row] = await db
        .insert(base.inboundEvents)
        .values({ providerEventId: payload.providerEventId, payload })
        .returning({ id: base.inboundEvents.id });
      return { id: row!.id };
    },

    async precreateContactAndConversation() {
      const [contact] = await db
        .insert(base.contacts)
        .values({ phoneE164: normalizePhoneE164(PHONE)!, name: 'Cliente T19' })
        .returning({ id: base.contacts.id });
      const [conv] = await db
        .insert(base.conversations)
        .values({ accountId: accId, contactId: contact!.id })
        .returning({ id: base.conversations.id });
      conversationId = conv!.id;
    },

    async setConversationAiMode(mode) {
      if (conversationId === null) throw new Error('precreateContactAndConversation primeiro');
      await db
        .update(base.conversations)
        .set({ aiMode: mode })
        .where(eq(base.conversations.id, conversationId));
    },

    async claimEvent(eventId, at) {
      await db
        .update(base.inboundEvents)
        .set({ aiClaimedAt: at })
        .where(eq(base.inboundEvents.id, eventId));
    },

    async countMessages() {
      const rows = await db.select({ id: base.messages.id }).from(base.messages);
      return rows.length;
    },

    async countOutbox() {
      const rows = await db.select({ id: base.outboxMessages.id }).from(base.outboxMessages);
      return rows.length;
    },

    async countHandoffs() {
      const rows = await db.select({ id: handoffs.id }).from(handoffs);
      return rows.length;
    },

    async getLead() {
      const [lead] = await db.select().from(base.leads).limit(1);
      if (lead === undefined) throw new Error('sem lead');
      const [conv] = await db
        .select({ leadId: base.conversations.leadId })
        .from(base.conversations)
        .limit(1);
      return { stage: lead.stage, conversationLinked: conv?.leadId === lead.id };
    },

    async getEvent(eventId) {
      const [row] = await db
        .select({ processedAt: base.inboundEvents.processedAt })
        .from(base.inboundEvents)
        .where(eq(base.inboundEvents.id, eventId));
      if (row === undefined) throw new Error('evento não existe');
      return { processedAt: row.processedAt };
    },

    async getOutboxRow() {
      // `sender` é da MESAGEM (a outbox só guarda priority 1=resposta/2=campanha).
      const [row] = await db
        .select({ sender: base.messages.sender, idempotencyKey: base.outboxMessages.idempotencyKey })
        .from(base.outboxMessages)
        .innerJoin(base.messages, eq(base.messages.id, base.outboxMessages.messageId))
        .limit(1);
      if (row === undefined) throw new Error('sem linha na outbox');
      return row;
    },
  };
  return harness;
}

test('mensagem recebida: cria contact/lead/conversation/mensagem, marca processed e notifica message.created', async () => {
  const h = await createInboundHarness();
  const ev = await h.insertEvent({ from: h.phone, text: 'olá' });
  const r = await handleInboundEvent(h.deps, ev.id);
  assert.equal(r.outcome, 'processed');
  assert.equal(await h.countMessages(), 1);
  const lead = await h.getLead();
  assert.equal(lead.stage, 'open'); // lead aberto ligado à conversa
  assert.ok(lead.conversationLinked);
  assert.ok((await h.getEvent(ev.id)).processedAt);
  assert.ok(h.notified.some((n) => n.type === 'message' && n.phase === 'created'));
  // reentrega → sem efeitos
  assert.equal((await handleInboundEvent(h.deps, ev.id)).outcome, 'skipped');
  assert.equal(await h.countMessages(), 1);
});

test('sem IA e conversa ai_active → failSafe: handoff + mensagem fixa enfileirada (sender ai)', async () => {
  const h = await createInboundHarness();
  await h.precreateContactAndConversation();
  await h.setConversationAiMode('ai_active');
  const ev = await h.insertEvent({ text: 'olá' });
  await handleInboundEvent(h.deps, ev.id);
  assert.equal(await h.countHandoffs(), 1);
  const o = await h.getOutboxRow();
  assert.equal(o.sender, 'ai');
  assert.equal(o.idempotencyKey, `inbound:${ev.id}`);
});

test('conversa ai_suggest (por omissão, D13) → NADA é enviado e sem handoff (canAct=false)', async () => {
  const h = await createInboundHarness();
  const ev = await h.insertEvent({ text: 'olá' });
  await handleInboundEvent(h.deps, ev.id);
  assert.equal(await h.countOutbox(), 0);
  assert.equal(await h.countHandoffs(), 0);
});

test('erro no processamento liberta o claim e o retry seguinte completa', async () => {
  const h = await createInboundHarness();
  const ev = await h.insertEvent({ text: 'olá' });
  let first = true;
  const failing: HandleInboundDeps = {
    ...h.deps,
    orchestrate: async (m) => {
      if (first) {
        first = false;
        throw new Error('db blip');
      }
      return h.deps.orchestrate(m);
    },
  };
  await assert.rejects(() => handleInboundEvent(failing, ev.id), /db blip/);
  assert.equal((await h.getEvent(ev.id)).processedAt, null, 'processed_at nunca antes do fim');
  assert.equal((await handleInboundEvent(h.deps, ev.id)).outcome, 'processed'); // claim libertado → reprocessa
});

test('evento com claim fresco de outro worker → erro reprocessável e processed_at continua nulo', async () => {
  const h = await createInboundHarness();
  const ev = await h.insertEvent({ text: 'olá' });
  await h.claimEvent(ev.id, h.now()); // claim concorrente
  await assert.rejects(() => handleInboundEvent(h.deps, ev.id), /retryable|claimed_elsewhere/);
  assert.equal((await h.getEvent(ev.id)).processedAt, null);
});

test('inboundEffects corre DEPOIS da mensagem guardada e ANTES do orquestrador', async () => {
  const h = await createInboundHarness();
  const order: string[] = [];
  const deps: HandleInboundDeps = {
    ...h.deps,
    notifySink: async (e) => {
      if (e.type === 'message' && e.phase === 'created') order.push('message_stored');
    },
    inboundEffects: async () => {
      order.push('effects');
    },
    orchestrate: async (m) => {
      void m;
      order.push('orchestrate');
      return {
        status: 'ok',
        reply: null,
        mode: 'draft',
        fired: [],
        handoffId: null,
        lockedAi: false,
        gapRecorded: false,
      };
    },
  };
  const ev = await h.insertEvent({ text: 'olá' });
  await handleInboundEvent(deps, ev.id);
  assert.deepEqual(order, ['message_stored', 'effects', 'orchestrate']);
});
