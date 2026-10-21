// Fase 3, Task 2: a migração da fase aplica de uma base vazia, o seed de
// configuração é idempotente (4 → 0) e as colunas novas (handoffs de claim/SLA,
// inbound ai_claimed) existem. `ai_claimed_at` é criado pela Fase 1 — aqui só
// se confirma que sobreviveu (não se gera ALTER duplicado).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SETTINGS,
  ensureSettingsSeed,
  readSettings,
} from '../../src/modules/settings/settings.js';
import { columnNames, migratedDb } from '../helpers/db.js';

test('migração aplica-se numa base vazia e o seed de configuração é idempotente', async () => {
  const db = await migratedDb();

  assert.equal(await ensureSettingsSeed(db), 4);
  assert.equal(await ensureSettingsSeed(db), 0);

  const s = await readSettings(db);
  assert.deepEqual(s, DEFAULT_SETTINGS);

  const cols = await columnNames(db, 'handoffs');
  assert.ok(cols.includes('opening_alerted_at'), 'handoffs.opening_alerted_at');
  assert.ok(cols.includes('sla_alerted_at'), 'handoffs.sla_alerted_at');

  const ie = await columnNames(db, 'inbound_events');
  assert.ok(ie.includes('ai_claimed_at'), 'inbound_events.ai_claimed_at (Fase 1)');

  const cfg = await columnNames(db, 'app_settings');
  assert.ok(cfg.includes('key') && cfg.includes('value'), 'app_settings (key/value)');

  const drafts = await columnNames(db, 'ai_drafts');
  assert.ok(drafts.includes('tenant_id'), 'ai_drafts.tenant_id (invariante Onda 1)');
  assert.ok(drafts.includes('status'), 'ai_drafts.status');
});
