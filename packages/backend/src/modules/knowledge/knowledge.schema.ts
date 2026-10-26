// Módulo "Conhecimento da IA" — CRM MilVendas
// Stack: Drizzle ORM + PostgreSQL + pgvector.
// Campos como ownerId, changedById, conversationId e messageId apontam para tabelas da
// base do CRM (users, conversations, messages): ligar com .references() na integração.
// Pré-requisito na base de dados: CREATE EXTENSION IF NOT EXISTS vector;
// (adicionar como migração SQL personalizada: `drizzle-kit generate --custom`).

import { and, cosineDistance, desc, eq, gt, relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn, PgDatabase } from 'drizzle-orm/pg-core';
import { tenants } from '../../adapters/db/schema/tenants.schema.js';

// ───────────── Helpers ─────────────

export const pk = () => uuid('id').defaultRandom().primaryKey();
export const ts = (name: string) => timestamp(name, { withTimezone: true });
export const createdAt = () => ts('created_at').defaultNow().notNull();
export const updatedAt = () =>
  ts('updated_at')
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date());

// ───────────── Enums ─────────────

export const knowledgeStatusEnum = pgEnum('knowledge_status', ['draft', 'published', 'archived']);
export const conversionGoalEnum = pgEnum('conversion_goal', [
  'purchase',
  'demo_request',
  'proposal_request',
  'installation_booking',
  'quote_visit',
]);
export const catalogKindEnum = pgEnum('catalog_kind', ['product', 'service', 'plan', 'package']);
export const pricingModeEnum = pgEnum('pricing_mode', ['fixed', 'from', 'quote_only']);
export const availabilityEnum = pgEnum('availability', ['available', 'limited', 'unavailable']);
export const docTypeEnum = pgEnum('doc_type', ['faq', 'policy', 'process', 'company_info', 'objection']);
export const ruleKindEnum = pgEnum('rule_kind', [
  'may_promise',
  'must_not_claim',
  'discount_limit',
  'payment_terms',
  'tone',
]);
export const answerTypeEnum = pgEnum('answer_type', ['text', 'number', 'choice', 'boolean']);
export const handoffPriorityEnum = pgEnum('handoff_priority', ['urgent', 'high', 'normal']);
export const handoffStatusEnum = pgEnum('handoff_status', ['pending', 'accepted', 'resolved', 'dismissed']);
// handoff_now: cria o handoff e passa a conversa a human_only.
// handoff_when_qualified: a IA continua a qualificar; quando as perguntas obrigatórias da linha
//   estão respondidas (ou o cliente insiste), comporta-se como handoff_now.
// flag_only: avisa o painel mas a IA continua a responder (sem bloqueio).
export const handoffActionEnum = pgEnum('handoff_action', ['handoff_now', 'handoff_when_qualified', 'flag_only']);
// A usar na tabela de conversas da base: controla quem responde.
export const aiModeEnum = pgEnum('ai_mode', ['ai_active', 'ai_suggest', 'human_only']);
export const gapStatusEnum = pgEnum('gap_status', ['open', 'resolved', 'ignored']);
export const suggestionStatusEnum = pgEnum('suggestion_status', ['pending', 'approved', 'rejected']);
export const chunkSourceEnum = pgEnum('chunk_source', ['doc', 'catalog']);
// Estado do upload de um documento de treino (extração assíncrona, Task 4).
export const uploadStatusEnum = pgEnum('upload_status', ['pending', 'processing', 'done', 'error']);

// ───────────── Linhas de negócio ─────────────

export const businessLines = pgTable('business_lines', {
  id: pk(),
  slug: text('slug').notNull().unique(), // software | custom | telecom | cctv
  name: text('name').notNull(),
  conversionGoal: conversionGoalEnum('conversion_goal').notNull(),
  active: boolean('active').notNull().default(true),
});

// ───────────── Conhecimento ─────────────

// Fonte de verdade para preço, disponibilidade e características.
// A IA consulta isto por ferramenta, nunca de texto solto.
export const catalogItems = pgTable(
  'catalog_items',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id), // Onda 1: scoping por tenant (spec §4.2)
    lineId: uuid('line_id')
      .notNull()
      .references(() => businessLines.id),
    kind: catalogKindEnum('kind').notNull(),
    name: text('name').notNull(),
    // Identidade estável do item dentro do tenant (spec "Treinar agente" §5–6):
    // o slug é único por tenant, não globalmente.
    slug: text('slug').notNull(),
    summary: text('summary').notNull(),
    details: jsonb('details'), // funcionalidades, especificações, requisitos
    pricingMode: pricingModeEnum('pricing_mode').notNull(),
    priceAmount: numeric('price_amount', { precision: 14, scale: 2 }),
    currency: text('currency').notNull().default('AOA'),
    priceNote: text('price_note'),
    availability: availabilityEnum('availability').notNull().default('available'),
    status: knowledgeStatusEnum('status').notNull().default('draft'),
    validFrom: ts('valid_from'),
    validUntil: ts('valid_until'),
    ownerId: uuid('owner_id').notNull(),
    reviewedAt: ts('reviewed_at'),
    reviewEveryDays: integer('review_every_days').notNull().default(90),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('catalog_items_tenant_slug_uq').on(t.tenantId, t.slug),
    index('catalog_items_status_valid_idx').on(t.status, t.validUntil),
    index('catalog_items_line_idx').on(t.lineId),
  ],
);

// Texto livre: FAQ, políticas, processos, informação da empresa, objeções.
export const knowledgeDocs = pgTable(
  'knowledge_docs',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id), // Onda 1: scoping por tenant (spec §4.2)
    lineId: uuid('line_id').references(() => businessLines.id), // null = vale para toda a empresa
    type: docTypeEnum('type').notNull(),
    title: text('title').notNull(),
    // Identidade estável do documento dentro do tenant (mesma regra do catálogo:
    // o diff da validação e o `baseVersion` casam por tenant + slug).
    slug: text('slug').notNull(),
    body: text('body').notNull(),
    status: knowledgeStatusEnum('status').notNull().default('draft'),
    validFrom: ts('valid_from'),
    validUntil: ts('valid_until'),
    ownerId: uuid('owner_id').notNull(),
    reviewedAt: ts('reviewed_at'),
    reviewEveryDays: integer('review_every_days').notNull().default(90),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('knowledge_docs_tenant_slug_uq').on(t.tenantId, t.slug),
    index('knowledge_docs_status_valid_idx').on(t.status, t.validUntil),
    index('knowledge_docs_line_type_idx').on(t.lineId, t.type),
  ],
);

// Pedaços indexados para pesquisa semântica.
// Regerados por job (ex.: BullMQ) sempre que um item é publicado ou alterado.
export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id), // Onda 1: scoping por tenant (spec §4.2)
    source: chunkSourceEnum('source').notNull(),
    docId: uuid('doc_id').references(() => knowledgeDocs.id, { onDelete: 'cascade' }),
    catalogItemId: uuid('catalog_item_id').references(() => catalogItems.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: 384 }), // multilingual-e5-small (ADR-0002/A4)
    embeddingModel: text('embedding_model'),
    active: boolean('active').notNull().default(true), // só chunks de itens publicados e válidos
  },
  (t) => [
    index('knowledge_chunks_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('knowledge_chunks_active_idx').on(t.active),
    index('knowledge_chunks_doc_idx').on(t.docId),
    index('knowledge_chunks_catalog_idx').on(t.catalogItemId),
  ],
);

// Limites duros e tom: o que a IA pode ou não pode dizer e prometer.
export const rules = pgTable(
  'rules',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id), // Onda 1: scoping por tenant (spec §4.2)
    lineId: uuid('line_id').references(() => businessLines.id),
    kind: ruleKindEnum('kind').notNull(),
    title: text('title').notNull(),
    // Identidade estável da regra dentro do tenant (casa com o slug staged).
    slug: text('slug').notNull(),
    instruction: text('instruction').notNull(),
    params: jsonb('params'), // ex.: { "maxDiscountPct": 10 }
    priority: integer('priority').notNull().default(0),
    status: knowledgeStatusEnum('status').notNull().default('draft'),
    // Versão publicada, como em `knowledge_docs` e `catalog_items`: é o
    // `baseVersion` que a validação usa para detetar corridas (spec §6).
    version: integer('version').notNull().default(1),
    ownerId: uuid('owner_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('rules_tenant_slug_uq').on(t.tenantId, t.slug),
    index('rules_status_line_idx').on(t.status, t.lineId),
  ],
);

// Guião de qualificação por linha (ex.: CCTV: nº de câmaras, interior/exterior).
export const qualificationQuestions = pgTable(
  'qualification_questions',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id), // Onda 1: scoping por tenant (spec §4.2)
    lineId: uuid('line_id')
      .notNull()
      .references(() => businessLines.id),
    key: text('key').notNull(), // ex.: camera_count
    question: text('question').notNull(),
    answerType: answerTypeEnum('answer_type').notNull().default('text'),
    choices: jsonb('choices'),
    required: boolean('required').notNull().default(false),
    position: integer('position').notNull().default(0),
    active: boolean('active').notNull().default(true),
  },
  (t) => [uniqueIndex('qualification_questions_line_key_uq').on(t.lineId, t.key)],
);

// ───────────── Handoff para humano ─────────────

export const handoffTriggers = pgTable(
  'handoff_triggers',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id), // Onda 1: scoping por tenant (spec §4.2)
    lineId: uuid('line_id').references(() => businessLines.id), // null = global
    // PURCHASE_INTENT, COMPLAINT, HUMAN_REQUESTED, LOW_CONFIDENCE, OUT_OF_SCOPE,
    // PRICE_NEGOTIATION, REPEATED_MISUNDERSTANDING
    code: text('code').notNull(),
    description: text('description').notNull(),
    detectionHint: text('detection_hint').notNull(), // instrução para a IA reconhecer o gatilho
    action: handoffActionEnum('action').notNull().default('handoff_now'),
    priority: handoffPriorityEnum('priority').notNull().default('normal'),
    active: boolean('active').notNull().default(true),
  },
  (t) => [index('handoff_triggers_line_active_idx').on(t.lineId, t.active)],
);

export const handoffs = pgTable(
  'handoffs',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id), // Onda 1: scoping por tenant (spec §4.2)
    conversationId: uuid('conversation_id').notNull(),
    triggerId: uuid('trigger_id').references(() => handoffTriggers.id),
    reason: text('reason').notNull(),
    summary: text('summary').notNull(), // resumo gerado pela IA
    leadSnapshot: jsonb('lead_snapshot'), // estado da conversa + respostas de qualificação
    priority: handoffPriorityEnum('priority').notNull().default('normal'),
    status: handoffStatusEnum('status').notNull().default('pending'),
    acceptedById: uuid('accepted_by_id'),
    createdAt: createdAt(),
    acceptedAt: ts('accepted_at'),
    resolvedAt: ts('resolved_at'),
    // Fase 3 (Tasks 14/15): alertas de abertura e SLA — garantem exatamente UM alerta
    // por handoff (sweep idempotente via destas marcas).
    openingAlertedAt: ts('opening_alerted_at'),
    slaAlertedAt: ts('sla_alerted_at'),
  },
  (t) => [
    index('handoffs_queue_idx').on(t.status, t.priority, t.createdAt),
    index('handoffs_conversation_idx').on(t.conversationId),
  ],
);

// ───────────── Melhoria contínua ─────────────

// Perguntas que a IA não soube responder.
export const knowledgeGaps = pgTable(
  'knowledge_gaps',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id), // Onda 1: scoping por tenant (spec §4.2)
    question: text('question').notNull(),
    normalizedQuestion: text('normalized_question').notNull(), // para agrupar repetições
    occurrences: integer('occurrences').notNull().default(1),
    conversationId: uuid('conversation_id'),
    lineId: uuid('line_id').references(() => businessLines.id),
    status: gapStatusEnum('status').notNull().default('open'),
    resolvedById: uuid('resolved_by_id'),
    resolvedAt: ts('resolved_at'),
    createdAt: createdAt(),
    lastSeenAt: ts('last_seen_at').defaultNow().notNull(),
  },
  (t) => [
    index('knowledge_gaps_status_occ_idx').on(t.status, t.occurrences),
    index('knowledge_gaps_normalized_idx').on(t.normalizedQuestion),
  ],
);

// Correção humana a uma resposta da IA, proposta como novo conhecimento.
// Só entra na base depois de aprovada por uma pessoa.
export const knowledgeSuggestions = pgTable(
  'knowledge_suggestions',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id), // Onda 1: scoping por tenant (spec §4.2)
    conversationId: uuid('conversation_id'),
    messageId: uuid('message_id'),
    gapId: uuid('gap_id').references(() => knowledgeGaps.id),
    aiAnswer: text('ai_answer'),
    humanAnswer: text('human_answer').notNull(),
    proposedTitle: text('proposed_title').notNull(),
    proposedBody: text('proposed_body').notNull(),
    targetDocId: uuid('target_doc_id').references(() => knowledgeDocs.id), // atualização de documento existente
    status: suggestionStatusEnum('status').notNull().default('pending'),
    reviewedById: uuid('reviewed_by_id'),
    reviewedAt: ts('reviewed_at'),
    createdAt: createdAt(),
  },
  (t) => [index('knowledge_suggestions_status_idx').on(t.status, t.createdAt)],
);

// Histórico de versões (permite reverter). snapshot = estado anterior da entidade.
export const knowledgeRevisions = pgTable(
  'knowledge_revisions',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id), // Onda 1: scoping por tenant (spec §4.2)
    entityType: text('entity_type').notNull(), // catalog_item | knowledge_doc | rule
    entityId: uuid('entity_id').notNull(),
    version: integer('version').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    changedById: uuid('changed_by_id').notNull(),
    // Publicação que aplicou esta revisão (nula nas revisões anteriores a esta
    // entrega). A callback evita depender da ordem de declaração das tabelas.
    publicationId: uuid('publication_id').references((): AnyPgColumn => knowledgePublications.id),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('knowledge_revisions_entity_version_uq').on(t.entityType, t.entityId, t.version),
    index('knowledge_revisions_entity_idx').on(t.entityType, t.entityId),
  ],
);

// Registo de cada resposta da IA (real ou do chat de teste) e das fontes usadas.
export const answerTraces = pgTable(
  'answer_traces',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id), // Onda 1: scoping por tenant (spec §4.2)
    conversationId: uuid('conversation_id'),
    messageId: uuid('message_id'),
    isTest: boolean('is_test').notNull().default(false),
    question: text('question').notNull(),
    answer: text('answer').notNull(),
    sources: jsonb('sources').notNull(), // [{ type, id, version, score }]
    model: text('model').notNull(),
    handoffId: uuid('handoff_id').references(() => handoffs.id),
    latencyMs: integer('latency_ms'),
    createdAt: createdAt(),
  },
  (t) => [
    index('answer_traces_conversation_idx').on(t.conversationId),
    index('answer_traces_test_created_idx').on(t.isTest, t.createdAt),
  ],
);

// ───────────── Área de rascunho e publicações ("Treinar agente") ─────────────
// O fluxo de treino escreve primeiro em `knowledge_draft_items` (nada fica
// activo) e só a validação atómica cria uma `knowledge_publications` + revisões.
// Spec: docs/superpowers/specs/2026-10-25-treinar-agente-conhecimento-design.md §5.

/** Entidades que podem entrar no rascunho (mesmos valores de `knowledge_revisions`). */
export type DraftEntityType = 'catalog_item' | 'knowledge_doc' | 'rule';
/** Operação staged sobre uma entidade: criar, actualizar ou remover. */
export type DraftOp = 'create' | 'update' | 'delete';

// Documento carregado para treino. O texto extraído fica guardado para permitir
// reprocessar sem novo upload; `status` segue o job de extração.
export const knowledgeTrainUploads = pgTable(
  'knowledge_train_uploads',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id), // Onda 1: scoping por tenant (spec §4.2)
    filename: text('filename').notNull(),
    mediaType: text('media_type').notNull(),
    text: text('text').notNull(),
    status: uploadStatusEnum('status').notNull().default('pending'),
    error: text('error'), // falha visível ao utilizador; nada staged
    lineSlug: text('line_slug'), // linha proposta pelo extractor
    lineConfirmed: boolean('line_confirmed').notNull().default(false),
    changedById: uuid('changed_by_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('train_uploads_tenant_status_idx').on(t.tenantId, t.status)],
);

// Item staged do rascunho: payload estruturado (jsonb) pronto a publicar.
// `slug` é a identidade do item dentro do tenant — no máximo uma linha por slug.
export const knowledgeDraftItems = pgTable(
  'knowledge_draft_items',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id), // Onda 1: scoping por tenant (spec §4.2)
    slug: text('slug').notNull(),
    entityType: text('entity_type').notNull(), // DraftEntityType
    op: text('op').notNull(), // DraftOp
    lineSlug: text('line_slug'),
    lineConfirmed: boolean('line_confirmed').notNull().default(false),
    payload: jsonb('payload').notNull(), // item estruturado validado por zod (T3)
    chunks: jsonb('chunks'), // chunks + embeddings calculados na extração (T2)
    baseVersion: integer('base_version'), // versão activa de origem (deteção de corrida, §6)
    changedById: uuid('changed_by_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('draft_items_tenant_slug_uq').on(t.tenantId, t.slug)],
);

// Registo da publicação atómica. `idempotency_key` dá retry seguro à validação;
// `publication_id` nas revisões permite reverter "a última publicação".
export const knowledgePublications = pgTable(
  'knowledge_publications',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id), // Onda 1: scoping por tenant (spec §4.2)
    kind: text('kind').notNull(), // 'train' | 'quick_edit' | 'revert'
    idempotencyKey: text('idempotency_key').notNull(),
    createdById: uuid('created_by_id').notNull(),
    applied: jsonb('applied'), // contagens { added, updated, archived }
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('publications_tenant_key_uq').on(t.tenantId, t.idempotencyKey)],
);

/** Linha staged lida da BD (consumida pelas T4–T8). */
export type StagedItemRow = typeof knowledgeDraftItems.$inferSelect;
/** Linha de upload lida da BD. */
export type UploadRow = typeof knowledgeTrainUploads.$inferSelect;
/** Linha de publicação lida da BD. */
export type PublicationRow = typeof knowledgePublications.$inferSelect;

// ───────────── Relações (para db.query) ─────────────

export const businessLinesRelations = relations(businessLines, ({ many }) => ({
  catalogItems: many(catalogItems),
  docs: many(knowledgeDocs),
  rules: many(rules),
  questions: many(qualificationQuestions),
  triggers: many(handoffTriggers),
}));

export const catalogItemsRelations = relations(catalogItems, ({ one, many }) => ({
  line: one(businessLines, { fields: [catalogItems.lineId], references: [businessLines.id] }),
  chunks: many(knowledgeChunks),
}));

export const knowledgeDocsRelations = relations(knowledgeDocs, ({ one, many }) => ({
  line: one(businessLines, { fields: [knowledgeDocs.lineId], references: [businessLines.id] }),
  chunks: many(knowledgeChunks),
}));

export const knowledgeChunksRelations = relations(knowledgeChunks, ({ one }) => ({
  doc: one(knowledgeDocs, { fields: [knowledgeChunks.docId], references: [knowledgeDocs.id] }),
  catalogItem: one(catalogItems, {
    fields: [knowledgeChunks.catalogItemId],
    references: [catalogItems.id],
  }),
}));

export const handoffTriggersRelations = relations(handoffTriggers, ({ one, many }) => ({
  line: one(businessLines, { fields: [handoffTriggers.lineId], references: [businessLines.id] }),
  handoffs: many(handoffs),
}));

export const handoffsRelations = relations(handoffs, ({ one }) => ({
  trigger: one(handoffTriggers, { fields: [handoffs.triggerId], references: [handoffTriggers.id] }),
}));

// ───────────── Pesquisa semântica (exemplo) ─────────────

// Devolve os chunks ativos mais próximos da pergunta (similaridade por cosseno).
export async function searchChunks(
  db: PgDatabase<any, any, any>,
  queryEmbedding: number[],
  { limit = 5, minSimilarity = 0.5 } = {},
) {
  const similarity = sql<number>`1 - (${cosineDistance(knowledgeChunks.embedding, queryEmbedding)})`;
  return db
    .select({
      id: knowledgeChunks.id,
      source: knowledgeChunks.source,
      docId: knowledgeChunks.docId,
      catalogItemId: knowledgeChunks.catalogItemId,
      content: knowledgeChunks.content,
      similarity,
    })
    .from(knowledgeChunks)
    .where(and(eq(knowledgeChunks.active, true), gt(similarity, minSimilarity)))
    .orderBy(desc(similarity))
    .limit(limit);
}
