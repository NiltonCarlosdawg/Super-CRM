// Fase 3, Task 15: varredura de abertura e SLA de 15 min (ADR-0003 A6.1).
// Lógica de decisão com fila falsa e relógio injetado — sem BD (docs/02 §2).
// Regras por pendente: (A) abertura, (B) SLA. Idempotência via CAS de mark*.
//
// Nota sobre a regra (B): o relógio de SLA conta da ABERTURA (openingAlertedAt)
// para handoffs criados fora de horas, e da criação para os criados em horário
// — resolve a contradição do plano (a regra literal daria slaAlerts:1 no teste 1).

import assert from 'node:assert/strict';
import test from 'node:test';

import type { AiMode, Priority } from '../../src/ports/ai-provider.js';
import type {
  HandoffQueueRepository,
  HandoffRow,
  SweepHandoff,
} from '../../src/ports/handoff-queue.js';
import type { TenantScope } from '../../src/ports/tenancy.js';
import { DEFAULT_SETTINGS } from '../../src/modules/settings/settings.js';
import { runHandoffScheduleSweep, type SweepDeps } from '../../src/application/schedule-sweep.js';

class FilaFalsa implements HandoffQueueRepository {
  rows: SweepHandoff[] = [];

  async claim(): Promise<'not_found'> {
    return 'not_found';
  }
  async get(): Promise<null> {
    return null;
  }
  async resolve(): Promise<'not_found'> {
    return 'not_found';
  }
  async listPending(): Promise<HandoffRow[]> {
    return [];
  }

  async listPendingForSweep(limit: number): Promise<SweepHandoff[]> {
    return this.rows
      .filter((r) => r.status === 'pending')
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  /** CAS: marca só se ainda não marcado (espelha o UPDATE … IS NULL). */
  async markOpeningAlerted(scope: TenantScope, id: string, now: Date): Promise<boolean> {
    const r = this.rows.find((x) => x.id === id && x.tenantId === scope.tenantId);
    if (r === undefined || r.openingAlertedAt !== null) return false;
    r.openingAlertedAt = now;
    return true;
  }
  async markSlaAlerted(scope: TenantScope, id: string, now: Date): Promise<boolean> {
    const r = this.rows.find((x) => x.id === id && x.tenantId === scope.tenantId);
    if (r === undefined || r.slaAlertedAt !== null) return false;
    r.slaAlertedAt = now;
    return true;
  }
}

interface Notice {
  type: string;
  reason: string;
  outsideHours?: boolean;
  opensAt?: string;
}

function makeDeps(rows: SweepHandoff[]) {
  const fila = new FilaFalsa();
  fila.rows = rows;
  const notifications: Notice[] = [];
  const audits: string[] = [];
  const modes = new Map<string, AiMode>();
  const deps: SweepDeps = {
    queue: fila,
    conversations: {
      async setAiMode(_scope: TenantScope, conversationId: string, mode: AiMode) {
        modes.set(conversationId, mode);
      },
    },
    settings: DEFAULT_SETTINGS,
    audit: {
      async record(e) {
        audits.push(e.action);
      },
    },
    notify: async (e) => {
      notifications.push({
        type: e.type,
        reason: e.reason,
        outsideHours: e.outsideHours,
        opensAt: e.opensAt,
      });
    },
  };
  return { deps, notifications, audits, modes, fila };
}

function mkRow(over: Partial<SweepHandoff> = {}): SweepHandoff {
  return {
    id: 'h1',
    conversationId: 'conv-1',
    tenantId: 'tenant-1',
    status: 'pending',
    priority: 'urgent' as Priority,
    createdAt: new Date('2026-10-07T22:00:00Z'),
    openingAlertedAt: null,
    slaAlertedAt: null,
    summary: 'resumo sintético',
    reason: 'motivo',
    leadSnapshot: null,
    ...over,
  };
}

test('abertura: alerta, human_only e marcação — uma só vez', async () => {
  const created = new Date('2026-10-07T22:00:00Z'); // 23:00 Luanda, fora de horas
  const open = new Date('2026-10-08T08:00:00Z'); // 09:00 Luanda, aberto
  const { deps, notifications, modes, fila } = makeDeps([mkRow({ createdAt: created })]);

  const first = await runHandoffScheduleSweep(deps, open);
  assert.deepEqual(first, { openingAlerts: 1, slaAlerts: 0 });
  assert.equal(modes.get('conv-1'), 'human_only');
  assert.deepEqual(notifications.map((n) => n.reason), ['opening_pending']);
  assert.equal(notifications[0]!.outsideHours, false);
  assert.equal(notifications[0]!.opensAt, undefined);
  assert.notEqual(fila.rows[0]!.openingAlertedAt, null);

  const second = await runHandoffScheduleSweep(deps, open); // idempotente
  assert.deepEqual(second, { openingAlerts: 0, slaAlerts: 0 });
  assert.equal(notifications.length, 1);
});

test('criado em horário útil não leva alerta de abertura', async () => {
  const created = new Date('2026-10-07T09:00:00Z'); // 10:00 Luanda, em horário
  const later = new Date('2026-10-07T10:00:00Z'); // 11:00 Luanda, aberto, 60 min depois
  const { deps, notifications } = makeDeps([mkRow({ createdAt: created })]);

  const r = await runHandoffScheduleSweep(deps, later);
  assert.equal(r.openingAlerts, 0);
  assert.ok(notifications.every((n) => n.reason !== 'opening_pending'));
});

test('SLA de 15 min: alerta só em horário útil e uma vez', async () => {
  const created = new Date('2026-10-07T09:00:00Z'); // 10:00 Luanda
  const now = new Date('2026-10-07T10:30:00Z'); // 90 min úteis depois
  const { deps, notifications } = makeDeps([mkRow({ createdAt: created })]);

  const r = await runHandoffScheduleSweep(deps, now);
  assert.deepEqual(r, { openingAlerts: 0, slaAlerts: 1 });
  assert.deepEqual(notifications.map((n) => n.reason), ['sla_accept_15min']);
  assert.equal(notifications[0]!.outsideHours, false);

  const again = await runHandoffScheduleSweep(deps, now); // idempotente
  assert.deepEqual(again, { openingAlerts: 0, slaAlerts: 0 });
  assert.equal(notifications.length, 1);
});

test('SLA ainda não atingido: nenhum alerta', async () => {
  const created = new Date('2026-10-07T09:00:00Z');
  const now = new Date('2026-10-07T09:10:00Z'); // 10 min úteis (< 15)
  const { deps, notifications } = makeDeps([mkRow({ createdAt: created })]);

  const r = await runHandoffScheduleSweep(deps, now);
  assert.deepEqual(r, { openingAlerts: 0, slaAlerts: 0 });
  assert.equal(notifications.length, 0);
});

test('handoff aceite não é varrido', async () => {
  const created = new Date('2026-10-07T22:00:00Z');
  const open = new Date('2026-10-08T08:00:00Z');
  const { deps, notifications } = makeDeps([mkRow({ createdAt: created, status: 'accepted' })]);

  const r = await runHandoffScheduleSweep(deps, open);
  assert.deepEqual(r, { openingAlerts: 0, slaAlerts: 0 });
  assert.equal(notifications.length, 0);
});
