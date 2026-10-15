// Fase 1, Task 5: o adaptador de auditoria grava ator, ação, entidade e
// detalhes com o `at` recebido (relógio controlado — docs/02 §3).

import assert from 'node:assert/strict';
import test from 'node:test';
import { auditLog } from '../../src/adapters/db/schema/audit.schema.js';
import { createAuditAdapter } from '../../src/adapters/db/audit-adapter.js';
import { migratedDb, resetDb } from '../helpers/db.js';

test('audit.record grava ator, ação, entidade e detalhes com o at recebido', async () => {
  await resetDb();
  const db = await migratedDb();
  const audit = createAuditAdapter({ db });
  const at = new Date('2026-10-07T10:00:00.000Z');
  // entityId é uuid no schema real (audit_log.entity_id, docs/01 §6) — o 'ev1'
  // do snippet é substituído por um uuid válido; a asserção de round-trip mantém-se.
  const entityId = '00000000-0000-4000-8000-000000000001';
  await audit.record({ actorId: null, action: 'webhook.rejected', entity: 'inbound_event',
    entityId, detail: { reason: 'invalid_signature' }, at, ip: '127.0.0.1' });
  const rows = await db.select().from(auditLog);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.actorId, null);
  assert.equal(rows[0]?.action, 'webhook.rejected');
  assert.equal(rows[0]?.entityId, entityId);
  // O campo do schema é `created_at` (Drizzle: createdAt) — o `at` recebido é o valor gravado.
  assert.equal(rows[0]?.createdAt.toISOString(), at.toISOString());
  assert.deepEqual(rows[0]?.details, { reason: 'invalid_signature', entity: 'inbound_event' });
});
