// Fase 3, Task 16: mapeamento do notify Socket.IO para os 5 eventos do painel
// (docs/02 §9). `createSocketNotify` vive em src/adapters/realtime/socket.ts
// (pré-construído na Fase 1, já coberto por realtime.test.ts); este unitário
// documenta/verifica o CONTRATO que a Fase 3 consome:
//   - pass-through de `outsideHours`/`opensAt` (Task 13) no `handoff.created`;
//   - `phase:'updated'` → `handoff.updated`;
//   - `alert` (Task 15) → `handoff.updated` com `reason`;
//   - fail-closed R31: evento sem `tenantId` é descartado (nunca sala global).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSocketNotify,
  type SocketIoLike,
} from '../../src/adapters/realtime/socket.js';
import type { NotifyEvent } from '../../src/ports/notify.js';

interface Emitted {
  room: string;
  event: string;
  payload: Record<string, unknown>;
}

function fakeIo() {
  const emitted: Emitted[] = [];
  const io: SocketIoLike = {
    to(room: string) {
      return {
        emit(event: string, payload: unknown) {
          emitted.push({ room, event, payload: payload as Record<string, unknown> });
          return io;
        },
      };
    },
  };
  return { io, emitted };
}

test('handoff fora de horas → handoff.created com outsideHours/opensAt (sem type/tenantId)', async () => {
  const { io, emitted } = fakeIo();
  const notify = createSocketNotify(io);
  await notify({
    type: 'handoff',
    tenantId: 't1',
    handoffId: 'h1',
    conversationId: 'c1',
    priority: 'urgent',
    reason: 'pedido de humano',
    outsideHours: true,
    opensAt: '2026-10-08T07:00:00.000Z',
  } as NotifyEvent);

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]!.event, 'handoff.created');
  assert.equal(emitted[0]!.room, 'tenant:t1:handoffs');
  const p = emitted[0]!.payload;
  assert.equal(p['outsideHours'], true, 'outsideHours passa (Task 13)');
  assert.equal(p['opensAt'], '2026-10-08T07:00:00.000Z', 'opensAt passa (Task 13)');
  assert.equal(p['v'], 1, 'payload versionado');
  assert.equal(p['type'], undefined, 'type não viaja ao cliente');
  assert.equal(p['tenantId'], undefined, 'tenantId é metadado de roteamento, não viaja');
  assert.equal(p['handoffId'], 'h1');
});

test('handoff phase updated → handoff.updated', async () => {
  const { io, emitted } = fakeIo();
  const notify = createSocketNotify(io);
  await notify({
    type: 'handoff',
    tenantId: 't1',
    phase: 'updated',
    handoffId: 'h1',
    priority: 'high',
  } as NotifyEvent);

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]!.event, 'handoff.updated');
  assert.equal(emitted[0]!.payload['priority'], 'high');
});

test('alert → handoff.updated com reason', async () => {
  const { io, emitted } = fakeIo();
  const notify = createSocketNotify(io);
  await notify({
    type: 'alert',
    tenantId: 't1',
    handoffId: 'h1',
    reason: 'opening_pending',
  } as NotifyEvent);

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]!.event, 'handoff.updated', 'alert levanta o reason em handoff.updated');
  assert.equal(emitted[0]!.payload['reason'], 'opening_pending');
});

test('flag → handoff.created', async () => {
  const { io, emitted } = fakeIo();
  const notify = createSocketNotify(io);
  await notify({
    type: 'flag',
    tenantId: 't1',
    handoffId: 'h1',
    reason: 'fora_de_escopo',
  } as NotifyEvent);

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]!.event, 'handoff.created');
});

test('sem tenantId → descartado (fail-closed R31, nunca sala global)', async () => {
  const { io, emitted } = fakeIo();
  const notify = createSocketNotify(io);
  // Simula dados vindos de JS sem tipos: o tenant é desconhecido.
  await notify({ type: 'handoff', handoffId: 'h1' } as unknown as NotifyEvent);

  assert.equal(emitted.length, 0, 'evento sem tenant não é emitido para lado nenhum');
});
