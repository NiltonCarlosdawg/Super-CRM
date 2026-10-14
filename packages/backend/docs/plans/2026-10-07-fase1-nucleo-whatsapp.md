# Fase 1 — Núcleo e WhatsApp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar o núcleo do CRM — autenticação/RBAC, schema base aplicado de zero, integração WA-AKG (adaptador + webhooks idempotentes), outbox com limites de envio, ciclo de vida de contas e API/Socket.IO de conversas — até ao critério da Fase 1 de `docs/01` §8.
**Architecture:** Hexagonal conforme `docs/02` §1: regras em `domain`/`application`, contratos em `ports`, Drizzle/Fastify/Socket.IO/WA-AKG em `adapters`, composição em `infra`. O WhatsApp só sai pela outbox transacional + worker com prioridade e serialização por conta; a entrada entra por webhook verificado → `inbound_events` idempotente → job → `handleInboundEvent` → orquestrador (`src/application/orchestrator.ts`, movido da Fase 0) com `AIProvider` indisponível (IA real é Fase 3).
**Tech Stack:** Node LTS + TypeScript `strict` (`noUncheckedIndexedAccess`), Fastify + zod, Drizzle ORM + PostgreSQL (pgvector), Redis + BullMQ (port de jobs da Fase 0), Socket.IO, argon2id, TOTP com `node:crypto`, `node:test`.
**Spec:** docs/01-contexto-e-plano.md §8 (Fase 1) + docs/06-decisoes-fechadas-a1-a11.md

**Pré-requisitos:** Fase 0 concluída e com gate aprovado (schema base + migrações, `loadConfig` em `src/infra/config.ts`, `JobQueue`, logger, CI, `docs/wa-akg-audit.md`, `docs/schema-base.md`, `reference/` movido para `src/` com mapa em `reference/README.md`). Os comandos reais estão em `AGENTS.md` (secção "Comandos"); os exemplos deste plano assumem `npm test`, `npm run test:integration`, `npm run lint`, `npm run typecheck`, `npm run db:generate` — adaptar só as flags ao `package.json` da Fase 0, nunca o alvo dos testes.

## Global Constraints

- Texto do plano e documentação em português; código, identificadores e commits em inglês; commits convencionais pequenos (`feat:`, `fix:`, `test:`, `docs:`, `chore:`), sem `push --force`, nunca com testes a falhar.
- TypeScript `strict` + `noUncheckedIndexedAccess` + `noImplicitOverride`; sem `any` sem comentário `// any: motivo`; sem `catch {}` vazio nem `@ts-ignore` sem justificação.
- Testes com `node:test` + `node:assert/strict`; integração só com Postgres e Redis reais (contentores da Fase 0, `TEST_DATABASE_URL`/`TEST_REDIS_URL`); sem dependência de internet, de hora real ou de ordem de execução (relógio e `random()` injetados).
- Só dados sintéticos em testes, fixtures e prompts; as 20 conversas reais de WhatsApp são proibidas em tudo.
- Migrações: nunca editar uma já aplicada; delta da Fase 1 = `drizzle/0002_*` gerado com `drizzle-kit generate`; `CREATE EXTENSION IF NOT EXISTS vector;` fica no `0000` custom da Fase 0; nunca `drizzle-kit push` fora de dev local; CI aplica as migrações de zero numa base vazia.
- Config: `loadConfig()` (`src/infra/config.ts`) mantém a forma exata (o `tests/unit/config.test.ts` da Fase 0 não se toca); `loadFullConfig()` em `src/infra/config-app.ts` compõe `loadAuthConfig()` + `loadMessagingConfig()`; o processo não arranca sem `AUTH_SECRET` (≥32 chars), `AUTH_TOTP_ISSUER`, `WA_AKG_BASE_URL` (URL http/https), `WA_AKG_API_KEY` e `WA_WEBHOOK_SECRET` (≥32 chars); mensagens de erro de config nunca contêm valores de segredos.
- Chaves novas e valores exatos: `AUTH_SESSION_TTL_HOURS=72`, `AUTH_LOGIN_RATE_MAX=5`, `AUTH_LOGIN_RATE_WINDOW_MS=900000`, `AUTH_LOGIN_LOCK_MAX_MS=3600000`, `HTTP_RATE_MAX=300`, `HTTP_RATE_WINDOW_MS=60000`, `HTTP_BODY_LIMIT_BYTES=1048576`.
- Chaves de mensagens e valores exatos: `WA_REPLY_DELAY_MS=1000-5000` (formato `min-max`), `WA_SEND_TIMEOUT_MS=15000`, `WA_SEND_MAX_ATTEMPTS=5`, `WA_OUTBOX_RETRY_DELAY_MS=30000`, `WA_OUTBOX_TICK_MS=1000`, `WA_CLAIM_TTL_MS=60000`, `WA_FAIL_WINDOW=20`, `WA_FAIL_RATIO=0.30`, `WA_CB_THRESHOLD=5`, `WA_CB_COOLDOWN_MS=30000`, `WA_MAX_MESSAGE_CHARS=4096`.
- `WA_CAMPAIGN_DELAY_MS`, `WA_CAMPAIGN_RAMP` e `WA_QUIET_HOURS` **não** são desta fase: pertencem a `loadCampaignConfig` (Fase 4, Task 1); a Fase 1 honra `scheduledAt` e `priority` calculados por quem faz o `enqueue`.
- WhatsApp só sai pela outbox: nenhum handler HTTP nem job chama `sendText`/`sendMedia` (provado por regra ESLint + teste estático na Task 9 e por espião na Task 22).
- Webhook: verificação sobre o corpo **bruto** (Buffer, antes do parse) em tempo constante; idempotência por `provider_event_id` em `inbound_events`; 2xx rápido (<500 ms medidos) e processamento assíncrono em job; `processed_at` só a seguir ao sucesso total do processamento.
- Idempotência: claim de evento em `inbound_events.ai_claimed_at` com TTL `WA_CLAIM_TTL_MS`, `releaseClaim(eventId)` no erro antes de repropagar, `idempotency_key` único na outbox (`inbound:<eventId>`, `rest:<conversationId>:<Idempotency-Key>`).
- Pacing da Fase 1: atraso de resposta aleatório em `WA_REPLY_DELAY_MS` calculado no `enqueue`; worker globalmente sequencial (⇒ serialização por conta, `docs/04` §7); resposta (`priority=1`) antes de campanha (`priority=2`); timeout de envio → `outcome: 'unknown'` → outbox `unknown_delivery`, mensagem continua `queued`, **sem retry automático**.
- Segredos: nunca em código, commits, logs, fixtures, prompts ou mensagens de erro; TOTP cifrado AES-256-GCM com chave HKDF de `AUTH_SECRET`; palavras-passe lidas só por stdin, nunca por argv.
- PII: nunca registar corpos completos de mensagens nem números inteiros; telefones em logs passam por `maskPhone` (`+244923111222` → `+244 9** *** *12`, `docs/02` §10).
- WA-AKG: acesso só pelo adaptador `src/adapters/wa-akg/` atrás do port `src/ports/messaging-provider.ts`; endpoints, headers e payloads exclusivamente de `docs/wa-akg-audit.md` (sem achado = não inventar; parar e perguntar); nunca ler nem escrever na base de dados do WA-AKG.
- IA: a Fase 1 compõe `handleInbound(ports, unavailableAiProvider, msg)`; decisão de handoff/bloqueio fica no orquestrador (D11); nenhuma rota chama a IA; nada sai para fornecedor externo (gate A11 intocado).
- Socket.IO: só os cinco eventos documentados (`handoff.created`, `handoff.updated`, `message.created`, `message.status`, `account.status`), payload `{ v: 1, ... }`, salas `agent`/`editor`/`admin`/`handoffs`, autenticação no handshake.
- RBAC por omissão negado: rota sem sessão → 401; papel insuficiente → 403. Matriz: conversas/mensagens/`me`/OpenAPI = qualquer papel; fila de handoffs = `agent`+`admin` (Fase 3); conhecimento = `editor`+`admin` (Fase 2); contas/utilizadores = `admin`.
- CSRF double-submit em todos os métodos inseguros (`POST`/`PATCH`/`DELETE`): cabeçalho `x-csrf-token` igual ao cookie `csrf`, comparação em tempo constante; exceções: `POST /v1/auth/login` e `POST /v1/webhooks/wa-akg`.

## Review Focus

- `tests/integration/migrations.test.ts` (Task 1): migrações aplicam de zero; `leads.stage` é `lead_stage NOT NULL DEFAULT 'open'` com `open|won|lost`; `inbound_events.ai_claimed_at` existe.
- `tests/contract/wa-akg-contract.test.ts` (Task 13): adaptador cumpre `docs/wa-akg-audit.md` (endpoints, auth, erros) contra mock fiel; timeout devolve `outcome:'unknown'` e nunca repete o envio.
- `tests/integration/outbox-worker.test.ts` (Task 18): serialização (nunca 2 envios concorrentes), resposta antes de campanha, conta não-`connected` adiada sem gastar tentativas, pico de falhas → `suspected_ban`.
- `tests/integration/webhook-idempotency.test.ts` (Task 20): assinatura inválida → 401 sem registo; mesmo evento 2× → 1 linha, 1 job, 1 efeito; 2xx em <500 ms.
- `tests/integration/send-flow.test.ts` (Task 22): webhook → `handleInboundEvent` → outbox → provider ponta-a-ponta; zero chamadas `sendText` antes do worker correr (nenhum envio fora da outbox).

## Contratos fixados para as Fases 2–5

- `tests/helpers/db.ts`: `migrateFromEmptyDb()`, `migratedDb()`, `resetDb()`, `columnNames(db, table)` (Fase 2 usa `columnNames(db, 'knowledge_chunks')`; Fase 4 usa `const db = await migratedDb()`).
- `tests/helpers/http.ts`: `buildTestApp()` → app Fastify com `sessions.{agent,editor,admin}` (valor da cookie), `csrf.{agent,editor,admin}`, `users.{...}`, `messaging`, `realtime` (Task 15+), `close()` que fecha io+queue+servidor; chamem `await app.close()`.
- `tests/helpers/outbox.ts` `runOutboxWorker()`, `tests/helpers/webhook.ts` `signWebhook()`, `tests/helpers/fake-messaging.ts` `createFakeMessaging()`.
- `src/ports/audit.ts`: `Audit.record({ actorId: string | null; action: string; entity: string; entityId: string; detail?: Record<string, unknown>; at: Date; ip?: string | null })` (assinatura exata citada pelas Fases 2 e 4; a Fase 3 adapta de `subjectType/subjectId` — ver lacunas).
- `src/ports/outbox.ts`: `Outbox.enqueue({ accountId, contactId, conversationId, sender: 'ai'|'human'|'campaign', text, idempotencyKey, scheduledAt? }) → { outboxId, duplicate }` + `pendingConversationCount(accountId)` (forma da Fase 4 `CampaignOutbox`; Fases 2/3 adaptam — ver lacunas).
- `src/adapters/db/orchestrator-ports.ts`: `createOrchestratorPorts({ db, notifySink, claimTtlMs, now, retrieve?, turnsLimit? })` + `releaseClaim(eventId)`; `msg.id` do orquestrador é o **id do evento** (`inbound_events.id`).
- `src/adapters/realtime/socket.ts`: `createSocketNotify(io)` com `io.to(room).emit(event, payload)` (estrutura exata que a Fase 3 usa nos testes), payload em pass-through.
- `src/application/handle-inbound.ts`: `handleInboundEvent(deps, eventId)` com seam `inboundEffects` (Fase 4) e `orchestrate` injetável (Fase 3 troca por `processInbound`).
- Guards: `requireRole('admin')` e `requireRole(['editor','admin'])` aceitam ambos os formatos (Fase 2 e Fase 4).
- `src/domain/phone.ts`: `normalizePhoneE164()` e `maskPhone()` (função única citada pelas Fases 4 e 5).

### Task 1: Migrações de zero, vocabulário de `leads.stage` e helpers de BD

**Files:**
- Modify: `src/adapters/db/schema/enums.ts`, `src/adapters/db/schema/leads.schema.ts`, `src/adapters/db/schema/inbound-events.schema.ts`, `src/adapters/db/schema/users.schema.ts`, `src/adapters/db/schema/sessions.schema.ts`, `src/adapters/db/schema/messages.schema.ts` (só as colunas listadas em "Implementar", e só se já não existirem), `docs/schema-base.md`, estrutura de diretórios em `docs/02-regras-backend.md` §1 (linha `tests/` ganha `helpers/`), `tests/unit/schema-coverage.test.ts` (estender lista de diretórios, nunca enfraquecer)
- Create: `drizzle/0002_*.sql` + `drizzle/meta/_journal.json` (gerados), `tests/helpers/db.ts`, `tests/integration/migrations.test.ts`

**Interfaces:**
```ts
// tests/helpers/db.ts — convenção da Fase 0: tipo do cliente Drizzle exportado por
// src/adapters/db/index.ts (usar o nome real exportado; este plano chama-lhe DbClient).
export async function migrateFromEmptyDb(): Promise<void>;   // aplica drizzle/ 0000→latest numa base vazia (memo por processo)
export async function resetDb(): Promise<void>;              // TRUNCATE CASCADE de todas as tabelas do CRM, exceto as do drizzle
export async function migratedDb(): Promise<DbClient>;       // migrateFromEmptyDb + resetDb + cliente (Fase 4: const db = await migratedDb())
export function columnNames(db: DbClient, table: string): Promise<string[]>;
export const LEAD_STAGE_VALUES = ['open', 'won', 'lost'] as const;

// src/adapters/db/schema/enums.ts (adicionar ao único sítio dos enums, docs/02 §2)
export const leadStageEnum = pgEnum('lead_stage', ['open', 'won', 'lost']);
```

**Steps:**

- [ ] **1. Ler o runner da Fase 0.** Ver como `tests/integration/job-queue.test.ts` isola a BD (BD única, `--test-concurrency=1` ou BD por processo) e seguir essa convenção nos helpers; se não houver isolamento, acrescentar `--test-concurrency=1` ao script `test:integration` do `package.json` (estender, nunca enfraquecer).
- [ ] **2. Teste falhado** `tests/integration/migrations.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { migrateFromEmptyDb, migratedDb, columnNames, LEAD_STAGE_VALUES } from '../helpers/db.js';

test('migrações aplicam de zero e leads.stage é lead_stage NOT NULL default open', async () => {
  await migrateFromEmptyDb();
  const db = await migratedDb();
  const cols = await columnNames(db, 'leads');
  assert.ok(cols.includes('stage'));
  assert.equal(cols.includes('estado'), false, 'coluna estado redundante removida (docs/01 §6)');
  const vals = await db`SELECT unnest(enum_range(NULL::lead_stage))::text AS v`;
  assert.deepEqual(vals.map((r) => r.v), [...LEAD_STAGE_VALUES]);
  const d = await db`SELECT is_nullable, column_default FROM information_schema.columns
                     WHERE table_name = 'leads' AND column_name = 'stage'`;
  assert.equal(d[0].is_nullable, 'NO');
  assert.match(d[0].column_default, /open/);
  const ev = await columnNames(db, 'inbound_events');
  assert.ok(ev.includes('ai_claimed_at'), 'claim de idempotência do evento (Fase 1, consumido pela Fase 3)');
});
```

- [ ] **3. Correr e ver falhar.** `npm run test:integration -- tests/integration/migrations.test.ts` → `fail 1`: `AssertionError [ERR_ASSERTION]: deepEqual` (tipo `lead_stage` inexistente) ou `ai_claimed_at` em falta.
- [ ] **4. Implementar.**
  - `enums.ts`: `export const leadStageEnum = pgEnum('lead_stage', ['open', 'won', 'lost']);`
  - `leads.schema.ts`: `stage: leadStageEnum('stage').notNull().default('open')` (hoje é `text NOT NULL` sem vocabulário — `docs/schema-base.md` nota isto como pergunta do gate); se existir coluna `estado`/`state`, removê-la; garantir `qualification` `jsonb not null default '{}'` e `owner_id` anulável (usa-se em `saveState`, Task 14); qualquer coluna `NOT NULL` sem default que impeça inserir um lead passa a `default` documentado.
  - `inbound-events.schema.ts`: `aiClaimedAt: timestamp('ai_claimed_at', { withTimezone: true })`.
  - `users.schema.ts`: `totpSecret: text('totp_secret')` (blob AES-GCM, nulo até ativar), `totpEnabledAt: timestamp('totp_enabled_at', { withTimezone: true })`; confirmar `active boolean not null default true` (`docs/01` §6) e acrescentar se faltar.
  - `sessions.schema.ts`: `mfaPending: boolean('mfa_pending').notNull().default(false)`.
  - `messages.schema.ts`: `mediaRef: text('media_ref')` (mídia recebida guarda só a referência — ver lacunas).
  - `conversations.schema.ts`: `UNIQUE (account_id, contact_id)` se a Fase 0 não a tiver (uma conversa por conta+contacto, `docs/01` §6 "o fio de mensagens"; necessária ao upsert da Task 19 e ao `findOrCreateForCampaign` da Fase 4) — registar a decisão em `docs/schema-base.md`.
  - `npm run db:generate` → `drizzle/0002_*.sql`; **revistar** o SQL gerado (casts `USING`, `SET DEFAULT`, `SET NOT NULL`), nunca editar depois de aplicado.
  - `tests/helpers/db.ts` conforme a Interfaces, com o TRUNCATE construído a partir dos nomes devolvidos por `information_schema.tables` (nomes vindos da BD, SQL por identificadores da própria consulta, nunca concatenado de input).
- [ ] **5. Correr e ver passar.** `npm run test:integration -- tests/integration/migrations.test.ts` → `pass 1, fail 0`; `npm run db:migrate` numa base vazia local do zero → sem erros.
- [ ] **6. Responder ao gate de schema.** Em `docs/schema-base.md`, marcar as perguntas: `leads.stage` = `lead_stage` (`open` = em curso, `won` = fechada ganha, `lost` = fechada perdida; consumido pela Fase 5 como `leadStatus`); coluna `estado` eliminada (redundante — uma só fonte de verdade por facto, `docs/05` §5); `unknown_delivery` confirmado em `outbox_status` (usado pela Task 18); estados de `followup_runs` → Fase 5; colunas de limites de `campaigns` → Fase 4; `vector` → ADR-0002/Fase 2.
- [ ] **7. lint/typecheck.** `npm run lint && npm run typecheck` → `0 erros`, `0 avisos novos`.
- [ ] **8. Commit.** `feat: apply base migrations from empty db and add lead_stage enum`

### Task 2: Testes de integração do conhecimento (`search-chunks` e seed de gatilhos)

**Files:**
- Create: `tests/integration/search-chunks.test.ts` (tarefa dona = Fase 1; a Fase 2 acrescenta casos), `tests/integration/handoff-triggers-seed.test.ts` (se já existir da Fase 0, acrescentar os casos sem alterar os existentes)

**Interfaces:**
```ts
// Consumes (Fase 0 movidos de reference/):
import { searchChunks } from '../../src/modules/knowledge/knowledge.schema.js';
import { businessLines, knowledgeChunks } from '../../src/modules/knowledge/knowledge.schema.js';
import { seedHandoffTriggers } from '../../src/modules/knowledge/handoff-triggers.seed.js';
```

**Steps:**

- [ ] **1. Teste falhado** `tests/integration/search-chunks.test.ts` (também prova que a extensão `vector` e o plano A pgvector funcionam de zero — se falhar, é o momento do plano B de `docs/06` A5):

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { migratedDb, resetDb } from '../helpers/db.js';

test('searchChunks: vetor igual devolve o próprio chunk; base vazia devolve []', async () => {
  await resetDb();
  const db = await migratedDb();
  assert.deepEqual(await searchChunks(db, [0.1, 0.2, 0.3]), []);
  // inserir um chunk sintético com embedding normalizado e consultar com o mesmo vetor
  const v = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
  await db.insert(knowledgeChunks).values({ /* campos mínimos reais do schema */ }).onConflictDoNothing();
  const hits = await searchChunks(db, v, { limit: 1 });
  assert.equal(hits.length, 1);
  assert.ok(hits[0].similarity >= 0.99);
});
```

- [ ] **2. Teste falhado** `tests/integration/handoff-triggers-seed.test.ts` (insere as 4 `business_lines` sintéticas diretamente — o seed publicado é da Fase 2):

```ts
test('seedHandoffTriggers: 16 gatilhos de arranque e segunda chamada não duplica', async () => {
  await resetDb();
  const db = await migratedDb();
  await db.insert(businessLines).values([ /* software, custom, telecom, cctv (slugs de docs/05 §4) */ ]);
  await seedHandoffTriggers(db);
  await seedHandoffTriggers(db);
  const rows = await db.select().from(handoffTriggers);
  assert.equal(rows.length, 16); // docs/01 §9: 8 globais + 8 por linha
  assert.equal(rows.filter((r) => r.lineId === null).length, 8);
});
```

- [ ] **3. Correr e ver falhar.** `npm run test:integration -- tests/integration/search-chunks tests/integration/handoff-triggers-seed` → `fail` (colunas/limites do schema ainda por confirmar contra o código real; corrigir os `values` do teste para os nomes reais de `knowledge.schema.ts` **sem** alterar as asserções).
- [ ] **4. Correr e ver passar.** → `pass 2, fail 0`. Se `searchChunks` falhar no plano A (extensão `vector` ausente), parar e perguntar (gate A5) — não trocar de plano por conta própria.
- [ ] **5. Commit.** `test: cover vector search and handoff trigger seed against real pg`

### Task 3: Normalização E.164 e máscara de logs

**Files:**
- Create: `src/domain/phone.ts`, `tests/unit/phone.test.ts`

**Interfaces:**
```ts
/** Devolve `+` e dígitos (10–15) ou null. Nunca infere país. */
export function normalizePhoneE164(input: string): string | null;
/** `+244923111222` → `+244 9** *** *12` (docs/02 §10); não-E.164 → `***`. */
export function maskPhone(phone: string): string;
```

**Steps:**

- [ ] **1. Teste falhado** `tests/unit/phone.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePhoneE164, maskPhone } from '../../src/domain/phone.js';

test('normalizePhoneE164', () => {
  assert.equal(normalizePhoneE164('+244 923 111 222'), '+244923111222');
  assert.equal(normalizePhoneE164('00244923111222'), '+244923111222');
  assert.equal(normalizePhoneE164('+244-923.111(222)'), '+244923111222');
  assert.equal(normalizePhoneE164('923111222'), null, 'sem código de país não se infere');
  assert.equal(normalizePhoneE164('+244923111'), null, 'curto demais');
  assert.equal(normalizePhoneE164('+2449231112221234'), null, 'longo demais');
  assert.equal(normalizePhoneE164('abc'), null);
  assert.equal(normalizePhoneE164('+244 923 111 222 x'), null);
});
test('maskPhone', () => {
  assert.equal(maskPhone('+244923111222'), '+244 9** *** *12');
  assert.equal(maskPhone('923111222'), '***');
});
```

- [ ] **2. Correr e ver falhar.** `npm test -- tests/unit/phone.test.ts` → `fail 1` (`Cannot find module ... src/domain/phone.ts`).
- [ ] **3. Implementar.** `trim`; remover espaços, pontos, hífenes e parênteses; prefixo `+` mantido, `00`→`+`; resto tem de ser 10–15 dígitos (caso contrário `null`); letras ou outros caracteres → `null`. `maskPhone`: `^\+(\d{10,15})$` senão `'***'`; código de país = `244` se os dígitos começam por `244`, senão os 3 primeiros; nacional mascarado = 1.º dígitos + `**` + `*` repetido até `n-3` + últimos 2, agrupado em blocos de 3 com espaço.
- [ ] **4. Correr e ver passar.** `npm test -- tests/unit/phone.test.ts` → `pass 2, fail 0`.
- [ ] **5. Commit.** `feat: add e164 phone normalizer and log masker`

### Task 4: Config de autenticação e de mensagens

**Files:**
- Create: `src/infra/config-app.ts`, `tests/unit/config-app.test.ts`
- Modify: `src/infra/main.ts` (passar a chamar `loadFullConfig(process.env)` — uma única leitura de env), `tests/unit/config-startup.test.ts` da Fase 0 (estender o caso válido com as variáveis novas), `.env.example`

**Interfaces:**
```ts
// src/infra/config-app.ts — reutiliza ConfigError/issues do src/infra/config.ts da Fase 0
export interface AuthConfig {
  authSecret: string; sessionTtlHours: number;
  loginRateMax: number; loginRateWindowMs: number; loginLockMaxMs: number;
  totpIssuer: string; httpRateMax: number; httpRateWindowMs: number; bodyLimitBytes: number;
}
export function loadAuthConfig(env: NodeJS.ProcessEnv): AuthConfig;

export interface MessagingConfig {
  waAkgBaseUrl: string; waAkgApiKey: string; waWebhookSecret: string;
  replyDelayMs: { min: number; max: number };
  sendTimeoutMs: number; sendMaxAttempts: number; outboxRetryDelayMs: number;
  outboxTickMs: number; claimTtlMs: number; failWindow: number; failRatio: number;
  cbThreshold: number; cbCooldownMs: number; maxMessageChars: number;
}
export function loadMessagingConfig(env: NodeJS.ProcessEnv): MessagingConfig;

export function loadFullConfig(env: NodeJS.ProcessEnv): AppConfig & { auth: AuthConfig; messaging: MessagingConfig };
```

**Steps:**

- [ ] **1. Teste falhado** `tests/unit/config-app.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAuthConfig, loadMessagingConfig, loadFullConfig } from '../../src/infra/config-app.js';

test('loadAuthConfig: sem env devolve issues exatas', () => {
  assert.throws(() => loadAuthConfig({}), (e: { issues?: string[] }) =>
    JSON.stringify(e.issues) === JSON.stringify(['falta AUTH_SECRET', 'falta AUTH_TOTP_ISSUER']));
});
test('loadAuthConfig: AUTH_SECRET curto é rejeitado e o valor não aparece na mensagem', () => {
  try { loadAuthConfig({ AUTH_SECRET: 'segredo-curto', AUTH_TOTP_ISSUER: 'MilVendas' }); assert.fail('devia lançar'); }
  catch (e) { const m = e as Error; assert.match(m.message, /AUTH_SECRET/); assert.ok(!m.message.includes('segredo-curto')); }
});
test('loadMessagingConfig: defaults exatos e intervalo de resposta', () => {
  const env = { WA_AKG_BASE_URL: 'http://wa.local:3001', WA_AKG_API_KEY: 'k', WA_WEBHOOK_SECRET: 's'.repeat(32) };
  const c = loadMessagingConfig(env);
  assert.deepEqual(c.replyDelayMs, { min: 1000, max: 5000 });
  assert.equal(c.sendTimeoutMs, 15000);
  assert.equal(c.sendMaxAttempts, 5);
  assert.equal(c.outboxRetryDelayMs, 30000);
  assert.equal(c.outboxTickMs, 1000);
  assert.equal(c.claimTtlMs, 60000);
  assert.equal(c.failWindow, 20);
  assert.equal(c.failRatio, 0.30);
  assert.equal(c.cbThreshold, 5);
  assert.equal(c.cbCooldownMs, 30000);
  assert.equal(c.maxMessageChars, 4096);
  assert.throws(() => loadMessagingConfig({ ...env, WA_REPLY_DELAY_MS: '5000-1000' }),
    /WA_REPLY_DELAY_MS: min > max/);
  assert.throws(() => loadMessagingConfig({ ...env, WA_WEBHOOK_SECRET: 'curto' }), /WA_WEBHOOK_SECRET/);
});
test('loadFullConfig: compõe base + auth + messaging sem ler env duas vezes', () => {
  const c = loadFullConfig({ DATABASE_URL: 'postgres://u:p@h/db', REDIS_URL: 'redis://h:6379',
    AUTH_SECRET: 'x'.repeat(32), AUTH_TOTP_ISSUER: 'MilVendas',
    WA_AKG_BASE_URL: 'http://wa.local:3001', WA_AKG_API_KEY: 'k', WA_WEBHOOK_SECRET: 's'.repeat(32) });
  assert.equal(c.auth.sessionTtlHours, 72);
  assert.equal(c.messaging.waAkgBaseUrl, 'http://wa.local:3001');
});
```

- [ ] **2. Correr e ver falhar.** `npm test -- tests/unit/config-app.test.ts` → `fail 1` (`Cannot find module ... config-app.ts`).
- [ ] **3. Implementar.** `loadAuthConfig`/`loadMessagingConfig` com a mesma mecânica de issues da Fase 0 (`falta X`, `X: valor não permitido`, `X: fora do intervalo ...`); `WA_REPLY_DELAY_MS` parseado como `min-max` com `0 ≤ min ≤ max ≤ 600000`; `WA_FAIL_RATIO` em (0,1]; números inteiros nos restantes campos no intervalo documentado; `loadFullConfig` chama `loadConfig(env)` uma vez e junta `{ auth, messaging }`. Atualizar `main.ts` e os casos do `config-startup.test.ts` (adicionar `AUTH_SECRET`, `AUTH_TOTP_ISSUER`, `WA_AKG_BASE_URL`, `WA_AKG_API_KEY`, `WA_WEBHOOK_SECRET` ao caso válido — estender, nunca enfraquecer; o caso inválido continua a falhar primeiro por `DATABASE_URL`). `.env.example`: todas as chaves novas com placeholders não funcionais (ex.: `WA_WEBHOOK_SECRET=<32+ caracteres aleatórios>`), zero segredos reais.
- [ ] **4. Correr e ver passar.** `npm test -- tests/unit/config-app.test.ts tests/unit/config.test.ts tests/unit/config-startup.test.ts` → `pass, fail 0`.
- [ ] **5. lint/typecheck.** `npm run lint && npm run typecheck` → `0 erros`.
- [ ] **6. Commit.** `feat: add auth and messaging config loaders`

### Task 5: Ports `Audit` e `MessagingProvider` e adaptador de auditoria

**Files:**
- Create: `src/ports/audit.ts`, `src/ports/messaging-provider.ts`, `src/adapters/db/audit-adapter.ts`, `tests/integration/audit.test.ts`
- Modify: `docs/02-regras-backend.md` §1 (linha `tests/` já inclui `helpers/` — confirmar na revisão final da Task 23)

**Interfaces:**
```ts
// src/ports/audit.ts — assinatura EXATA citada pelas Fases 2 (linha "Consumes") e 4 (CampaignAudit)
export interface Audit {
  record(input: {
    actorId: string | null;        // null = ação de sistema (webhook, job)
    action: string;                // ex.: 'auth.login', 'account.status_changed'
    entity: string; entityId: string;
    detail?: Record<string, unknown>;
    at: Date;                      // relógio controlado nos testes
    ip?: string | null;
  }): Promise<void>;
}
// src/adapters/db/audit-adapter.ts
export function createAuditAdapter(deps: { db: DbClient }): Audit;

// src/ports/messaging-provider.ts — cópia VERBATIM do contrato de docs/04 §5:
// SessionStatus, SendResult, ProviderEvent, MessagingProvider (health, createSession,
// getSession, getQr, logout, sendText, sendMedia, verifyAndParseWebhook) + erros:
export class ProviderUnavailableError extends Error { readonly transient = true; }   // rede/5xx/CB aberto → retry
export class CircuitOpenError extends Error { readonly transient = true; }           // breaker aberto → adiar sem gastar tentativa
export class WebhookError extends Error { readonly code: 'invalid_signature' | 'payload_invalid'; }
```

**Steps:**

- [ ] **1. Copiar o contrato.** `src/ports/messaging-provider.ts` com os tipos de `docs/04` §5 literalmente (o port é só tipos + as classes de erro; a prova é `npm run typecheck` e o uso integral na Task 11).
- [ ] **2. Teste falhado** `tests/integration/audit.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { migratedDb, resetDb } from '../helpers/db.js';
import { createAuditAdapter } from '../../src/adapters/db/audit-adapter.js';

test('audit.record grava ator, ação, entidade e detalhes com o at recebido', async () => {
  await resetDb();
  const db = await migratedDb();
  const audit = createAuditAdapter({ db });
  const at = new Date('2026-10-07T10:00:00.000Z');
  await audit.record({ actorId: null, action: 'webhook.rejected', entity: 'inbound_event',
    entityId: 'ev1', detail: { reason: 'invalid_signature' }, at, ip: '127.0.0.1' });
  const rows = await db.select().from(auditLog);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actorId, null);
  assert.equal(rows[0].action, 'webhook.rejected');
  assert.equal(rows[0].entityId, 'ev1');
  assert.equal(rows[0].at.toISOString(), at.toISOString());
});
```

- [ ] **3. Correr e ver falhar.** `npm run test:integration -- tests/integration/audit.test.ts` → `fail 1` (`Cannot find module ... audit-adapter.ts`; os nomes de colunas reais vêm de `audit.schema.ts` da Fase 0).
- [ ] **4. Implementar.** `createAuditAdapter`: um INSERT parametrizado; `detail` serializado com `JSON.stringify` (coluna `text`/`jsonb` do Fase 0); erros de escrita são propagados (nunca engolidos, `docs/02` §3).
- [ ] **5. Correr e ver passar.** → `pass 1, fail 0`; `npm run typecheck` → `0 erros` (port de messaging incluído).
- [ ] **6. Commit.** `feat: add audit and messaging provider ports with audit adapter`

### Task 6: Palavras-passe argon2id, script de bootstrap e ADR-0006

**Files:**
- Create: `src/ports/security.ts`, `src/infra/security/argon2.ts`, `src/domain/password.ts`, `scripts/create-user.ts`, `docs/adr/0006-dependencias-fase1.md`, `tests/unit/password.test.ts`, `tests/integration/create-user-script.test.ts`
- Modify: `docs/02-regras-backend.md` §1 (árvore ganha `scripts/` e `infra/security/`), `tests/unit/schema-coverage.test.ts` (lista de diretórios estendida)

**Interfaces:**
```ts
// src/ports/security.ts
export interface PasswordHasher {
  hash(plain: string): Promise<string>;            // argon2id
  verify(hash: string, plain: string): Promise<boolean>;
}
// src/infra/security/argon2.ts
export function createArgon2Hasher(): PasswordHasher;   // argon2id m=19456, t=2, p=1 (OWASP)
// src/domain/password.ts (regra pura, validada na fronteira)
export function assertPasswordPolicy(plain: string): void;  // 12–100 chars, sem só espaços; DomainError('weak_password')
// scripts/create-user.ts
//   npx tsx scripts/create-user.ts --email a@b.c --name "Nome" --role admin   (palavra-passe LIDA por stdin: echo -n '...' | npx tsx ...)
```

**Steps:**

- [ ] **1. ADR das dependências novas.** Criar `docs/adr/0006-dependencias-fase1.md` (estado: proposto; revisão por `docs/02` §12): `argon2` (Task 6), `zod` + `@fastify/cookie` + `@fastify/rate-limit` + `@fastify/swagger` (Task 9), `socket.io` e `socket.io-client` (dev, Task 15); justificação, licença MIT, versões fixadas no lockfile, `npm audit` obrigatório; Fastify já decidido em ADR-0001, Socket.IO em D8 (Fase 0); TOTP sem dependência (`node:crypto`, RFC 6238); zod v4 usa `z.toJSONSchema` para o OpenAPI, senão `zod-to-json-schema` (verificar com `npm ls zod` na Task 9 e registar a escolha neste ADR).
- [ ] **2. Teste falhado** `tests/unit/password.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { createArgon2Hasher } from '../../src/infra/security/argon2.js';
import { assertPasswordPolicy } from '../../src/domain/password.js';

test('argon2id: hash idempotente por chamada, verify correto/errado', async () => {
  const h = createArgon2Hasher();
  const hash = await h.hash('senha-muito-forte-123');
  assert.ok(hash.startsWith('$argon2id$'));
  assert.equal(await h.verify(hash, 'senha-muito-forte-123'), true);
  assert.equal(await h.verify(hash, 'senha-muito-forte-124'), false);
  assert.notEqual(await h.hash('senha-muito-forte-123'), hash, 'sal novo a cada hash');
});
test('assertPasswordPolicy: 11 chars lança weak_password; 12 passa', () => {
  assert.throws(() => assertPasswordPolicy('curta123456'), /weak_password/);
  assert.doesNotThrow(() => assertPasswordPolicy('senha-muito-forte-123'));
});
```

- [ ] **3. Correr e ver falhar.** `npm test -- tests/unit/password.test.ts` → `fail 1`; `npm install argon2` (registado no ADR-0006).
- [ ] **4. Implementar.** `createArgon2Hasher` (`argon2.hash(plain, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 })`); `assertPasswordPolicy` com `DomainError('weak_password')`.
- [ ] **5. Teste falhado do script** `tests/integration/create-user-script.test.ts`: `spawnSync('npx', ['--no-install', 'tsx', 'scripts/create-user.ts', '--email', 'bootstrap@test.local', '--name', 'Bootstrap', '--role', 'admin'], { input: 'senha-muito-forte-123', env: testEnv })` → `status 0`, `stdout` contém `created user bootstrap@test.local role admin` e não contém a palavra-passe; segunda execução → `status 1` e `email already exists`; sem stdin (`input: ''`) → `status 1` e `password via stdin`.
- [ ] **6. Correr script → falhar → implementar** `scripts/create-user.ts`: lê env via `loadFullConfig`, valida `--role` ∈ `agent|editor|admin`, lê a palavra-passe inteira de `process.stdin` (nunca de argv, nunca de `process.env`), aplica `assertPasswordPolicy`, hash, INSERT com `active = true`, `audit.record({ actorId: null, action: 'user.created', ... })`; logs sem segredos.
- [ ] **7. Correr e ver passar.** `npm run test:integration -- tests/integration/create-user-script.test.ts tests/integration/audit.test.ts` → `pass, fail 0`.
- [ ] **8. Commit.** `feat: add argon2id password hashing and user bootstrap script` e `docs: record phase 1 dependencies in adr 0006`

### Task 7: Sessões, login e bloqueio progressivo

**Files:**
- Create: `src/ports/auth.ts`, `src/application/auth/login.ts`, `src/application/auth/login-limiter.ts`, `src/adapters/db/auth.ts`, `tests/unit/login-limiter.test.ts`, `tests/integration/login.test.ts`

**Interfaces:**
```ts
// src/ports/auth.ts
export type Role = 'agent' | 'editor' | 'admin';
export interface SessionRecord { sessionId: string; userId: string; role: Role; mfaPending: boolean; expiresAt: Date; }
export interface SessionStore {
  create(input: { userId: string; role: Role; mfaPending: boolean; now: Date; ttlHours: number; ip: string }):
    Promise<{ sessionId: string; expiresAt: Date }>;
  get(sessionId: string, now: Date): Promise<SessionRecord | null>;   // nula se expirada/revogada
  revoke(sessionId: string): Promise<void>;
  revokeAllForUser(userId: string, exceptSessionId?: string): Promise<void>;
}
export interface AuthUserRepo {
  findByEmail(email: string): Promise<{ id: string; name: string; email: string; role: Role; active: boolean;
    passwordHash: string; totpEnabledAt: Date | null } | null>;
  dummyHash(): Promise<string>;   // hash constante para tempo de verificação igual (anti-enumeração)
  updatePassword(userId: string, passwordHash: string, now: Date): Promise<void>;
}
/** Port de MFA; a implementação real é a Task 8 (aqui só o contrato para testes com fake). */
export interface MfaPort {
  startSetup(input: { userId: string; email: string; now: Date }): Promise<{ otpauthUrl: string }>; // gera+persiste segredo cifrado
  verifyAndFinish(input: { sessionId: string; userId: string; code: string; now: Date }): Promise<boolean>;
}
// src/application/auth/login.ts
export type LoginResult =
  | { status: 'ok'; sessionId: string; expiresAt: Date; user: { id: string; name: string; email: string; role: Role } }
  | { status: 'mfa_setup_required'; sessionId: string; expiresAt: Date; otpauthUrl: string }
  | { status: 'mfa_required'; sessionId: string; expiresAt: Date }
  | { status: 'invalid_credentials' }
  | { status: 'rate_limited'; retryAfterSeconds: number };
export function createLoginService(deps: {
  users: AuthUserRepo; sessions: SessionStore; hasher: PasswordHasher; mfa: MfaPort;
  limiter: LoginLimiter; audit: Audit; cfg: AuthConfig; now(): Date;
}): {
  login(input: { email: string; password: string; ip: string }): Promise<LoginResult>;
  logout(sessionId: string): Promise<void>;
  loadSession(sessionId: string): Promise<SessionRecord | null>;
  changePassword(input: { sessionId: string; currentPassword: string; newPassword: string; ip: string }): Promise<void>;
};
// src/application/auth/login-limiter.ts (em memória — instância única, ADR-0001: um só servidor)
export function createLoginLimiter(cfg: { max: number; windowMs: number; lockMaxMs: number }, now: () => Date): {
  check(key: string): { allowed: true } | { allowed: false; retryAfterSeconds: number };
  fail(key: string): void;
  reset(key: string): void;
};
```

**Steps:**

- [ ] **1. Teste falhado** `tests/unit/login-limiter.test.ts` (relógio falso — nada de espera real):

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { createLoginLimiter } from '../../src/application/auth/login-limiter.js';

test('bloqueio progressivo: 5 falhas bloqueiam; 2.º bloqueio dobra; sucesso limpa', () => {
  let t = Date.parse('2026-10-07T10:00:00.000Z');
  const l = createLoginLimiter({ max: 5, windowMs: 900000, lockMaxMs: 3600000 }, () => new Date(t));
  for (let i = 0; i < 5; i++) { assert.equal(l.check('a@b.c|1.2.3.4').allowed, true); l.fail('a@b.c|1.2.3.4'); }
  const r = l.check('a@b.c|1.2.3.4');
  assert.equal(r.allowed, false);
  assert.equal((r as { retryAfterSeconds: number }).retryAfterSeconds, 30);   // 2^(5-5) * 30s
  l.fail('a@b.c|1.2.3.4');                                                    // 6.ª falha → dobra
  const r2 = l.check('a@b.c|1.2.3.4');
  assert.equal((r2 as { retryAfterSeconds: number }).retryAfterSeconds, 60);
  t += 61_000;
  assert.equal(l.check('a@b.c|1.2.3.4').allowed, true);                       // expirou o 2.º bloqueio
  l.reset('a@b.c|1.2.3.4');
  assert.equal(l.check('a@b.c|1.2.3.4').allowed, true);
});
```

- [ ] **2. Correr e ver falhar.** `npm test -- tests/unit/login-limiter.test.ts` → `fail 1`.
- [ ] **3. Implementar o limiter** com as fórmulas exatas: falhas dentro da janela; `failures >= max` → `lockedUntil = now + min(lockMaxMs, 2^(failures-max) * 30000)`; `reset` limpa; entrada expirada é removida no acesso (cap de 10000 chaves, descarta a mais antiga).
- [ ] **4. Teste falhado** `tests/integration/login.test.ts` (Postgres real, MfaPort fake):

```ts
test('login: password errada 5× → rate_limited; certa → sessão criada e audit', async () => {
  // utilizador sintético 'agent@test.local' com hash real criado no arranque do teste
  for (let i = 0; i < 5; i++) assert.equal((await svc.login({ email, password: 'errada', ip })).status, 'invalid_credentials');
  const rl = await svc.login({ email, password: 'errada', ip });
  assert.equal(rl.status, 'rate_limited');
  assert.equal((rl as { retryAfterSeconds: number }).retryAfterSeconds, 30);
  const ok = await svc.login({ email, password: 'senha-muito-forte-123', ip });
  assert.equal(ok.status, 'ok');
  assert.ok(await svc.loadSession((ok as { sessionId: string }).sessionId));
  assert.equal((await audits()).filter((a) => a.action === 'auth.login').length, 1);
});
test('login de admin sem TOTP → mfa_setup_required e sessão mfaPending', async () => {
  const r = await adminSvc.login({ email: 'admin@test.local', password: 'senha-muito-forte-123', ip });
  assert.equal(r.status, 'mfa_setup_required');
  assert.match((r as { otpauthUrl: string }).otpauthUrl, /^otpauth:\/\/totp\//);
  assert.equal((await svc.loadSession((r as { sessionId: string }).sessionId))?.mfaPending, true);
});
test('utilizador inativo e password errada devolvem a MESMA resposta (anti-enumeração)', async () => {
  assert.equal((await svc.login({ email: 'inexistente@test.local', password: 'x', ip })).status, 'invalid_credentials');
});
```

- [ ] **5. Correr e ver falhar.** `npm run test:integration -- tests/integration/login.test.ts` → `fail 1`.
- [ ] **6. Implementar.** `createSessionStore` (`sessions` da Fase 0; PK é a cookie: `randomUUID()`, `expires_at = now + ttlHours`, revogação = DELETE); `createAuthUserRepo` (email lowercase+trim; `dummyHash` = hash argon2 de constante gerado uma vez no arranque); `createLoginService`: limiter (`key = email|ip`) → verificação com `dummyHash` quando o utilizador não existe → `active === false` ⇒ `invalid_credentials` (mesma resposta) → ok: se `role === 'admin' && totpEnabledAt === null` ⇒ `mfa.startSetup` + sessão `mfaPending` ⇒ `mfa_setup_required`; audit `auth.login` (sucesso) e `auth.login_failed` (falha, `actorId: null`, `detail.email` sem password); `changePassword` valida a atual, aplica `assertPasswordPolicy`, `revokeAllForUser(userId, except sessionId atual)`, audit `auth.password_changed`. Relógio sempre via `deps.now()`.
- [ ] **7. Correr e ver passar.** → `pass, fail 0`; `npm run lint && npm run typecheck` → `0 erros`.
- [ ] **8. Commit.** `feat: add session login service with progressive rate limiting`

### Task 8: TOTP para `admin`

**Files:**
- Create: `src/infra/security/totp.ts`, `src/application/auth/mfa.ts`, `tests/unit/totp.test.ts`, `tests/integration/mfa.test.ts`
- Modify: `src/ports/security.ts` (acrescentar `Totp`)

**Interfaces:**
```ts
// src/ports/security.ts (adicionar)
export interface Totp {
  generateSecret(): string;                                              // 20 bytes → base32 RFC 4648 (32 chars)
  otpauthUrl(input: { secret: string; accountEmail: string; issuer: string }): string;
  verify(input: { secret: string; code: string; at?: Date; window?: number }): boolean;  // janela ±1 de 30s, window default 1
}
// src/infra/security/totp.ts
export function createTotp(): Totp;   // node:crypto HMAC-SHA1, RFC 6238 — sem dependências
export function encryptSecret(plain: string, authSecret: string): string;  // AES-256-GCM, chave = HKDF-SHA256(authSecret, info 'crm-totp'), retorna base64(iv|tag|ct)
export function decryptSecret(blob: string, authSecret: string): string;
// src/application/auth/mfa.ts — implementa MfaPort da Task 7
export function createMfaService(deps: { users: UserTotpRepo; sessions: SessionStore; totp: Totp;
  cfg: AuthConfig; audit: Audit; now(): Date }): MfaPort;
```

**Steps:**

- [ ] **1. Teste falhado** `tests/unit/totp.test.ts` (vetor oficial RFC 6238 — valores exatos):

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTotp, encryptSecret, decryptSecret } from '../../src/infra/security/totp.js';

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';  // secret ASCII "12345678901234567890"

test('RFC 6238: T=59s → 287082 (SHA1)', () => {
  const totp = createTotp();
  assert.equal(totp.verify({ secret: RFC_SECRET, code: '287082', at: new Date(59_000) }), true);
  assert.equal(totp.verify({ secret: RFC_SECRET, code: '000000', at: new Date(59_000) }), false);
  assert.equal(totp.verify({ secret: RFC_SECRET, code: '287082', at: new Date(89_000) }), true,  'janela -1 (30s)');
  assert.equal(totp.verify({ secret: RFC_SECRET, code: '287082', at: new Date(119_000) }), false, 'fora da janela');
});
test('otpauthUrl com issuer codificado', () => {
  const url = createTotp().otpauthUrl({ secret: RFC_SECRET, accountEmail: 'admin@test.local', issuer: 'MilVendas' });
  assert.equal(url, 'otpauth://totp/MilVendas:admin@test.local?secret=' + RFC_SECRET + '&issuer=MilVendas&algorithm=SHA1&digits=6&period=30');
});
test('encryptSecret/decryptSecret: roundtrip, IV distinto e chave errada falha', () => {
  const a = encryptSecret(RFC_SECRET, 'x'.repeat(32));
  const b = encryptSecret(RFC_SECRET, 'x'.repeat(32));
  assert.notEqual(a, b);
  assert.equal(decryptSecret(a, 'x'.repeat(32)), RFC_SECRET);
  assert.throws(() => decryptSecret(a, 'y'.repeat(32)));
});
```

- [ ] **2. Correr e ver falhar.** `npm test -- tests/unit/totp.test.ts` → `fail 1`.
- [ ] **3. Implementar TOTP/cifra.** Base32 encode/decode próprios; HOTP: `HMAC-SHA1(secretBytes, floor(t/30))` big-endian 4 bytes → código 6 dígitos com `padStart`; comparação em tempo constante (`timingSafeEqual` sobre buffers de mesmo tamanho); `otpauthUrl` conforme o asserção exata; `encryptSecret` com `hkdfSync('sha256', authSecret, '', 'crm-totp', 32)` + IV aleatório de 12 bytes.
- [ ] **4. Teste falhado** `tests/integration/mfa.test.ts`: `startSetup` persiste `totp_secret` **cifrado** (o valor base32 não aparece em claro na BD), `verifyAndFinish` com código correto limpa `mfaPending` e marca `totpEnabledAt`, código errado devolve `false` e não limpa; audit `auth.totp_enabled`.
- [ ] **5. Correr → falhar → implementar `createMfaService` → passar.** `npm run test:integration -- tests/integration/mfa.test.ts` → `pass, fail 0`.
- [ ] **6. Commit.** `feat: add rfc 6238 totp with encrypted secret storage`

### Task 9: App Fastify, guards, erros RFC 9457, OpenAPI e `buildTestApp`

**Files:**
- Create: `src/adapters/http/app.ts`, `src/adapters/http/guards.ts`, `src/adapters/http/errors.ts`, `src/adapters/http/routes/auth.ts`, `tests/helpers/http.ts`, `tests/helpers/fake-messaging.ts`, `tests/integration/auth-routes.test.ts`, `tests/integration/http-foundations.test.ts`, `tests/unit/lint-wa-akg-isolation.test.ts`
- Modify: `src/infra/main.ts` (escuta HTTP + graceful shutdown com o queue/io da Fase 0), `eslint.config.*` da Fase 0 (regra `no-restricted-imports`), `tests/helpers/` documentado na árvore de `docs/02` §1 (feito na Task 1)

**Interfaces:**
```ts
// src/adapters/http/guards.ts
export interface AuthContext { sessionId: string; userId: string; role: Role; mfaPending: boolean; ip: string; }
export function authenticate(deps: { sessions: SessionStore }): preHandlerHookHandler;
   // sem sessão/expirada → 401 problem 'unauthenticated'; mfaPending fora da allowlist → 403 'mfa_required'
   // allowlist: POST /v1/auth/totp/setup, POST /v1/auth/totp/verify, POST /v1/auth/logout
export function requireRole(...roles: Array<Role | Role[]>): preHandlerHookHandler;
   // achata arrays: requireRole('admin') e requireRole(['editor','admin']) — papel insuficiente → 403 'forbidden'
export function csrfGuard(): onRequestHookHandler;
   // POST/PATCH/DELETE autenticados por cookie: header 'x-csrf-token' === cookie 'csrf' (timingSafeEqual) → senão 403 'csrf_invalid'
// src/adapters/http/errors.ts
export type ProblemJson = { type: string; title: string; status: number; detail?: string; requestId?: string };
export function toProblem(err: unknown, requestId: string): { status: number; body: ProblemJson };
   // DomainError(code)→mapa do domínio; validação zod→400 'validation_failed'; sessão→401; papel/CSRF→403;
   // Idempotency-Key repetida com corpo diferente→409; rate/lockout→429 (com 'Retry-After'); resto→500 'internal_error' sem stack
// src/adapters/http/app.ts
export interface HttpDeps {
  cfg: AppConfig & { auth: AuthConfig; messaging: MessagingConfig };
  db: DbClient; audit: Audit; login: ReturnType<typeof createLoginService>; mfa: MfaPort;
  users?: UsersRepository; accounts?: AccountsRepository; accountLifecycle?: AccountLifecycle;
  outbox?: Outbox; messagingProvider?: MessagingProvider; jobs?: JobQueue;
  realtime?: { io: Server }; logger: Logger; now(): Date;
}
export function buildHttpApp(deps: HttpDeps): Promise<FastifyInstance>;   // rotas registadas = só as criadas até à task corrente
// tests/helpers/http.ts
export interface TestApp extends FastifyInstance {
  sessions: Record<'agent' | 'editor' | 'admin', string>;   // valor da cookie 'session'
  csrf: Record<'agent' | 'editor' | 'admin', string>;       // valor do cookie 'csrf' (para header 'x-csrf-token')
  users: Record<'agent' | 'editor' | 'admin', { id: string; email: string; role: Role }>;
  messaging: FakeMessaging;
  realtime?: { io: Server };
  close(): Promise<void>;                                   // sobrepõe o close do Fastify: fecha io + queue + servidor
}
export function buildTestApp(opts?: { config?: Partial<AuthConfig & MessagingConfig> }): Promise<TestApp>;
// tests/helpers/fake-messaging.ts
export function createFakeMessaging(): {
  provider: MessagingProvider;
  sendTextCalls: Array<{ sessionId: string; to: string; text: string; idempotencyKey: string }>;
  sendMediaCalls: Array<unknown>;
  queueResult(r: SendResult | Error): void;   // respostas programadas; por omissão 'accepted'
};
```

**Steps:**

- [ ] **1. Teste falhado** `tests/integration/http-foundations.test.ts` (raw body + isolamento do adaptador + estática de envios):

```ts
test('raw body preservado: o Buffer é byte a byte o corpo enviado', async () => {
  const app = await buildTestApp();
  app.get('/v1/probe-raw', async (req) => ({ len: req.rawBody?.length ?? 0, sha: createHash('sha256').update(req.rawBody ?? '').digest('hex') }));
  const raw = '{"a":"contraseña ≠ ascii"}';
  const res = await app.inject({ method: 'POST', url: '/v1/probe-raw', headers: { 'content-type': 'application/json' }, payload: raw });
  assert.equal(res.json().sha, createHash('sha256').update(raw).digest('hex'));
  await app.close();
});
```

```ts
// tests/unit/lint-wa-akg-isolation.test.ts
test('ESLint proíbe importar src/adapters/wa-akg fora de src/infra', async () => {
  const probe = 'import { createWaAkgAdapter } from "../../adapters/wa-akg/index.js";\nexport const x = createWaAkgAdapter;\n';
  const eslint = new Linter(); // com a config real do projeto
  const msgs = await lintTextFile(probe, 'src/application/__probe.ts');
  assert.ok(msgs.some((m) => m.ruleId === 'no-restricted-imports'), 'regra deve disparar no probe');
  const ok = await lintProject();                       // npm run lint sobre src/ e tests/
  assert.equal(ok.errorCount, 0);                       // código real limpo
});
test('sendText/sendMedia só aparecem no adaptador e no worker da outbox (análise estática)', () => {
  const hits = walkTsFiles('src').filter((f) =>
    !f.startsWith('src/adapters/wa-akg/') && f !== 'src/application/outbox-worker.ts' &&
    /\.send(Text|Media)\s*\(/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(hits, [], 'envio direto fora da outbox');
});
```

- [ ] **2. Correr e ver falhar.** `npm run test:integration -- tests/integration/http-foundations.test.ts && npm test -- tests/unit/lint-wa-akg-isolation.test.ts` → `fail` (`req.rawBody` inexistente; regra ESLint ausente).
- [ ] **3. Implementar fundamentos do HTTP.**
  - `app.ts`: registar `@fastify/swagger`; parser de conteúdo JSON `parseAs: 'buffer'` que preenche `request.rawBody` (module augmentation, sem `any`) e faz `JSON.parse` → 400 problem em caso inválido; `bodyLimit: deps.cfg.auth.bodyLimitBytes`; `@fastify/rate-limit` global `max: httpRateMax`, `timeWindow: httpRateWindowMs`; hook de erros único → `toProblem` + `Content-Type: application/problem+json` + `requestId` no body; logger com `requestId` (Fase 0) e sem corpos de mensagem/PIDs inteiros.
  - ESLint: `no-restricted-imports` com `files: ['src/**']`, `ignore: ['src/infra/**', 'src/adapters/wa-akg/**']`, padrão `**/adapters/wa-akg/*`, mensagem `WA-AKG é acessível só do composition root (docs/04 §5)`.
  - `guards.ts` e `errors.ts` conforme a Interfaces.
  - `main.ts`: `loadFullConfig` (Task 4), `buildHttpApp`, escuta, e graceful shutdown (SIGTERM/SIGINT: para de aceitar ligações, fecha servidor → io → queue).
- [ ] **4. Teste falhado** `tests/integration/auth-routes.test.ts`:

```ts
test('login, me, logout e CSRF', async () => {
  const app = await buildTestApp();
  const noSess = await app.inject({ method: 'POST', url: '/v1/auth/password', payload: { currentPassword: 'a', newPassword: 'b' } });
  assert.equal(noSess.statusCode, 401);
  const noCsrf = await app.inject({ method: 'POST', url: '/v1/auth/password',
    cookies: { session: app.sessions.admin }, payload: { currentPassword: 'senha-muito-forte-123', newPassword: 'outra-senha-forte-12' } });
  assert.equal(noCsrf.statusCode, 403);
  assert.match(noCsrf.json().detail, /csrf/i);
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: app.users.agent.email, password: 'senha-muito-forte-123' } });
  assert.equal(login.statusCode, 200);
  assert.ok(login.headers['set-cookie'].some((c: string) => c.startsWith('session=') && /HttpOnly/.test(c) && /SameSite=Lax/.test(c)));
  const me = await app.inject({ method: 'GET', url: '/v1/auth/me', cookies: { session: app.sessions.agent } });
  assert.deepEqual(me.json().role, 'agent');
  const adminOnly = await app.inject({ method: 'POST', url: '/v1/users',
    cookies: { session: app.sessions.agent }, headers: { 'x-csrf-token': app.csrf.agent }, payload: {} });
  assert.equal(adminOnly.statusCode, 403);
  const logout = await app.inject({ method: 'POST', url: '/v1/auth/logout', cookies: { session: app.sessions.agent }, headers: { 'x-csrf-token': app.csrf.agent } });
  assert.equal(logout.statusCode, 204);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/auth/me', cookies: { session: app.sessions.agent } })).statusCode, 401);
  await app.close();
});
test('admin pendente de TOTP: /v1/auth/me → 403 mfa_required; totp/verify → 200', async () => {
  const app = await buildTestApp();
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: app.users.admin.email, password: 'senha-muito-forte-123' } });
  assert.equal(login.json().mfa, 'setup');
  const pending = login.cookies.session as { value: string };
  assert.equal((await app.inject({ method: 'GET', url: '/v1/auth/me', cookies: { session: pending.value } })).statusCode, 403);
  // secret está cifrado na BD; calcular o código com decryptSecret + createTotp() e submeter:
  const ok = await app.inject({ method: 'POST', url: '/v1/auth/totp/verify', cookies: { session: pending.value },
    headers: { 'x-csrf-token': login.cookies.csrf.value }, payload: { code } });
  assert.equal(ok.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/auth/me', cookies: { session: pending.value } })).statusCode, 200);
  await app.close();
});
```

- [ ] **5. Correr e ver falhar.** `npm run test:integration -- tests/integration/auth-routes.test.ts` → `fail 1` (rotas inexistentes → 404).
- [ ] **6. Implementar rotas de auth.**
  - `POST /v1/auth/login` (zod `{ email, password }`; isento de CSRF): mapeia `LoginResult` → `ok`/`mfa_required`/`mfa_setup_required` = 200 com cookies `session` (HttpOnly, SameSite=Lax, Path=/, `Secure` se `NODE_ENV==='production'`, `Expires=expiresAt`) e `csrf` (leitura JS); `invalid_credentials` = 401 problem genérico; `rate_limited` = 429 + header `Retry-After`. Exceção de rate: rota regista `max: loginRateMax`, `timeWindow: loginRateWindowMs` no `@fastify/rate-limit`.
  - `POST /v1/auth/logout` (204, revoga sessão se existir, apaga cookies), `GET /v1/auth/me` (200 `{id,name,email,role}`; garante cookie `csrf` se ausente), `POST /v1/auth/password` (`currentPassword`/`newPassword`, `assertPasswordPolicy`, revoga as outras sessões, audit `auth.password_changed`).
  - `POST /v1/auth/totp/setup` (pendente; devolve `otpauthUrl`, idempotente) e `POST /v1/auth/totp/verify` (`{ code }`, rate `max: 10/timeWindow 1 min`, sucesso ⇒ sessão não-pendente, audit `auth.totp_enabled`).
  - OpenAPI: registar schemas zod via `z.toJSONSchema` (confirmar `npm ls zod`; v3 ⇒ `zod-to-json-schema`, registar a escolha no ADR-0006), servir `GET /v1/openapi.json` (autenticado, qualquer papel) e `/health/live` + `/health/ready` públicos (ready: db, Redis, `messagingProvider.health()` com timeout 2s → 503 se algum falhar).
- [ ] **7. Teste falhado de `buildTestApp`** (no mesmo ficheiro de auth-routes): `const app = await buildTestApp(); assert.ok(app.sessions.agent && app.sessions.editor && app.sessions.admin && app.csrf.admin && app.users.admin.id);` + reset de BD entre apps (segunda `buildTestApp` não vê dados da primeira) — correr, falhar, implementar (`migratedDb`/`resetDb` da Task 1, utilizadores sintéticos um por papel com a mesma password de teste `senha-muito-forte-123`, MfaPort fake com código fixo `123456`, login direto na criação das cookies), correr → `pass, fail 0`.
- [ ] **8. lint/typecheck e prova estática.** `npm run lint && npm run typecheck` → `0 erros`; `npm test -- tests/unit/lint-wa-akg-isolation.test.ts` → `pass 2, fail 0`.
- [ ] **9. Commit.** `feat: add fastify app with session guards csrf and problem json errors`

### Task 10: API de utilizadores

**Files:**
- Create: `src/ports/users.ts`, `src/adapters/db/users.ts`, `src/adapters/http/routes/users.ts`, `tests/integration/users-api.test.ts`

**Interfaces:**
```ts
// src/ports/users.ts
export interface UsersRepository {
  create(input: { name: string; email: string; role: Role; passwordHash: string; now: Date }): Promise<{ id: string }>;
  list(): Promise<Array<{ id: string; name: string; email: string; role: Role; active: boolean; createdAt: Date }>>;
  get(id: string): Promise<{ id: string; name: string; email: string; role: Role; active: boolean; createdAt: Date } | null>;
  update(id: string, patch: { name?: string; role?: Role; active?: boolean; passwordHash?: string; now: Date }): Promise<boolean>;
  countActiveAdmins(): Promise<number>;
}
export function createUsersRepository(db: DbClient): UsersRepository;
// Rotas (todas requireRole('admin'), sessão + CSRF):
//   POST   /v1/users                  01 {name,email,role,password}        → 201 {user}
//   GET    /v1/users                  → 200 {users}
//   PATCH  /v1/users/:id              {name?,role?,active?,password?}      → 200 {user}
```

**Steps:**

- [ ] **1. Teste falhado** `tests/integration/users-api.test.ts`:

```ts
test('RBAC e guarda do último admin', async () => {
  const app = await buildTestApp();
  const post = (s: string, csrf: string, payload: unknown) => app.inject({ method: 'POST', url: '/v1/users',
    cookies: { session: s }, headers: { 'x-csrf-token': csrf }, payload });
  assert.equal((await app.inject({ method: 'GET', url: '/v1/users' })).statusCode, 401);
  assert.equal((await post(app.sessions.agent, app.csrf.agent, {})).statusCode, 403);
  const created = await post(app.sessions.admin, app.csrf.admin,
    { name: 'Novo', email: 'NOVO@test.local', role: 'agent', password: 'senha-muito-forte-123' });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().email, 'novo@test.local', 'email normalizado para minúsculas');
  const dup = await post(app.sessions.admin, app.csrf.admin,
    { name: 'Novo', email: 'novo@test.local', role: 'agent', password: 'senha-muito-forte-123' });
  assert.equal(dup.statusCode, 409);
  // último admin: remover o papel ao próprio → 403; desativar o outro admin → 409
  assert.equal((await app.inject({ method: 'PATCH', url: `/v1/users/${app.users.admin.id}`,
    cookies: { session: app.sessions.admin }, headers: { 'x-csrf-token': app.csrf.admin }, payload: { role: 'agent' } })).statusCode, 403);
  await app.close();
});
test('reset de palavra-passe invalida as sessões do utilizador alvo', async () => {
  // PATCH password → cookie antigo do alvo → 401; audit 'user.password_reset'
});
```

- [ ] **2. Correr e ver falhar.** → `fail 1` (404).
- [ ] **3. Implementar.** `createUsersRepository` (email `lower(trim())` único; `update` devolve `false` se não existir); rota com zod por método; guardas: auto-mutação de `role`/`active` → 403 `cannot_modify_self`; `countActiveAdmins() === 1` e a mutação tira um admin de circulação → 409 `last_admin`; `password` usa `assertPasswordPolicy` + hasher + `revokeAllForUser` do alvo; `role`/`active` mudados revogam as sessões do alvo; audit `user.created`, `user.updated`, `user.role_changed`, `user.deactivated`, `user.password_reset` (com `at` do relógio injetado, `ip` do pedido); erros `DomainError` → mapa do `toProblem` (400/404/409).
- [ ] **4. Correr e ver passar.** → `pass, fail 0`; `npm run lint && npm run typecheck` → `0 erros`.
- [ ] **5. Commit.** `feat: add users management api with rbac`

### Task 11: Adaptador WA-AKG

**Files:**
- Create: `src/adapters/wa-akg/index.ts`, `src/adapters/wa-akg/http.ts`, `src/adapters/wa-akg/schemas.ts`, `src/adapters/wa-akg/README.md`, `tests/unit/wa-akg-adapter.test.ts`
- Modify: nenhum ficheiro fora de `src/adapters/wa-akg/`

**Interfaces:**
```ts
// src/adapters/wa-akg/index.ts
export function createWaAkgAdapter(opts: {
  baseUrl: string; apiKey: string; webhookSecret: string;
  sendTimeoutMs: number; cbThreshold: number; cbCooldownMs: number;
  fetchImpl?: typeof fetch; now?: () => Date; sleep?: (ms: number) => Promise<void>;
}): MessagingProvider;   // name = 'wa-akg'
```

**Steps:**

- [ ] **1. Extrair o mapa da auditoria (sem inventar).** De `docs/wa-akg-audit.md` §A (perguntas 1–4) transcrever para `src/adapters/wa-akg/README.md` a tabela: método + caminho + auth (header exato) + corpo + resposta para criar sessão, obter QR, estado, logout, enviar texto, enviar mídia, saúde; e de §B a semântica de timeout/idempotência (pergunta 3). **Se algum destes 7 endpoints estiver `Refutado`/`Não verificável`, ou a autenticação não estiver confirmada com `ficheiro:linha`: parar e perguntar ao humano** (gate da Fase 0) — não escrever o adaptador contra endpoints supostos.
- [ ] **2. Teste falhado** `tests/unit/wa-akg-adapter.test.ts` (fetch injetado — sem rede):

```ts
test('mapeamento de resultados: 200 com id → accepted; 422 → rejected; AbortError → unknown sem retry', async () => {
  const calls: unknown[] = [];
  const okAdapter = createWaAkgAdapter({ ...cfg, fetchImpl: (async (url: string, init: unknown) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: 'wamid.ABC' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch });
  const r = await okAdapter.sendText({ sessionId: 's1', to: '+244923111222', text: 'olá', idempotencyKey: 'k1' });
  assert.deepEqual(r, { providerMessageId: 'wamid.ABC', outcome: 'accepted' });
  // header de auth e campos do corpo EXATAMENTE como documentados no README/auditoria
  assert.equal(calls.length, 1);

  const rejected = createWaAkgAdapter({ ...cfg, fetchImpl: (async () =>
    new Response(JSON.stringify({ error: 'invalid number' }), { status: 422 })) as typeof fetch });
  const rr = await rejected.sendText({ sessionId: 's1', to: '+244923111222', text: 'olá', idempotencyKey: 'k1' });
  assert.equal(rr.outcome, 'rejected');
  assert.ok(rr.error);

  const slow = createWaAkgAdapter({ ...cfg, sendTimeoutMs: 5, fetchImpl: (async (_u: string, init: { signal: AbortSignal }) =>
    new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))))) as typeof fetch });
  const ur = await slow.sendText({ sessionId: 's1', to: '+244923111222', text: 'olá', idempotencyKey: 'k1' });
  assert.deepEqual(ur, { providerMessageId: null, outcome: 'unknown' });
});
test('circuit breaker: cbThreshold falhas consecutivas abrem; após cbCooldownMs volta a meia-abertura', async () => {
  let t = 0; const now = () => new Date(t);
  let n = 0;
  const a = createWaAkgAdapter({ ...cfg, cbThreshold: 2, cbCooldownMs: 30000, now,
    fetchImpl: (async () => { n++; throw new TypeError('fetch failed'); }) as typeof fetch });
  await assert.rejects(() => a.health()); await assert.rejects(() => a.health());
  await assert.rejects(() => a.health());            // 3.ª: breaker deve estar aberto → CircuitOpenError
  assert.equal(n, 2, 'não chamou a rede com o breaker aberto');
  t += 30_001;
  await a.health();                                   // meia-abertura: uma chamada de teste
  assert.equal(n, 3);
});
```

- [ ] **3. Correr e ver falhar.** `npm test -- tests/unit/wa-akg-adapter.test.ts` → `fail 2`.
- [ ] **4. Implementar.** `http.ts`: `fetch` com `AbortSignal.timeout(sendTimeoutMs)`, headers de auth exatos da auditoria, `ProviderUnavailableError` em rede/timeout de ligação/5xx/401-nosso-lado, validação zod de **toda** a resposta (`schemas.ts`) — resposta inesperada ⇒ erro, nunca adivinhar; `index.ts`: 7 métodos do port com o mapeamento de `README.md`, `verifyAndParseWebhook` isolado para a Task 12; breaker por instância (`cbThreshold` consecutivas `ProviderUnavailableError` ⇒ `CircuitOpenError` durante `cbCooldownMs`, meio-sucesso fecha); normalização de telefone com `normalizePhoneE164`; nenhum tipo do WA-AKG para fora do diretório.
- [ ] **5. Correr e ver passar.** → `pass 2, fail 0`; `npm run lint` com a regra da Task 9 → o adaptador não é importado fora de `src/infra` → `0 erros`.
- [ ] **6. Commit.** `feat: add wa-akg messaging adapter with circuit breaker`

### Task 12: `verifyAndParseWebhook` e helper de assinatura

**Files:**
- Create: `src/adapters/wa-akg/webhook.ts`, `src/ports/provider-events.ts`, `tests/helpers/webhook.ts`, `tests/unit/webhook-verify.test.ts`
- Modify: `src/adapters/wa-akg/index.ts` (método do port), `src/adapters/wa-akg/schemas.ts` (esquemas zod dos payloads capturados)

**Interfaces:**
```ts
// src/ports/provider-events.ts — schema de runtime junto ao tipo (fronteira; usado pelo adaptador e pelo job)
export type { ProviderEvent, SessionStatus } from './messaging-provider.js';
export const providerEventSchema: ZodType<ProviderEvent>;
export function parseProviderEvent(payload: unknown): ProviderEvent;   // lança WebhookError('payload_invalid')

// MessagingProvider.verifyAndParseWebhook (docs/04 §5) — implementação em src/adapters/wa-akg/webhook.ts
// verifyAndParseWebhook(headers, rawBody): ProviderEvent[]
//   1) recomputa a assinatura sobre rawBody e compara em tempo constante (timingSafeEqual);
//   2) valida com providerEventSchema; 3) eventos de tipo desconhecido com assinatura válida → ignorados (log) e não lançam.

// tests/helpers/webhook.ts
export function signWebhook(rawBody: Buffer, secret: string, opts?: { at?: Date }): Record<string, string>;
   // devolve os headers EXATOS do esquema documentado em docs/wa-akg-audit.md §B
```

**Steps:**

- [ ] **1. Gate da assinatura.** Ler `docs/wa-akg-audit.md` §B (perguntas 5–8). Casos: (a) HMAC confirmado → implementar o esquema exato (header, algoritmo, formato hex/base64, janela de timestamp se existir); (b) só segredo partilhado → comparar header com `WA_WEBHOOK_SECRET` em tempo constante e registar em `docs/schema-base`/relatório que a proteção é segredo+rede (`docs/03` §5); (c) **nenhuma** das duas → parar e perguntar: é gate de `docs/03` §5, não se avança a Task 12 sem decisão humana.
- [ ] **2. Teste falhado** `tests/unit/webhook-verify.test.ts` (vetores calculados com o esquema auditado; corpo de exemplo sintético):

```ts
test('assinatura válida → eventos normalizados; corpo alterado ou assinatura errada → lança', () => {
  const raw = Buffer.from(JSON.stringify({ /* captura real de docs/wa-akg-audit.md §B, campos sintéticos */ }));
  const headers = signWebhook(raw, 's'.repeat(32));
  const adapter = createWaAkgAdapter(cfg);
  const events = adapter.verifyAndParseWebhook(headers, raw);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'message.received');
  assert.equal(events[0].sessionId, 'sess-test-1');
  assert.ok((events[0] as { message: { from?: string } }));  // 'from' normalizado a E.164 pela função única
  const tampered = Buffer.concat([raw, Buffer.from(' ')]);
  assert.throws(() => adapter.verifyAndParseWebhook(headers, tampered), /invalid_signature/);
  assert.throws(() => adapter.verifyAndParseWebhook({ ...headers, 'x-signature': '0'.repeat(64) }, raw), /invalid_signature/);
});
test('payload válido mas desconhecido (evento novo do WA-AKG) é ignorado sem lançar', () => {
  const raw = Buffer.from(JSON.stringify({ type: 'future.event', id: 'e9' }));
  const headers = signWebhook(raw, 's'.repeat(32));
  assert.deepEqual(createWaAkgAdapter(cfg).verifyAndParseWebhook(headers, raw), []);
});
```

- [ ] **3. Correr e ver falhar.** `npm test -- tests/unit/webhook-verify.test.ts` → `fail 1`.
- [ ] **4. Implementar.** `webhook.ts`: extrair o header de assinatura (nomes exatos da auditoria), `timingSafeEqual` sobre buffers de igual tamanho (tamanhos diferentes ⇒ inválido), parse JSON do `rawBody`, validação por evento; `provider-events.ts` com os esquemas zod construídos a partir das capturas reais de `docs/wa-akg-audit.md` §B (campo a campo — **sem inventar nomes**); `from` passa por `normalizePhoneE164` (inválido ⇒ `payload_invalid`); timestamps → `Date` UTC; tipo `message.kind` fora do union documentado ⇒ `'other'`. `signWebhook` espelha o esquema (o teste de cima é o espelho).
- [ ] **5. Correr e ver passar.** → `pass 2, fail 0`.
- [ ] **6. Commit.** `feat: verify wa-akg webhooks over raw body with constant time compare`

### Task 13: Mock fiel, testes de contrato e CI

**Files:**
- Create: `tests/contract/mock-wa-akg.ts`, `tests/contract/wa-akg-contract.test.ts`
- Modify: `package.json` (script `test:contract`), workflow de CI da Fase 0 (passo `npm run test:contract`)

**Interfaces:**
```ts
// tests/contract/mock-wa-akg.ts — servidor node:http efémero fiel a docs/wa-akg-audit.md
export function startMockWaAkg(opts?: { failAuth?: boolean; malformed?: boolean }): Promise<{
  baseUrl: string; received: Array<{ method: string; path: string; headers: Record<string, string>; body: unknown }>;
  close(): Promise<void>;
}>;
// tests/contract/wa-akg-contract.test.ts
// npm run test:contract  →  node --test tests/contract/   (mesmos flags do runner da Fase 0)
```

**Steps:**

- [ ] **1. Construir o mock da auditoria.** Uma rota por endpoint marcado em `docs/wa-akg-audit.md` §A, com: mesmo caminho/método, mesma autenticação exigida, mesmo shape de resposta de sucesso (capturas), 401 com header errado, 400 de validação, JSON malformado num caso e rota lenta (`delay > sendTimeoutMs`) num caso. Sem achado na auditoria para um endpoint que precisamos → parar e perguntar (regra 3 do `AGENTS.md`).
- [ ] **2. Teste falhado** `tests/contract/wa-akg-contract.test.ts`:

```ts
test('contrato: sendText envia auth+corpo esperados e valida a resposta', async () => {
  const mock = await startMockWaAkg();
  try {
    const a = createWaAkgAdapter({ ...cfgFromMock(mock.baseUrl), sendTimeoutMs: 100 });
    const r = await a.sendText({ sessionId: 's1', to: '+244923111222', text: 'olá', idempotencyKey: 'k-1' });
    assert.equal(r.outcome, 'accepted');
    const req = mock.received.find((x) => x.method === 'POST' && x.path === PATH_SEND_TEXT_DO_AUDIT);
    assert.equal(req?.headers[AUTH_HEADER_DO_AUDIT], 'test-key');
    assert.equal((req?.body as { to?: string }).to, '+244923111222');   // campo exato documentado
  } finally { await mock.close(); }
});
test('contrato: timeout → unknown e a MESMA chamada não se repete', async () => {
  const mock = await startMockWaAkg({ slow: true });
  try {
    const a = createWaAkgAdapter({ ...cfgFromMock(mock.baseUrl), sendTimeoutMs: 30 });
    const r = await a.sendText({ sessionId: 's1', to: '+244923111222', text: 'olá', idempotencyKey: 'k-1' });
    assert.deepEqual(r, { providerMessageId: null, outcome: 'unknown' });
  } finally { await mock.close(); }
});
test('contrato: resposta inesperada é rejeitada (nunca adivinha)', async () => {
  const mock = await startMockWaAkg({ malformed: true });
  // sendText/getSession → lança erro de schema, nunca devolve campo inventado
});
```

- [ ] **3. Correr e ver falhar.** `npm run test:contract` → `fail` (script inexistente / rotas do mock em falta).
- [ ] **4. Implementar.** `mock-wa-akg.ts` conforme o passo 1; testar os 7 métodos do port (sucesso + autenticação errada + malformado + lento) e `health()`; adicionar `"test:contract": "<runner da Fase 0> tests/contract/"` ao `package.json` e o passo ao workflow de CI (junto aos restantes testes; `npm audit --audit-level=high` já existe na Fase 0 — confirmar).
- [ ] **5. Correr e ver passar.** `npm run test:contract` → `pass, fail 0`; `npm run lint && npm run typecheck` → `0 erros`.
- [ ] **6. Commit.** `test: add wa-akg contract tests against audited mock` e `chore: run contract tests in ci`

### Task 14: `createOrchestratorPorts` e `releaseClaim`

**Files:**
- Create: `src/adapters/db/orchestrator-ports.ts`, `src/domain/question.ts`, `tests/integration/orchestrator-ports.test.ts`

**Interfaces:**
```ts
// src/domain/question.ts (partilhado com a Fase 2 — eles reutilizam, não redefinem)
export function normalizeQuestion(text: string): string;   // trim + minúsculas + espaços colapsados

// src/adapters/db/orchestrator-ports.ts
export function createOrchestratorPorts(deps: {
  db: DbClient;
  notifySink: (e: NotifyEvent) => Promise<void>;
  claimTtlMs: number;                 // WA_CLAIM_TTL_MS
  now(): Date;                        // usado como $now em TODO o SQL (relógio controlado)
  retrieve?: Ports['retrieve'];       // default: async () => []  (Fase 2/3 ligam searchChunks + embeddings)
  turnsLimit?: number;                // default 20
}): Ports & { releaseClaim(eventId: string): Promise<void> };
```

**Steps:**

- [ ] **1. Teste falhado** `tests/integration/orchestrator-ports.test.ts` (Postgres real; `msg.id` é o id do evento — contrato com a Fase 3):

```ts
test('claimMessage: true, false, stale re-claim após claimTtlMs e releaseClaim', async () => {
  let t = Date.parse('2026-10-07T10:00:00.000Z');
  const ports = createOrchestratorPorts({ db, notifySink: sink, claimTtlMs: 60000, now: () => new Date(t) });
  const evId = (await insertInboundEvent()).id;
  assert.equal(await ports.claimMessage(evId), true);
  assert.equal(await ports.claimMessage(evId), false);       // outro worker não entra
  t += 60_001;                                                // claim expirou (crash a meio)
  assert.equal(await ports.claimMessage(evId), true);
  await ports.releaseClaim(evId);                             // caminho de erro da Task 19
  assert.equal(await ports.claimMessage(evId), true);
});
test('estado: saveState grava ai_mode, miss_streak e qualification no lead; loadState devolve turnos incluindo a atual', async () => {
  // conversa com 2 mensagens guardadas → loadState → turns.length === 2 e o último é o do cliente
  // saveState({ aiMode: 'human_only', missStreak: 1, answers: { empresa: 'MilVendas' } }) → reload igual
});
test('conhecimento: só itens publicados e válidos; gatilhos globais + da linha; notify em pass-through', async () => {
  // inserir: regra da linha + regra global expirada; pergunta; gatilho global e da linha; chunk publicado e chunk draft
  // rules(line) → só a da linha e a global ativa; triggers(line) → ambos; retrieve → usa deps.retrieve (default [])
  // createHandoff → id; bumpHandoffPriority('normal' → 'high') sobe, ('high' → 'normal') não desce
  // recordGap 2× com o mesmo texto → knowledge_gaps.count === 2 (normalizeQuestion)
  // notifySink recebe { type: 'handoff', handoffId, prioridade extra: 'x' } intacto (pass-through da Fase 3)
});
```

- [ ] **2. Correr e ver falhar.** `npm run test:integration -- tests/integration/orchestrator-ports.test.ts` → `fail 1`.
- [ ] **3. Implementar** os 14 métodos de `Ports` (`reference/ai-provider.ts` → `src/ports/ai-provider.ts`) + `releaseClaim`, com SQL parametrizado (`sql\`\``, nunca concat), tudo com `$now = deps.now()`:
  - `claimMessage(id)` → `UPDATE inbound_events SET ai_claimed_at = $now WHERE id = $1 AND (ai_claimed_at IS NULL OR ai_claimed_at < $now - make_interval(secs => $ttl)) RETURNING id` (linha ⇒ `true`); `releaseClaim(id)` → `SET ai_claimed_at = NULL`.
  - `loadState` → conversa (`ai_mode`, `miss_streak`, `line` via `business_lines.slug`, `lead_id`) + `leads.qualification` (answers) + últimos `turnsLimit` mensagens como `Turn[]` (inbound → turno do cliente, outbound → turno da IA; ordenado por `created_at` asc; a mensagem atual já está guardada — `docs/05` §3); `saveState` → transação: `UPDATE conversations` (só os campos do patch) + `UPDATE leads SET qualification` se houver lead.
  - `retrieve` = `deps.retrieve ?? (async () => [])` (comment: ligar `searchChunks` é Fase 2/3); `lookupCatalog` → `catalog_items` com `status='published'` e dentro de `valid_from/valid_until` da linha; `rules`/`questions`/`triggers` → ativos/publicados, globais (`line IS NULL`) + da linha (a da linha prevalece — o orquestrador já resolve por código).
  - `findOpenHandoff` (`status='pending'`), `createHandoff` (INSERT … RETURNING), `bumpHandoffPriority` (sobe só, por rank `normal<high<urgent` em `CASE`), `recordGap` (upsert por `normalizeQuestion`), `saveTrace` (INSERT `answer_traces`), `notify` → `deps.notifySink(e)` sem tocar no payload.
- [ ] **4. Correr e ver passar.** → `pass 3, fail 0`; `npm run lint && npm run typecheck` → `0 erros`.
- [ ] **5. Commit.** `feat: implement orchestrator ports over database`

### Task 15: Socket.IO, salas e `createSocketNotify`

**Files:**
- Create: `src/adapters/realtime/socket.ts`, `tests/integration/realtime.test.ts`
- Modify: `src/infra/main.ts` (attach ao servidor HTTP + fecho no graceful shutdown), `tests/helpers/http.ts` (campo `realtime`)

**Interfaces:**
```ts
// src/adapters/realtime/socket.ts
export const NOTIFY_EVENTS = ['handoff.created', 'handoff.updated', 'message.created', 'message.status', 'account.status'] as const;
export type NotifyEvent = { type: 'handoff' | 'flag' | 'alert' | 'message' | 'account'; phase?: string; [k: string]: unknown };
export interface SocketIoLike { to(room: string): { emit(event: string, payload: unknown): unknown } }
export function createSocketNotify(io: SocketIoLike): (e: NotifyEvent) => Promise<void>;
// mapeamento: handoff+phase 'updated' → handoff.updated | handoff(sem phase) → handoff.created | flag → handoff.created
//             alert → handoff.updated (leva 'reason') | message+phase 'created' → message.created | message+phase 'status' → message.status
//             account → account.status | tipo desconhecido → log warn e NÃO emite (só 5 eventos)
// salas: message.* → ['agent','editor','admin'] | handoff.* → ['handoffs'] | account.status → ['admin']
// payload: { v: 1, ...resto } sem 'type'/'phase'; pass-through dos restantes campos (ex.: outsideHours, opensAt)
export function attachRealtime(deps: { server: HTTPServer; sessions: SessionStore; now(): Date }):
  { io: Server; close(): Promise<void> };
```

**Steps:**

- [ ] **1. Teste falhado** `tests/integration/realtime.test.ts` (socket.io-client real):

```ts
test('salas por papel: agent vê message.created, editor NÃO vê handoff.created, admin vê account.status', async () => {
  const app = await buildTestApp();
  const agent = await connectClient(app, 'agent');   // handshake com cookie session=app.sessions.agent
  const editor = await connectClient(app, 'editor');
  const admin = await connectClient(app, 'admin');
  const got = collect(agent, 'message.created'); const noHandoff = collect(editor, 'handoff.created');
  const gotAcct = collect(admin, 'account.status'); const agentNoAcct = collect(agent, 'account.status');
  await app.realtime!.io.of('/').emit('message.created', { v: 1, messageId: 'm1' });  // via createSocketNotify
  await notify({ type: 'handoff', handoffId: 'h1', conversationId: 'c1', priority: 'high', reason: 'r' });
  await notify({ type: 'account', accountId: 'a1', status: 'connected' });
  assert.ok(await got); assert.equal(await noHandoff, null); assert.ok(await gotAcct); assert.equal(await agentNoAcct, null);
  await closeClients(); await app.close();
});
test('handshake sem sessão ou expirada → connect_error', async () => {
  const app = await buildTestApp();
  await assert.rejects(() => connectClientRaw(app, 'sessao-inexistente'), /unauthorized/);
  await app.close();
});
test('mapeamento: payload extra sobrevive e só saem os 5 eventos (espião de io.to().emit)', () => {
  const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
  const fake: SocketIoLike = { to: (room) => ({ emit: (event, payload) => { emitted.push({ room, event, payload }); } }) };
  const notify = createSocketNotify(fake);
  // (await notify({ type: 'handoff', outsideHours: true, opensAt: '2026-10-08T08:00:00Z', handoffId: 'h1', ... }))
  //   → evento 'handoff.created', payload { v: 1, outsideHours: true, opensAt: '...', handoffId: 'h1', ... }
  // (await notify({ type: 'handoff', phase: 'updated', handoffId: 'h1', ... })) → 'handoff.updated'
  // (await notify({ type: 'alert', reason: 'opening_pending', handoffId: 'h1' })) → 'handoff.updated'
  // (await notify({ type: 'message', phase: 'status', messageId: 'm1', status: 'sent' })) → 'message.status'
  // (await notify({ type: 'wat' })) → nenhum emit, 0 eventos
  assert.deepEqual(emitted.map((e) => e.event), ['handoff.created', 'handoff.updated', 'handoff.updated', 'message.status']);
  assert.ok(emitted.every((e) => (e.payload as { v: number }).v === 1));
});
```

- [ ] **2. Correr e ver falhar.** `npm run test:integration -- tests/integration/realtime.test.ts` → `fail 1`.
- [ ] **3. Implementar.** `socket.io` com `cookie` parseado no handshake (`sessions.get`, sem sessão ou expirada ⇒ `next(new Error('unauthorized'))`); `socket.join` na sala do papel + `handoffs` para `agent`/`admin` (`docs/02` §9); `createSocketNotify` conforme a Interfaces (payload em pass-through — é o contrato que a Fase 3 usa); `attachRealtime` devolve `io` e `close()`; ligar em `main.ts` (`httpServer` de dentro do Fastify) e no `close()` do `buildTestApp`.
- [ ] **4. Correr e ver passar.** → `pass 3, fail 0`; `npm run lint && npm run typecheck` → `0 erros`.
- [ ] **5. Commit.** `feat: add socket.io auth rooms and notify event mapping`

### Task 16: Ciclo de vida das contas WhatsApp

**Files:**
- Create: `src/ports/accounts.ts`, `src/adapters/db/accounts.ts`, `src/application/account-lifecycle.ts`, `src/adapters/http/routes/whatsapp-accounts.ts`, `tests/integration/account-lifecycle.test.ts`, `tests/integration/accounts-api.test.ts`

**Interfaces:**
```ts
// src/ports/accounts.ts
export type AccountStatus = 'connecting' | 'connected' | 'disconnected' | 'suspected_ban';  // docs/04 §6
export interface AccountsRepository {
  create(input: { label: string; purpose: 'support' | 'sales' | 'campaigns'; providerSessionId: string; now: Date }): Promise<{ id: string }>;
  list(): Promise<AccountRow[]>;
  get(id: string): Promise<AccountRow | null>;
  findByProviderSession(sessionId: string): Promise<AccountRow | null>;
  setStatus(id: string, status: AccountStatus, now: Date): Promise<boolean>;  // false se já nesse estado
  setPhone(id: string, phone: string | null): Promise<void>;
}
export interface AccountLifecycle {
  onSessionStatus(input: { sessionId: string; status: SessionStatus; at: Date }): Promise<void>;
  onQr(input: { sessionId: string; qr: string; at: Date }): Promise<void>;
  recordSendResult(input: { accountId: string; ok: boolean; at: Date }): Promise<void>;
}
export function createAccountLifecycle(deps: {
  accounts: AccountsRepository; provider: MessagingProvider; notifySink: (e: NotifyEvent) => Promise<void>;
  audit: Audit; cfg: { failWindow: number; failRatio: number }; now(): Date;
}): AccountLifecycle;
// Rotas (todas requireRole('admin'), sessão + CSRF):
//   POST /v1/whatsapp-accounts {label, purpose}      → 201 {account}   (adaptador.createSession)
//   GET  /v1/whatsapp-accounts                        → 200 {accounts}
//   GET  /v1/whatsapp-accounts/:id                    → 200 {account, qr?}   (qr = provider.getQr se connecting)
//   POST /v1/whatsapp-accounts/:id/logout             → 200 {account}   (provider.logout + disconnected + audit)
```

**Steps:**

- [ ] **1. Teste falhado** `tests/integration/account-lifecycle.test.ts`:

```ts
test('logged_out inesperado (connected) → suspected_ban; após logout de admin → no-op', async () => {
  await accounts.setStatus(acc.id, 'connected', now());
  await life.onSessionStatus({ sessionId, status: 'logged_out', at: now() });
  assert.equal((await accounts.get(acc.id))?.status, 'suspected_ban');
  assert.equal((await audits()).filter((a) => a.action === 'account.suspected_ban').length, 1);
  assert.ok((await notified()).some((n) => n.type === 'account' && n.status === 'suspected_ban'));
  // cenário 2: admin fez logout primeiro (estado já 'disconnected') → continua 'disconnected', sem audit novo
  await accounts.setStatus(acc2.id, 'disconnected', now());
  await life.onSessionStatus({ sessionId: sess2, status: 'logged_out', at: now() });
  assert.equal((await accounts.get(acc2.id))?.status, 'disconnected');
});
test('pico de falhas: 7 de 20 envios falhados (35% ≥ 30%) → suspected_ban; abaixo do limiar não muda', async () => {
  // 20 chamadas a recordSendResult(false) sete vezes, assert status; 6 falhas → permanece 'connected'
});
test('connected: telefone associa-se; reconexão de número de conta antiga desconectada migra o telefone', async () => {
  await life.onSessionStatus({ sessionId: sNew, status: 'connected', at: now() });  // getSession devolve +244923111222
  assert.equal((await accounts.get(newId))?.phoneE164, '+244923111222');
  assert.equal((await accounts.get(oldId))?.phoneE164, null);   // conta antiga desconectada perdeu o telefone
  assert.ok((await audits()).some((a) => a.action === 'account.phone_reassigned'));
});
```

- [ ] **2. Correr e ver falhar.** `npm run test:integration -- tests/integration/account-lifecycle.test.ts` → `fail 1`.
- [ ] **3. Implementar o ciclo de vida.** Tabela de transições (docs/04 §6), tudo com `setStatus` condicional (só emite audit/evento se a transição mudou algo):
  - `connected` → `connected`; guarda o `phone` de `provider.getSession` (`normalizePhoneE164`); conflito de `phone_e164` com outra conta **não-`connected`** → limpa o telefone da antiga + audit `account.phone_reassigned`; com conta `connected` (impossível na prática) → log de erro e telefone nulo.
  - `disconnected`/`unknown` → `disconnected`; `connecting`/`qr_pending` → mantém `connecting`.
  - `logged_out`: estado atual `connected` → `suspected_ban` + audit `account.suspected_ban` + alerta estruturado (bloqueia envios — o worker da Task 18 não envia contas `suspected_ban`; sem qualquer automação de recuperação); qualquer outro estado → no-op.
  - `onQr` → só notifica `{ type: 'account', status: 'connecting', accountId, qr }` (o QR também vai por evento, `docs/04` §6; o REST `GET :id` devolve-o por polling, `docs/02` §9).
  - `recordSendResult` → consulta as últimas `WA_FAIL_WINDOW` mensagens outbound da conta (por `updated_at` desc; usar `outbox_messages` se tiver `account_id`, senão `messages`) e se `falhas / janela >= WA_FAIL_RATIO` → `suspected_ban` (uma vez). Falha = estado `failed` (rejeição permanente); timeouts `unknown` **não** contam (ver lacunas).
  - Toda a transição → `notifySink({ type: 'account', accountId, status })`.
- [ ] **4. Teste falhado das rotas** `tests/integration/accounts-api.test.ts`: sem sessão → 401; `agent`/`editor` → 403; criação sem `purpose` → 400; criação ok → 201 `status:'connecting'`; `GET :id` devolve `qr` do provider falso; `POST :id/logout` → `disconnected` + audit `account.logout` + limpa telefone; `label` vazio → 400 (`detail` menciona `label`).
- [ ] **5. Correr → falhar → implementar rotas → passar.** `npm run test:integration -- tests/integration/accounts-api.test.ts` → `pass, fail 0`; `npm run lint && npm run typecheck` → `0 erros`.
- [ ] **6. Commit.** `feat: add whatsapp account lifecycle and admin routes`

### Task 17: Port de outbox com enqueue transacional

**Files:**
- Create: `src/ports/outbox.ts`, `src/adapters/db/outbox.ts`, `tests/integration/outbox-enqueue.test.ts`

**Interfaces:**
```ts
// src/ports/outbox.ts — forma EXATA consumida pela Fase 4 (CampaignOutbox)
export interface Outbox {
  enqueue(input: {
    accountId: string; contactId: string; conversationId: string;
    sender: 'ai' | 'human' | 'campaign'; text: string;
    idempotencyKey: string; scheduledAt?: Date;
  }): Promise<{ outboxId: string; duplicate: boolean }>;
  pendingConversationCount(accountId: string): Promise<number>;   // filas 'queued' + 'sending' da conta
}
export function createOutbox(deps: {
  db: DbClient;
  notifySink: (e: NotifyEvent) => Promise<void>;
  now(): Date;
  random(): number;                                  // injetável (testes usam 0)
  replyDelay: { min: number; max: number };          // WA_REPLY_DELAY_MS
}): Outbox;
```

**Steps:**

- [ ] **1. Teste falhado** `tests/integration/outbox-enqueue.test.ts`:

```ts
test('enqueue: cria mensagem+outbox numa transação; repetir a chave não duplica nem reemite evento', async () => {
  const o = createOutbox({ db, notifySink: sink, now: () => new Date('2026-10-07T10:00:00Z'), random: () => 0, replyDelay: { min: 1000, max: 5000 } });
  const first = await o.enqueue({ accountId, contactId, conversationId, sender: 'human', text: 'olá', idempotencyKey: 'rest:c1:K1' });
  assert.equal(first.duplicate, false);
  const again = await o.enqueue({ accountId, contactId, conversationId, sender: 'human', text: 'olá', idempotencyKey: 'rest:c1:K1' });
  assert.equal(again.duplicate, true);
  assert.equal(again.outboxId, first.outboxId);
  assert.equal((await countMessages()), 1, 'rollback da mensagem órfã no conflito');
  assert.equal((await countNotifications()), 1, 'message.created só após o commit da 1.ª');
  const row = await getOutbox(first.outboxId);
  assert.equal(row.priority, 1);
  assert.equal(row.scheduledAt.toISOString(), '2026-10-07T10:00:01.000Z', 'random()=0 → min do WA_REPLY_DELAY_MS');
});
test('prioridade: campaign = 2, ai/human = 1; pendingConversationCount só conta queued+sending', async () => {
  await o.enqueue({ ..., sender: 'campaign', text: 'promo', idempotencyKey: 'campaign:r1', scheduledAt: new Date('2026-10-07T11:00:00Z') });
  assert.equal((await getOutboxByKey('campaign:r1')).priority, 2);
  // marcar uma como 'sent' → pendingConversationCount desce
});
```

- [ ] **2. Correr e ver falhar.** `npm run test:integration -- tests/integration/outbox-enqueue.test.ts` → `fail 1`.
- [ ] **3. Implementar.** Transação: gerar `messageId`; INSERT na mensagem (`direction 'outbound'`, `status 'queued'`, `sender`, corpo, `provider_message_id` NULL) → INSERT na outbox (`message_id`, `account_id`, `priority = sender === 'campaign' ? 2 : 1`, `scheduled_at = scheduledAt ?? now + randomInt(min,max)`, `attempts 0`, `status 'queued'`) com `ON CONFLICT (idempotency_key) DO NOTHING` → sem linha devolvida ⇒ `ROLLBACK` (a mensagem órfã desaparece) e `SELECT` da existente ⇒ `{ outboxId, duplicate: true }`; com linha ⇒ `COMMIT` e só **depois** `notifySink({ type: 'message', phase: 'created', messageId, conversationId, accountId, sender, status: 'queued', createdAt })`. `pendingConversationCount` = contagem de `queued`+`sending` da conta. Nenhuma validação de texto aqui (fronteira é a rota/job — `docs/02` §3).
- [ ] **4. Correr e ver passar.** → `pass 2, fail 0`; `npm run lint && npm run typecheck` → `0 erros`.
- [ ] **5. Commit.** `feat: add outbox port with transactional enqueue`

### Task 18: Worker de envio e `registerRecurring`

**Files:**
- Create: `src/application/outbox-worker.ts`, `tests/helpers/outbox.ts`, `tests/integration/outbox-worker.test.ts`, `tests/integration/job-recurring.test.ts`
- Modify: `src/ports/job-queue.ts` (novo método), `src/adapters/queue/bullmq.ts` (implementação), `src/infra/main.ts` (registar `outbox.tick`)

**Interfaces:**
```ts
// src/ports/job-queue.ts ( Acrescentar, sem mudar os métodos existentes da Fase 0 )
registerRecurring(name: string, handler: (payload: Record<string, unknown>, ctx: JobContext) => Promise<void>,
  opts: { everyMs: number }): Promise<void>;
  // BullMQ: Queue.add(name, {}, { repeat: { every: everyMs }, removeOnComplete: true, removeOnFail: true }) + Worker por nome;
  // dedupe em memória (Map por name): segunda chamada com o mesmo name é no-op; payload vazio (nada de dados), ctx igual

// src/application/outbox-worker.ts
export interface OutboxWorkerDeps {
  db: DbClient; provider: MessagingProvider; accounts: AccountLifecycle;
  notifySink: (e: NotifyEvent) => Promise<void>; audit: Audit;
  now(): Date; random(): number; logger: { info(o: object): void; warn(o: object): void; error(o: object): void };
  cfg: { sendTimeoutMs: number; maxAttempts: number; retryDelayMs: number };
}
export function runOutboxTick(deps: OutboxWorkerDeps): Promise<{ claimed: number; sent: number }>;
// tests/helpers/outbox.ts
export function runOutboxWorker(overrides?: Partial<OutboxWorkerDeps>): Promise<{ claimed: number; sent: number }>;
```

**Steps:**

- [ ] **1. Teste falhado** `tests/integration/job-recurring.test.ts`:

```ts
test('registerRecurring: dispara a cada everyMs; registrar duas vezes não duplica execuções', async () => {
  const queue = createJobQueue({ redisUrl: TEST_REDIS_URL });
  let runs = 0;
  const h = async () => { runs += 1; };
  await queue.registerRecurring('test.repeat', h, { everyMs: 100 });
  await queue.registerRecurring('test.repeat', h, { everyMs: 100 });   // 2.ª chamada = no-op
  await new Promise((r) => setTimeout(r, 550));
  await queue.close();
  assert.ok(runs >= 3 && runs <= 6, `runs=${runs} (3–6 em 550ms; >6 houve duplicação)`);
});
```

- [ ] **2. Correr e ver falhar.** `npm run test:integration -- tests/integration/job-recurring.test.ts` → `fail 1` (`registerRecurring is not a function`).
- [ ] **3. Implementar `registerRecurring`** no port e no adaptador BullMQ (conforme Interfaces; dedupe por nome num `Map`; se o Redis estiver no ramo B da Fase 0 — `pg-boss` — implementar a repetição com o mecanismo equivalente **no mesmo port**, o teste acima é o contrato e não muda).
- [ ] **4. Teste falhado** `tests/integration/outbox-worker.test.ts`:

```ts
test('timeout → unknown_delivery, mensagem continua queued, SEM reenvio automático', async () => {
  const provider = createFakeMessaging();
  provider.queueResult({ providerMessageId: null, outcome: 'unknown' });
  await enqueueFixture({ sender: 'human', text: 'olá' });          // já devida (scheduled_at no passado)
  await runOutboxWorker({ provider });
  await runOutboxWorker({ provider });
  await runOutboxWorker({ provider });
  assert.equal(provider.sendTextCalls.length, 1, 'nunca reenvia um envio de resultado desconhecido');
  assert.equal((await getOutboxRow()).status, 'unknown_delivery');
  assert.equal((await getMessageRow()).status, 'queued');
  assert.ok(logs().some((l) => l.level === 'error' && l.reason === 'send_unknown'));   // alerta de reconciliação
});
test('serialização e prioridade: nunca 2 envios simultâneos; resposta antes de campanha', async () => {
  let inFlight = 0, maxInFlight = 0;
  const provider = { ...createFakeMessaging(), sendText: async (i) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 20)); inFlight--; return { providerMessageId: 'm', outcome: 'accepted' }; } };
  await enqueueFixture({ sender: 'campaign', idempotencyKey: 'campaign:1', scheduledAt: past(10_000) });  // prio 2, mais antiga
  await enqueueFixture({ sender: 'ai', idempotencyKey: 'inbound:1', scheduledAt: past(1_000) });           // prio 1
  await runOutboxWorker({ provider });
  assert.equal(maxInFlight, 1);
  assert.deepEqual(provider.sendTextCalls.map((c) => c.idempotencyKey), ['inbound:1', 'campaign:1']);
});
test('conta não-connected adia SEM gastar tentativa; suspected_ban adia igual', async () => {
  await accounts.setStatus(acc.id, 'disconnected', now());
  await runOutboxWorker({ provider });
  const row = await getOutboxRow();
  assert.equal(row.status, 'queued');
  assert.equal(row.attempts, 0);
  assert.equal(provider.sendTextCalls.length, 0);
  assert.ok(row.scheduledAt.getTime() >= now().getTime() + 30000 - 50);   // WA_OUTBOX_RETRY_DELAY_MS
});
test('transientes esgotam em WA_SEND_MAX_ATTEMPTS → failed + dead-letter; aceitação → sent + message.status', async () => {
  for (let i = 0; i < 5; i++) { provider.queueResult(new TypeError('fetch failed')); await runOutboxWorker({ provider }); }
  assert.equal((await getOutboxRow()).status, 'failed');
  assert.equal((await getMessageRow()).status, 'failed');
  assert.ok(logs().some((l) => l.deadLetter === true));
  // aceitação: status outbox 'sent', message 'sent' com provider_message_id, notify { type:'message', phase:'status', status:'sent' }
});
test('sweep: linha 'sending' velha (crash) → unknown_delivery', async () => {
  // marcar sending com updated_at < now - (sendTimeoutMs + 10s) → tick → unknown_delivery + log
});
```

- [ ] **5. Correr e ver falhar.** `npm run test:integration -- tests/integration/outbox-worker.test.ts` → `fail` (worker inexistente).
- [ ] **6. Implementar `runOutboxTick`** (algoritmo exato):
  1. **Sweep:** `outbox_messages` com `status='sending'` e `updated_at < $now - (sendTimeoutMs + 10000)` → `unknown_delivery`, log `alert { reason: 'stale_sending' }` (mensagem continua `queued`).
  2. **Claim:** seleção `status='queued' AND scheduled_at <= $now ORDER BY priority ASC, scheduled_at ASC LIMIT 10 FOR UPDATE SKIP LOCKED`, cada linha transicionada para `sending` na sua própria transação curta (o `SKIP LOCKED` torna o tick seguro em execução sobreposta — é o *lock* dos jobs recorrentes, `docs/02` §6).
  3. **Processamento sequencial** (concorrência 1 global ⇒ serialização por conta, `docs/04` §7), por linha, **nesta ordem**: conta ausente/`disconnected`/`connecting`/`suspected_ban` → voltar a `queued` com `scheduled_at = $now + WA_OUTBOX_RETRY_DELAY_MS` e **sem** incrementar `attempts` (as mensagens saem da cabeça, não bloqueiam as outras); senão `provider.sendText({ sessionId: provider_session_id, to: phone do contacto, text, idempotencyKey: outbox.id })` e:
     - `accepted` → outbox `sent`, mensagem `sent` + `provider_message_id`, `accounts.recordSendResult({ ok: true })`, `notifySink({ type:'message', phase:'status', ... })`, log info com telefone mascarado;
     - `rejected` → outbox `failed`, mensagem `failed`, `recordSendResult({ ok: false })`, log `error { deadLetter: true, outboxId }`;
     - `unknown` → outbox `unknown_delivery`, mensagem fica `queued`, `recordSendResult({ ok: false })`, log `error { reason: 'send_unknown' }` — **nunca** reenviar (docs/04 §5);
     - exceção `CircuitOpenError` → voltar a `queued` com `scheduled_at = $now + WA_OUTBOX_RETRY_DELAY_MS`, sem incrementar `attempts`;
     - exceção transiente (`ProviderUnavailableError`) → se `attempts + 1 < WA_SEND_MAX_ATTEMPTS`: `queued` com `scheduled_at = $now + WA_OUTBOX_RETRY_DELAY_MS * 2^attempts + jitter(0..250ms)` (o incremento de `attempts` acontece no claim de envio, passo 3); senão outbox `failed` + mensagem `failed` + dead-letter;
     - erro não-transiente (zod do adapter, bug) → repropagar (o job vai para dead-letter da fila).
  4. `attempts` incrementa-se **só** quando se chama o provider; devolver `{ claimed, sent }`.
- [ ] **7. Ligar no arranque.** `main.ts`: `registerRecurring('outbox.tick', handlerQueChama runOutboxTick, { everyMs: cfg.messaging.outboxTickMs })`; o handler valida o payload vazio com zod (`{}`) e trata erro com log + rethrow (retry da fila).
- [ ] **8. Correr e ver passar.** → `pass, fail 0`; `npm run lint && npm run typecheck` → `0 erros`.
- [ ] **9. Commit.** `feat: add recurring jobs to job queue port` e `feat: add outbox send worker with pacing and serialization`

### Task 19: `handle-inbound.ts`, `AIProvider` indisponível e seam de efeitos

**Files:**
- Create: `src/application/handle-inbound.ts`, `src/adapters/ai/unavailable.ts`, `tests/integration/handle-inbound.test.ts`
- Modify: `src/domain/phone.ts` não; nenhum ficheiro de `reference/` nem da Fase 0 para além do que se indica

**Interfaces:**
```ts
// src/application/handle-inbound.ts
export interface HandleInboundDeps {
  db: DbClient;
  ports: Ports & { releaseClaim(eventId: string): Promise<void> };
  orchestrate: (msg: InboundMessage) => Promise<Outcome>;      // Fase 1: (m) => handleInbound(ports, unavailableAiProvider, m)
  outbox: Outbox;
  notifySink: (e: NotifyEvent) => Promise<void>;
  cfg: { claimTtlMs: number };
  now(): Date;
  /** Seam Fase 4 (opt-out/markReplied): depois da mensagem guardada, antes do orquestrador. Default no-op. */
  inboundEffects?: (input: { contactId: string; conversationId: string; text: string; receivedAt: Date }) => Promise<void>;
}
export function handleInboundEvent(deps: HandleInboundDeps, eventId: string):
  Promise<{ outcome: 'skipped' | 'processed' | Outcome['status'] }>;

// src/adapters/ai/unavailable.ts
export function createUnavailableAiProvider(reason = 'ai_not_configured'): AIProvider;
// respond() e summarizeForHandoff() rejeitam com DomainError(reason) — orquestrador cai no failSafe (docs/05 §3.4)

// Composição (src/infra/main.ts)
const orchestrate = (msg: InboundMessage) => handleInbound(ports, unavailableAiProvider, msg);
```

**Steps:**

- [ ] **1. Teste falhado** `tests/integration/handle-inbound.test.ts`:

```ts
test('mensagem recebida: cria contact/lead/conversation/mensagem, marca processed e notifica message.created', async () => {
  const ev = await insertEvent({ type: 'message.received', from: '+244923111222', text: 'olá' });
  const r = await handleInboundEvent(deps, ev.id);
  assert.equal(r.outcome, 'processed');
  assert.equal((await countMessages()), 1);
  assert.equal((await getLead()).stage, 'open');            // lead aberto ligado à conversa
  assert.ok((await getEvent()).processedAt);
  assert.ok((await notified()).some((n) => n.type === 'message' && n.phase === 'created'));
  assert.equal((await handleInboundEvent(deps, ev.id)).outcome, 'skipped');   // reentrega → sem efeitos
  assert.equal((await countMessages()), 1);
});
test('sem IA e conversa ai_active → failSafe: handoff + mensagem fixa enfileirada (sender ai)', async () => {
  await setConversationAiMode('ai_active');
  const ev = await insertEvent({ text: 'olá' });
  await handleInboundEvent(deps, ev.id);
  assert.equal((await countHandoffs()), 1);
  const o = await getOutboxRow();
  assert.equal(o.sender, 'ai');
  assert.equal(o.idempotencyKey, `inbound:${ev.id}`);
});
test('conversa ai_suggest (por omissão, D13) → NADA é enviado e sem handoff (canAct=false)', async () => {
  await handleInboundEvent(deps, (await insertEvent({ text: 'olá' })).id);
  assert.equal((await countOutbox()), 0);
  assert.equal((await countHandoffs()), 0);
});
test('erro no processamento liberta o claim e o retry seguinte completa', async () => {
  let first = true;
  const failing = { ...deps, orchestrate: async (m: InboundMessage) => { if (first) { first = false; throw new Error('db blip'); } return deps.orchestrate(m); } };
  await assert.rejects(() => handleInboundEvent(failing, ev.id), /db blip/);
  assert.equal((await getEvent()).processedAt, null, 'processed_at nunca antes do fim');
  assert.equal((await handleInboundEvent(deps, ev.id)).outcome, 'processed');  // claim libertado → reprocessa
});
test('evento com claim fresco de outro worker → erro reprocessável e processed_at continua nulo', async () => {
  await claimEvent(ev.id, deps.now());                       // claim concorrente
  await assert.rejects(() => handleInboundEvent(deps, ev.id), /retryable|claimed_elsewhere/);
  assert.equal((await getEvent()).processedAt, null);
});
test('inboundEffects corre DEPOIS da mensagem guardada e ANTES do orquestrador', async () => {
  const order: string[] = [];
  // deps com orchestrate que regista 'orchestrate' e inboundEffects que regista 'effects' + liga a mensagem
  await handleInboundEvent(depsWithHooks, ev.id);
  assert.deepEqual(order, ['message_stored', 'effects', 'orchestrate']);
});
```

- [ ] **2. Correr e ver falhar.** `npm run test:integration -- tests/integration/handle-inbound.test.ts` → `fail 1`.
- [ ] **3. Implementar `handleInboundEvent`** (fluxo exato, um passo por efeito colateral):
  1. carregar o evento; `processed_at` preenchido → `{ outcome: 'skipped' }`;
  2. `parseProviderEvent(row.payload)` (revalidação na fronteira do job); tipo ≠ `message.received` → `{ outcome: 'skipped' }`; dados invalidáveis (`from` não-normalizável) → marcar `processed_at` + `logger.error({ reason: 'payload_invalid', eventId })` e `{ outcome: 'skipped' }` (evento venenoso não entra em retry infinito, `docs/02` §3);
  3. conta por `sessionId` (`whatsapp_accounts.provider_session_id`); sem conta → log warn + `processed_at` + skipped;
  4. guardar (idempotente): contacto por `normalizePhoneE164(from)` (upsert), conversa por `UNIQUE (account_id, contact_id)` (cria com `line` nulo, `ai_mode 'ai_suggest'`, `last_message_at`), lead em falta na conversa → INSERT (`stage 'open'`, `qualification '{}'`, `line` nulo — ver lacunas) + `conversations.lead_id`, mensagem (`ON CONFLICT (account_id, provider_message_id) DO NOTHING` + SELECT, `direction 'inbound'`, `sender 'customer'`, `status 'delivered'`, `media_ref` se mídia) + `notifySink({ type: 'message', phase: 'created', ... })`;
  5. `await deps.inboundEffects?.({ contactId, conversationId, text, receivedAt })` (sempre com o texto real; erro propaga, nunca `catch {}`);
  6. `outcome = await deps.orchestrate({ id: eventId, conversationId, text: text ?? '', isTest: false })` — **`msg.id` é o id do evento** (o orquestrador faz o claim em `inbound_events`);
  7. se `outcome.status === 'duplicate'` → o evento não está processado (passo 1) logo há outro worker com o claim: lançar erro reprocessável (`RetryableConflictError`, a fila tenta mais tarde — o vencedor marca `processed_at`);
  8. se `outcome.mode === 'send' && outcome.reply` → `outbox.enqueue({ accountId, contactId, conversationId, sender: 'ai', text: reply, idempotencyKey: 'inbound:' + eventId })`; se `mode === 'draft' && reply` → **não envia** (rascunho fica registado em `answer_traces` via `saveTrace`; aprovação de rascunho é Fase 3) com log estruturado `{ reason: 'reply_draft_pending', correlationId }` sem texto;
  9. marcar `processed_at = now()` → `{ outcome: outcome.status }`;
  10. `catch` → `await ports.releaseClaim(eventId)` (best effort) e repropagar o erro original (o retry volta a claimar — `docs/05` §3.1; é exatamente o que a Review Focus nº 1 da Fase 3 aponta).
- [ ] **4. Ligar a composição.** `main.ts`: `createOrchestratorPorts({ db, notifySink, claimTtlMs: cfg.messaging.claimTtlMs, now })`, `orchestrate = (m) => handleInbound(ports, createUnavailableAiProvider(), m)`.
- [ ] **5. Correr e ver passar.** → `pass 6, fail 0`; `npm run lint && npm run typecheck` → `0 erros`.
- [ ] **6. Commit.** `feat: add inbound event handler with claims and idempotency`

### Task 20: Rota de webhook, ingestão idempotente e job de processamento

**Files:**
- Create: `src/application/ingest-webhook.ts`, `src/application/message-status.ts`, `src/adapters/http/routes/webhook.ts`, `tests/integration/webhook-idempotency.test.ts`, `tests/unit/message-status.test.ts`
- Modify: `src/infra/main.ts` (registrar rota pública + job `inbound.process`)

**Interfaces:**
```ts
// src/application/ingest-webhook.ts
export function ingestWebhook(deps: {
  db: DbClient; provider: MessagingProvider; jobs: JobQueue; now(): Date;
  logger: { warn(o: object): void };
}, input: { headers: Record<string, string | undefined>; rawBody: Buffer; ip: string }):
  Promise<{ accepted: number; duplicates: number }>;
   // verifyAndParseWebhook (joga WebhookError → rota 401) → INSERT inbound_events 1 linha por evento
   // (payload = evento normalizado JSON, ON CONFLICT (provider_event_id) DO NOTHING) → por evento novo:
   // jobs.enqueue('inbound.process', { eventId, correlationId }, { idempotencyKey: 'inbound-event:' + providerEventId, correlationId })
// src/adapters/http/routes/webhook.ts → POST /v1/webhooks/wa-akg (público, SEM sessão/CSRF, corpo bruto)
//   202 { received: true, events } em <500 ms; 401 problem 'invalid_signature'; 400 'payload_invalid'
// job 'inbound.process' (payload zod { eventId: string, correlationId: string }) — despacha por tipo:
//   message.received → handleInboundEvent | message.status → advanceMessageStatus
//   session.status → accountLifecycle.onSessionStatus | session.qr → accountLifecycle.onQr  (e marca processed)
// src/application/message-status.ts
export type MessageStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed';
export function nextStatus(current: MessageStatus, incoming: MessageStatus): MessageStatus;
export function advanceMessageStatus(deps: { db: DbClient; notifySink; now(): Date },
  input: { accountId: string; providerMessageId: string; status: 'sent' | 'delivered' | 'read' | 'failed'; at: Date }):
  Promise<{ changed: boolean }>;
```

**Steps:**

- [ ] **1. Teste falhado** `tests/unit/message-status.test.ts` (estados só avançam, `docs/04` §8):

```ts
test('matriz: só avança; failed é terminal a partir de queued/sent/delivered; read nunca recua', () => {
  assert.equal(nextStatus('queued', 'sent'), 'sent');
  assert.equal(nextStatus('sent', 'delivered'), 'delivered');
  assert.equal(nextStatus('delivered', 'read'), 'read');
  assert.equal(nextStatus('delivered', 'sent'), 'delivered', 'evento atrasado não recua');
  assert.equal(nextStatus('read', 'delivered'), 'read');
  assert.equal(nextStatus('queued', 'failed'), 'failed');
  assert.equal(nextStatus('delivered', 'failed'), 'failed');
  assert.equal(nextStatus('failed', 'delivered'), 'failed', 'failed é terminal');
  assert.equal(nextStatus('read', 'failed'), 'read', 'failed não sobrepõe read');
});
```

- [ ] **2. Correr e ver falhar.** `npm test -- tests/unit/message-status.test.ts` → `fail 1`.
- [ ] **3. Implementar `nextStatus`/`advanceMessageStatus`** (rank `queued 0 < sent 1 < delivered 2 < read 3`; `failed` aceite só de rank 0–2 e depois é terminal; UPDATE condicional transacional + `notifySink({ type: 'message', phase: 'status', ... })` quando `changed`).
- [ ] **4. Teste falhado** `tests/integration/webhook-idempotency.test.ts`:

```ts
test('assinatura inválida → 401 sem linha; mesmo evento 2× → 1 linha, 1 job, 2 respostas rápidas', async () => {
  const app = await buildTestApp();
  const raw = Buffer.from(JSON.stringify(payload));                 // captura auditada, campos sintéticos
  const bad = await app.inject({ method: 'POST', url: '/v1/webhooks/wa-akg', headers: { ...signWebhook(raw, 'segredo-errado' + 'x'.repeat(24)), 'content-type': 'application/json' }, payload: raw });
  assert.equal(bad.statusCode, 401);
  assert.equal(await countEvents(), 0);

  const headers = signWebhook(raw, TEST_WEBHOOK_SECRET);
  const t0 = process.hrtime.bigint();
  const a = await app.inject({ method: 'POST', url: '/v1/webhooks/wa-akg', headers: { ...headers, 'content-type': 'application/json' }, payload: raw });
  const b = await app.inject({ method: 'POST', url: '/v1/webhooks/wa-akg', headers: { ...headers, 'content-type': 'application/json' }, payload: raw });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(a.statusCode, 202); assert.equal(b.statusCode, 202);
  assert.ok(ms < 500, `2 pedidos em ${ms.toFixed(1)}ms (job não correu no request)`);
  assert.equal(await countEvents(), 1);
  assert.equal(enqueuedJobs('inbound.process').length, 1);
});
test('job: message.status avança estado; session.status atualiza conta e notifica; payload inválido rejeita sem retry', async () => {
  // handler direto: { eventId } de um evento message.status enviado depois de 'sent' → 'delivered' + notify
  // session.status 'connected' → conta 'connected' + notify account.status
  // handler com payload {} → lança erro de validação zod (rejeitado, não processa)
});
```

- [ ] **5. Correr e ver falhar.** `npm run test:integration -- tests/integration/webhook-idempotency.test.ts` → `fail 1`.
- [ ] **6. Implementar.**
  - Rota: aceita só `content-type: application/json`, lê `req.rawBody` (Task 9), chama `ingestWebhook`, mapeia `WebhookError('invalid_signature')` → 401, `payload_invalid` → 400, resto → `toProblem`; sem log de corpo (só `ip` + `providerEventId` + resultado).
  - `ingestWebhook`: como na Interfaces; resposta devolvida antes de qualquer processamento (o job é que corre o pipeline); logs mascarados.
  - Job `inbound.process`: valida payload com zod na fronteira (inválido ⇒ throw, sem retry, morto na dead-letter) e despacha por tipo como na Interfaces; `message.received` chama `handleInboundEvent(deps, eventId)`; os restantes tipos marcam `processed_at` no fim; erro ⇒ rethrow (retry com backoff da Fase 0) — o `releaseClaim` do handle-inbound garante que o retry não é engolido.
  - `main.ts`: `jobs.register('inbound.process', handler)` + registar a rota pública.
- [ ] **7. Correr e ver passar.** → `pass 3, fail 0`; `npm run lint && npm run typecheck` → `0 erros`.
- [ ] **8. Commit.** `feat: add idempotent webhook ingest with async processing`

### Task 21: API de conversas e mensagens

**Files:**
- Create: `src/ports/conversations.ts`, `src/adapters/db/conversations.ts`, `src/application/messaging.ts`, `src/adapters/http/routes/conversations.ts`, `tests/integration/conversations-api.test.ts`

**Interfaces:**
```ts
// src/ports/conversations.ts
export interface ConversationView { id: string; accountId: string; contactId: string; contactPhone: string;
  leadId: string | null; line: string | null; aiMode: AiMode; missStreak: number; lastMessageAt: Date | null; createdAt: Date; }
export interface MessageView { id: string; conversationId: string; direction: 'inbound' | 'outbound';
  sender: 'customer' | 'ai' | 'human' | 'campaign'; kind: string; body: string;
  status: 'queued' | 'sent' | 'delivered' | 'read' | 'failed'; mediaRef: string | null; createdAt: Date; }
export interface ConversationsRepository {
  list(input: { accountId?: string; cursor?: string; limit: number }): Promise<{ items: ConversationView[]; nextCursor: string | null }>;
  get(id: string): Promise<{ conversation: ConversationView; lastMessage: MessageView | null } | null>;
  listMessages(input: { conversationId: string; cursor?: string; limit: number }): Promise<{ items: MessageView[]; nextCursor: string | null }>;
  getMessageByOutbox(outboxId: string): Promise<MessageView | null>;
}
export function createConversationsRepository(db: DbClient): ConversationsRepository;
// src/application/messaging.ts
export function createMessageSender(deps: { outbox: Outbox; repo: ConversationsRepository; audit: Audit;
  cfg: { maxMessageChars: number }; now(): Date }): {
  sendHumanMessage(input: { conversationId: string; text: string; idempotencyKey: string; actorId: string; ip: string }):
    Promise<{ message: MessageView; replayed: boolean } | { conflict: true }>;
};
// Rotas (qualquer papel autenticado; sessão + CSRF nas mutações):
//   GET  /v1/conversations?accountId=&cursor=&limit=          → 200 { conversations, nextCursor }
//   GET  /v1/conversations/:id                                → 200 { conversation, lastMessage }
//   GET  /v1/conversations/:id/messages?cursor=&limit=        → 200 { messages, nextCursor }
//   POST /v1/conversations/:id/messages  {text}  + header Idempotency-Key
//        → 201 { message, replayed: false } | 200 { message, replayed: true } | 409 problem idempotency_conflict
```

**Steps:**

- [ ] **1. Teste falhado** `tests/integration/conversations-api.test.ts`:

```ts
test('paginação por cursor: 5 mensagens, limit 2 → 3 páginas sem repetir nem faltar', async () => {
  const app = await buildTestApp();
  // fixture: conversa com 5 mensagens sintéticas (created_at decrescente confirmado)
  const auth = { cookies: { session: app.sessions.agent } };
  const p1 = await app.inject({ method: 'GET', url: `/v1/conversations/${cid}/messages?limit=2`, ...auth });
  const p2 = await app.inject({ method: 'GET', url: `/v1/conversations/${cid}/messages?limit=2&cursor=${encodeURIComponent(p1.json().nextCursor)}`, ...auth });
  const p3 = await app.inject({ method: 'GET', url: `/v1/conversations/${cid}/messages?limit=2&cursor=${encodeURIComponent(p2.json().nextCursor)}`, ...auth });
  const ids = [...p1.json().messages, ...p2.json().messages, ...p3.json().messages].map((m: { id: string }) => m.id);
  assert.equal(ids.length, 5);
  assert.equal(new Set(ids).size, 5);
  assert.equal(p3.json().nextCursor, null);
  assert.equal((await app.inject({ method: 'GET', url: `/v1/conversations/${cid}/messages?cursor=lixo`, ...auth })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: `/v1/conversations/${cid}/messages?limit=101`, ...auth })).statusCode, 400);
});
test('envio humano: sem Idempotency-Key → 400; 1.ª → 201; replay → 200 replayed; corpo diferente → 409; texto longo → 400', async () => {
  const app = await buildTestApp();
  const post = (key: string | null, text: string, s = app.sessions.agent, c = app.csrf.agent) => app.inject({
    method: 'POST', url: `/v1/conversations/${cid}/messages`, cookies: { session: s },
    headers: { 'x-csrf-token': c, ...(key ? { 'idempotency-key': key } : {}) }, payload: { text } });
  const noKey = await post(null, 'olá');
  assert.equal(noKey.statusCode, 400);
  assert.match(noKey.json().detail, /Idempotency-Key/);
  const first = await post('K1', 'olá');
  assert.equal(first.statusCode, 201);
  assert.equal(first.json().replayed, false);
  assert.equal(provider.sendTextCalls.length, 0, 'nenhum envio fora da outbox (worker ainda não correu)');
  const replay = await post('K1', 'olá');
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().replayed, true);
  assert.equal(replay.json().message.id, first.json().message.id);
  const conflict = await post('K1', 'outro texto');
  assert.equal(conflict.statusCode, 409);
  const tooLong = await post('K2', 'x'.repeat(4097));
  assert.equal(tooLong.statusCode, 400);
  assert.match(tooLong.json().detail, /4096|WA_MAX_MESSAGE_CHARS/);
  const empty = await post('K3', '   ');
  assert.equal(empty.statusCode, 400);
  // efeitos: 1 mensagem + 1 outbox (priority 1, scheduled dentro de [min,max] do relógio/rng do teste)
  await app.close();
});
test('RBAC: sem sessão → 401; qualquer papel lê; editor também envia', async () => { ... });
```

- [ ] **2. Correr e ver falhar.** `npm run test:integration -- tests/integration/conversations-api.test.ts` → `fail 1` (404).
- [ ] **3. Implementar.**
  - `createConversationsRepository`: paginação por cursor *keyset* opaco (`base64url` de `{ t, id }`, `ORDER BY last_message_at DESC, id DESC` e `created_at DESC, id DESC` com comparação de par `(t, id)`); `limit` default 50, aceite 1–100 (fora ⇒ erro de validação 400); cursor inválido ⇒ `DomainError('invalid_cursor')` 400; `SELECT` explícito de colunas (sem `SELECT *`), junção ao contacto para `contactPhone`.
  - `createMessageSender.sendHumanMessage`: valida fronteira (`1 ≤ length ≤ WA_MAX_MESSAGE_CHARS`, sem só espaços → 400), `outbox.enqueue({ sender: 'human', idempotencyKey: 'rest:' + conversationId + ':' + idempotencyKey, text })`; `duplicate` ⇒ `getMessageByOutbox(outboxId)` → corpo igual ⇒ `{ message, replayed: true }`, corpo diferente ⇒ `{ conflict: true }` (rota → 409); primeiro ⇒ audit `message.sent` (`actorId`, `at`, `ip`); conversa inexistente ⇒ 404.
  - Rota: zod `{ text }`, cabeçalho `Idempotency-Key` obrigatório (em falta ⇒ 400 com `detail` a mencionar `Idempotency-Key`), `requireRole` nenhum (qualquer papel), CSRF ativo; serialização exata das Views; `message.created` já sai do `enqueue` (Task 17).
- [ ] **4. Correr e ver passar.** → `pass 3, fail 0`; `npm run lint && npm run typecheck` → `0 erros`.
- [ ] **5. Commit.** `feat: add conversations and messages api with cursor pagination`

### Task 22: Fluxo ponta-a-ponta e suíte completa

**Files:**
- Test: `tests/integration/send-flow.test.ts`
- Modify: nenhum código de produção (só se um teste destoar — corrigir o código, nunca o teste)

**Interfaces:**
```ts
// Consumes: buildTestApp, signWebhook, createFakeMessaging, runOutboxWorker,
//           handleInboundEvent (via job 'inbound.process'), runOutboxTick
```

**Steps:**

- [ ] **1. Teste falhado** `tests/integration/send-flow.test.ts`:

```ts
test('entrada: webhook assinado → 202 rápido → job → handoff+reply na outbox → worker envia UMA vez', async () => {
  const app = await buildTestApp();
  await setConversationForPhone('+244923111222', { aiMode: 'ai_active' });   // sem IA real → failSafe da Fase 1
  const raw = Buffer.from(JSON.stringify(msgReceivedPayload));
  const res = await app.inject({ method: 'POST', url: '/v1/webhooks/wa-akg',
    headers: { ...signWebhook(raw, TEST_WEBHOOK_SECRET), 'content-type': 'application/json' }, payload: raw });
  assert.equal(res.statusCode, 202);
  await runJob('inbound.process');                                            // executor do job, fila real
  assert.equal((await countHandoffs()), 1);
  const out = await getOutboxRow();
  assert.equal(out.sender, 'ai');
  assert.equal(out.idempotencyKey, `inbound:${(await getEvent()).id}`);
  assert.equal(app.messaging.sendTextCalls.length, 0, 'worker ainda não correu');

  await runOutboxWorker({ provider: app.messaging.provider });
  assert.equal(app.messaging.sendTextCalls.length, 1);
  const call = app.messaging.sendTextCalls[0];
  assert.equal(call.to, '+244923111222');
  assert.equal(call.idempotencyKey, out.idempotencyKey);
  assert.equal((await getMessageRow()).status, 'sent');
  // reentrega do MESMO webhook → nenhum efeito novo
  await app.inject({ method: 'POST', url: '/v1/webhooks/wa-akg', headers: { ...signWebhook(raw, TEST_WEBHOOK_SECRET), 'content-type': 'application/json' }, payload: raw });
  await runJob('inbound.process');
  assert.equal(app.messaging.sendTextCalls.length, 1);
  assert.equal((await countMessages()), 2, '1 inbound + 1 outbound, sem duplicados');
  await app.close();
});
test('saída: POST humano com Idempotency-Key → nada antes do worker → depois UMA chamada sequencial por conta', async () => {
  // 2 mensagens para a mesma conta; espião de concorrência máx. = 1; contador de eventos: message.created ×2, message.status ×2
});
test('saída sem sessão/CSRF nunca chega à outbox', async () => {
  // POST sem cookies → 401 e countOutbox() === 0
});
```

- [ ] **2. Correr e ver falhar.** `npm run test:integration -- tests/integration/send-flow.test.ts` → `fail 1` (rota/job ainda não ligados de ponta a ponta — este teste é o que os liga).
- [ ] **3. Corrigir o código, não o teste.** Ligar o que faltar em `main.ts` (job `inbound.process` + rota webhook + worker), corrigindo bugs reais à superfície; se um pressuposto do teste estiver errado contra a spec (`docs/01` §7, `docs/04` §7–8), corrigir o teste apenas com a evidência da spec citada.
- [ ] **4. Correr e ver passar.** → `pass 3, fail 0`.
- [ ] **5. Suíte completa.** `npm run lint` → `0 erros`; `npm run typecheck` → `0 erros`; `npm test` → `fail 0`; `npm run test:integration` → `fail 0`; `npm run test:contract` → `fail 0`; `npm audit --audit-level=high` → sem vulnerabilidades altas/críticas novas. Colar a saída integral no relatório.
- [ ] **6. Commit.** `test: cover end to end inbound and outbound send flows`

### Task 23: Documentação, runbooks e verificação final

**Files:**
- Create: `docs/runbooks/wa-akg.md`, `src/adapters/http/README.md`
- Modify: `src/adapters/wa-akg/README.md` (completar com "como correr os contratos"), `docs/schema-base.md` (confirmar estado final das perguntas da Task 1), `docs/02-regras-backend.md` §1 (árvore final: `tests/helpers/`, `scripts/`, `src/infra/security/` — conferir contra `find src tests -type d`), `README.md` do repositório (se existir: secção "Como correr" com os comandos reais)

**Interfaces:**
```ts
// docs/runbooks/wa-akg.md — linhas de docs/04 §10 com comandos reais:
//   sessão desligada | logged_out inesperado/pico de falhas (suspected_ban) | WA-AKG em baixo |
//   reconciliação de unknown_delivery (SQL de listagem + passos manuais) | fuga de segredos (rodar já)
// src/adapters/http/README.md — responsabilidade, mapa de rotas + papéis, como testar
```

**Steps:**

- [ ] **1. READMEs e runbooks.** Escrever os ficheiros acima (curtos, `docs/02` §13): no README do adaptador, tabela endpoint→método do port→teste de contrato; no de HTTP, matriz de rotas × papéis (a da Global Constraints) e o fluxo de cookies/CSRF/TOTP; runbooks com comandos concretos (`npm run test:contract`, SQL de consulta de `unknown_delivery`, etc.), sem segredos.
- [ ] **2. Verificação de estrutura.** `find src tests -type d | sort` corresponde à árvore de `docs/02` §1 atualizada; `npm test -- tests/unit/schema-coverage.test.ts` → `pass, fail 0` (lista estendida, nunca enfraquecida); `git status --porcelain` vazio após os commits.
- [ ] **3. Prova de ausência de segredos/PII.** `grep -rniE "(password|secret|api[_-]?key|token)\s*[:=]\s*['\"][^'\"]{8,}" src tests scripts --exclude-dir=node_modules` → rever manualmente: só placeholders; logs de exemplo com telefone mascarado (`maskPhone`).
- [ ] **4. Verificação no navegador (hook global).** Subir o ambiente de teste (contentores + `npm run dev` em background com env de exemplo) e correr `bash ~/.config/opencode/skills/agent-browser-verify/scripts/verify.sh http://localhost:3000/v1/openapi.json`; confirmar: snapshot carrega, console sem erros de JS, screenshot anexado ao relatório; testar também `http://localhost:3000/health/live` (200) e `http://localhost:3000/v1/auth/me` sem sessão (401 problem+json); no fim, `agent-browser close --all`.
- [ ] **5. Suíte final.** `npm run lint && npm run typecheck && npm test && npm run test:integration && npm run test:contract` → todos com `fail 0`; colar as saídas no relatório.
- [ ] **6. Relatório de fim de fase.** Entregar (resposta ao utilizador): o que mudou, evidência por critério de `docs/01` §8 (tabela critério → teste → saída), o que ficou por fazer, riscos novos, decisões que precisam de humano (secção "Lacunas" abaixo), e o estado de prontidão para o gate.
- [ ] **7. Commit.** `docs: add adapter http readmes and wa-akg runbooks`

## Lacunas de spec (decisões que precisam de humano)

1. **`inbound_events.ai_claimed_at` — quem cria a migração.** A Fase 3 documenta a coluna como "(novo, Fase 3)"; esta fase cria-a em `drizzle/0002_*` porque a idempotência da Fase 1 precisa dela. A execução da Fase 3 (Tasks 16/17) tem de detetar a coluna existente e não gerar migração duplicada — confirmar com quem executar a Fase 3.
2. **Assinatura da outbox.** ~~Fases 2/3 citam `enqueue({ conversationId, sender, body, idempotencyKey }) → string`~~ — **resolvido:** os planos das Fases 2 e 3 foram alinhados na revisão pós-escrita com a forma desta Fase 1 (`{ accountId, contactId, conversationId, sender, text, idempotencyKey, scheduledAt? } → { outboxId, duplicate }`, Task 17), que é também a da Fase 4. Nenhuma adaptação extra necessária.
3. **Assinatura do `Audit`.** Fixa `{ entity, entityId, detail?, at, ip? }` (Fases 2 e 4 citam exatamente isto); a Fase 3 cita `{ subjectType, subjectId, metadata? }` e terá de adaptar (a cláusula deles admite).
4. **Divisão do pacing.** O prompt da tarefa pedia `WA_CAMPAIGN_DELAY_MS`, `WA_CAMPAIGN_RAMP` e `WA_QUIET_HOURS` na outbox da Fase 1; este plano deixa-as à Fase 4 (`loadCampaignConfig`) e a Fase 1 honra `scheduledAt`+`priority` — confirmar esta divisão (a Fase 4 já as implementa no `enqueue`/tick delas).
5. **Runner de testes da Fase 4.** ~~O plano da Fase 4 usa `vitest`~~ — **resolvido:** o plano da Fase 4 foi convertido para `node:test` + `node:assert/strict` na revisão pós-escrita (0 ocorrências de `vitest`, blocos validados com `tsc --strict`). Todos os planos usam `node:test`; um só comando de teste no CI.
6. **Coluna `estado` de `leads`.** `docs/01` §6 lista `stage` e `estado`; este plano elimina `estado` e fixa `lead_stage` (`open|won|lost`), que é o que a Fase 5 mapeia como `leadStatus`. Tem de ser confirmado no gate de schema da Fase 0 (as perguntas do gate estão respondidas em `docs/schema-base.md` pela Task 1).
7. **Composição do "pico de falhas"** → `suspected_ban`: os números (≥30% em 20) vêm de `docs/04` §7, que fala de campanhas; §6 não define métrica para envios normais. Aqui contam-se só rejeições permanentes (`failed`); timeouts não contam. A calibrar com dados reais.
8. **Mídia recebida.** Fica `media_ref` a apontar para o WA-AKG; copiar para armazenamento do CRM (`docs/04` §1 limite 4) exige decidir armazenamento, validação de tipo/tamanho e retenção — depende da pergunta A4 da auditoria. Sem decisão, URLs podem expirar e a mensagem fica sem conteúdo.
9. **Esquema de assinatura de webhook.** Depende de `docs/wa-akg-audit.md` §B (perguntas 5–8). Se o WA-AKG não tiver HMAC nem segredo partilhado, é gate de `docs/03` §5 e a Task 12 pára.
10. **Atribuição de linha (`leads.line`/`conversations.line`).** Em mensagens orgânicas não há linha conhecida: a Fase 1 deixa `null` (só gatilhos globais até a Fase 3/4 definirem a atribuição). Produto tem de decidir quem a preenche.
11. **`message.created` para campanhas/follow-ups.** Regra fixada aqui: **quem cria a linha emite** (o `enqueue` da Fase 1 para human/AI; os jobs das Fases 4/5 para campaign/followup). Alinhar os planos deles.
12. **Recuperação de `suspected_ban`.** `docs/04` §6 proíbe automação; a Fase 1 não cria rota para um admin limpar o estado. Definir a ação humana (runbook da Task 23 descreve a investigação, não a limpeza).
13. **`buildTestApp().close()`.** O helper fecha io+queue+servidor no `close()`; as Fases 2 e 4 têm de chamar `await app.close()` em cada teste que o use — verificar quando executarem.

## Gate de fim de fase

Gate de `docs/01` §8 (Fase 1): **"primeiro envio real, só para número de teste."**

Critérios da fase (`docs/01` §8) e evidência mínima exigida antes do gate:

- [ ] Autenticação e RBAC do painel → `tests/integration/auth-routes.test.ts` + `tests/integration/users-api.test.ts` (Tasks 9–10).
- [ ] Schema base aplicado por migrações numa base vazia → `tests/integration/migrations.test.ts` + CI a aplicar `drizzle/` do zero (Task 1).
- [ ] Adaptador WA-AKG com testes de contrato contra um mock fiel ao comportamento auditado → `tests/contract/wa-akg-contract.test.ts` (Task 13).
- [ ] Webhooks: verificação de assinatura e caixa de entrada idempotente (mesmo evento 2 vezes) → `tests/integration/webhook-idempotency.test.ts` (Task 20).
- [ ] Outbox + fila de envio com atrasos e limites por conta → `tests/integration/outbox-enqueue.test.ts` + `tests/integration/outbox-worker.test.ts` (Tasks 17–18).
- [ ] Gestão de contas WhatsApp (criar sessão, QR, estado, desligar) → `tests/integration/accounts-api.test.ts` + `tests/integration/account-lifecycle.test.ts` (Task 16).
- [ ] API REST e eventos Socket.IO para conversas e mensagens → `tests/integration/conversations-api.test.ts` + `tests/integration/realtime.test.ts` (Tasks 15 e 21).
- [ ] Fluxo completo sem envios fora da outbox → `tests/integration/send-flow.test.ts` + regra ESLint/análise estática (Tasks 9 e 22).

Regras do gate:

- Esta fase **não faz nenhum envio real**: toda a validação é com o mock fiel da auditoria e com o `FakeMessaging`.
- O primeiro envio real (número de teste, ambiente staging, `WA_*` de staging) só acontece após **aprovação humana explícita** (`AGENTS.md`: "o primeiro envio real de WhatsApp para um número que não seja de teste" é gate; aqui o gate da fase é o envio para número de teste) e fica registado no relatório com dados do envio e resultado.
- **Recusar o gate** se: algum critério acima sem evidência colada; algum teste a falhar; qualquer segredo ou dado pessoal em código/logs/fixtures; qualquer chamada `sendText`/`sendMedia` fora do worker de outbox; `processed_at` preenchido antes do fim do processamento.
