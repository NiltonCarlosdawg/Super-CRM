// Fase 1, Task 2: seed de gatilhos de handoff — 16 gatilhos de arranque
// (docs/01 §9: 8 globais + 8 por linha) e idempotência da segunda chamada.

import assert from 'node:assert/strict';
import test from 'node:test';
import { seedHandoffTriggers } from '../../src/modules/knowledge/handoff-triggers.seed.js';
import {
  businessLines,
  handoffTriggers,
} from '../../src/modules/knowledge/knowledge.schema.js';
import { migratedDb, resetDb } from '../helpers/db.js';

test('seedHandoffTriggers: 16 gatilhos de arranque e segunda chamada não duplica', async () => {
  await resetDb();
  const db = await migratedDb();
  // Slugs de docs/05 §4; nomes/objetivos são dados sintéticos (os docs não
  // fecham objetivos por linha — enum conversion_goal).
  await db.insert(businessLines).values([
    { slug: 'software', name: 'Software', conversionGoal: 'demo_request' },
    { slug: 'custom', name: 'Soluções personalizadas', conversionGoal: 'proposal_request' },
    { slug: 'telecom', name: 'Telecomunicações', conversionGoal: 'purchase' },
    { slug: 'cctv', name: 'CCTV', conversionGoal: 'installation_booking' },
  ]);
  await seedHandoffTriggers(db);
  await seedHandoffTriggers(db);
  const rows = await db.select().from(handoffTriggers);
  assert.equal(rows.length, 16); // docs/01 §9: 8 globais + 8 por linha
  assert.equal(rows.filter((r) => r.lineId === null).length, 8);
});
