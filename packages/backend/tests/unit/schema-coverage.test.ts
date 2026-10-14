// Cobertura do schema base contra o esboço de docs/01 §6 (16 tabelas: 14 do esboço
// + sessions por A2 + campaign_accounts pelas "contas permitidas") e os 12 exports do
// módulo de conhecimento (docs/01 §6, linha "Módulo de conhecimento").
// Cada par [export, tabela SQL] tem de existir e mapear para o nome de tabela correto.
// Correr com: npm test

import assert from 'node:assert/strict';
import test from 'node:test';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import * as baseSchema from '../../src/adapters/db/schema/index.js';
import * as knowledgeSchema from '../../src/modules/knowledge/knowledge.schema.js';

/** Pares [export, nome da tabela SQL] do schema base (Task 9). */
const BASE_TABLES = [
  ['users', 'users'],
  ['sessions', 'sessions'],
  ['whatsappAccounts', 'whatsapp_accounts'],
  ['contacts', 'contacts'],
  ['leads', 'leads'],
  ['conversations', 'conversations'],
  ['messages', 'messages'],
  ['inboundEvents', 'inbound_events'],
  ['outboxMessages', 'outbox_messages'],
  ['campaigns', 'campaigns'],
  ['campaignRecipients', 'campaign_recipients'],
  ['campaignAccounts', 'campaign_accounts'],
  ['followupSequences', 'followup_sequences'],
  ['followupSteps', 'followup_steps'],
  ['followupRuns', 'followup_runs'],
  ['auditLog', 'audit_log'],
] as const;

/** Pares [export, nome da tabela SQL] do módulo de conhecimento (já existente). */
const KNOWLEDGE_TABLES = [
  ['businessLines', 'business_lines'],
  ['catalogItems', 'catalog_items'],
  ['knowledgeDocs', 'knowledge_docs'],
  ['knowledgeChunks', 'knowledge_chunks'],
  ['rules', 'rules'],
  ['qualificationQuestions', 'qualification_questions'],
  ['handoffTriggers', 'handoff_triggers'],
  ['handoffs', 'handoffs'],
  ['knowledgeGaps', 'knowledge_gaps'],
  ['knowledgeSuggestions', 'knowledge_suggestions'],
  ['knowledgeRevisions', 'knowledge_revisions'],
  ['answerTraces', 'answer_traces'],
] as const;

const schema: Record<string, unknown> = { ...baseSchema, ...knowledgeSchema };

for (const [exportName, tableName] of [...BASE_TABLES, ...KNOWLEDGE_TABLES]) {
  test(`schema exporta ${exportName} como tabela ${tableName}`, () => {
    const table = schema[exportName];
    assert.ok(table, `export '${exportName}' não existe`);
    assert.equal(getTableConfig(table as PgTable).name, tableName);
  });
}
