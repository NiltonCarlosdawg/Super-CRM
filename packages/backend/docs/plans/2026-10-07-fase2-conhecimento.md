# Fase 2 — Conhecimento Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar o módulo de conhecimento completo — CRUD com papéis, publicação `draft → published → archived` com revisões e reversão, pesquisa semântica com embeddings locais `vector(384)` atrás do port `EmbeddingsProvider`, seeds de qualificação (15) e gatilhos (16), ciclo de lacunas A9 com aprovação humana, alertas de revisão e chat de teste que mostra as fontes — sem `AIProvider` real.
**Architecture:** O schema de `reference/knowledge.schema.ts` vive em `src/modules/knowledge/` (migração `vector(1536) → vector(384)` autorizada por ADR-0002/A4) e é consumido por serviços Drizzle dentro do módulo; o fluxo de publicação é um caso de uso em `src/application/knowledge/` com dependências estruturais (repositório, fila, auditoria), como `processInbound` na Fase 3. O `EmbeddingsProvider` é um port com adaptador `@huggingface/transformers` (modelo ONNX pré-carregado em volume, nunca download) e um fake determinístico para testes; atrás do mesmo port fica o Plano B FTS (`tsvector` português), acionado só se a evidência da Fase 0 refutar o pgvector.
**Tech Stack:** Node ≥ 24 LTS + TypeScript (`strict`, `noUncheckedIndexedAccess`) + `node:test`/`tsx`; Drizzle ORM + PostgreSQL pgvector (migrações `drizzle-kit generate`); Redis + BullMQ atrás do port de jobs (Fase 0); Fastify `/v1` + zod (Fase 1); `@huggingface/transformers` (ONNX, CPU, ADR-0002); `pino`.
**Spec:** docs/01-contexto-e-plano.md §8 (Fase 2) + docs/06-decisoes-fechadas-a1-a11.md
**Also implements:** docs/05 §5 e §7, docs/03 §3, ADR-0002 (A4), ADR-0004 (A8, A9)

## Global Constraints

- TypeScript `strict: true`, `noUncheckedIndexedAccess: true`, `noImplicitOverride: true`, `verbatimModuleSyntax: true`; sem `any` sem comentário `// any: motivo` na própria linha (heurística de referência: `PgDatabase<any, any, any>` em `knowledge.schema.ts`, cujo aviso `no-explicit-any` já é permitido no ESLint pelo ADR-0005).
- IDs `uuid` (`uuid('id').defaultRandom()`); nunca IDs sequenciais expostos.
- Datas sempre `timestamptz` UTC; conversão de fuso só na apresentação (o sweep diário calcula a meia-noite de `Africa/Luanda`).
- Dinheiro em `numeric(14, 2)` no Postgres e **string** em TypeScript (`catalog_items.price_amount`); nunca `number` com vírgula flutuante.
- Sem segredos em código, commits, logs, fixtures ou prompts; `EMBEDDINGS_MODEL_DIR` é caminho de ficheiro, nunca credencial; erros de config citam a **chave**, nunca o valor.
- Só dados sintéticos: as 20 conversas reais de WhatsApp estão proibidas em testes, fixtures, seeds, prompts e exemplos.
- Texto do plano e dos comentários em português; código, identificadores e mensagens de commit em inglês; commits convencionais e pequenos (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`), nunca com testes a falhar; sem `push --force`.
- Testes de integração só com **Postgres e Redis reais em contentores** (`docker-compose.test.yml` da Fase 0); nenhum teste depende da internet (embeddings fake; o adaptador real só corre com o modelo já no volume).
- Idempotência em jobs: `idempotencyKey` determinístico por (entidade, versão) no reindex e por dia Luanda no sweep; handler resistente a reexecução.
- Toda a entrada validada com zod na fronteira (rotas, payloads de jobs, config); erros em `application/problem+json`.
- RBAC no servidor em cada pedido: leitura = qualquer sessão (`agent`, `editor`, `admin`); mutação = `editor` + `admin`; `agent` só lê (`docs/05` §5, `docs/03` §3).
- Publicações, arquivamentos, reversões e aprovações de sugestão escrevem `audit_log` (quem, o quê, quando) — `docs/03` §3.
- Nenhum envio direto: sugestão de resposta aprovada entra na **outbox** da Fase 1 com `idempotencyKey`; aprovação humana é sempre anterior ao envio (A9, D13).
- Migrações só geradas por `npm run db:generate`, revistas à mão (sem `DROP TABLE`), nunca editadas depois de aplicadas; sem `drizzle-kit push`.
- Sem `AIProvider` real nesta fase (é a Fase 3): o chat de teste usa um stub determinístico e ainda não chama o orquestrador.

## Contratos consumidos (Fases 0–1 e referência)

- **Fase 0:** `src/modules/knowledge/knowledge.schema.ts` e `src/modules/knowledge/handoff-triggers.seed.ts` (movidos de `reference/` pela Task 6 da Fase 0 — se ainda estiverem em `reference/`, movê-los primeiro com `git mv`, só ajustando imports, regra 14); `handleInbound`/`DEFAULT_CONFIG` em `src/application/orchestrator.ts` (não usado nesta fase, ver Task 11); port de jobs `JobQueue` (`enqueue(name, payload, { idempotencyKey, correlationId, delayMs? })`, `register(name, handler)`) em `src/ports/job-queue.ts`; `loadConfig`/`AppConfig` em `src/infra/config.ts`; helpers de teste `tests/helpers/db.ts` (`migrateFromEmptyDb()`, `columnNames(db, table)`); `tests/integration/search-chunks.test.ts` (tarefa dona na Fase 0 = Fase 1 — esta fase só acrescenta casos).
- **Fase 1 (plano `docs/plans/2026-10-07-fase1-nucleo-whatsapp.md`, contratos já fixados):** guard de sessão + CSRF + `requireRole` no arranque Fastify, mapper RFC 9457, porta `Audit` (`record(input: { actorId: string | null; action: string; entity: string; entityId: string; detail?: Record<string, unknown>; at: Date }): Promise<void>` em `src/ports/audit.ts` — assinatura da Fase 1 Task 5, idêntica à citada pelo plano da Fase 4; se diferir, adaptar mantendo `action`/`entityId`), outbox `enqueue({ accountId, contactId, conversationId, sender: 'ai' | 'human' | 'campaign', text, idempotencyKey, scheduledAt? }): Promise<{ outboxId: string; duplicate: boolean }>` (Fase 1 Task 17, mesma forma do plano da Fase 4 — `accountId`/`contactId` obtêm-se da conversa em vez de assumir campos soltos), helper de testes `buildTestApp()` em `tests/helpers/http.ts` (sessões/CSRF por papel). Se algum destes não existir quando a tarefa correr, criar o mínimo equivalente no próprio ponto de chamada (padrão já usado pelo plano da Fase 4 para o port `Audit`).
- **Fase 3 (consome-nos, não repetir):** `EmbeddingsProvider` (`src/ports/embeddings.ts`), `searchChunks`, `pk()/ts()/createdAt()` do schema, `triggerSeeds`, `normalizeGapQuestion`/`recordGap`, caso de uso do chat de teste em `src/modules/knowledge/` (a Fase 3 troca o stub pelo `AIProvider` real e passa a chamar `handleInbound(..., { isTest: true })`), chaves `RETRIEVAL_TOP_K`/`RETRIEVAL_MIN_SIMILARITY` (mesmas chaves e defaults na `AIConfig` da Fase 3, Task 5). Atenção: o plano da Fase 3 Task 16 escreve `Ports.recordGap` em `src/adapters/db/orchestrator-ports.ts` — para a agrupação em `knowledge_gaps.normalized_question` não se partir em duas fórmulas, esse mapeamento tem de delegar em `recordGap`/`normalizeGapQuestion` desta fase (se a Fase 3 mantiver cópia própria, a fórmula tem de ser byte a byte igual); registar a conferência no relatório da Fase 3.
- **Referência:** `SourceRef`, `TraceInput`, `LineSlug` de `src/ports/ai-provider.ts`; os 16 gatilhos de `handoff-triggers.seed.ts`; A8/ADR-0004 (15 perguntas, todas `required`); A9/ADR-0004 (ligação lacuna→conversa→sugestão de resposta, com `answer_trace`).

## Review Focus

- `searchChunks` tem de ignorar chunks `active = true` órfãos de itens rascunho, arquivados ou fora de validade (o flag pode ficar stale entre sweeps) — fixa `tests/integration/search-chunks.test.ts`, teste `chunk ativo de item não publicado ou expirado não aparece` (tarefa dona: Task 5).
- O ciclo A9 nunca envia sem aprovação humana: publicar com `gapId` cria **uma** sugestão pendente e **zero** linhas na outbox; o envio só acontece em `approveSuggestion` — fixa `tests/integration/knowledge-gaps-suggestions.test.ts` (tarefa dona: Task 9).
- Idempotência dos jobs de conhecimento: `knowledge.reindex` repetido não duplica chunks e o sweep do mesmo dia Luanda corre uma vez — fixa `tests/integration/knowledge-reindex.test.ts` (Task 4) e `tests/unit/knowledge-sweep.test.ts` (Task 10).
- Migração `vector(1536) → vector(384)`: tem de aplicar-se de zero numa base vazia e recriar o índice HNSW — fixa `tests/integration/knowledge-schema.test.ts` (tarefa dona: Task 1).
- `RETRIEVAL_TOP_K`/`RETRIEVAL_MIN_SIMILARITY` existem em dois sítios (config desta fase e `AIConfig` da Fase 3) — os defaults 5 / 0.75 têm de casar; divergência é bug de config partilhada — fixa `tests/unit/knowledge-config.test.ts` (tarefa dona: Task 2) mais `tests/unit/ai-config.test.ts` (Fase 3, Task 5).

---

### Task 1: Schema do conhecimento em `src/modules/knowledge/` — `vector(384)` e a ligação A9

**Files:**
- Modify: `src/modules/knowledge/knowledge.schema.ts` (se ainda estiver em `reference/`, primeiro `git mv reference/knowledge.schema.ts src/modules/knowledge/knowledge.schema.ts` com ajuste de imports — regra 14)
- Modify: `tests/helpers/db.ts` (acrescentar `columnDimension`, `notNullColumns`, `hasIndex` só se a Fase 0/1 os não tiver; nada de alterar funções existentes)
- Create: `drizzle/NNNN_*.sql` (gerado por `npm run db:generate`, revisto à mão)
- Test: `tests/integration/knowledge-schema.test.ts`

**Interfaces:**
- Consumes: `migrateFromEmptyDb()`, `columnNames(db, table)` de `tests/helpers/db.ts` (Fase 0/1); extensão `vector` já criada pela migração `0000` (Fase 0); autorização da migração de dimensão em `docs/adr/0002` (A4) e da modelação da ligação lacuna→sugestão em `docs/adr/0004` (A9).
- Produces: o mesmo módulo, com estas mudanças exatas:

```ts
export const suggestionKindEnum = pgEnum('suggestion_kind', ['knowledge', 'reply']);
// knowledgeChunks.embedding: vector('embedding', { dimensions: 384 })  // era 1536 — ADR-0002/A4
// índice knowledgeChunks_embedding_idx mantido: .using('hnsw', t.embedding.op('vector_cosine_ops'))
// knowledgeSuggestions acrescenta:
//   kind: suggestionKindEnum('kind').notNull().default('knowledge'),
//   answerTraceId: uuid('answer_trace_id').references(() => answerTraces.id),
// e humanAnswer / proposedTitle deixam de ser .notNull()
//   (kind 'reply' usa só proposedBody + conversationId + gapId; a validação por tipo é das Tasks 6 e 9)
// ordem no ficheiro: o bloco answerTraces passa a vir ANTES de knowledgeSuggestions (só reordenação)
```

- Mantidos sem mudança de comportamento: helpers `pk()`, `ts()`, `createdAt()`, `updatedAt()` (consumidos pela Fase 3 Task 2), `aiModeEnum`, os 12 exports de tabelas e `searchChunks` (muda na Task 5).

**Steps:**

- [ ] Escrever `tests/integration/knowledge-schema.test.ts` falhado:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { migrateFromEmptyDb, columnNames, notNullColumns, columnDimension, hasIndex } from '../helpers/db.js';

test('migração do zero: vector(384), índice HNSW e colunas da ligação A9', async () => {
  await migrateFromEmptyDb();
  assert.equal(await columnDimension('knowledge_chunks', 'embedding'), 384);
  assert.ok(await hasIndex('knowledge_chunks_embedding_idx'), 'índice HNSW recriado');
  const cols = await columnNames('knowledge_suggestions');
  assert.ok(cols.includes('kind'));
  assert.ok(cols.includes('answer_trace_id'));
  const notNull = await notNullColumns('knowledge_suggestions');
  assert.ok(!notNull.includes('human_answer'));
  assert.ok(!notNull.includes('proposed_title'));
});
```

- [ ] Correr `npm run test:integration -- knowledge-schema` → **tem de falhar** (`columnDimension` devolve `1536`, ou helpers inexistentes — implementar primeiro os helpers de `tests/helpers/db.ts` e voltar a correr até falhar na asserção `384`).
- [ ] Implementar as mudanças exatas das Interfaces em `knowledge.schema.ts` (incluindo a reordenação de `answerTraces` para conseguir a FK `answer_trace_id`).
- [ ] `npm run db:generate` → rever o SQL gerado: espera-se `ALTER TABLE knowledge_chunks ALTER COLUMN embedding TYPE vector(384)`, `CREATE TYPE suggestion_kind`, `ALTER TABLE knowledge_suggestions ADD COLUMN …` e a **recriação do índice HNSW** (se o kit dropar o índice e não o recriar, acrescentar à migração, à mão e na mesma ordem: `DROP INDEX knowledge_chunks_embedding_idx; ALTER TABLE … ; CREATE INDEX knowledge_chunks_embedding_idx ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);` — nunca `DROP TABLE`).
- [ ] Correr `npm run test:integration -- knowledge-schema` → `pass`, `fail 0`.
- [ ] `npm run typecheck && npm run lint` → sem erros (o `// any: motivo` do `searchChunks` mantém-se; nenhum import novo de `domain`/`application` para Drizzle).
- [ ] Commit: `feat: migrate knowledge vectors to 384 and model suggestion linkage`.

---

### Task 2: Configuração do conhecimento + port `EmbeddingsProvider` + adaptador local

**Files:**
- Create: `src/ports/embeddings.ts`, `src/modules/knowledge/config.ts`, `src/adapters/ai/embeddings.ts`, `tests/helpers/fake-embeddings.ts`, `tests/unit/knowledge-config.test.ts`, `tests/unit/embeddings.test.ts`
- Modify: `src/infra/config.ts` (acrescentar `knowledge: loadKnowledgeConfig(env)` ao `AppConfig`, com erro convertido em `ConfigError.issues`), `.env.example` (chaves novas, sem valores reais), `tests/unit/config.test.ts` (acrescentar `knowledge` ao objeto esperado do `deepEqual` e um caso de chave inválida), `docs/adr/0005-toolchain-fundacao.md` (registar a dependência `@huggingface/transformers`, decisão ADR-0002/A4)
- Test: `tests/unit/knowledge-config.test.ts`, `tests/unit/embeddings.test.ts`

**Interfaces:**
- Consumes: `loadConfig`/`ConfigError` de `src/infra/config.ts` (Fase 0); decisão A4 de `docs/06` e ADR-0002 (modelo local, `vector(384)`, variante MiniLM por RAM).
- Produces:

```ts
// src/ports/embeddings.ts
export interface EmbeddingsProvider {
  readonly model: string;
  readonly dimensions: number;
  /** Texto de pesquisa (prefixo de query, se o modelo o exigir). */
  embedQuery(text: string): Promise<number[]>;
  /** Lote de textos a indexar (prefixo de passagem). */
  embedPassages(texts: readonly string[]): Promise<number[][]>;
}
export type EmbeddingsErrorCode = 'model_missing' | 'embed_failed' | 'dimension_mismatch';
export class EmbeddingsError extends Error { readonly code: EmbeddingsErrorCode; }

// src/modules/knowledge/config.ts
export interface KnowledgeConfig {
  retrieval: { topK: number; minSimilarity: number };   // RETRIEVAL_TOP_K=5, RETRIEVAL_MIN_SIMILARITY=0.75
  embeddings: { model: string; modelDir: string; dimensions: number; batchSize: number };
  chunking: { maxChars: number };                       // KNOWLEDGE_CHUNK_MAX_CHARS=800
}
export class KnowledgeConfigError extends Error { readonly issues: readonly string[]; }
export function loadKnowledgeConfig(env: Readonly<Record<string, string | undefined>>): KnowledgeConfig;

// src/adapters/ai/embeddings.ts
export function createEmbeddings(opts: { modelDir: string; model: string }): EmbeddingsProvider;

// tests/helpers/fake-embeddings.ts
export const fakeEmbeddings: EmbeddingsProvider;          // model 'fake', dimensions 384, determinístico
export function fakeEmbeddingVector(text: string): number[]; // mesma fórmula, para testes
```

Chaves env e limites exatos (erros citam a chave, nunca o valor): `RETRIEVAL_TOP_K` (default `5`, inteiro 1–50), `RETRIEVAL_MIN_SIMILARITY` (default `0.75`, 0–1), `EMBEDDINGS_MODEL` (default `multilingual-e5-small`, não vazio), `EMBEDDINGS_MODEL_DIR` (default `./models/multilingual-e5-small`, não vazio), `EMBEDDINGS_BATCH_SIZE` (default `32`, inteiro 1–256), `KNOWLEDGE_CHUNK_MAX_CHARS` (default `800`, inteiro 200–4000). `dimensions` é sempre `384` (não configurável: tem de casar com a coluna; a variante MiniLM da ADR-0002 também tem 384 — troca-se só `EMBEDDINGS_MODEL_DIR`).

**Steps:**

- [ ] Escrever `tests/unit/knowledge-config.test.ts` falhado:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadKnowledgeConfig, KnowledgeConfigError } from '../../src/modules/knowledge/config.js';

test('defaults exatos (docs/05 §6 + A4)', () => {
  assert.deepEqual(loadKnowledgeConfig({}), {
    retrieval: { topK: 5, minSimilarity: 0.75 },
    embeddings: { model: 'multilingual-e5-small', modelDir: './models/multilingual-e5-small', dimensions: 384, batchSize: 32 },
    chunking: { maxChars: 800 },
  });
});
test('erros citam a chave, nunca o valor', () => {
  const bad = (env: Record<string, string>) => {
    try { loadKnowledgeConfig(env); return null; } catch (e) { return e as KnowledgeConfigError; }
  };
  assert.equal(bad({ RETRIEVAL_TOP_K: '0' })?.issues[0], 'RETRIEVAL_TOP_K: fora do intervalo 1-50');
  assert.equal(bad({ RETRIEVAL_MIN_SIMILARITY: '1.5' })?.issues[0], 'RETRIEVAL_MIN_SIMILARITY: fora do intervalo 0-1');
  assert.equal(bad({ EMBEDDINGS_BATCH_SIZE: '0' })?.issues[0], 'EMBEDDINGS_BATCH_SIZE: fora do intervalo 1-256');
  assert.equal(bad({ KNOWLEDGE_CHUNK_MAX_CHARS: '100' })?.issues[0], 'KNOWLEDGE_CHUNK_MAX_CHARS: fora do intervalo 200-4000');
  assert.equal(bad({ EMBEDDINGS_MODEL: '' })?.issues[0], 'EMBEDDINGS_MODEL: valor não permitido');
  assert.ok(!bad({ EMBEDDINGS_MODEL: 'segredo-local' })?.issues.join().includes('segredo-local'));
});
```

- [ ] Escrever `tests/unit/embeddings.test.ts` falhado:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { fakeEmbeddings, fakeEmbeddingVector } from '../helpers/fake-embeddings.js';
import { createEmbeddings } from '../../src/adapters/ai/embeddings.js';
import { EmbeddingsError } from '../../src/ports/embeddings.js';

test('fake é determinístico, 384 dimensões e mede similaridade por tokens partilhados', async () => {
  const a = await fakeEmbeddings.embedQuery('plano de internet');
  assert.equal(a.length, 384);
  assert.deepEqual(a, fakeEmbeddingVector('plano de internet'));
  assert.deepEqual(a, await fakeEmbeddings.embedQuery('plano de internet'));
  const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * (y[i] ?? 0), 0);
  assert.ok(dot(a, await fakeEmbeddings.embedQuery('plano de internet')) > dot(a, await fakeEmbeddings.embedQuery('cctv câmaras')));
  assert.equal((await fakeEmbeddings.embedPassages(['a', 'b'])).length, 2);
});
test('adaptador real falha sem download quando o volume não tem o modelo', () => {
  assert.throws(
    () => createEmbeddings({ modelDir: '/modelo-que-nao-existe', model: 'multilingual-e5-small' }),
    (e: unknown) => e instanceof EmbeddingsError && e.code === 'model_missing' && /modelo-que-nao-existe/.test(e.message),
  );
});
```

- [ ] Correr `npm test -- tests/unit/knowledge-config.test.ts && npm test -- tests/unit/embeddings.test.ts` → **tem de falhar** (`Cannot find module …/config.js`).
- [ ] Implementar: `src/modules/knowledge/config.ts` com zod por chave (mensagens na ordem `RETRIEVAL_TOP_K, RETRIEVAL_MIN_SIMILARITY, EMBEDDINGS_MODEL, EMBEDDINGS_MODEL_DIR, EMBEDDINGS_BATCH_SIZE, KNOWLEDGE_CHUNK_MAX_CHARS`, formato `<CHAVE>: fora do intervalo a-b` / `<CHAVE>: valor não permitido`, `issues` congelado); `src/ports/embeddings.ts` (só tipos + erro); `tests/helpers/fake-embeddings.ts` com fórmula determinística — por token (`NFD` sem diacríticos, minúsculas, split em não-alfanuméricos) `idx = fnv1a(token) % 384`, soma 1 nesse índice, normalização L2 ao fim; texto sem tokens → vetor `[1, 0, …]`; `embedQuery(t) === embedPassages([t])[0]`; `createEmbeddings` valida que `modelDir` existe com ficheiro de configuração antes de construir o pipeline e lança `EmbeddingsError('model_missing')` com o caminho; **nunca** download — usar a opção da versão instalada de `@huggingface/transformers` que força caminho local (verificar na doc da versão instalada e citar `ficheiro:linha` no relatório; `npm install @huggingface/transformers` e registar no ADR-0005).
- [ ] `src/infra/config.ts`: `AppConfig` ganha `knowledge: KnowledgeConfig`; `loadConfig` chama `loadKnowledgeConfig(env)` uma vez e junta `issues` ao `ConfigError`.
- [ ] `tests/unit/config.test.ts` (Fase 0): acrescentar `knowledge: loadKnowledgeConfig({})` ao objeto esperado e o caso `RETRIEVAL_TOP_K: '0'` → `issues` contém `RETRIEVAL_TOP_K: fora do intervalo 1-50` (atualização do `deepEqual`, não enfraquecimento).
- [ ] `.env.example` com as 6 chaves e os defaults documentados (comentário: modelo ONNX pré-carregado em volume; em produção `EMBEDDINGS_MODEL_DIR` aponta para o volume do alojamento).
- [ ] Correr `npm test -- tests/unit/knowledge-config.test.ts && npm test -- tests/unit/embeddings.test.ts && npm test` → `pass`, `fail 0`; `npm run typecheck && npm run lint` → sem erros.
- [ ] Commit: `feat: add knowledge config and local embeddings provider port`.

### Task 3: Seeds — linhas de negócio, 15 perguntas de qualificação (A8) e 16 gatilhos

**Files:**
- Create: `src/modules/knowledge/business-lines.seed.ts`, `src/modules/knowledge/qualification-questions.seed.ts`, `scripts/seed-knowledge.ts`
- Test: `tests/integration/knowledge-seed.test.ts`

**Interfaces:**
- Consumes: `triggerSeeds` e `seedHandoffTriggers(db)` de `src/modules/knowledge/handoff-triggers.seed.ts` (Fase 0/referência); tabelas `businessLines`, `qualificationQuestions` do schema; campos aprovados em `docs/06` A8 e ADR-0004.
- Produces:

```ts
// src/modules/knowledge/business-lines.seed.ts
export interface LineSeed { slug: LineSlug; name: string; conversionGoal: 'demo_request' | 'proposal_request' | 'installation_booking' | 'quote_visit'; }
export const lineSeeds: readonly LineSeed[]; // software|custom|telecom|cctv
export async function seedBusinessLines(db: PgDatabase): Promise<number>; // idempotente: só insere slugs em falta

// src/modules/knowledge/qualification-questions.seed.ts
export interface QuestionSeed { lineSlug: LineSlug; key: string; question: string; answerType: 'text' | 'number' | 'choice' | 'boolean'; choices: readonly string[] | null; position: number; }
export const questionSeeds: readonly QuestionSeed[]; // 15, todos required=true na inserção
export async function seedQualificationQuestions(db: PgDatabase): Promise<number>; // idempotente por (lineId, key)

// src/modules/knowledge/seed.ts  (orquestrador único, usado pelo script e pelos testes)
export async function seedKnowledge(db: PgDatabase): Promise<{ lines: number; questions: number; triggers: number }>;
// ordem obrigatória: seedBusinessLines → seedQualificationQuestions → seedHandoffTriggers
// (seedHandoffTriggers lança `Linha de negócio inexistente: <slug>` se as linhas falharem)
```

Dados exatos de `questionSeeds` (A8: campos de `docs/05` §7, **todos** `required`; `key` em `snake_case` como os exemplos `camera_count`/`location` dos docs):

| # | lineSlug | key | question | answerType | choices | position |
|---|---|---|---|---|---|---|
| 1 | software | `company` | Qual é o nome da tua empresa? | text | null | 1 |
| 2 | software | `user_count` | Quantas pessoas vão usar o sistema? | number | null | 2 |
| 3 | software | `main_need` | Qual é a tua necessidade principal? | text | null | 3 |
| 4 | custom | `problem` | Qual é o problema que queres resolver? | text | null | 1 |
| 5 | custom | `scope` | Qual é o âmbito do trabalho, ou seja, o que está incluído? | text | null | 2 |
| 6 | custom | `user_count` | Quantas pessoas vão usar a solução? | number | null | 3 |
| 7 | custom | `desired_deadline` | Para quando precisas de ter isto pronto? | text | null | 4 |
| 8 | custom | `decision_maker` | Quem decide a compra? | text | null | 5 |
| 9 | telecom | `service_type` | Que serviço pretendes? | text | null | 1 |
| 10 | telecom | `premise_type` | É para casa ou para empresa? | choice | `["casa","empresa"]` | 2 |
| 11 | telecom | `address` | Qual é a morada da instalação? | text | null | 3 |
| 12 | cctv | `camera_count` | Quantas câmaras precisas? | number | null | 1 |
| 13 | cctv | `interior_exterior` | É para interior ou exterior? | choice | `["interior","exterior"]` | 2 |
| 14 | cctv | `site_type` | Que tipo de local é? | text | null | 3 |
| 15 | cctv | `location` | Onde fica o local a vigiar? | text | null | 4 |

Só `premise_type` e `interior_exterior` têm `choices`: são os únicos vocabulários fechados escritos nos docs (casa/empresa, interior/exterior). Os restantes ficam `text` — **não inventar** vocabulários que os docs não definem.

`lineSeeds` (nomes de `docs/01` §2; `conversionGoal` inferido dos gatilhos por linha do próprio seed — `demo_request`↔software, `proposal_request`↔custom, `installation_booking`↔telecom, `quote_visit`↔cctv — registar no relatório como decisão a confirmar pelo dono):

| slug | name | conversionGoal |
|---|---|---|
| `software` | Software | `demo_request` |
| `custom` | Soluções personalizadas | `proposal_request` |
| `telecom` | Telecomunicações | `installation_booking` |
| `cctv` | CCTV | `quote_visit` |

**Steps:**

- [ ] Escrever `tests/integration/knowledge-seed.test.ts` falhado:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { seedKnowledge } from '../../src/modules/knowledge/seed.js';
import { seedHandoffTriggers } from '../../src/modules/knowledge/handoff-triggers.seed.js';

test('seedKnowledge: 4 linhas, 15 perguntas (3/5/3/4) e 16 gatilhos, tudo idempotente', async () => {
  const first = await seedKnowledge(db);
  assert.deepEqual(first, { lines: 4, questions: 15, triggers: 16 });
  const second = await seedKnowledge(db);
  assert.deepEqual(second, { lines: 0, questions: 0, triggers: 0 });   // segunda vez: nada
  const byLine = await countQuestionsByLine();                          // helper: join business_lines
  assert.deepEqual(byLine, { software: 3, custom: 5, telecom: 3, cctv: 4 });
  assert.equal(await countWhere('qualification_questions', 'required = false'), 0); // A8: todos required
  assert.deepEqual(await positionsFor('cctv'), [1, 2, 3, 4]);
  assert.equal(await countRows('handoff_triggers'), 16);
});

test('gatilhos sem linhas de negócio lançam erro (ordem do seed)', async () => {
  await assert.rejects(seedHandoffTriggers(dbFresh), /Linha de negócio inexistente/);
});
```

- [ ] Correr `npm run test:integration -- knowledge-seed` → **tem de falhar** (`Cannot find module …/seed.js`).
- [ ] Implementar os dois seeds e `seedKnowledge`, seguindo o padrão idempotente de `seedHandoffTriggers` (ler chaves existentes, inserir só as em falta, lançar se um `lineSlug` não existir). `questionSeeds` = tabela acima com `required: true` e `active: true` na inserção; `lineSeeds` = tabela acima. `scripts/seed-knowledge.ts`: liga com `pg.Pool` a `DATABASE_URL`, corre `seedKnowledge`, imprime JSON `{"event":"knowledge.seed","lines":n,"questions":n,"triggers":n}` e sai 0 (ou 1 com o erro, sem ecoar a password da URL).
- [ ] Correr `npm run test:integration -- knowledge-seed` → `pass`, `fail 0`; `npm run typecheck && npm run lint` → sem erros.
- [ ] No relatório: registar que os `key` literais de 13 das 15 perguntas não constam dos docs (A8 aprovou os campos, não as strings) e o mapa `conversionGoal` acima — ambos para confirmação do dono; e que o seed de produção corre via `npx tsx scripts/seed-knowledge.ts` após as migrações (documentar no README, Task 12).
- [ ] Commit: `feat: seed business lines and qualification questions idempotently`.

---

### Task 4: Chunking + job de embeddings (`knowledge.reindex`)

**Files:**
- Create: `src/domain/knowledge/chunking.ts`, `src/modules/knowledge/reindex.ts`, `tests/unit/chunking.test.ts`
- Test: `tests/integration/knowledge-reindex.test.ts`

**Interfaces:**
- Consumes: `JobQueue` de `src/ports/job-queue.ts` (Fase 0); `EmbeddingsProvider` (Task 2); `KnowledgeConfig` (Task 2); tabelas `knowledgeDocs`, `catalogItems`, `knowledgeChunks`.
- Produces:

```ts
// src/domain/knowledge/chunking.ts (puro, sem I/O)
export function chunkText(text: string, opts: { maxChars: number }): string[];

// src/modules/knowledge/reindex.ts
export type ChunkableEntityType = 'catalog_item' | 'knowledge_doc';
export interface ReindexDeps { db: PgDatabase; embeddings: EmbeddingsProvider; config: KnowledgeConfig; }
export interface ReindexPayload { entityType: ChunkableEntityType; entityId: string; }
export async function reindexKnowledgeItem(d: ReindexDeps, payload: ReindexPayload): Promise<{ chunks: number; active: boolean }>;
export function registerKnowledgeJobs(jobs: JobQueue, d: ReindexDeps): Promise<void>; // regista o handler de 'knowledge.reindex'
// payload de enfileirar (publicado pela Task 7): { entityType, entityId, version }
// idempotencyKey: `knowledge.reindex:<entityType>:<entityId>:<version>`
```

Algoritmo de `chunkText` (exato): (1) partir por linhas em branco (`\n\s*\n`) em blocos; (2) juntar blocos consecutivos enquanto `comprimento(atual) + 1 + comprimento(próximo) ≤ maxChars` (separador `\n`); (3) bloco sozinho acima de `maxChars` → partir por frases (`/(?<=[.!?])\s+/`) e agrupar frases pela mesma regra; (4) frase acima de `maxChars` → partir por espaços em pedaços ≤ `maxChars`; (5) `trim` de cada chunk e remover vazios.

Texto-fonte a embedar (exato): `knowledge_docs` → `${title}\n\n${body}`; `catalog_items` → `name`, `summary`, `priceNote` (se existir) e os valores escalares de `details` como `chave: valor`, juntos com `\n\n`.

Regra de `active` no handler: `status = 'published'` **e** (`valid_from` nulo ou ≤ `now`) **e** (`valid_until` nulo ou > `now`) → `active = true` e (re)cria chunks; caso contrário → `active = false` nos chunks existentes **sem embedar** (nenhum chunk apagado, para a reativação não custar re-embed).

**Steps:**

- [ ] Escrever `tests/unit/chunking.test.ts` falhado:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkText } from '../../src/domain/knowledge/chunking.js';

test('parágrafos juntam-se até maxChars', () => {
  assert.deepEqual(chunkText('A.\n\nB.\n\nC.', { maxChars: 7 }), ['A.\nB.', 'C.']);
});
test('bloco acima de maxChars divide por frases', () => {
  assert.deepEqual(chunkText('Uma frase longa aqui. Outra frase aqui.', { maxChars: 25 }), ['Uma frase longa aqui.', 'Outra frase aqui.']);
});
test('frase sem espaços acima de maxChars divide por pedaços', () => {
  assert.deepEqual(chunkText('ABCDEFGHIJ', { maxChars: 4 }), ['ABCD', 'EFGH', 'IJ']);
});
test('texto vazio ou só espaços devolve []', () => {
  assert.deepEqual(chunkText(' \n\n ', { maxChars: 100 }), []);
  assert.deepEqual(chunkText('', { maxChars: 100 }), []);
});
```

- [ ] Correr `npm test -- tests/unit/chunking.test.ts` → **tem de falhar** (`Cannot find module …/chunking.js`).
- [ ] Implementar `chunkText` conforme o algoritmo acima (corpo já deduzível; sem dependências).
- [ ] Correr `npm test -- tests/unit/chunking.test.ts` → `4 pass`, `0 fail`.
- [ ] Escrever `tests/integration/knowledge-reindex.test.ts` falhado (Postgres real + `fakeEmbeddings`):

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { reindexKnowledgeItem, registerKnowledgeJobs } from '../../src/modules/knowledge/reindex.js';
import { fakeEmbeddings } from '../helpers/fake-embeddings.js';

const DOC = '00000000-0000-4000-8000-00000000d001';
const cfg = { retrieval: { topK: 5, minSimilarity: 0.75 }, embeddings: { model: 'fake', modelDir: '.', dimensions: 384, batchSize: 32 }, chunking: { maxChars: 800 } };
const deps = () => ({ db, embeddings: fakeEmbeddings, config: cfg });

test('reindex de item publicado e válido cria chunks ativos com 384 dimensões', async () => {
  await insertDoc({ id: DOC, title: 'Planos Fast', body: 'Plano de 10 Mbps.\n\nSuporte 24 horas.', status: 'published' });
  const r = await reindexKnowledgeItem(deps(), { entityType: 'knowledge_doc', entityId: DOC });
  assert.equal(r.active, true);
  assert.ok(r.chunks >= 1);
  const rows = await chunksOf(DOC);
  assert.equal(rows.length, r.chunks);
  assert.ok(rows.every((c) => c.active && c.embedding_model === 'fake' && c.embedding.length === 384));
});

test('reindex é idempotente: segunda execução não duplica chunks', async () => {
  const a = await reindexKnowledgeItem(deps(), { entityType: 'knowledge_doc', entityId: DOC });
  const b = await reindexKnowledgeItem(deps(), { entityType: 'knowledge_doc', entityId: DOC });
  assert.equal(a.chunks, b.chunks);
  assert.equal((await chunksOf(DOC)).length, b.chunks);
});

test('item rascunho ou fora de validade desativa chunks sem embedar', async () => {
  await sql(`UPDATE knowledge_docs SET status = 'draft' WHERE id = '${DOC}'`);
  const r = await reindexKnowledgeItem(deps(), { entityType: 'knowledge_doc', entityId: DOC });
  assert.deepEqual(r, { chunks: (await chunksOf(DOC)).length, active: false });
  assert.ok((await chunksOf(DOC)).every((c) => !c.active));   // chunks preservados para reativação
});

test('registerKnowledgeJobs liga o handler ao nome knowledge.reindex', async () => {
  const handlers = new Map<string, Function>();
  await registerKnowledgeJobs({ enqueue: async () => {}, register: async (n: string, h: Function) => { handlers.set(n, h); }, close: async () => {} }, deps());
  assert.ok(handlers.has('knowledge.reindex'));
});
```

- [ ] Correr `npm run test:integration -- knowledge-reindex` → **tem de falhar** (`Cannot find module …/reindex.js`).
- [ ] Implementar `src/modules/knowledge/reindex.ts`: `reindexKnowledgeItem` (carrega o item → `not found` lança erro permanente `knowledge item not found: <id>`; se inativo → só `UPDATE … SET active = false` dos chunks do item e devolve `{ chunks, active: false }`; se ativo → texto-fonte, `chunkText`, `embedPassages` em lotes de `config.embeddings.batchSize`, `DELETE` dos chunks do item + `INSERT` dos novos com `active = true`, `embedding_model = embeddings.model`) — tudo numa transação; `registerKnowledgeJobs(jobs, d)` chama `jobs.register('knowledge.reindex', handler)` com validação zod do payload (sem `version` aceite também: o handler não depende dele, o `version` serve só de chave de idempotência).
- [ ] Correr `npm run test:integration -- knowledge-reindex` → `4 pass`, `0 fail`; `npm run typecheck && npm run lint` → sem erros.
- [ ] Commit: `feat: chunk and embed published knowledge in an idempotent job`.

---

### Task 5: `searchChunks` — só itens publicados e válidos (Plano A pgvector; Plano B FTS condicional)

**Files:**
- Modify: `src/modules/knowledge/knowledge.schema.ts` (`searchChunks`)
- Modify: `tests/integration/search-chunks.test.ts` (tarefa dona Fase 1 — acrescentar os casos abaixo; se ainda não existir, criá-lo)
- Test: `tests/integration/search-chunks.test.ts`

**Interfaces:**
- Consumes: `fakeEmbeddings` (Task 2), tabelas do schema (Task 1), `KnowledgeConfig.retrieval` (Task 2).
- Produces:

```ts
export async function searchChunks(
  db: PgDatabase<any, any, any>,   // any: PgDatabase de reference/; alterar exige ADR (AGENTS.md §14)
  queryEmbedding: number[],
  opts: { limit: number; minSimilarity: number },   // SEM defaults: o valor vem sempre da config (docs/05 §6)
): Promise<{
  id: string; source: 'doc' | 'catalog'; docId: string | null; catalogItemId: string | null;
  content: string; similarity: number; version: number;
}[]>;
// WHERE: knowledge_chunks.active = true
//   AND similaridade cosseno > minSimilarity
//   AND ( (doc_id NOT NULL  E existe knowledge_docs com status='published' E dentro de valid_from/valid_until)
//      OR (catalog_item_id NOT NULL E existe catalog_items com status='published' E dentro da validade) )
// ORDER BY similaridade DESC LIMIT limit
```

Os dois defaults de referência (`limit = 5`, `minSimilarity = 0.5`) desaparecem: `opts` passa a ser **obrigatório** (nenhum chamador existente o omite — `reference/` não chama `searchChunks`; a Fase 3 passará `config.retrieval` com 5 / 0.75). Registar esta mudança de assinatura no relatório; se o dono a considerar uma decisão de arquitetura, escrever ADR curto.

**Steps:**

- [ ] Acrescentar a `tests/integration/search-chunks.test.ts` os testes falhados novos:

```ts
test('chunk ativo de item não publicado ou expirado não aparece', async () => {
  const okId = await seedDoc({ title: 'Planos Fast', body: 'Plano de internet de 10 Mbps.', status: 'published', active: true });
  const draftId = await seedDoc({ title: 'Segredo', body: 'plano confidencial', status: 'draft', active: true });      // estado stale
  const oldId = await seedDoc({ title: 'Antigo', body: 'plano antigo', status: 'published', active: true, validUntil: '2026-01-01T00:00:00Z' });
  const q = await fakeEmbeddings.embedQuery('plano');
  const hits = await searchChunks(db, q, { limit: 5, minSimilarity: 0.1 });
  assert.deepEqual(hits.map((h) => h.docId), [okId]);
  assert.ok(!hits.some((h) => h.docId === draftId || h.docId === oldId));
  assert.equal(typeof hits[0]!.version, 'number');          // version vem do item pai (contracto RetrievedChunk)
});

test('limit e minSimilarity vêm da config, sem defaults escondidos', async () => {
  const q = await fakeEmbeddings.embedQuery('plano');
  assert.equal((await searchChunks(db, q, { limit: 1, minSimilarity: 0.1 })).length, 1);
  assert.deepEqual(await searchChunks(db, q, { limit: 5, minSimilarity: 0.999 }), []);
});
```

- [ ] Correr `npm run test:integration -- search-chunks` → **tem de falhar** (o `WHERE` atual só tem `active = true` → o chunk `draft` aparece; e a assinatura sem `opts` já não compila).
- [ ] Implementar o `WHERE` acima com template `sql` parametrizado do Drizzle (`EXISTS` contra a tabela pai, com `valid_from`/`valid_until` nulos a significar "sem limite"), `LEFT JOIN`/subselect para devolver `version` do pai, e `opts` obrigatório sem defaults. `ORDER BY` e `LIMIT` como na referência.
- [ ] Correr `npm run test:integration -- search-chunks` → `pass`, `fail 0` (os casos antigos da Fase 1 continuam a passar).
- [ ] `npm run typecheck && npm run lint` → sem erros.
- [ ] **Ramo B (só se `docs/cpanel-capacidades.md` §1 pgvector estiver `Refutado`):** escrever `docs/adr/0006-fts-sem-pgvector.md` (contexto, opções, decisão, consequências); alargar a assinatura para `searchChunks(db, query: { text: string; embedding?: number[] }, opts)` trocando a similaridade por `ts_rank_cd(to_tsvector('portuguese', content), plainto_tsquery('portuguese', query.text))` quando não houver `embedding`, com índice GIN de expressão gerado por migração; omitir a dependência do `vector` nesta migração; o mesmo teste acima é o contrato e tem de passar sem alterações (adaptar só o helper `embedQuery` → `query.text`); `npm install` sem dependências novas.
- [ ] Commit: `feat: restrict semantic search to published and valid knowledge` (ramo B: `feat: search knowledge with portuguese fts when pgvector is unavailable`).

### Task 6: CRUD das 5 entidades com validação e revisões

**Files:**
- Create: `src/modules/knowledge/errors.ts`, `src/modules/knowledge/validation.ts`, `src/modules/knowledge/repository.ts`, `src/modules/knowledge/service.ts`
- Test: `tests/unit/knowledge-validation.test.ts`, `tests/integration/knowledge-crud.test.ts`

**Interfaces:**
- Consumes: schema (Task 1); porta `Audit` da Fase 1 (`record({ actorId, action, entity, entityId, detail?, at })`); `lineSeeds`/`questionSeeds` da Task 3 para fixtures de teste.
- Produces:

```ts
// src/modules/knowledge/errors.ts
export type KnowledgeErrorCode =
  | 'invalid_input' | 'not_found' | 'conflict' | 'invalid_transition' | 'invalid_revert'
  | 'unsupported_entity' | 'gap_not_found' | 'gap_not_open' | 'suggestion_invalid_state' | 'expired_item';
export class KnowledgeError extends Error { readonly code: KnowledgeErrorCode; readonly status: number; }
// status: invalid_input/unsupported_entity 400 · not_found/gap_not_found 404
//         conflict/invalid_transition/invalid_revert/gap_not_open/suggestion_invalid_state/expired_item 409

// src/modules/knowledge/validation.ts
export type KnowledgeEntityType = 'catalog_item' | 'knowledge_doc' | 'rule' | 'qualification_question' | 'handoff_trigger';
export function parseCreate(type: KnowledgeEntityType, raw: unknown): Record<string, unknown>; // zod; lança KnowledgeError('invalid_input')
export function parsePatch(type: KnowledgeEntityType, raw: unknown): Record<string, unknown>;  // parcial, ≥1 campo

// src/modules/knowledge/repository.ts
export type KnowledgeRow =
  | typeof catalogItems.$inferSelect | typeof knowledgeDocs.$inferSelect | typeof rules.$inferSelect
  | typeof qualificationQuestions.$inferSelect | typeof handoffTriggers.$inferSelect;
export interface KnowledgeRepository {
  find(type: KnowledgeEntityType, id: string): Promise<KnowledgeRow | null>;
  list(type: KnowledgeEntityType, filter: { status?: KnowledgeStatus; lineId?: string; limit: number; cursor: string | null }): Promise<{ items: KnowledgeRow[]; nextCursor: string | null }>;
  insert(type: KnowledgeEntityType, data: Record<string, unknown>): Promise<KnowledgeRow>;
  /** Grava knowledge_revisions com o estado ANTERIOR (version atual) e incrementa a versão (coluna em catalog/doc; contagem em rule). */
  update(type: KnowledgeEntityType, id: string, patch: Record<string, unknown>, ctx: { actorId: string; note: string | null; at: Date }): Promise<KnowledgeRow>;
  currentVersion(type: KnowledgeEntityType, id: string): Promise<number>;
}
export function createKnowledgeRepository(db: PgDatabase): KnowledgeRepository;

// src/modules/knowledge/service.ts
export interface KnowledgeServiceDeps { db: PgDatabase; audit: AuditPort; }
export async function createKnowledgeItem(d: KnowledgeServiceDeps, type: KnowledgeEntityType, raw: unknown, ctx: { actorId: string; at: Date }): Promise<KnowledgeRow>;
export async function updateKnowledgeItem(d: KnowledgeServiceDeps, type: KnowledgeEntityType, id: string, raw: unknown, ctx: { actorId: string; at: Date; note?: string }): Promise<KnowledgeRow>;
export async function getKnowledgeItem(d: KnowledgeServiceDeps, type: KnowledgeEntityType, id: string): Promise<KnowledgeRow>;
export async function listKnowledgeItems(d: KnowledgeServiceDeps, type: KnowledgeEntityType, filter: { status?: KnowledgeStatus; lineId?: string; limit: number; cursor: string | null }): Promise<{ items: KnowledgeRow[]; nextCursor: string | null }>;
```

Limites de validação exatos (zod, por tipo; `slug`/`key`/`code` únicos → `KnowledgeError('conflict')`):

| tipo | campos e limites |
|---|---|
| `catalog_item` | `lineId` uuid obrigatório; `kind` enum do `catalog_kind`; `name` 1–120; `slug` `/^[a-z0-9]+(-[a-z0-9]+)*$/` 1–60; `summary` 1–500; `details` objeto ou null; `pricingMode` enum; `priceAmount` string `/^\d{1,12}(\.\d{1,2})?$/` — obrigatório em `fixed`/`from`, `null` obrigatório em `quote_only`; `currency` `/^[A-Z]{3}$/` default `AOA`; `priceNote` ≤300 ou null; `availability` enum default `available`; `validFrom`/`validUntil` ISO (com `validFrom ≤ validUntil`); `reviewEveryDays` 1–3650 default 90 |
| `knowledge_doc` | `lineId` uuid ou null; `type` enum do `doc_type`; `title` 1–150; `body` 1–20000; `validFrom`/`validUntil` como acima; `reviewEveryDays` 1–3650 default 90 |
| `rule` | `lineId` uuid ou null; `kind` enum do `rule_kind`; `title` 1–150; `instruction` 1–2000; `params` objeto ou null; `priority` −100..100 default 0 |
| `qualification_question` | `lineId` uuid obrigatório; `key` `/^[a-z][a-z0-9_]{0,40}$/`; `question` 1–300; `answerType` enum default `text`; `choices` 2–20 strings únicas — **obrigatório sse** `answerType='choice'`, senão null; `required` bool default false; `position` 0–999 |
| `handoff_trigger` | `lineId` uuid ou null; `code` `/^[a-z][a-z0-9_]{0,60}$/`; `description` 1–300; `detectionHint` 1–4000; `action` enum default `handoff_now`; `priority` enum default `normal`; `active` bool default true |

Regras de revisão (catálogo, documentos e regras — `knowledge_revisions.entity_type` `catalog_item | knowledge_doc | rule`): `insert` não escreve revisão (estado inicial = versão 1); `update` escreve `knowledge_revisions` com `version` = versão atual e `snapshot` = linha **antes** da alteração (comentário do schema: "snapshot = estado anterior"), depois incrementa (coluna `version` em `catalog_items`/`knowledge_docs`; em `rules`, que não tem coluna, a versão atual = `count(revisions) + 1`). Perguntas e gatilhos **não** são versionados (não têm `status`/`version` — CRUD + `active`).

**Steps:**

- [ ] Escrever `tests/unit/knowledge-validation.test.ts` falhado (casos exatos):

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCreate, parsePatch } from '../../src/modules/knowledge/validation.js';
import { KnowledgeError } from '../../src/modules/knowledge/errors.js';

const err = (fn: () => unknown) => { try { fn(); return null; } catch (e) { return e as KnowledgeError; } };
const catalogOk = { lineId: '00000000-0000-4000-8000-000000000001', kind: 'plan', name: 'Fast 10', slug: 'fast-10', summary: 'Plano de 10 Mbps', pricingMode: 'fixed', priceAmount: '25000.00' };

test('catálogo: válido passa; priceAmount não numérico e fixo sem preço falham', () => {
  assert.equal(err(() => parseCreate('catalog_item', catalogOk)), null);
  assert.equal(err(() => parseCreate('catalog_item', { ...catalogOk, priceAmount: '25.000,00 Kz' }))?.code, 'invalid_input');
  assert.equal(err(() => parseCreate('catalog_item', { ...catalogOk, priceAmount: null }))?.code, 'invalid_input'); // fixed exige preço
  assert.equal(err(() => parseCreate('catalog_item', { ...catalogOk, pricingMode: 'quote_only', priceAmount: '10.00' }))?.code, 'invalid_input'); // quote_only não leva preço
});
test('slug inválido, validade invertida e reviewEveryDays fora do intervalo falham', () => {
  assert.equal(err(() => parseCreate('catalog_item', { ...catalogOk, slug: 'Fast 10!' }))?.code, 'invalid_input');
  assert.equal(err(() => parseCreate('knowledge_doc', { type: 'faq', title: 'T', body: 'B', validFrom: '2026-10-10T00:00:00Z', validUntil: '2026-10-01T00:00:00Z' }))?.code, 'invalid_input');
  assert.equal(err(() => parseCreate('knowledge_doc', { type: 'faq', title: 'T', body: 'B', reviewEveryDays: 0 }))?.code, 'invalid_input');
});
test('pergunta: choices exigidas em choice e proibidas em text', () => {
  assert.equal(err(() => parseCreate('qualification_question', { lineId: '00000000-0000-4000-8000-000000000001', key: 'premise_type', question: 'Casa ou empresa?', answerType: 'choice' }))?.code, 'invalid_input');
  assert.equal(err(() => parseCreate('qualification_question', { lineId: '00000000-0000-4000-8000-000000000001', key: 'premise_type', question: 'Casa ou empresa?', answerType: 'choice', choices: ['casa', 'casa'] }))?.code, 'invalid_input'); // duplicada
  assert.equal(err(() => parseCreate('qualification_question', { lineId: '00000000-0000-4000-8000-000000000001', key: 'morada', question: 'Morada?', answerType: 'text', choices: ['a', 'b'] }))?.code, 'invalid_input');
});
test('patch sem campos e campos desconhecidos falham (sem mass assignment)', () => {
  assert.equal(err(() => parsePatch('knowledge_doc', {}))?.code, 'invalid_input');
  assert.equal(err(() => parsePatch('knowledge_doc', { ownerId: 'x' }))?.code, 'invalid_input');
});
```

- [ ] Correr `npm test -- tests/unit/knowledge-validation.test.ts` → **tem de falhar** (`Cannot find module …/validation.js`).
- [ ] Implementar `errors.ts`, `validation.ts` (5 esquemas zod + união por tipo; `parsePatch` = `.partial().refine(mínimo 1 campo)` sobre o mesmo esquema, campos `id/status/version/createdAt/updatedAt/ownerId` nunca aceites).
- [ ] Correr `npm test -- tests/unit/knowledge-validation.test.ts` → `4 pass`, `0 fail`.
- [ ] Escrever `tests/integration/knowledge-crud.test.ts` falhado (Postgres real; fixtures = `seedKnowledge` da Task 3):

```ts
test('criar → listar com cursor → atualizar escreve revisão e incrementa versão', async () => {
  const d = { db, audit };
  const doc = await createKnowledgeItem(d, 'knowledge_doc', { type: 'faq', title: 'FAQ inicial', body: 'Resposta A.' }, { actorId: USER, at: new Date('2026-10-07T10:00:00Z') });
  assert.equal((doc as typeof knowledgeDocs.$inferSelect).version, 1);
  const upd = await updateKnowledgeItem(d, 'knowledge_doc', doc.id, { body: 'Resposta B.' }, { actorId: USER, at: new Date('2026-10-07T11:00:00Z') });
  assert.equal((upd as typeof knowledgeDocs.$inferSelect).version, 2);
  const revs = await revisionsOf(doc.id);                     // [{ version: 1, snapshot.body: 'Resposta A.', changedById: USER }]
  assert.equal(revs.length, 1);
  assert.equal(revs[0].version, 1);
  assert.equal(revs[0].snapshot.body, 'Resposta A.');
  const page1 = await listKnowledgeItems(d, 'knowledge_doc', { limit: 1, cursor: null });
  assert.equal(page1.items.length, 1); assert.ok(page1.nextCursor);
  const page2 = await listKnowledgeItems(d, 'knowledge_doc', { limit: 1, cursor: page1.nextCursor });
  assert.equal(page2.items.length, 1); assert.notEqual(page2.items[0]!.id, page1.items[0]!.id);
});
test('slug duplicado é conflict e pedido inexistente é not_found', async () => {
  await createKnowledgeItem(d, 'catalog_item', catalogBody, { actorId: USER, at: new Date() });
  await assert.rejects(createKnowledgeItem(d, 'catalog_item', catalogBody, { actorId: USER, at: new Date() }),
    (e) => e instanceof KnowledgeError && e.code === 'conflict' && e.status === 409);
  await assert.rejects(getKnowledgeItem(d, 'catalog_item', NONE), (e) => e instanceof KnowledgeError && e.code === 'not_found' && e.status === 404);
});
test('regras versionam pela contagem de revisões (sem coluna version)', async () => {
  const r1 = await createKnowledgeItem(d, 'rule', { kind: 'discount_limit', title: 'Teto', instruction: 'Máximo 10%', params: { maxDiscountPct: 10 } }, ctx);
  await updateKnowledgeItem(d, 'rule', r1.id, { instruction: 'Máximo 5%' }, ctx);
  assert.equal(await currentVersion(d, 'rule', r1.id), 2);
  assert.equal((await revisionsOf(r1.id)).length, 1);
});
test('audit escreve knowledge.created e knowledge.updated com ator e hora', async () => {
  await createKnowledgeItem(d, 'knowledge_doc', { type: 'faq', title: 'T', body: 'B' }, ctx);
  await updateKnowledgeItem(d, 'knowledge_doc', id, { title: 'T2' }, ctx);
  assert.deepEqual(audit.calls.map((c) => c.action), ['knowledge.created', 'knowledge.updated']);
  assert.equal(audit.calls[1]!.actorId, ctx.actorId);
  assert.ok(audit.calls[1]!.at instanceof Date);
});
```

- [ ] Correr `npm run test:integration -- knowledge-crud` → **tem de falhar** (`Cannot find module …/service.js`).
- [ ] Implementar `repository.ts` (`db.transaction` em `update`: SELECT atual → INSERT revisão com estado anterior → UPDATE com `version + 1`/nova contagem; `list` com cursor `createdAt.getTime()+id` e ordem `createdAt DESC, id`; `find` devolve `null` em 0 linhas; o `service` acrescenta `ownerId: ctx.actorId` aos dados antes do INSERT onde a coluna é `NOT NULL` — `catalog_items.owner_id`, `knowledge_docs.owner_id`, `rules.owner_id` — e `knowledge_revisions.changedById` recebe sempre o ator; **nunca vêm do cliente**) e `service.ts` (parse → repo → `audit.record({ actorId, action: 'knowledge.created' | 'knowledge.updated', entity: 'knowledge_item', entityId: id, detail: { type }, at })`; `find` null → `KnowledgeError('not_found')`; slug/key duplicado → `conflict` via `UNIQUE` do Postgres (`catalog_items.slug`, `qualification_questions(line_id, key)`); `handoff_triggers` **não tem** UNIQUE no schema (o mesmo `code` pode existir em linhas diferentes) → na mesma transação, SELECT por `(lineId, code)` com `lineId IS NULL` como escopo global e `conflict` se existir; mensagem `detail` sem ecoar o valor integral).
- [ ] Correr `npm run test:integration -- knowledge-crud` → `pass`, `fail 0`; `npm test` → `fail 0`; `npm run typecheck && npm run lint` → sem erros.
- [ ] Commit: `feat: add knowledge crud with validation and revisions`.

---

### Task 7: Publicação, arquivamento e reversão (caso de uso em `application`)

**Files:**
- Create: `src/application/knowledge/publication.ts`
- Modify: `src/modules/knowledge/repository.ts` (acrescentar `publish`, `archive`, `revert` — transações com revisão)
- Test: `tests/unit/knowledge-publication.test.ts`, `tests/integration/knowledge-revisions.test.ts`

**Interfaces:**
- Consumes: `KnowledgeRepository` da Task 6; `JobQueue` (Fase 0); `AuditPort` (Fase 1); `knowledgeGaps` (Task 1).
- Produces:

```ts
// src/application/knowledge/publication.ts — só tipos estruturais, sem import de Drizzle (docs/02 §1)
export type PublishableEntityType = 'catalog_item' | 'knowledge_doc' | 'rule';
export interface PublicationItem { id: string; type: PublishableEntityType; status: KnowledgeStatus; version: number; validFrom: Date | null; validUntil: Date | null; }
export interface PublicationDeps {
  knowledge: {
    get(type: PublishableEntityType, id: string): Promise<PublicationItem | null>;
    publish(i: { type: PublishableEntityType; id: string; actorId: string; note: string | null; at: Date }): Promise<{ version: number }>;
    archive(i: { type: PublishableEntityType; id: string; actorId: string; note: string | null; at: Date }): Promise<{ version: number }>;
    revert(i: { type: PublishableEntityType; id: string; toVersion: number; actorId: string; note: string | null; at: Date }): Promise<{ version: number }>;
    findGap(gapId: string): Promise<{ id: string; status: 'open' | 'resolved' | 'ignored' } | null>;
  };
  jobs: { enqueue(name: string, payload: Record<string, unknown>, opts: { idempotencyKey: string; correlationId: string }): Promise<void> };
  audit: AuditPort;
}
export async function publishKnowledgeItem(d: PublicationDeps, i: { type: PublishableEntityType; id: string; actorId: string; note?: string; gapId?: string; correlationId: string; at: Date }): Promise<{ version: number; gapId: string | null }>;
export async function archiveKnowledgeItem(d: PublicationDeps, i: { type: PublishableEntityType; id: string; actorId: string; note?: string; correlationId: string; at: Date }): Promise<{ version: number }>;
export async function revertKnowledgeItem(d: PublicationDeps, i: { type: PublishableEntityType; id: string; toVersion: number; actorId: string; note?: string; correlationId: string; at: Date }): Promise<{ version: number }>;
```

Regras exatas (decisão, todas testadas):
1. `get` null → `KnowledgeError('not_found')`.
2. Transições: `publish` só de `draft|archived` → `published` (de `published` → `invalid_transition`); `archive` só de `published|draft` → `archived` (de `archived` → `invalid_transition`); `revert` só para `toVersion < version` e com revisão existente para `toVersion` (caso contrário `invalid_revert`); perguntas/gatilhos → `unsupported_entity`.
3. Validade: `validUntil !== null && validUntil <= at` → `expired_item` (409, `detail` cita `valid_until`) — não se publica item já fora de validade.
4. `gapId` presente: `findGap` null → `gap_not_found`; `status !== 'open'` → `gap_not_open`.
5. Sucesso = transação de publicação (revisão com estado anterior + `status` + `reviewed_at = at`) **depois**: `audit.record` (`knowledge.published`/`knowledge.archived`/`knowledge.reverted`, `detail` com `{ type, version, gapId? }`); se `type !== 'rule'` → `jobs.enqueue('knowledge.reindex', { entityType, entityId, version }, { idempotencyKey: 'knowledge.reindex:<type>:<id>:<version>', correlationId })` (regras não são embedadas); se `gapId` → `jobs.enqueue('knowledge.gap-suggestion', { gapId, entityType, entityId, version, actorId }, { idempotencyKey: 'knowledge.gap-suggestion:<gapId>:<type>:<id>:<version>', correlationId })`.
6. `revert` de catálogo/documento publicado → enfileira `knowledge.reindex` com a nova versão (o conteúdo pode ter mudado).

**Steps:**

- [ ] Escrever `tests/unit/knowledge-publication.test.ts` falhado (deps falsas em memória):

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { publishKnowledgeItem, archiveKnowledgeItem, revertKnowledgeItem } from '../../src/application/knowledge/publication.js';
import { KnowledgeError } from '../../src/modules/knowledge/errors.js';

function fakeDeps(item: Partial<PublicationItem> = {}, gap: { id: string; status: 'open' | 'resolved' | 'ignored' } | null = null) {
  const calls: Record<string, unknown[]> = { publish: [], archive: [], revert: [], audit: [], enqueue: [] };
  return {
    calls,
    deps: {
      knowledge: {
        get: async () => ({ id: 'i1', type: 'knowledge_doc' as const, status: 'draft' as const, version: 1, validFrom: null, validUntil: null, ...item }),
        publish: async (i: never) => { calls.publish.push(i); return { version: (item.version ?? 1) + 1 }; },
        archive: async (i: never) => { calls.archive.push(i); return { version: (item.version ?? 1) + 1 }; },
        revert: async (i: never) => { calls.revert.push(i); return { version: (item.version ?? 1) + 1 }; },
        findGap: async () => gap,
      },
      jobs: { enqueue: async (n: string, p: Record<string, unknown>, o: { idempotencyKey: string }) => { calls.enqueue.push({ n, p, o }); } },
      audit: { record: async (e: never) => { calls.audit.push(e); } },
    } satisfies PublicationDeps,
  };
}
const base = { type: 'knowledge_doc' as const, id: 'i1', actorId: 'u1', correlationId: 'c1', at: new Date('2026-10-07T12:00:00Z') };

test('publicar: transição + auditoria + reindex com chave por versão', async () => {
  const { deps, calls } = fakeDeps();
  const r = await publishKnowledgeItem(deps, base);
  assert.deepEqual(r, { version: 2, gapId: null });
  assert.deepEqual(calls.enqueue.map((e: any) => [e.n, e.o.idempotencyKey]), [['knowledge.reindex', 'knowledge.reindex:knowledge_doc:i1:2']]);
  assert.equal((calls.audit[0] as any).action, 'knowledge.published');
});
test('regras publicam sem reindex (não são embedadas)', async () => {
  const { deps, calls } = fakeDeps({ type: 'rule' });
  await publishKnowledgeItem(deps, { ...base, type: 'rule' });
  assert.equal(calls.enqueue.length, 0);
});
test('transições inválidas, item expirado e gap não aberto', async () => {
  assert.equal((await publishKnowledgeItem(fakeDeps({ status: 'published' }).deps, base).catch((e) => e)).code, 'invalid_transition');
  assert.equal((await publishKnowledgeItem(fakeDeps({ validUntil: new Date('2026-10-01T00:00:00Z') }).deps, base).catch((e) => e)).code, 'expired_item');
  assert.equal((await publishKnowledgeItem(fakeDeps({}, { id: 'g1', status: 'resolved' }).deps, { ...base, gapId: 'g1' }).catch((e) => e)).code, 'gap_not_open');
  assert.equal((await publishKnowledgeItem(fakeDeps({}, null).deps, { ...base, gapId: 'g1' }).catch((e) => e)).code, 'gap_not_found');
});
test('publicar com gapId abre também a fila knowledge.gap-suggestion', async () => {
  const { deps, calls } = fakeDeps({}, { id: 'g1', status: 'open' });
  const r = await publishKnowledgeItem(deps, { ...base, gapId: 'g1' });
  assert.equal(r.gapId, 'g1');
  const gapJob = (calls.enqueue as any[]).find((e) => e.n === 'knowledge.gap-suggestion');
  assert.equal(gapJob.o.idempotencyKey, 'knowledge.gap-suggestion:g1:knowledge_doc:i1:2');
  assert.deepEqual(gapJob.p, { gapId: 'g1', entityType: 'knowledge_doc', entityId: 'i1', version: 2, actorId: 'u1' });
});
test('reverter para a versão atual ou inexistente é invalid_revert; arquivar audita', async () => {
  assert.equal((await revertKnowledgeItem(fakeDeps({ version: 3 }).deps, { ...base, toVersion: 3 }).catch((e) => e)).code, 'invalid_revert');
  const { deps, calls } = fakeDeps({ status: 'published' });
  await archiveKnowledgeItem(deps, base);
  assert.equal((calls.audit[0] as any).action, 'knowledge.archived');
  assert.equal((calls.enqueue as any[])[0].n, 'knowledge.reindex');
});
```

- [ ] Correr `npm test -- tests/unit/knowledge-publication.test.ts` → **tem de falhar** (`Cannot find module …/publication.js`).
- [ ] Implementar `publication.ts` com as 6 regras acima (validação zod dos inputs, ordem: `get` → transição → validade → gap → transação → auditoria → enfileirar; um falha ⇒ nenhum efeito secundário). Os métodos `publish`/`archive`/`revert` do `repository.ts` são escritos no passo de integração abaixo (os testes de unidade correm com `PublicationDeps` falsas em memória).
- [ ] Correr `npm test -- tests/unit/knowledge-publication.test.ts` → `5 pass`, `0 fail`.
- [ ] Escrever `tests/integration/knowledge-revisions.test.ts` falhado (Postgres real): criar doc → publicar (via `publishKnowledgeItem` com deps reais: repo + fila falsa que grava + audit falso) → afirmar `status='published'`, `version=2`, `reviewed_at` = `at`, revisões `[{version:1, snapshot.status:'draft'}]`; alterar corpo → `version=3`, revisão `[{…},{version:2, snapshot.status:'published'}]`; `revertKnowledgeItem(toVersion=1)` → corpo original de volta, `version=4`, revisões `3`, e `status` mantido em `published` (reverte conteúdo, não a última transição de estado — registar este comportamento no README); reverte para `toVersion=99` (sem revisão) → `KnowledgeError('invalid_revert')` com `status` 409; a fila falsa registou `knowledge.reindex` com chave `knowledge.reindex:knowledge_doc:<id>:2` na publicação e `…:4` na reversão.
- [ ] Correr `npm run test:integration -- knowledge-revisions` → **tem de falhar** (`repo.publish is not a function` — os testes de unidade correram com deps falsas e o repositório real ainda não tem estes métodos).
- [ ] Implementar no `repository.ts` os métodos `publish`/`archive`/`revert` e `findGap(gapId)` (leitura pontual de `knowledge_gaps`, para o `PublicationDeps.knowledge` real da Task 8), cada um dos primeiros numa transação: SELECT atual → INSERT em `knowledge_revisions` com `version` = versão atual, `snapshot` = linha **antes** da alteração, `changedById = actorId`, `note` → UPDATE com `status`, `version + 1` e `reviewed_at = at` (só em `publish`); em `revert`, carregar o `snapshot` de `toVersion`, gravá-lo como estado atual e pôr `version = toVersion + 1`. Devolve `{ version }`, que `PublicationDeps.knowledge` consome.
- [ ] Correr `npm run test:integration -- knowledge-revisions` → `pass`, `fail 0`; `npm run typecheck && npm run lint` → sem erros (nenhum import de Drizzle em `publication.ts`).
- [ ] Commit: `feat: publish archive and revert knowledge with audit and jobs`.

---

### Task 8: API REST do conhecimento (RBAC `editor`/`admin`, erros RFC 9457)

**Files:**
- Create: `src/adapters/http/routes/knowledge.ts`
- Modify: `src/modules/knowledge/service.ts` (acrescentar `listKnowledgeRevisions`), arranque HTTP da Fase 1 (registar as rotas + schemas OpenAPI, mesmo padrão do plano da Fase 4 para `campaigns`)
- Test: `tests/integration/knowledge-api.test.ts`

**Interfaces:**
- Consumes: `createKnowledgeItem`/`updateKnowledgeItem`/`getKnowledgeItem`/`listKnowledgeItems` (Task 6), `publishKnowledgeItem`/`archiveKnowledgeItem`/`revertKnowledgeItem` (Task 7), guard de sessão + CSRF + `requireRole` e mapper RFC 9457 da Fase 1 (adaptar nomes), `buildTestApp()` de `tests/helpers/http.ts` (Fase 1).
- Produces:

```ts
// src/modules/knowledge/service.ts (acrescentado)
export async function listKnowledgeRevisions(d: KnowledgeServiceDeps, type: KnowledgeEntityType, id: string, opts: { limit: number }):
  Promise<{ items: { version: number; snapshot: Record<string, unknown>; changedById: string; note: string | null; createdAt: Date }[] }>;
// type fora de 'catalog_item' | 'knowledge_doc' | 'rule' → KnowledgeError('unsupported_entity')

// rotas — segmento :type → KnowledgeEntityType (segmento desconhecido → 400 unsupported_entity)
//   catalog | docs | rules | questions | triggers
GET    /v1/knowledge/:type?status=&lineId=&limit=20&cursor=      → 200 { items, nextCursor }  qualquer sessão
GET    /v1/knowledge/:type/:id                                   → 200 { item }               qualquer sessão
GET    /v1/knowledge/:type/:id/revisions?limit=20                → 200 { items }              qualquer sessão
POST   /v1/knowledge/:type                                       → 201 { item }               editor | admin
PATCH  /v1/knowledge/:type/:id                                   → 200 { item }               editor | admin
POST   /v1/knowledge/:type/:id/publish   body { note?, gapId? }  → 200 { version, gapId }     editor | admin
POST   /v1/knowledge/:type/:id/archive   body { note? }          → 200 { version }            editor | admin
POST   /v1/knowledge/:type/:id/revert    body { toVersion, note? } → 200 { version }          editor | admin
```

- Corpo do pedido validado com os **mesmos** zod da Task 6 (`parseCreate`/`parsePatch`); a rota só valida, chama o caso de uso e serializa (`docs/02` §1).
- `correlationId` dos jobs: cabeçalho `X-Correlation-Id` se for uuid válido, senão `randomUUID()` por pedido.
- Erros: `KnowledgeError` → problem+json no mapper único da Fase 1 (400/404/409 conforme o mapa da Task 6), `Content-Type: application/problem+json`.
- RBAC no servidor em cada pedido: `GET` = qualquer sessão autenticada; `POST`/`PATCH` = `requireRole(['editor', 'admin'])` (`agent` → 403).

**Steps:**

- [ ] Escrever `tests/integration/knowledge-api.test.ts` falhado (node:test + `buildTestApp()`; fixtures = `seedKnowledge` da Task 3):

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTestApp } from '../helpers/http.js';
import { seedKnowledge } from '../../src/modules/knowledge/seed.js';

const DOC_BODY = { type: 'faq', title: 'FAQ API', body: 'Resposta de teste.' };

test('RBAC: agent lê mas não escreve; sem sessão 401; sem CSRF 403', async () => {
  const app = await buildTestApp();
  await seedKnowledge(app.db);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/knowledge/docs' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/knowledge/docs', cookies: { session: app.sessions.agent } })).statusCode, 200);
  const asAgent = { cookies: { session: app.sessions.agent }, headers: { 'x-csrf-token': app.csrf.agent }, payload: DOC_BODY };
  assert.equal((await app.inject({ method: 'POST', url: '/v1/knowledge/docs', ...asAgent })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/knowledge/docs', cookies: { session: app.sessions.editor }, payload: DOC_BODY })).statusCode, 403); // CSRF em falta
});

test('editor cria, publica, reverte e lista revisões; transição inválida é 409 problem+json', async () => {
  const app = await buildTestApp();
  await seedKnowledge(app.db);
  const ed = { cookies: { session: app.sessions.editor }, headers: { 'x-csrf-token': app.csrf.editor } };
  const created = await app.inject({ method: 'POST', url: '/v1/knowledge/docs', ...ed, payload: DOC_BODY });
  assert.equal(created.statusCode, 201);
  const id = created.json().item.id;
  assert.equal(created.json().item.status, 'draft');
  const pub = await app.inject({
    method: 'POST', url: `/v1/knowledge/docs/${id}/publish`, ...ed,
    headers: { ...ed.headers, 'x-correlation-id': '00000000-0000-4000-8000-00000000c001' }, payload: {},
  });
  assert.equal(pub.statusCode, 200); assert.equal(pub.json().version, 2);
  const twice = await app.inject({ method: 'POST', url: `/v1/knowledge/docs/${id}/publish`, ...ed, payload: {} });
  assert.equal(twice.statusCode, 409);
  assert.match(twice.headers['content-type'], /application\/problem\+json/);
  const revs = await app.inject({ method: 'GET', url: `/v1/knowledge/docs/${id}/revisions`, cookies: { session: app.sessions.agent } });
  assert.equal(revs.statusCode, 200);
  assert.deepEqual(revs.json().items.map((r: { version: number }) => r.version), [1]);
  const back = await app.inject({ method: 'POST', url: `/v1/knowledge/docs/${id}/revert`, ...ed, payload: { toVersion: 1 } });
  assert.equal(back.statusCode, 200); assert.equal(back.json().version, 3);
  const bad = await app.inject({ method: 'GET', url: '/v1/knowledge/desconhecido', cookies: { session: app.sessions.agent } });
  assert.equal(bad.statusCode, 400);
});
```

- [ ] Correr `npm run test:integration -- knowledge-api` → **tem de falhar** (esperado: `404` — as rotas ainda não existem).
- [ ] Implementar `src/adapters/http/routes/knowledge.ts` conforme a tabela das Interfaces (mapeamento `:type`, zod da Task 6, `requireRole(['editor','admin'])` nas mutações, `correlationId` do cabeçalho ou `randomUUID()`, `KnowledgeError` → problem+json no mapper da Fase 1), acrescentar `listKnowledgeRevisions` ao `service.ts` e registar as rotas no arranque HTTP (OpenAPI gerado do código). Deps reais: `KnowledgeServiceDeps = { db, audit }`; `PublicationDeps = { knowledge: createKnowledgeRepository(db) /* get, publish, archive, revert, findGap */, jobs: JobQueue da Fase 0, audit }`.
- [ ] Correr `npm run test:integration -- knowledge-api` → `2 pass`, `0 fail`; `npm test` → `fail 0`; `npm run typecheck && npm run lint` → sem erros.
- [ ] Commit: `feat: expose knowledge rest api with editor rbac`.

---

### Task 9: Ciclo de lacunas A9 — registo, sugestões e aprovação humana

**Files:**
- Create: `src/modules/knowledge/gaps.ts`, `src/modules/knowledge/suggestions.ts`, `src/adapters/http/routes/knowledge-gaps.ts`
- Test: `tests/unit/gap-normalization.test.ts`, `tests/integration/knowledge-gaps-suggestions.test.ts`

**Interfaces:**
- Consumes: schema `knowledgeGaps`/`knowledgeSuggestions`/`answerTraces` (Task 1), `KnowledgeRepository` + `findGap` (Tasks 6–7), `publishKnowledgeItem` (Task 7), `JobQueue` (Fase 0), `AuditPort` e outbox da Fase 1, `LineSlug` de `src/ports/ai-provider.ts` (referência), A9 de `docs/06` + ADR-0004.
- Produces:

```ts
// src/modules/knowledge/gaps.ts
export function normalizeGapQuestion(question: string): string;
// fórmula EXATA: question.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim()
// — mesma fórmula do normalize de reference/keyword-safety-net.ts (linhas 11-15); citar ficheiro:linha no relatório
export async function recordGap(db: PgDatabase, g: { question: string; conversationId: string; line: LineSlug | null }, at: Date):
  Promise<{ id: string; occurrences: number }>;
export async function listGaps(db: PgDatabase, f: { status?: 'open' | 'resolved' | 'ignored'; limit: number; cursor: string | null }):
  Promise<{ items: { id: string; question: string; normalizedQuestion: string; occurrences: number; conversationId: string | null; lineId: string | null; status: string; createdAt: Date; lastSeenAt: Date }[]; nextCursor: string | null }>;

// src/modules/knowledge/suggestions.ts
export interface SuggestionDeps {
  db: PgDatabase;
  outbox: { enqueue(i: { accountId: string; contactId: string; conversationId: string; sender: 'human'; text: string;
                         idempotencyKey: string; scheduledAt?: Date }): Promise<{ outboxId: string; duplicate: boolean }> };
  audit: AuditPort;
}
export async function createSuggestion(d: SuggestionDeps, i: {
  kind: 'knowledge'; humanAnswer: string; proposedTitle: string; proposedBody: string;
  gapId?: string | null; conversationId?: string | null; messageId?: string | null;
  aiAnswer?: string | null; targetDocId?: string | null; actorId: string; at: Date;
}): Promise<{ id: string }>;
export async function proposeKnowledgeSuggestion(d: SuggestionDeps, i: {
  gapId: string; entityType: 'catalog_item' | 'knowledge_doc'; entityId: string; version: number;
  actorId: string; at: Date;
}): Promise<{ suggestionId: string | null }>;
export async function approveSuggestion(d: SuggestionDeps, i: { id: string; actorId: string; note?: string; at: Date }):
  Promise<{ suggestionId: string; outboxId: string | null; docId: string | null }>;
export async function rejectSuggestion(d: SuggestionDeps, i: { id: string; actorId: string; note?: string; at: Date }):
  Promise<{ suggestionId: string }>;
export function registerSuggestionJobs(jobs: JobQueue, d: SuggestionDeps): Promise<void>; // handler de 'knowledge.gap-suggestion'

// rotas (src/adapters/http/routes/knowledge-gaps.ts; estáticas antes de :type da Task 8)
GET  /v1/knowledge/gaps?status=open&limit=20&cursor=   → 200 { items, nextCursor }  qualquer sessão
POST /v1/knowledge/gaps                                → 201 { gap }               editor | admin  body { question, conversationId?, lineSlug? }
GET  /v1/knowledge/suggestions?status=pending          → 200 { items, nextCursor }  qualquer sessão
POST /v1/knowledge/suggestions                         → 201 { suggestion }         editor | admin  body { humanAnswer, proposedTitle, proposedBody, gapId?, conversationId?, messageId?, aiAnswer?, targetDocId? }
POST /v1/knowledge/suggestions/:id/approve             → 200 { suggestion, outboxId, docId }  editor | admin
POST /v1/knowledge/suggestions/:id/reject              → 200 { suggestion }         editor | admin
```

Regras exatas (todas testadas):
1. `recordGap`: `normalized` vazio → `KnowledgeError('invalid_input')`; SELECT `status = 'open'` com `normalized_question = normalized` (mais antigo) → se existir, `occurrences + 1`, `last_seen_at = at` e **`conversationId`/`lineId` mantêm-se** (a sugestão A9 vai para a conversa original); senão INSERT com `status = 'open'` e `lineId` = lookup de `business_lines.slug` (slug desconhecido ou `line` `null` → `lineId` `null` — lacuna nunca se perde por falta de linha). Lacunas `resolved`/`ignored` não reabrem: uma repetição depois de resolvida cria linha nova (sinal de que o conhecimento publicado não cobriu a pergunta).
2. `proposeKnowledgeSuggestion` (handler do job, payload zod `{ gapId, entityType, entityId, version, actorId }`): `findGap` null → erro permanente `knowledge gap not found: <id>`; já existe sugestão para `(gapId, entityId)` → devolve a existente (**idempotente por reexecução**); gap sem `conversationId` → devolve `{ suggestionId: null }` (não há conversa para onde responder); caso contrário, numa transação: (a) `answer_traces` `{ conversationId: gap.conversationId, isTest: false, question: gap.question, answer: proposedBody, sources: [{ type: 'doc'|'catalog', id: entityId, version, score: 1 }], model: 'knowledge-gap' }`; (b) `knowledge_suggestions` `kind: 'reply'`, `gapId`, `conversationId`, `proposedTitle`/`proposedBody` da fonte publicada (`knowledge_doc` → `title`/`body`; `catalog_item` → `name`/`summary` + `\n` + `priceNote` se existir), `humanAnswer: null`, `answerTraceId`, `status: 'pending'`. **Zero** linhas na outbox aqui (A9: só após aprovação).
3. `approveSuggestion`: `not found` → `not_found` (404); `status !== 'pending'` → `suggestion_invalid_state` (409). `kind 'reply'` → transação (sugestão `approved` + `reviewedById`/`reviewedAt` + gap → `resolved` com `resolvedById`/`resolvedAt`) **depois** `outbox.enqueue({ accountId, contactId, conversationId, sender: 'human', text: proposedBody, idempotencyKey: 'suggestion:<id>' })` (`accountId`/`contactId` vêm da conversa associada à sugestão — a forma é a da Fase 1 Task 17) + `audit` `knowledge.suggestion.approved`. `kind 'knowledge'` → transação (sugestão `approved` + gap resolvido se `gapId` + com `targetDocId` → `repository.update('knowledge_doc', targetDocId, { title, body })` que escreve revisão; sem `targetDocId` → `repository.insert('knowledge_doc', { type: 'faq', title: proposedTitle, body: proposedBody, lineId, ownerId: actorId })` em `status: 'draft'`) + `audit` `knowledge.suggestion.approved`; **nunca** outbox e **nunca** publica sozinho (a publicação é o passo da Task 7).
4. `rejectSuggestion`: `rejected` + `reviewedById`/`reviewedAt` + `audit` `knowledge.suggestion.rejected`; gap e outbox intactos.
5. `createSuggestion` valida por tipo: `humanAnswer` 1–4000, `proposedTitle` 1–150, `proposedBody` 1–20000 obrigatórios; uuids opcionais validados; `targetDocId` tem de existir (`not_found`).

**Steps:**

- [ ] Escrever `tests/unit/gap-normalization.test.ts` falhado:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeGapQuestion } from '../../src/modules/knowledge/gaps.js';

test('minúsculas, sem acentos e trim — mesma fórmula da rede de segurança', () => {
  assert.equal(normalizeGapQuestion('  Como é o PREÇO?  '), 'como e o preco?');
  assert.equal(normalizeGapQuestion('Como é o preço?'), normalizeGapQuestion(' COMO É O PREÇO? '));
  assert.equal(normalizeGapQuestion('com  poço'), 'com  poço');   // espaço interno não é colapsado (fórmula da referência)
  assert.equal(normalizeGapQuestion('   '), '');
});
```

- [ ] Correr `npm test -- tests/unit/gap-normalization.test.ts` → **tem de falhar** (`Cannot find module …/gaps.js`).
- [ ] Implementar `gaps.ts` (`normalizeGapQuestion` com a fórmula exata acima; `recordGap` com a regra 1; `listGaps` com cursor `createdAt.getTime()+id`, ordem `occurrences DESC, createdAt DESC` — "ordenadas por frequência", `docs/05` §5).
- [ ] Correr `npm test -- tests/unit/gap-normalization.test.ts` → `4 pass`, `0 fail`.
- [ ] Escrever `tests/integration/knowledge-gaps-suggestions.test.ts` falhado (Postgres real; fila falsa que grava payloads; audit falso; outbox falso):

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { recordGap } from '../../src/modules/knowledge/gaps.js';
import { proposeKnowledgeSuggestion, approveSuggestion, rejectSuggestion, registerSuggestionJobs } from '../../src/modules/knowledge/suggestions.js';

test('recordGap agrupa por pergunta normalizada e guarda a conversa original', async () => {
  const a = await recordGap(db, { question: 'Como funciona a instalação?', conversationId: CONV1, line: 'telecom' }, T1);
  const b = await recordGap(db, { question: 'COMO  funciona  a instalação?', conversationId: CONV2, line: 'telecom' }, T2);
  assert.equal(b.id, a.id); assert.equal(b.occurrences, 2);           // mesma linha (trim + minúsculas + acentos)
  const row = await gapRow(a.id);
  assert.equal(row.conversation_id, CONV1);                            // conversa original preservada
  assert.ok(row.line_id);
  const c = await recordGap(db, { question: 'Onde fica o armazém?', conversationId: CONV3, line: 'nlinha' as LineSlug }, T1);
  assert.equal((await gapRow(c.id)).line_id, null);                    // slug desconhecido não perde a lacuna
});

test('A9: publicar com gapId cria UMA sugestão pendente e ZERO linhas na outbox; aprovação é que envia', async () => {
  const gap = await recordGap(db, { question: 'Têm suporte 24 horas?', conversationId: CONV1, line: 'telecom' }, T1);
  await publishKnowledgeItem(realDeps, { ...publishBase, gapId: gap.id });          // Task 7 enfileira
  assert.deepEqual(queue.enqueued.map((e) => e.name), ['knowledge.reindex', 'knowledge.gap-suggestion']);
  await handler(queue.payloadOf('knowledge.gap-suggestion'));                        // corre o job
  await handler(queue.payloadOf('knowledge.gap-suggestion'));                        // reexecução
  const sugs = await suggestionsOf(gap.id);
  assert.equal(sugs.length, 1);                                                       // idempotente
  assert.equal(sugs[0].kind, 'reply'); assert.equal(sugs[0].status, 'pending');
  assert.equal(await countOutbox(), 0);                                               // NUNCA envia sem aprovação
  const trace = await traceRow(sugs[0].answer_trace_id);
  assert.deepEqual(trace.sources, [{ type: 'doc', id: DOC, version: 2, score: 1 }]);
  const r = await approveSuggestion(deps, { id: sugs[0].id, actorId: USER, at: T3 });
  assert.equal(await countOutbox(), 1);
  const out = await outboxRow(0);
  assert.equal(out.idempotencyKey, `suggestion:${sugs[0].id}`); assert.equal(out.sender, 'human');
  assert.equal((await gapRow(gap.id)).status, 'resolved');
  await assert.rejects(approveSuggestion(deps, { id: sugs[0].id, actorId: USER, at: T4 }),
    (e) => e.code === 'suggestion_invalid_state' && e.status === 409);                // duplo clique não reenvia
});

test('correção humana: criar → aprovar materializa doc rascunho; rejeitar não toca no gap', async () => {
  const created = await createSuggestion(deps, { kind: 'knowledge', humanAnswer: 'Sim, 24 horas.', proposedTitle: 'Suporte', proposedBody: 'Suporte 24 horas por telefone e WhatsApp.', conversationId: CONV1, actorId: USER, at: T1 });
  const approved = await approveSuggestion(deps, { id: created.id, actorId: USER, at: T2 });
  assert.equal(approved.outboxId, null);
  const doc = await docRow(approved.docId!);
  assert.equal(doc.status, 'draft'); assert.equal(doc.body, 'Suporte 24 horas por telefone e WhatsApp.');
  const g = await recordGap(db, { question: 'Qual o prazo de entrega?', conversationId: CONV1, line: 'custom' }, T1);
  const s2 = await createSuggestion(deps, { kind: 'knowledge', humanAnswer: '3 dias úteis.', proposedTitle: 'Prazo', proposedBody: 'Prazo médio de 3 dias úteis.', gapId: g.id, actorId: USER, at: T1 });
  await rejectSuggestion(deps, { id: s2.id, actorId: USER, at: T2 });
  assert.equal((await gapRow(g.id)).status, 'open');                                  // gap só fecha na aprovação
  const before = await countOutbox();
  await approveSuggestion(deps, { id: created.id, actorId: USER, at: T3 }).catch(() => {}); // já aprovada: 409, nada muda
  assert.equal(await countOutbox(), before);                                          // kind 'knowledge' nunca põe nada na outbox
});
```

- [ ] Correr `npm run test:integration -- knowledge-gaps-suggestions` → **tem de falhar** (`Cannot find module …/suggestions.js`).
- [ ] Implementar `suggestions.ts` com as regras 2–5 (`db.transaction` em cada transação; fora da transação só o `outbox.enqueue`, para que falha de envio nunca deixe registo aprovado sem tentativa — se o enqueue falhar, o erro sobe e a fila da Fase 0 reintenta), `registerSuggestionJobs` (zod do payload, handler resistente a reexecução pela regra 2) e `src/adapters/http/routes/knowledge-gaps.ts` (rotas da Interfaces; conversa `lineSlug` → `lineId` como em `recordGap`; `KnowledgeError` → problem+json).
- [ ] Correr `npm run test:integration -- knowledge-gaps-suggestions` → `3 pass`, `0 fail`; `npm test` → `fail 0`; `npm run typecheck && npm run lint` → sem erros.
- [ ] No relatório: registar (a) a fórmula de normalização é a de `reference/keyword-safety-net.ts` e a Fase 3 Task 16 tem de delegar nela; (b) lacuna resolvida só na aprovação da sugestão (decisão do plano — docs não fixam quando `knowledge_gaps.status` muda); (c) `sender: 'human'` na outbox, dentro do vocabulário `message_sender` de `docs/01` §6.
- [ ] Commit: `feat: close the knowledge gap cycle with human approved suggestions`.

---

### Task 10: Sweep de validade + alertas de itens por rever

**Files:**
- Create: `src/domain/knowledge/sweep-schedule.ts`, `src/modules/knowledge/sweep.ts`, `tests/unit/knowledge-sweep.test.ts`
- Modify: `src/infra/main.ts` (registar o job e enfileirar a primeira execução no arranque), `src/adapters/http/routes/knowledge.ts` (acrescentar `GET /v1/knowledge/review-due`)
- Test: `tests/integration/knowledge-sweep.test.ts`

**Interfaces:**
- Consumes: `JobQueue` (Fase 0; `enqueue(name, payload, { idempotencyKey, correlationId, delayMs? })`), tabelas `knowledge_chunks`/`catalog_items`/`knowledge_docs` (Tasks 1 e 4), `docs/05` §5 ("itens por rever geram alerta", `valid_from`/`valid_until`, `reviewed_at` + `review_every_days`).
- Produces:

```ts
// src/domain/knowledge/sweep-schedule.ts (puro, sem I/O; Africa/Luanda = UTC+1 sem DST)
export function luandaDateKey(at: Date): string;                       // 'YYYY-MM-DD' na hora local de Luanda
export interface SweepRun { dateKey: string; at: Date; delayMs: number; idempotencyKey: string; }
export function nextSweepRun(at: Date): SweepRun;                      // próxima meia-noite de Luanda DEPOIS de `at`
export function sweepIdempotencyKey(dateKey: string): string;          // `knowledge.sweep:${dateKey}`

// src/modules/knowledge/sweep.ts
export interface SweepDeps { db: PgDatabase; log: { info(e: Record<string, unknown>, m: string): void }; }
export interface ReviewDueItem { type: 'catalog_item' | 'knowledge_doc'; id: string; title: string; reviewedAt: Date | null; dueAt: Date; }
export async function listReviewDue(d: { db: PgDatabase }, i: { at: Date; limit: number }): Promise<{ items: ReviewDueItem[] }>;
export async function runKnowledgeSweep(d: SweepDeps, i: { at: Date }): Promise<{ reactivated: number; deactivated: number; reviewDue: number }>;
export async function registerSweepJob(jobs: JobQueue, d: SweepDeps): Promise<void>;   // handler de 'knowledge.sweep'
```

Regras exatas:
1. `at` de referência da query de revisão: `dueAt = COALESCE(reviewed_at, created_at) + review_every_days * 1 dia`; item em revisão ⇔ `status = 'published'` **e** `dueAt <= at` (só `catalog_items` e `knowledge_docs` têm `review_every_days`; `rules` não — não entram).
2. Validade nos chunks (SQL parametrizado, nunca embedar): `deactivate` = chunks `active = true` cujo pai **não** está publicado ou fora de `valid_from ≤ at < valid_until` → `active = false` (`RETURNING` conta as linhas); `reactivate` = chunks `active = false` cujo pai está publicado e válido → `active = true`. **Nenhum chunk é apagado nem re-embedado** (a reativação é barata, Task 4); sweep **não** cria chunks para itens publicados sem reindex — isso é da publicação.
3. Alerta: `runKnowledgeSweep` chama `listReviewDue` e emite `log.info({ event: 'knowledge.review_due', count, dueIds, sweepAt }, 'knowledge items due for review')` (pino; é o alerta desta fase — não há tabela de notificações nem evento Socket.IO para isto, `docs/01` §9 limita os eventos a cinco) e devolve `reviewDue`. O mesmo dado é consultável em `GET /v1/knowledge/review-due?limit=50` (qualquer sessão).
4. Agendamento: `registerSweepJob` trata `payload { dateKey }` validado com zod; **no fim** de cada execução enfileira `nextSweepRun(at)` com `delayMs` e `idempotencyKey` — o BullMQ usa a chave como `jobId` (Fase 0), portanto **o mesmo dia Luanda corre uma vez**. `src/infra/main.ts` regista o handler e, no arranque, enfileira `knowledge.sweep` com `idempotencyKey = sweepIdempotencyKey(luandaDateKey(new Date()))` e `correlationId: 'startup'`.

**Steps:**

- [ ] Escrever `tests/unit/knowledge-sweep.test.ts` falhado:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { luandaDateKey, nextSweepRun, sweepIdempotencyKey } from '../../src/domain/knowledge/sweep-schedule.js';

test('chave do dia e próxima meia-noite de Luanda em UTC', () => {
  assert.equal(luandaDateKey(new Date('2026-10-07T12:00:00Z')), '2026-10-07');  // 13:00 locais
  assert.equal(luandaDateKey(new Date('2026-10-07T22:30:00Z')), '2026-10-07');  // 23:30 locais
  assert.equal(luandaDateKey(new Date('2026-10-07T23:30:00Z')), '2026-10-08');  // 00:30 locais
  assert.equal(luandaDateKey(new Date('2026-10-07T23:00:00Z')), '2026-10-08');  // meia-noite exata já é dia seguinte
  const run = nextSweepRun(new Date('2026-10-07T12:00:00Z'));
  assert.equal(run.dateKey, '2026-10-08');
  assert.equal(run.at.toISOString(), '2026-10-07T23:00:00.000Z');
  assert.equal(run.delayMs, 11 * 3600_000);
  assert.equal(run.idempotencyKey, 'knowledge.sweep:2026-10-08');
  assert.equal(sweepIdempotencyKey('2026-10-07'), 'knowledge.sweep:2026-10-07');
});
test('duas chamadas no mesmo dia Luanda dão a MESMA chave — a fila deduplica', () => {
  assert.equal(
    sweepIdempotencyKey(luandaDateKey(new Date('2026-10-07T01:00:00Z'))),
    sweepIdempotencyKey(luandaDateKey(new Date('2026-10-07T20:00:00Z'))),
  );
  const next = nextSweepRun(new Date('2026-10-07T23:00:00Z'));
  assert.equal(next.delayMs, 24 * 3600_000);                                   // das 23:00Z às 23:00Z seguintes
});
```

- [ ] Correr `npm test -- tests/unit/knowledge-sweep.test.ts` → **tem de falhar** (`Cannot find module …/sweep-schedule.js`).
- [ ] Implementar `sweep-schedule.ts` (`Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Luanda' })` para a data local; meia-noite local = data+1 a `00:00` local = `23:00Z` do dia Luanda anterior; `delayMs = at2 - at` nunca negativo).
- [ ] Correr `npm test -- tests/unit/knowledge-sweep.test.ts` → `2 pass`, `0 fail`.
- [ ] Escrever `tests/integration/knowledge-sweep.test.ts` falhado (Postgres real; log falso que grava linhas):

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { runKnowledgeSweep, registerSweepJob, listReviewDue } from '../../src/modules/knowledge/sweep.js';

const AT = new Date('2026-10-07T12:00:00Z');

test('expiração desativa chunks sem os apagar; validade futura volta a ativar', async () => {
  const doc = await publishedDocWithChunks({ validUntil: '2026-10-01T00:00:00Z' });   // já expirado
  const n = (await chunksOf(doc)).length;
  const r1 = await runKnowledgeSweep(deps, { at: AT });
  assert.ok(r1.deactivated >= 1);
  assert.ok((await chunksOf(doc)).every((c) => !c.active));
  assert.equal((await chunksOf(doc)).length, n);                                       // nunca apagados
  await sql(`UPDATE knowledge_docs SET valid_until = NULL WHERE id = '${doc}'`);
  const r2 = await runKnowledgeSweep(deps, { at: AT });
  assert.ok(r2.reactivated >= 1);
  assert.ok((await chunksOf(doc)).every((c) => c.active));                             // reativação sem re-embed
});

test('itens por rever: query, log de alerta e endpoint', async () => {
  const old = await publishedDoc({ reviewedAt: '2026-07-01T00:00:00Z', reviewEveryDays: 90 });   // vencido a 2026-09-29
  const fresh = await publishedDoc({ reviewedAt: '2026-10-01T00:00:00Z', reviewEveryDays: 90 });
  const r = await runKnowledgeSweep(deps, { at: AT });
  assert.equal(r.reviewDue, 1);
  assert.equal(log.lines.filter((l) => l.event === 'knowledge.review_due').length, 1);
  assert.deepEqual(log.lines.at(-1)!.dueIds, [old]);
  const due = await listReviewDue({ db }, { at: AT, limit: 50 });
  assert.equal(due.items.length, 1);
  assert.equal(due.items[0]!.id, old);
  assert.equal(due.items[0]!.dueAt.toISOString(), '2026-09-29T00:00:00.000Z');
  assert.equal((await app.inject({ method: 'GET', url: '/v1/knowledge/review-due', cookies: { session: app.sessions.agent } })).statusCode, 200);
});

test('handler agenda a próxima execução com a chave do dia seguinte', async () => {
  const handlers = new Map<string, Function>();
  await registerSweepJob(queueThatRecords(handlers), deps);
  assert.ok(handlers.has('knowledge.sweep'));
  await handlers.get('knowledge.sweep')!({ dateKey: '2026-10-07' });
  assert.equal(enqueued.at(-1)!.name, 'knowledge.sweep');
  assert.equal(enqueued.at(-1)!.opts.idempotencyKey, 'knowledge.sweep:2026-10-08');   // mesmo dia → mesma chave
});
```

- [ ] Correr `npm run test:integration -- knowledge-sweep` → **tem de falhar** (`Cannot find module …/sweep.js`).
- [ ] Implementar `sweep.ts` com as regras 1–4 (SQL parametrizado, `COALESCE(reviewed_at, created_at)`, os dois `UPDATE … RETURNING`, alerta pelo `d.log` injetado, agendamento da próxima execução no fim do handler) e ligar em `src/infra/main.ts` (regra 4); acrescentar `GET /v1/knowledge/review-due` ao `routes/knowledge.ts` da Task 8 (só leitura, qualquer sessão).
- [ ] Correr `npm run test:integration -- knowledge-sweep` → `3 pass`, `0 fail`; `npm test` → `fail 0`; `npm run typecheck && npm run lint` → sem erros.
- [ ] No relatório: registar que o "alerta" desta fase é log estruturado + endpoint (não existe tabela de notificações nem evento Socket.IO próprio; `docs/01` §9 limita os eventos a cinco) — se o dono quiser alerta persistente, é decisão para a Fase 5 (observabilidade).
- [ ] Commit: `feat: sweep knowledge validity and alert on reviews due`.

---

### Task 11: Chat de teste com fontes e sem efeitos colaterais

**Files:**
- Create: `src/modules/knowledge/traces.ts`, `src/modules/knowledge/test-chat.ts`
- Modify: `src/adapters/http/routes/knowledge.ts` (acrescentar `POST /v1/knowledge/test-chat`)
- Test: `tests/integration/knowledge-test-chat.test.ts`

**Interfaces:**
- Consumes: `EmbeddingsProvider.embedQuery` (Task 2), `searchChunks` (Task 5), `KnowledgeConfig.retrieval` (Task 2), `answerTraces` (Task 1), `buildTestApp()` (Fase 1), `docs/05` §5 ("chat de teste … vê que fontes usou … não gera handoffs, lacunas nem notificações").
- Produces:

```ts
// src/modules/knowledge/traces.ts
export interface TraceSource { type: 'doc' | 'catalog' | 'chunk' | 'rule'; id: string; version?: number; score?: number; }
export interface TraceInput {
  conversationId: string | null; messageId: string | null; isTest: boolean;
  question: string; answer: string; sources: readonly TraceSource[];
  model: string; latencyMs: number | null;
}
export async function saveAnswerTrace(db: PgDatabase, t: TraceInput): Promise<{ id: string }>;

// src/modules/knowledge/test-chat.ts — STUB determinístico, sem AIProvider (é a Fase 3, Task 17, que o troca)
export interface TestChatDeps { db: PgDatabase; embeddings: EmbeddingsProvider; config: KnowledgeConfig; }
export interface TestChatResult {
  reply: string | null;
  sources: { type: 'doc' | 'catalog'; id: string; version: number; score: number }[];
  traceId: string;
}
export async function runTestChat(d: TestChatDeps, i: { text: string; at: Date }): Promise<TestChatResult>;

// rota
POST /v1/knowledge/test-chat   body { text: 1–2000 }  → 200 { reply, sources, traceId }   qualquer sessão autenticada
```

Comportamento exato (deps não incluem orquestrador, outbox, audit nem notify — os efeitos colaterais são impossíveis por construção):
1. zod no `text` (trim, 1–2000) → `invalid_input` vazio.
2. `embedQuery(text)` → `searchChunks(db, v, { limit: config.retrieval.topK, minSimilarity: config.retrieval.minSimilarity })`.
3. `reply = hits[0]?.content ?? null` (stub: responde com o topo; sem fonte, `null`).
4. `sources = hits.map(h => ({ type: h.source, id: h.docId ?? h.catalogItemId, version: h.version, score: h.similarity }))`.
5. `saveAnswerTrace({ isTest: true, question: text, answer: reply ?? '', sources, model: 'stub:' + embeddings.model, conversationId: null, messageId: null, latencyMs })`.
6. **Zero** handoffs, **zero** lacunas, **zero** notificações, **zero** linhas na outbox, `handleInbound` nunca é chamado.

**Steps:**

- [ ] Escrever `tests/integration/knowledge-test-chat.test.ts` falhado (Postgres real + `fakeEmbeddings`; `config` de teste `{ retrieval: { topK: 5, minSimilarity: 0.1 }, … }` — o corte de similaridade real é da Task 5):

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { runTestChat } from '../../src/modules/knowledge/test-chat.js';
import { fakeEmbeddings } from '../helpers/fake-embeddings.js';

test('devolve a fonte do topo, grava trace isTest e não tem efeitos colaterais', async () => {
  const doc = await publishedDoc({ title: 'Planos de internet', body: 'Fast 10: 10 Mbps por 25.000 Kz.' });
  const r = await runTestChat(deps, { text: 'Qual é o plano de internet?', at: AT });
  assert.ok(r.reply !== null && r.reply.includes('Fast 10'));
  assert.deepEqual(r.sources.map((s) => s.id), [doc]);
  const trace = await traceRow(r.traceId);
  assert.equal(trace.is_test, true);
  assert.equal(trace.model, 'stub:fake');
  assert.deepEqual(trace.sources, r.sources);
  assert.equal(trace.question, 'Qual é o plano de internet?');
  assert.equal(await countHandoffs(), 0);
  assert.equal(await countGaps(), 0);
  assert.equal(await countOutbox(), 0);
  assert.equal(await countTracesWhere({ isTest: false }), 0);      // nenhum trace de produção
});

test('sem conhecimento publicado: reply null, fontes vazias, trace igualmente gravado', async () => {
  const r = await runTestChat(deps, { text: 'assunto sem fonte nenhuma xyz', at: AT });
  assert.equal(r.reply, null);
  assert.deepEqual(r.sources, []);
  assert.equal((await traceRow(r.traceId)).answer, '');
});

test('rota: qualquer papel autenticado, 401 sem sessão, corpo inválido 400', async () => {
  const app = await buildTestApp();
  const url = '/v1/knowledge/test-chat';
  assert.equal((await app.inject({ method: 'POST', url, payload: { text: 'olá' } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url, cookies: { session: app.sessions.agent }, payload: { text: 'olá' } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url, cookies: { session: app.sessions.agent }, payload: { text: '' } })).statusCode, 400);
});
```

- [ ] Correr `npm run test:integration -- knowledge-test-chat` → **tem de falhar** (`Cannot find module …/test-chat.js`).
- [ ] Implementar `traces.ts` (INSERT direto, SQL parametrizado) e `test-chat.ts` (comportamento 1–6; a app de teste injeta `fakeEmbeddings` no arranque de teste); acrescentar a rota ao `routes/knowledge.ts` (zod, qualquer sessão autenticada, sem `requireRole`, sem audit).
- [ ] Correr `npm run test:integration -- knowledge-test-chat` → `3 pass`, `0 fail`; `npm test` → `fail 0`; `npm run typecheck && npm run lint` → sem erros.
- [ ] No relatório: registar como decisão a confirmar — o stub responde com o conteúdo do topo (docs só exigem "mostra as fontes"), e o chat está disponível a `agent`/`editor`/`admin` (não muta conhecimento; escreve só o seu `answer_trace`).
- [ ] Commit: `feat: add test chat with sources and no side effects`.

---

### Task 12: README do módulo, notas em `docs/05` e suite completa

**Files:**
- Create: `src/modules/knowledge/README.md`
- Modify: `docs/05-ia-conhecimento-handoff.md` §7 (nota de rodapé com o seed implementado)
- Test: nenhum novo — correr a suite toda e colar o output no relatório.

**Interfaces:**
- Consumes: tudo das Tasks 1–11.
- Produces: `src/modules/knowledge/README.md` com exatamente estes pontos: (1) responsabilidade do módulo e fronteiras (o que fica em `domain`/`application`); (2) as 12 tabelas e os estados `draft → published → archived`, `pending → approved|rejected`, `open → resolved|ignored`; (3) revisões e reversão (incluindo "revert não muda o `status`"); (4) port `EmbeddingsProvider` + adaptador local + fake, e a proibição de download (modelo no volume); (5) as 6 chaves de config com defaults; (6) jobs `knowledge.reindex`, `knowledge.gap-suggestion`, `knowledge.sweep` com os padrões de `idempotencyKey` exatos; (7) rotas REST e matriz RBAC; (8) seeds (`npx tsx scripts/seed-knowledge.ts` após migrações) e a tabela das 15 perguntas; (9) ciclo A9 lacuna → publicação → sugestão → aprovação → outbox; (10) chat de teste (stub desta fase; upgrade na Fase 3 Task 17) e o que ele nunca faz; (11) comandos de teste.

**Steps:**

- [ ] Escrever `src/modules/knowledge/README.md` com os 11 pontos acima (números exatos das chaves e keys; nada de segredos nem valores reais de ambiente).
- [ ] Acrescentar a `docs/05` §7 a nota: "Seed implementado na Fase 2 em `src/modules/knowledge/qualification-questions.seed.ts` (15 perguntas, todas `required`; chaves e textos a confirmar no gate da Fase 2)."
- [ ] Correr `npm run lint && npm run typecheck && npm test && npm run test:integration` → **todos com 0 falhas**; colar a saída integral no relatório (sem `npm run eval`: o avaliador precisa do `AIProvider` real, é da Fase 3).
- [ ] `npm run db:generate` → sem migrações pendentes ("No schema changes, nothing to generate"); confirmar que `drizzle/` não mudou por acidente.
- [ ] Procurar segredos e dados reais: `grep -rn "password\|api_key\|token" src/modules/knowledge tests/integration/knowledge-* scripts/seed-knowledge.ts` → só chaves de config, sem valores.
- [ ] Commit: `docs: add knowledge module readme and phase 2 notes`.

---

## Gate de fim de fase

`docs/01` §8 **não define gate formal para a Fase 2** (os gates da fase são os de envio/campanha/`ai_active`, que pertencem às Fases 1, 4 e 3). Fecha-se por **requisitos de aceitação demonstrados** — cada critério de `docs/01` §8 (Fase 2) com o teste que o prova:

| Critério (docs/01 §8, Fase 2) | Demonstração |
|---|---|
| CRUD do catálogo, documentos, regras, perguntas e gatilhos, com papéis (`editor`, `admin`) | Task 6 `tests/integration/knowledge-crud.test.ts` + Task 8 `tests/integration/knowledge-api.test.ts` (RBAC 401/403/200) |
| Publicação com histórico de versões e reversão | Task 7 `tests/integration/knowledge-revisions.test.ts` + `docs/03` §3 no audit (`knowledge.published` etc.) |
| Job de chunking e embeddings; pesquisa só em itens publicados e válidos | Task 4 `tests/integration/knowledge-reindex.test.ts` (idempotente) + Task 5 `tests/integration/search-chunks.test.ts` + Task 1 `tests/integration/knowledge-schema.test.ts` (`vector(384)` do zero, HNSW) |
| Registo de lacunas e fila de sugestões a partir de correções humanas | Task 9 `tests/integration/knowledge-gaps-suggestions.test.ts` (A9: 1 sugestão, 0 outbox até aprovar) |
| Chat de teste (`isTest`) com fontes; não gera handoffs nem lacunas | Task 11 `tests/integration/knowledge-test-chat.test.ts` |
| Alertas de itens por rever (`reviewed_at` + `review_every_days`) | Task 10 `tests/integration/knowledge-sweep.test.ts` + `GET /v1/knowledge/review-due` |
| (A8/ADR-0004) seed de 15 perguntas + 16 gatilhos idempotente | Task 3 `tests/integration/knowledge-seed.test.ts` |

Checklist de fecho: typecheck, lint, unitários e integração a 0 falhas com output colado (Task 12); migração `vector(1536) → vector(384)` gerada, revista (sem `DROP TABLE`) e aplicada de zero num teste; nenhum segredo nem dado real em código/testes/seed; README do módulo escrito.

**Decisões que precisam de humano antes de dar a Fase 2 por fechada** (o plano não as resolve):
1. `key`/texto literais das 13 perguntas cujos strings não constam dos docs e o mapa `conversionGoal` por linha (Task 3).
2. Fecho do gap só na aprovação da sugestão, e materialização da sugestão `kind 'knowledge'` como doc `draft` (Task 9) — docs não fixam o momento.
3. `sender: 'human'` e adaptação da assinatura da outbox da Fase 1 (Task 9).
4. Parâmetros iniciais de chunking (800 chars) e de recuperação (`RETRIEVAL_TOP_K=5`, `RETRIEVAL_MIN_SIMILARITY=0.75`) — `docs/05` §5 diz "valores iniciais a calibrar".
5. Resposta do stub do chat (topo) e RBAC do chat disponível a todos os papéis (Task 11).
6. Mudança de assinatura de `searchChunks` (`opts` obrigatório, sem defaults) — se o dono a classificar como decisão de arquitetura, exige ADR (regra 14 do `AGENTS.md`).
7. Alerta de revisão = log estruturado + endpoint; alerta persistente é assunto da Fase 5 (Task 10).

