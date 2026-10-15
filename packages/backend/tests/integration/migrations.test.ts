// Fase 1, Task 1: as migrações aplicam de zero numa base vazia e o vocabulário
// de `leads.stage` está fechado como enum `lead_stage` (gate, docs/schema-base.md §4).

import assert from 'node:assert/strict';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { columnNames, LEAD_STAGE_VALUES, migrateFromEmptyDb, migratedDb } from '../helpers/db.js';

test('migrações aplicam de zero e leads.stage é lead_stage NOT NULL default open', async () => {
  await migrateFromEmptyDb();
  const db = await migratedDb();
  const cols = await columnNames(db, 'leads');
  assert.ok(cols.includes('stage'));
  assert.equal(cols.includes('estado'), false, 'coluna estado redundante removida (docs/01 §6)');
  // `leads.status` é o campo "estado" de docs/01 §6: eliminado por ser
  // redundante com `stage` (docs/schema-base.md §4, Q2).
  assert.equal(cols.includes('status'), false, 'leads.status eliminado — redundante com stage (docs/05 §5)');
  const vals = await db.execute(sql`SELECT unnest(enum_range(NULL::lead_stage))::text AS v`);
  assert.deepEqual(
    (vals.rows as Array<{ v: string }>).map((r) => r.v),
    [...LEAD_STAGE_VALUES],
  );
  const d = await db.execute(sql`SELECT is_nullable, column_default FROM information_schema.columns
                     WHERE table_name = 'leads' AND column_name = 'stage'`);
  const row = (d.rows as Array<{ is_nullable: string; column_default: string }>)[0];
  assert.ok(row, 'leads.stage existe');
  assert.equal(row.is_nullable, 'NO');
  assert.match(row.column_default, /open/);
  const ev = await columnNames(db, 'inbound_events');
  assert.ok(ev.includes('ai_claimed_at'), 'claim de idempotência do evento (Fase 1, consumido pela Fase 3)');
});
