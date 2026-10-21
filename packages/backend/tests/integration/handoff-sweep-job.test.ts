// Fase 3, Task 15: varredura contra Postgres real — duas execuções do handler
// com o MESMO `now` → exatamente 1 alerta, 1 `opening_alerted_at` e 1 linha em
// `audit_log` (idempotência do CAS de mark*, docs/02 §6).
// Fixtures sintéticas — as 20 conversas reais nunca são tocadas (AGENTS.md §13).

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import * as base from '../../src/adapters/db/schema/index.js';
import { handoffs } from '../../src/modules/knowledge/knowledge.schema.js';
import {
  createHandoffConversations,
  createHandoffQueueRepository,
} from '../../src/adapters/db/handoff-queue.js';
import { createAuditAdapter } from '../../src/adapters/db/audit-adapter.js';
import { DEFAULT_SETTINGS } from '../../src/modules/settings/settings.js';
import { runHandoffScheduleSweep, type SweepDeps } from '../../src/application/schedule-sweep.js';
import { migratedDb } from '../helpers/db.js';

test('duas execuções da varredura com o mesmo now: exatamente 1 alerta', async () => {
  const db = await migratedDb();

  // Handoff sintético, criado fora de horas (23:00 Luanda), pendente. A
  // conversa é um id aleatório: o setAiMode do sweep é um UPDATE sem efeito e a
  // idempotência testa-se em handoffs/audit_log, não na conversa.
  const [h] = await db
    .insert(handoffs)
    .values({
      tenantId: base.MILVENDAS_TENANT_ID,
      conversationId: randomUUID(),
      reason: 'Cliente pediu falar com humano',
      summary: 'resumo sintético',
      leadSnapshot: null,
      priority: 'urgent',
      status: 'pending',
      createdAt: new Date('2026-10-07T22:00:00Z'),
    })
    .returning({ id: handoffs.id });
  const hid = h!.id;

  const notifyLog: Array<{ reason?: string }> = [];
  const deps: SweepDeps = {
    queue: createHandoffQueueRepository(db),
    conversations: createHandoffConversations(db),
    settings: DEFAULT_SETTINGS,
    audit: createAuditAdapter({ db }),
    notify: async (e) => {
      notifyLog.push({ reason: e.reason });
    },
  };

  const now = new Date('2026-10-08T08:00:00Z'); // 09:00 Luanda, aberto
  const r1 = await runHandoffScheduleSweep(deps, now);
  const r2 = await runHandoffScheduleSweep(deps, now);

  assert.deepEqual(r1, { openingAlerts: 1, slaAlerts: 0 });
  assert.deepEqual(r2, { openingAlerts: 0, slaAlerts: 0 });
  assert.equal(notifyLog.filter((n) => n.reason === 'opening_pending').length, 1);

  const [row] = await db
    .select({ openingAlertedAt: handoffs.openingAlertedAt })
    .from(handoffs)
    .where(eq(handoffs.id, hid));
  assert.notEqual(row!.openingAlertedAt, null, 'opening_alerted_at marcado');

  const audits = await db
    .select({ action: base.auditLog.action })
    .from(base.auditLog)
    .where(eq(base.auditLog.action, 'handoff.opening_alert'));
  assert.equal(audits.length, 1, 'exatamente 1 linha em audit_log');
});
