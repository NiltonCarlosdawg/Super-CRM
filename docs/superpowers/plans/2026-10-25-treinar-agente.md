# Treinar Agente (Conhecimento Self-Service) — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Expor a API completa do fluxo "Treinar agente" (upload/guiado → itens em rascunho editáveis → mini-chat de teste → validação atómica aditiva → edição rápida → reversão) para o painel construir por fora.

**Architecture:** Fastify routes em `src/adapters/http/routes/`, lógica de negócio em `src/modules/knowledge/` (staging numa tabela nova `knowledge_draft_items` com payload jsonb; publicação = transacção + `knowledge_publications` + revisões). Extração via `AIProvider.extractKnowledge` (tool call com saída estruturada validada por zod); chunks/embeddings do rascunho calculados na extração, com `EmbeddingsProvider` atrás de port (runtime real fica para ADR — testes usam fake determinístico).

**Tech Stack:** Fastify 5, Drizzle ORM + Postgres (pgvector), BullMQ/Redis, zod, node:test + contentores reais.

**Spec:** `docs/superpowers/specs/2026-10-25-treinar-agente-conhecimento-design.md` (aprovado pelo dono 2026-10-25). O plano argumenta do spec; executores leem ambos.

**Estado:** implementado em 2026-10-29 — todas as tasks concluídas em `main`, commits `ae6ae58..bc7c0d9` (+ `5114e55` de dependências). Gates finais: typecheck 0 · lint 0 erros · unit 236/236 · integração 166/166 · `eval:baseline` exacto. Revisão final whole-branch aprovada após corrigir a migração `0011`. Continuação da Fase 2 (embeddings, PDF/OCR, `qualification_questions`, alertas de revisão, fila de sugestões) fica para o incremento seguinte — ver `packages/backend/src/modules/knowledge/README.md`.

## Global Constraints

- TypeScript `strict`; sem `any` sem comentário a justificar. Identificadores em inglês; comentários/docs em português (padrão do repo).
- zod em toda a fronteira: HTTP (body/params), payload de jobs, saída estruturada do LLM.
- IA só pelo `AIProvider`; WhatsApp só pela outbox; payload de jobs = **só IDs** (docs/02 §6).
- Multi-tenant: toda a query sob `TenantScope` (`request.auth.tenantId`); cross-tenant responde como nos módulos existentes (nunca vaza dados).
- Papéis das rotas de conhecimento: `requireAnyRole('editor', 'admin')` + `requireTenant()` (decisão do dono: `agent` fica de fora).
- Sem segredos/PII em código, logs ou fixtures; só cenários sintéticos.
- Migrações: gerar com `npm run db:generate`, revistar o SQL; **nunca** editar migração já aplicada.
- Testes primeiro; commits convencionais (`feat:`, `test:`, `docs:`); suites unit e integração nunca em paralelo.
- Ficheiros novos em `src/modules/knowledge/` seguem o estilo dos existentes (cabeçalho de comentário PT a explicar o porquê).

## Review Focus

Falhas prováveis que nenhum teste isolado apanha; cada uma tem teste fixado na task dona.

1. **Fuga cross-tenant** em qualquer rota nova (ver rascunho alheio, validar sobre dados doutro tenant, chat de teste doutro tenant) → testes em T4 (GET draft de outro tenant), T6 (validar sob tenant B), T8 (chat sob tenant B).
2. **Uploads inválidos:** base64 malformado (400), corpo gigante (413), mediaType não suportado hoje — PDF/OCR entram com ADR (415 com mensagem explícita) → teste em T4; activo intacto quando a extração falha (upload → `error`, nada staged) → teste em T4.
3. **Corrida validação/edição:** duas validações simultâneas → **uma** publicação; edição rápida durante rascunho → `conflict`, nunca merge silencioso → testes em T6 (concorrência) e T8/T7.
4. **Saída LLM malformada** na extração (`items` com enum inválido, preço textual em `fixed`, sem tool call) → `LLMError`, upload `error`, nada staged → teste em T3/T4.
5. **Segurança do chat de teste:** `isTest` nunca cria handoffs/lacunas nem envia mensagens; `target=draft` não vaza conteúdo para o retrieve de produção → teste em T8.

---

### Task 1: Schema — área de rascunho, publicações, migrações

**Files:**
- Modify: `packages/backend/src/modules/knowledge/knowledge.schema.ts`
- Modify: `packages/backend/src/adapters/db/schema/conversations.schema.ts`
- Create: `packages/backend/drizzle/00XX_*.sql` (gerado)
- Test: `packages/backend/tests/integration/train-schema.test.ts` (novo)

**Interfaces:**
- Produz (para T4–T8): tabelas `knowledgeTrainUploads`, `knowledgeDraftItems`, `knowledgePublications`; coluna `knowledgeRevisions.publicationId`; `conversations.isTest`; tipos `StagedItemRow = typeof knowledgeDraftItems.$inferSelect`, `UploadRow`, `PublicationRow`, e constantes `DraftEntityType = 'catalog_item' | 'knowledge_doc' | 'rule'`, `DraftOp = 'create' | 'update' | 'delete'` exportadas do schema.

- [x] **Step 1: Escrever o teste que falha**

`tests/integration/train-schema.test.ts` (padrão de `tests/integration/migrations.test.ts` + `migrateFromEmptyDb`):
- `catalog_items` aceita o mesmo `slug` em dois tenants (insert 2 linhas com mesmo slug, tenantIds distintos → OK) mas **rejeita** slug repetido no mesmo tenant (assert rejeição com unique violation).
- `knowledge_draft_items` rejeita duas staged rows com o mesmo `(tenant_id, slug)` e aceita payloads jsonb com campos `op`, `baseVersion`, `lineConfirmed`, `chunks` (insert + select roundtrip).
- `knowledge_publications` rejeita `(tenant_id, idempotency_key)` repetido.
- `knowledge_revisions` aceita `publication_id` nulo e não nulo (FK para publicação existente).
- `conversations.is_test` existe, `NOT NULL default false` (via `information_schema`).

- [x] **Step 2: Correr e ver falhar**

Run: `cd packages/backend && npm run test:integration -- train-schema`
Expected: FAIL (tabelas/colunas inexistentes).

- [x] **Step 3: Alterar o schema Drizzle**

Em `knowledge.schema.ts`:
- `catalogItems.slug`: remover `.unique()`; no array de índices, `uniqueIndex('catalog_items_tenant_slug_uq').on(t.tenantId, t.slug)`.
- Nova tabela `knowledgeTrainUploads` (`knowledge_train_uploads`): `id`, `tenantId` FK tenants, `filename` text notNull, `mediaType` text notNull, `text` text notNull, `status` enum `upload_status ['pending','processing','done','error']` notNull default pending, `error` text, `lineSlug` text, `lineConfirmed` boolean notNull default false, `changedById` uuid notNull, `createdAt`, `updatedAt`, index `(tenant_id, status)`.
- Nova tabela `knowledgeDraftItems` (`knowledge_draft_items`): `id`, `tenantId` FK, `slug` text notNull, `entityType` text notNull (constante `DraftEntityType`), `op` text notNull (`DraftOp`), `lineSlug` text, `lineConfirmed` boolean notNull default false, `payload` jsonb notNull, `chunks` jsonb, `baseVersion` integer, `changedById` uuid notNull, `createdAt`, `updatedAt`, `uniqueIndex('draft_items_tenant_slug_uq').on(t.tenantId, t.slug)`.
- Nova tabela `knowledgePublications` (`knowledge_publications`): `id`, `tenantId` FK, `kind` text notNull (`'train' | 'quick_edit' | 'revert'`), `idempotencyKey` text notNull, `createdById` uuid notNull, `applied` jsonb (contagens added/updated/archived), `createdAt`, `uniqueIndex('publications_tenant_key_uq').on(t.tenantId, t.idempotencyKey)`.
- `knowledgeRevisions`: nova coluna `publicationId` uuid `.references((): AnyPgColumn => knowledgePublications.id)` (nula para revisões antigas).
- Exportar tipos `StagedItemRow`, `UploadRow`, `PublicationRow` com `$inferSelect`.

Em `conversations.schema.ts`: `isTest: boolean('is_test').notNull().default(false)`.

- [x] **Step 4: Gerar e revistar a migração**

Run: `cd packages/backend && npm run db:generate`
Revistar o SQL gerado: tem de (a) fazer drop de `catalog_items_slug_unique` e criar o índice composto, (b) criar as 3 tabelas + enum, (c) adicionar `publication_id` e `is_test`. Se o drizzle-kit gerar `ALTER TABLE ... DROP CONSTRAINT` inesperado em outras tabelas, corrigir o schema (não o SQL à mão) e regenerar.

- [x] **Step 5: Correr o teste e a suíte de migrações**

Run: `cd packages/backend && npm run test:integration -- "train-schema|migrations|database-ready"`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add packages/backend/src/modules/knowledge/knowledge.schema.ts packages/backend/src/adapters/db/schema/conversations.schema.ts packages/backend/drizzle/ packages/backend/tests/integration/train-schema.test.ts
git commit -m "feat(knowledge): draft workspace, publications and tenant-scoped slug schema"
```

---

### Task 2: Port de embeddings + chunking (primitivos puros)

**Files:**
- Create: `packages/backend/src/ports/embeddings.ts`
- Create: `packages/backend/src/modules/knowledge/chunking.ts`
- Create: `packages/backend/tests/helpers/fake-embeddings.ts`
- Test: `packages/backend/tests/unit/chunking.test.ts` (novo)

**Interfaces:**
- Produz: `EmbeddingsProvider { readonly model: string; readonly dimensions: number; embedTexts(texts: readonly string[], signal?: AbortSignal): Promise<readonly number[][]> }`; `chunkText(text: string, opts?: { maxChars?: number; overlapChars?: number }): string[]` (default 1200/150); `chunkCatalogItemText(item: { name: string; summary: string; details?: Record<string, unknown> | null }): string[]`; `fakeEmbeddings(dimensions?: number): EmbeddingsProvider` (vetores determinísticos por hash do texto — mesmos textos → mesmos vetores; base para T8 com cosine).

- [x] **Step 1: Testes que falham**

`tests/unit/chunking.test.ts`:
- `chunkText` de texto com 3 parágrafos longos → 3+ chunks, cada um `<= maxChars`, todos presentes (join dos chunks contém todos os parágrafos, sem cortar palavra no limite — último espaço antes de `maxChars`).
- `chunkText` com overlap: chunk N contém os últimos `overlapChars` do chunk N−1.
- `chunkText('texto curto')` → `['texto curto']`.
- `chunkCatalogItemText` inclui `name`, `summary` e valores de `details`, um chunk.
- `fakeEmbeddings`: mesmo texto → mesmo vetor; textos diferentes → vetores diferentes; `dimensions` respeitado.

- [x] **Step 2: Correr e ver falhar**

Run: `cd packages/backend && npx tsx --test tests/unit/chunking.test.ts`
Expected: FAIL (ficheiros não existem).

- [x] **Step 3: Implementar**

Port puro (sem lógica, estilo `src/ports/llm-transport.ts`). `chunkText`: divide por parágrafo (`\n\s*\n`), junta parágrafos até `maxChars`, parte por espaço no limite, avança com passo `maxChars - overlapChars`. `chunkCatalogItemText` = 1 chunk `name — summary — details em JSON.stringify`. Fake: hash FNV-1a por caractere → pseudo-vetor normalizado (mesma semente por texto).

- [x] **Step 4: Correr e ver passar**

Run: `cd packages/backend && npx tsx --test tests/unit/chunking.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/backend/src/ports/embeddings.ts packages/backend/src/modules/knowledge/chunking.ts packages/backend/tests/helpers/fake-embeddings.ts packages/backend/tests/unit/chunking.test.ts
git commit -m "feat(knowledge): embeddings port and text chunking primitives"
```

---

### Task 3: `AIProvider.extractKnowledge` (saída estruturada validada)

**Files:**
- Modify: `packages/backend/src/ports/ai-provider.ts`
- Modify: `packages/backend/src/adapters/ai/llm-ai-provider.ts`
- Modify: `packages/backend/src/adapters/ai/unavailable.ts`
- Create: `packages/backend/src/adapters/ai/extraction-schema.ts`
- Test: `packages/backend/tests/unit/extract-knowledge.test.ts` (novo)

**Interfaces:**
- Produz (para T4): tipos novos em `ai-provider.ts`:

```ts
export type ExtractedPayload =
  | { kind: 'catalog_item'; name: string; summary: string; details: Record<string, unknown> | null;
      pricingMode: 'fixed' | 'from' | 'quote_only'; priceAmount: string | null; currency: string;
      priceNote: string | null; availability: 'available' | 'limited' | 'unavailable' }
  | { kind: 'knowledge_doc'; docType: 'faq' | 'policy' | 'process' | 'company_info' | 'objection';
      title: string; body: string }
  | { kind: 'rule'; ruleKind: 'may_promise' | 'must_not_claim' | 'discount_limit' | 'payment_terms' | 'tone';
      title: string; instruction: string; params: Record<string, unknown> | null };
export interface ExtractedItem { slug: string; lineSlug: LineSlug | null; op: 'create' | 'update'; payload: ExtractedPayload }
```

e `AIProvider.extractKnowledge(input: { text: string }, signal?: AbortSignal): Promise<{ items: ExtractedItem[] }>`.

- [x] **Step 1: Testes que falham**

`tests/unit/extract-knowledge.test.ts` (padrão `tests/helpers/fake-llm.ts`, `createLlmAIProvider` com transport fake):
- tool call `submit_knowledge` com args válidos `{ items: [...] }` → retorna os items normalizados (enums intactos, `currency` default `'AOA'` quando ausente, slug kebab-case passado pelo modelo preservado).
- args com enum inválido (`pricingMode: 'caro'`) → rejeita com `LLMError`.
- resposta só com texto (sem tool call) → `LLMError`.
- `createUnavailableAiProvider().extractKnowledge(...)` → rejeita com `LLMError` (mesma semântica de indisponibilidade do resto do provider).

- [x] **Step 2: Correr e ver falhar**

Run: `cd packages/backend && npx tsx --test tests/unit/extract-knowledge.test.ts`
Expected: FAIL (`extractKnowledge` não existe).

- [x] **Step 3: Implementar**

- `extraction-schema.ts`: zod `extractedKnowledgeSchema` (espelho dos tipos; enums como `z.enum`; regra: `pricingMode: 'fixed' | 'from'` exige `priceAmount` string numérica — caso contrário erro).
- `llm-ai-provider.ts`: tool `EXTRACT_KNOWLEDGE_TOOL` (`submit_knowledge`, inputSchema JSON Schema dos items); `extractKnowledge` faz **uma** chamada (system curto: "extrai o conhecimento da empresa para o CRM; não inventes preços") com a tool, ecoa o tool call como nos métodos existentes, valida args com o schema → `LLMError` em falha. Não toca em `respond`.
- `unavailable.ts`: método que rejeita sempre com `LLMError('ai_unavailable', ...)`.
- Actualizar qualquer outro implementador de `AIProvider` nos ficheiros (grep `: AIProvider` / `satisfies AIProvider`) para não quebrar o typecheck.

- [x] **Step 4: Correr teste + typecheck**

Run: `cd packages/backend && npx tsx --test tests/unit/extract-knowledge.test.ts && npm run typecheck`
Expected: PASS, 0 erros.

- [x] **Step 5: Commit**

```bash
git add packages/backend/src/ports/ai-provider.ts packages/backend/src/adapters/ai/ packages/backend/tests/unit/extract-knowledge.test.ts
git commit -m "feat(ai): extractKnowledge port with validated structured output"
```

---

### Task 4: Upload → job de extração → rascunho (staging + rotas)

**Files:**
- Create: `packages/backend/src/modules/knowledge/parsers.ts`
- Create: `packages/backend/src/modules/knowledge/train-service.ts`
- Create: `packages/backend/src/modules/knowledge/extract-job.ts`
- Create: `packages/backend/src/adapters/http/routes/knowledge-train.ts`
- Modify: `packages/backend/src/adapters/http/app.ts` (HttpDeps + registo condicional das rotas)
- Modify: `packages/backend/tests/helpers/http.ts` (bundle de conhecimento no TestApp)
- Create: `packages/backend/tests/helpers/fake-jobs.ts`
- Test: `packages/backend/tests/integration/train-upload.test.ts` (novo)

**Interfaces:**
- Consumes: T1 (tabelas), T2 (`chunkText`, `chunkCatalogItemText`, `EmbeddingsProvider`, `fakeEmbeddings`), T3 (`extractKnowledge`).
- Produz (para T5–T8):
  - `parseUpload(mediaType: string, content: Buffer): { text: string }` — aceita `text/plain` e `text/markdown`; outro → `UnsupportedFormatError` (a rota mapeia para 415).
  - `TrainDeps = { db: DbClient; scope: TenantScope; audit: Audit; now(): Date; embedder?: EmbeddingsProvider }`.
  - `stageExtracted(deps: TrainDeps, input: { uploads: UploadRow[]; items: ExtractedItem[]; changedById: string }): Promise<StagedItemRow[]>` — chunks por item (`knowledge_doc` → `chunkText(body)`; `catalog_item` → `chunkCatalogItemText`; `rule` → sem chunks), embeddings via `deps.embedder` quando presente (senão `embedding: null`), upsert em `knowledge_draft_items` por `(tenantId, slug)` (payload + chunks + `baseVersion` resolvido contra o activo + `lineConfirmed` vindo do upload).
  - `listDraftItems(deps): Promise<StagedItemRow[]>`; `patchDraftItem(deps, id, patch: { payload?: Record<string, unknown>; lineSlug?: string; confirmLine?: boolean }): Promise<StagedItemRow>`; `deleteDraftItem(deps, id): Promise<void>` (remove a staged row — cancela a alteração staged; nunca toca no activo).
  - `createExtractHandler(deps: { db; provider; embedder?; audit; now; logger }): (payload: Record<string, unknown>) => Promise<void>` — payload zod `{ uploadId: string }`; CAS `pending→processing`; parse → `extractKnowledge` → `stageExtracted` → `done`; erro → `status: error` + mensagem (sem conteúdo do documento).
  - `HttpDeps.knowledge?: { db: DbClient; provider: AIProvider; aiCfg: AIConfig; settings: Settings; jobs: JobQueue; embedder?: EmbeddingsProvider; audit: Audit; now(): Date }`.
  - Rotas (todas com `authenticate + requireTenant + requireAnyRole('editor','admin')`):
    - `POST /v1/knowledge/train/documents` body `{ documents: [{ filename: string; mediaType: string; contentBase64: string }], lineSlug?: LineSlug }` → cria uploads (`lineConfirmed = lineSlug !== undefined`), enfileira `knowledge.extract` por upload, `202 { uploadIds }`. Body limit de rota 8 MiB.
    - `GET /v1/knowledge/train/draft` → `{ items: StagedItemRow[] }`.
    - `PATCH /v1/knowledge/train/draft/:id` body `{ payload?: object; lineSlug?: string; confirmLine?: boolean }`.
    - `DELETE /v1/knowledge/train/draft/:id`.

- [x] **Step 1: Testes que falham**

`tests/integration/train-upload.test.ts` (usa `buildTestApp`, `fakeLlm` com `toolCallResult('submit_knowledge', {...})`, `fakeEmbeddings()`, `createCapturingJobQueue()` de `fake-jobs.ts`):
- editor faz upload de TXT (base64) → `202` com `uploadIds`; TestApp `runPendingJobs()` → GET draft devolve os items staged com `chunks` e `embedding` (array) preenchidos; audit tem `knowledge.staged`.
- upload com `lineSlug` pré-selecionado → items com `lineConfirmed: true`.
- mediaType `application/pdf` → `415` com mensagem a apontar para o ADR pendente; corpo inválido (`contentBase64: '!!!'`) → `400`; corpo > 8 MiB → `413`.
- **falha de extração** (transport fake devolve texto sem tool call) → upload `status: 'error'`, draft vazio, activo intacto.
- `agent` → `403`; sem sessão → `401`.
- **isolamento:** utilizador do tenant B (criar 2º tenant + utilizador via SQL directo, padrão de `isolation.test.ts`) não vê o rascunho de A no GET.
- PATCH confirma linha (`confirmLine: true`) e DELETE remove item.

- [x] **Step 2: Correr e ver falhar**

Run: `cd packages/backend && npm run test:integration -- train-upload`
Expected: FAIL (rotas 404).

- [x] **Step 3: Implementar**

`parsers.ts` com registry simples `{ 'text/plain': utf8, 'text/markdown': utf8 }`; `train-service.ts` e `extract-job.ts` conforme as assinaturas acima; rota compõe `TrainDeps` por pedido a partir de `deps.knowledge!` + `request.auth` (padrão do `scope()` de `drafts.ts`). `buildTestApp` passa a construir o bundle com `createLlmAIProvider({ transport: fakeTransport, config: ... })` (guião injectável por override), `fakeEmbeddings()`, `createCapturingJobQueue()` e expõe `runPendingJobs()` + `knowledgeApp` para os testes; `app.ts` regista `knowledge-trainRoutes` quando `deps.knowledge` presente. Registar o handler `knowledge.extract` também no `main.ts` fica para T9.

- [x] **Step 4: Correr teste + typecheck**

Run: `cd packages/backend && npm run test:integration -- train-upload && npm run typecheck`
Expected: PASS, 0 erros.

- [x] **Step 5: Commit**

```bash
git add packages/backend/src/modules/knowledge/ packages/backend/src/adapters/http/ packages/backend/tests/
git commit -m "feat(knowledge): document upload, extraction job and draft staging"
```

---

### Task 5: Fluxo guiado (passo a passo → mesmo pipeline)

**Files:**
- Modify: `packages/backend/src/modules/knowledge/train-service.ts` (`formatGuidedTranscript`)
- Modify: `packages/backend/src/adapters/http/routes/knowledge-train.ts`
- Test: `packages/backend/tests/integration/train-guided.test.ts` (novo)

**Interfaces:**
- Consumes: T4 (pipeline, `knowledge_train_uploads`, job).
- Produz: `formatGuidedTranscript(answers: ReadonlyArray<{ question: string; answer: string }>): string` (transcrição numerada `Pergunta: ... Resposta: ...`); rota `POST /v1/knowledge/train/guided` body `{ lineSlug: LineSlug; answers: Array<{ question: string; max 300; answer: string; max 4000 }> }` (mínimo 1 resposta) → cria upload (`filename: 'passo-a-passo'`, `mediaType: 'text/plain'`, `lineSlug`, `lineConfirmed: true`) → enfileira → `202 { uploadIds }`.

- [x] **Step 1: Testes que falham**

`tests/integration/train-guided.test.ts`:
- editor responde 3 perguntas da linha cctv → `202`; `runPendingJobs()` → draft tem itens staged com `lineSlug: 'cctv'` e `lineConfirmed: true`; o texto do upload guardado contém as respostas.
- `answers: []` → `400`; `lineSlug` desconhecido (não existe em `business_lines`) → `400`/`404` com mensagem clara.

- [x] **Step 2: Correr e ver falhar**

Run: `cd packages/backend && npm run test:integration -- train-guided`
Expected: FAIL (rota 404).

- [x] **Step 3: Implementar**

`formatGuidedTranscript` puro; rota valida `lineSlug` contra `business_lines` (select por slug; inexistente → `HttpError(404, 'line_not_found')`); reutiliza a criação de upload + enqueue da T4 (extrair helper `queueExtraction(deps, { filename, mediaType, text, lineSlug, lineConfirmed, changedById })` no train-service e usar nos dois).

- [x] **Step 4: Correr teste + typecheck**

Run: `cd packages/backend && npm run test:integration -- train-guided && npm run typecheck`
Expected: PASS, 0 erros.

- [x] **Step 5: Commit**

```bash
git add packages/backend/src/modules/knowledge/ packages/backend/src/adapters/http/routes/knowledge-train.ts packages/backend/tests/integration/train-guided.test.ts
git commit -m "feat(knowledge): guided step-by-step capture into the training pipeline"
```

---

### Task 6: Diff e validação atómica aditiva

**Files:**
- Create: `packages/backend/src/modules/knowledge/diff.ts`
- Create: `packages/backend/src/modules/knowledge/publish-service.ts`
- Modify: `packages/backend/src/adapters/http/routes/knowledge-train.ts`
- Test: `packages/backend/tests/unit/diff.test.ts` + `packages/backend/tests/integration/train-validate.test.ts` (novos)

**Interfaces:**
- Consumes: T1 (`knowledge_draft_items`, `knowledge_publications`, `knowledge_revisions`), T4 (staging).
- Produz (para T7/T8):
  - `diff.ts`: `PublishedSnapshot { slug: string; entityType: DraftEntityType; version: number; canonical: string; rowId: string }`; `DiffEntry { slug; entityType; op: DraftOp; classification: 'added' | 'updated' | 'unchanged' | 'conflict' | 'archived'; baseVersion: number | null; currentVersion: number | null }`; `canonicalPayload(entityType: DraftEntityType, payload: unknown): string` (JSON.stringify com chaves ordenadas só dos campos editáveis: catalog → name/summary/details/pricingMode/priceAmount/currency/priceNote/availability/lineSlug; doc → title/body/type/lineSlug; rule → title/instruction/params/lineSlug); `computeDraftDiff(staged: Array<Pick<StagedItemRow,'slug'|'entityType'|'op'|'payload'|'baseVersion'|'lineConfirmed'>>, published: PublishedSnapshot[]): { entries: DiffEntry[]; unconfirmedSlugs: string[] }` — regras: create sem activo → `added`; create com activo → `conflict`; update sem activo → `conflict`; update com `baseVersion === currentVersion` → `updated` (canonical difere) ou `unchanged`; `baseVersion !== currentVersion` → `conflict`; delete com match → `archived`; delete sem activo ou versão divergente → `conflict`; `lineConfirmed: false` → para `unconfirmedSlugs`.
  - `publish-service.ts`: `diffDraft(deps: TrainDeps): Promise<{ entries: DiffEntry[]; unconfirmedSlugs: string[]; digest: string }>` (`digest = sha256` dos staged slugs + canónicos ordenados); `validateDraft(deps, input: { changedById: string; acceptConflicts?: string[] }): Promise<{ publicationId: string; applied: { added: number; updated: number; archived: number }; idempotent: boolean }>` — se `unconfirmedSlugs` não vazio → `HttpError(422, 'lines_unconfirmed', slugs)`; se conflitos fora de `acceptConflicts` → `HttpError(409, 'draft_conflicts', entries)`; senão **transacção**: publicação idempotente pelo `digest` (chave única `(tenantId, digest)`; repetição → devolve publicação existente com `idempotent: true`), `added` → insert `status:'published'` + revisão `version: 1`, `updated`/`archived`/conflitos aceites → snapshot na revisão (`version` actual, `publicationId`) + update (bump `version`, `archived` = `status:'archived'`), limpa staged rows do tenant, audit `knowledge.validated`.
  - Rotas novas: `GET /v1/knowledge/train/diff` → `{ entries, unconfirmedSlugs, digest }`; `POST /v1/knowledge/train/validate` body `{ acceptConflicts?: string[] }` → resultado acima.

- [x] **Step 1: Testes unitários que falham**

`tests/unit/diff.test.ts`: uma tabela por regra da interface `computeDraftDiff` (added, updated, unchanged, conflict×3 origens: create-sobre-existente, update-sobre-versão-mudada, delete-sausente; archived; unconfirmed) + `canonicalPayload` ignora ordem de chaves e campos extra, mas deteta mudança de preço.

- [x] **Step 2: Correr e ver falhar**

Run: `cd packages/backend && npx tsx --test tests/unit/diff.test.ts`
Expected: FAIL.

- [x] **Step 3: Implementar `diff.ts` e os seus testes**

Regras puras acima; sem DB.

- [x] **Step 4: Testes de integração que falham**

`tests/integration/train-validate.test.ts` (staging directo na tabela + activo via insert `catalog_items published`):
- carga nova válida → `GET diff` devolve `added`; `POST validate` → publicação criada (`kind:'train'`, `applied.added = n`), staged vazia, itens activos consultáveis, revisões com `publication_id`; audit `knowledge.validated`.
- sobreposição: staged `op:'update'` com `baseVersion` correcto e preço novo → `updated`; activo tem o preço novo depois de validar (**novo prevalece**).
- staged com `op:'update'` e `baseVersion` desactualizado (activo mudou entretanto) → `409 draft_conflicts`; com `acceptConflicts: [slug]` → aplica a versão do rascunho.
- item sem linha confirmada → `422 lines_unconfirmed`.
- **idempotência:** validar duas vezes o mesmo conteúdo (re-staged igual) → segunda resposta `idempotent: true`, mesmo `publicationId`, sem duplicados.
- **concorrência:** duas chamadas `validateDraft` em paralelo (Promise.all) → exactamente uma publicação nova.
- **isolamento:** tenant B no mesmo request scope não enxerga staged de A (validate sobre B com staged vazio → diff vazio).

- [x] **Step 5: Correr tudo**

Run: `cd packages/backend && npx tsx --test tests/unit/diff.test.ts && npm run test:integration -- train-validate && npm run typecheck`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add packages/backend/src/modules/knowledge/ packages/backend/src/adapters/http/routes/knowledge-train.ts packages/backend/tests/
git commit -m "feat(knowledge): additive merge diff and atomic publication with idempotency"
```

---

### Task 7: Edição rápida (dia-a-dia) e reversão

**Files:**
- Modify: `packages/backend/src/modules/knowledge/publish-service.ts`
- Create: `packages/backend/src/adapters/http/routes/knowledge-items.ts`
- Modify: `packages/backend/src/adapters/http/app.ts`
- Test: `packages/backend/tests/integration/train-quickedit.test.ts` (novo)

**Interfaces:**
- Consumes: T6 (`canonicalPayload`, `PublishedSnapshot`, publicações/revisões).
- Produz: `quickEditItem(deps, input: { itemId: string; entityType: DraftEntityType; patch: Record<string, unknown>; changedById: string }): Promise<{ publicationId: string }>` — transacção: carrega activo sob scope (não existe → `404`), valida `patch` por tipo (zod parcial: preço só número/`null` em `fixed`, etc.), snapshot-revisão (`version` actual, `publicationId`), update + bump `version`, publicação `kind:'quick_edit'` (idempotencyKey = uuid), audit `knowledge.item_edited`; `listPublications(deps, limit?)`; `revertPublication(deps, input: { publicationId: string; changedById: string }): Promise<{ reverted: number }>` — só reverte se **todas** as entidades da publicação estiverem na `version` posterior à publicação (se entidade mudou depois → `409 stale_revert` com slugs); transacção: snapshot actual → revisão, restaura snapshot anterior (bump `version`), publicação `kind:'revert'`, audit `knowledge.reverted`. Rotas: `PATCH /v1/knowledge/items/:id` body `{ entityType, patch }` (editor/admin); `GET /v1/knowledge/published` (é a listagem dos itens activos — consolida o `GET /v1/knowledge/items` + `GET /v1/knowledge/published` do desenho numa só rota); `POST /v1/knowledge/published/revert` body `{ publicationId }`.

- [x] **Step 1: Testes que falham**

`tests/integration/train-quickedit.test.ts`:
- item publicado (seed direto) → PATCH preço → `200`; activo reflecte o preço; `GET /v1/knowledge/published` lista; revisão + publicação `quick_edit` criadas.
- patch inválido (`priceAmount: 'muito caro'` em `fixed`) → `400`.
- reversão: após quick-edit, `POST revert` → preço volta ao anterior; `kind:'revert'` registado.
- **reversão velha:** quick-edit 1, quick-edit 2 (mesmo item), reverte 1 → `409 stale_revert`.
- isolamento: item de outro tenant → `404`.

- [x] **Step 2: Correr e ver falhar**

Run: `cd packages/backend && npm run test:integration -- train-quickedit`
Expected: FAIL.

- [x] **Step 3: Implementar**

Padrão T6 (transacção + revisão + publicação); `zodPatchByType` no publish-service; rotas com os guards de sempre; registo em `app.ts` dentro do mesmo bloco `deps.knowledge`.

- [x] **Step 4: Correr teste + typecheck**

Run: `cd packages/backend && npm run test:integration -- train-quickedit && npm run typecheck`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/backend/src/modules/knowledge/ packages/backend/src/adapters/http/ packages/backend/tests/integration/train-quickedit.test.ts
git commit -m "feat(knowledge): quick single-item edits and publication revert"
```

---

### Task 8: Chat de teste (substrato sintético + modo rascunho)

**Files:**
- Create: `packages/backend/src/modules/knowledge/test-conversation.ts`
- Create: `packages/backend/src/modules/knowledge/draft-retrieval.ts`
- Create: `packages/backend/src/adapters/http/routes/knowledge-chat-test.ts`
- Modify: `packages/backend/src/adapters/http/app.ts`
- Test: `packages/backend/tests/integration/train-chat-test.test.ts` (novo)

**Interfaces:**
- Consumes: T2 (`fakeEmbeddings`), T4 (staged `chunks` jsonb), T6 (activo), `test-chat.ts` existente (`createTestChat({ ports, provider, db, settings, aiCfg, conversationId })` → `{ reply, sources }`).
- Produz: `ensureTestConversation(db: DbClient, tenantId: string): Promise<string>` (encontra-ou-cria conta `label: 'chat-de-teste'` + contacto sintético + conversa com `isTest: true`, `lineId: null`); `draft-retrieval.ts`: `scoreChunks(query: string, chunks: ReadonlyArray<{ id: string; content: string; embedding: readonly number[] | null }>, embedder?: EmbeddingsProvider): Promise<Array<{ id: string; score: number }>>` (com embedder → cosseno com a query embebida; sem → sobreposição de tokens normalizada) e `retrieveForTarget(deps: TrainDeps, query: string, target: 'draft' | 'published'): Promise<RetrievedChunk[]>` (draft → chunks staged do tenant ordenados por score com `topK = 5`, `minSimilarity = 0.15`; published → `[]` por agora — o runtime de embeddings é ADR pendente, documentado); `lookupCatalogForTarget(deps, query, target): Promise<CatalogFact[]>` (draft → facts dos staged `catalog_item` filtrados por score de tokens; published → `[]`). Rota `POST /v1/knowledge/chat/test` body `{ text: string; max 2000; target?: 'draft' | 'published' (default 'published') }` → ports = `{ ...factory.forTenant(tenantId), retrieve: (q) => retrieveForTarget(..., q, target), lookupCatalog: (q) => lookupCatalogForTarget(...) }` → `createTestChat` → `200 { reply, sources }`. `HttpDeps.knowledge` ganha `portsFactory?: OrchestratorPortsFactory`.

- [x] **Step 1: Testes que falham**

`tests/integration/train-chat-test.test.ts`:
- staged doc "As nossas câmaras CCTV custam 250.000 AOA" + `target: 'draft'` → `reply` presente e `sources` contêm o item staged; **nenhuma** row nova em `handoffs` nem `knowledge_gaps`.
- mesmo staged com `target: 'published'` (default) → `sources` vazias (conteúdo do rascunho não entra no retrieve de produção).
- segunda chamada reutiliza a mesma conversa de teste (contagem de conversas `is_test = 1` por tenant).
- isolamento: tenant B com staged próprio → o chat de B só vê chunks de B.
- `agent` → `403` (papéis da decisão do dono).

- [x] **Step 2: Correr e ver falhar**

Run: `cd packages/backend && npm run test:integration -- train-chat-test`
Expected: FAIL.

- [x] **Step 3: Implementar**

`test-conversation.ts` (select por `contacts.phoneE164` sintético único por tenant — ex.: `+2449000000<suffix do tenant>` — e `conversations.isTest = true`); `draft-retrieval.ts` puro o suficiente para unit-testável, consultas drizzle sob scope; rota compõe ports a partir de `deps.knowledge.portsFactory` (ausente → `503 knowledge_ports_unavailable`); mensagens do chat ficam na conversa de teste (turnos guardados pelo orquestrador como no normal).

- [x] **Step 4: Correr teste + typecheck**

Run: `cd packages/backend && npm run test:integration -- train-chat-test && npm run typecheck`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/backend/src/modules/knowledge/ packages/backend/src/adapters/http/ packages/backend/tests/integration/train-chat-test.test.ts
git commit -m "feat(knowledge): test chat with synthetic conversation and draft-mode retrieval"
```

---

### Task 9: Composição (main.ts), README do módulo e docs

**Files:**
- Modify: `packages/backend/src/infra/main.ts`
- Modify: `packages/backend/src/modules/knowledge/README.md` (novo)
- Modify: `docs/superpowers/specs/2026-10-25-treinar-agente-conhecimento-design.md` (estado + apontamento para o plano)

**Interfaces:**
- Consumes: T4 (`createExtractHandler`), T8 (`HttpDeps.knowledge` completo).

- [x] **Step 1: Ligar no main.ts**

Construir o bundle de conhecimento quando `config` tiver `AI_API_KEY` (provider LLM real, já existente) ou mesmo com o `unavailableAiProvider` (rotas respondem; extração falha com `ai_unavailable` e upload fica `error` — comportamento honesto documentado): `{ db, provider, aiCfg, settings: await readSettings(db), jobs, audit, now, portsFactory: orchestratorPorts }` (embedder **omitido** — runtime de embeddings é ADR pendente; o código está preparado). Registar `jobs.register('knowledge.extract', createExtractHandler(...))` junto do `inbound.process`. `settings` usa `ensureSettingsSeed` já existente.

- [x] **Step 2: Verificar arranque**

Run: `cd packages/backend && npm run typecheck && npm run test:integration -- "http-foundations|config-startup|train-"`
Expected: PASS (arranque sem Redis/AI continua a funcionar — contrato Fase 0).

- [x] **Step 3: README + doc de desenho**

`src/modules/knowledge/README.md`: fluxo (diagrama de passos), tabelas novas, semântica de mesclagem, formatos aceites (TXT/MD; PDF/OCR = ADR pendente), runtime embeddings = ADR pendente, exemplos de payload por rota; nota de âmbito: `qualification_questions` (guião de qualificação), alertas de revisão e fila de sugestões ficam na continuação da Fase 2 (decisão do dono 2026-10-25). No design doc: linha de estado "aprovado 2026-10-25 → implementado; plano: docs/superpowers/plans/2026-10-25-treinar-agente.md".

- [x] **Step 4: Commit**

```bash
git add packages/backend/src/infra/main.ts packages/backend/src/modules/knowledge/README.md docs/superpowers/specs/2026-10-25-treinar-agente-conhecimento-design.md
git commit -m "feat(knowledge): wire training flow into composition root and document module"
```

---

### Task 10: Gates finais

- [x] **Step 1: Suítes completas (nunca em paralelo)**

Run (colar output no relatório):
```
cd packages/backend && npm run typecheck
cd packages/backend && npm run lint
cd packages/backend && npm test
cd packages/backend && npm run test:integration
cd packages/backend && npm run eval:baseline   # tem de bater certo com docs/eval-metas.md
```
Expected: 0 erros de typecheck; lint sem erros novos; unit + integração todos PASS; baseline exacto (o eval não pode ter mudado).

- [x] **Step 2: Semântica de commits verificada**

Run: `git log --oneline -12` — commits pequenos e convencionais; working tree limpa (excepto `.env` e `graphify-out/`).

- [x] **Step 3: Relatório final**

Resumo: o que mudou, output real dos comandos acima, o que ficou por fazer (PDF/OCR, runtime de embeddings, alertas de revisão/sugestões — pendentes de ADR/tarefa seguinte), riscos novos, decisões pendentes de humano.
