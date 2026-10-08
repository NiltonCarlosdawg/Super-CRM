# Fase 5 — Follow-ups e endurecimento Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar sequências de follow-up por linha com todas as regras de paragem, limites e auditoria de `docs/05` §9, e endurecer a operação com métricas, health checks, alertas, retenção, direitos dos titulares, backups cifrados testados, runbooks e revisão de segurança (`docs/02` §10, `docs/03` §7/§10/§11, `docs/04` §10).
**Architecture:** A lógica de follow-ups é domínio puro (validação de passos, janelas horárias em `Africa/Luanda`, decisão `wait/stop/defer/proceed`) consumido por casos de uso que escrevem **só** na outbox, com job idempotente, cap diário por conta e serialização. O endurecimento é transversal: módulo de métricas próprio (sem dependência nova), rotas `/health/live`, `/health/ready` e `/metrics`, job de alertas com estado em Postgres, jobs de retenção e casos de uso de exportação/apagamento, tudo documentado em `docs/runbooks/`.
**Tech Stack:** Node LTS + Fastify, PostgreSQL + Drizzle ORM (migrações versionadas), Redis + BullMQ atrás do port de jobs, Socket.IO, zod, `node:test` + `assert/strict` (estilo de `reference/orchestrator.test.ts`), testes de integração com Postgres e Redis reais em contentores.
**Spec:** docs/01-contexto-e-plano.md §8 (Fase 5) + docs/06-decisoes-fechadas-a1-a11.md; regras de follow-up em docs/05 §9; endurecimento em docs/02 §10, docs/03 §7/§10/§11 e docs/04 §10.

## Global Constraints

- TypeScript `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`; sem `any` sem comentário `// any: motivo` na própria linha.
- IDs `uuid` (`defaultRandom()`); todos os timestamps `timestamptz` UTC; dinheiro `numeric` no Postgres e `string` em TS.
- Telefones sempre E.164 normalizados pela função única existente (Fase 1); nunca números de telefone completos em logs (mascarar).
- Sem segredos em código, commits, logs, fixtures ou prompts; `.env.example` sem valores reais; chaves novas só como nomes + valores de arranque validados no módulo `config`.
- Só dados sintéticos em testes, seeds e exemplos; as 20 conversas reais são proibidas em tudo.
- Texto do plano e dos comentários em português; código, identificadores e mensagens de commit em inglês; commits convencionais pequenos (`feat:`, `test:`, `fix:`, `docs:`, `chore:`); nunca commits com testes a falhar.
- Testes de integração com **Postgres e Redis reais** (contentores da Fase 0); nenhum teste depende de internet, de relógio real ou de ordem de execução — o tempo entra como parâmetro `now: Date`.
- Idempotência em webhooks, jobs e envios; **nenhum envio direto**: follow-ups entram na `outbox` e saem pela fila com a serialização por conta do `docs/04` §7.
- WA-AKG só pelo port `MessagingProvider`; IA só pelo port `AIProvider` (com `redactForLLM` sempre); decisão de paragem/bloqueio é do código, nunca do prompt (D11).
- Migrações Drizzle geradas com `npm run db:generate`, revistas e aplicáveis do zero numa base vazia; nunca editar migração já aplicada; nunca `drizzle-kit push` fora de dev local.
- Sem dependência nova sem ADR curto: as métricas são implementadas em `src/infra/metrics.ts` (não adicionar `prom-client`).
- Estrutura hexagonal de `docs/02` §1: `domain/` e `application/` não importam Drizzle, BullMQ, Fastify, Socket.IO nem SDKs; toda a entrada validada com zod na fronteira (HTTP, jobs, saída do LLM); erros RFC 9457 `application/problem+json`.
- Comandos do repositório conforme `AGENTS.md` § Comandos (preenchido na Fase 0): `npm test`, `npm run test:integration`, `npm run typecheck`, `npm run lint`, `npm run db:generate`, `npm run db:migrate`.

## Entradas das fases anteriores (consumir, não reinventar)

- **Fase 1:** entidades `whatsapp_accounts`, `contacts` (`marketing_consent`, `consent_at`, `consent_source`, `opted_out_at`), `leads`, `conversations` (`ai_mode`, `line`), `messages` (`direction`, `sender`), `inbound_events`, `outbox_messages` (`idempotency_key`, `scheduled_at`, conta), `users`, `audit_log`; outbox + fila com limites e serialização por conta.
- **Fase 2:** módulo de conhecimento (`reference/knowledge.schema.ts` movido para `src/modules/knowledge/`), incluindo `answer_traces` e o repositório de traces.
- **Fase 3:** port `AIProvider` + adaptador com as cinco guardas determinísticas (`docs/05` §6) e `redactForLLM`; configuração de horário de atendimento (A6: tabela de configuração do painel, fuso `Africa/Luanda`, default Seg–Sex 08:00–17:00); job/rotas de handoff.
- **Fase 4:** configuração `WA_QUIET_HOURS` (default `20:00 a 08:00`, `Africa/Luanda`) e contas/limites de campanha.
- Referenciar tudo isto **pelos nomes de entidades de `docs/01` §6** e pelos contratos dos planos anteriores; onde o plano diga "alinhar com o caminho/nome da Fase N", o ponto de chamada e o comportamento são obrigatórios, o nome do ficheiro segue o plano que o criou.

## Review Focus

- `stop` tem prioridade sobre `defer`: handoff aberto + fora de horário comercial → **para** a sequência, não adia — fixado pelo teste `evaluateRun: open handoff outside business hours stops the run` (Task 4).
- O cap diário conta o dia de `Africa/Luanda`, não UTC (contagem vira à meia-noite local, mesmo já tendo passado a meia-noite UTC) — fixado pelo teste `processDueRun defers at Luanda midnight when daily cap is reached` (Task 7).
- Um job repetido/concorrente não duplica o mesmo follow-up ao cliente — fixado pelo teste `processDueRun twice enqueues a single outbox row` e `processDueRuns caps a same-account batch` (Task 7).
- `DELETE /v1/contacts/:id` não deixa resíduos de dados pessoais em tabelas de outros módulos (`inbound_events` com payload, `outbox_messages`, `knowledge_gaps`, `answer_traces`) — fixado pelo teste `deleteContactData leaves no residual rows or phone strings` (Task 15).
- `/health/ready` degrada para 503 com o WA-AKG ou a base em baixo, mantendo `/health/live` em 200 — fixado pelo teste `ready returns 503 when messaging is down while live stays 200` (Task 11).

---

## Sequência de dependências

Task 1 → Tasks 2–4 (domínio) → Tasks 6–9 (casos de uso de follow-up) → Task 10 (API). Task 5 (métricas) é pré-requisito das Tasks 7, 9 e 12. Tasks 11–18 são independentes entre si, exceto: Task 12 (alertas) consome a Task 5; Task 16 produz o runbook de backups usado na Task 18; Task 18 é a última. A ordem de execução das Tasks 7 e 9 é livre **após** a Task 6: a Task 7 só precisa dos tipos de geração (Task 1) e a Task 9 só implementa o corpo e liga o worker real.

---

### Task 1: Schema das follow-ups e migração

**Files:**
- Create: `src/domain/followups/enums.ts`
- Create: `src/modules/followups/schema.ts`
- Modify: schema Drizzle de `answer_traces` (`src/modules/knowledge/schema.ts`) — acrescentar `followup_run_id`
- Modify: schema Drizzle da `outbox_messages` (módulo da Fase 1) — acrescentar `followup_run_id`
- Create: migração gerada por `npm run db:generate` (ex.: `drizzle/00XX_followups.sql`; usar o nome real devolvido pelo comando)
- Test: `tests/integration/followups-schema.test.ts`

**Interfaces:**
- Consumes: entidades base `users`, `leads`, `conversations`, `contacts`, `whatsapp_accounts`, `outbox_messages`, `answer_traces` (docs/01 §6; schemas das Fases 1–2).
- Produces: `src/domain/followups/enums.ts` — puros, sem Drizzle, usados por schema, domínio e aplicação:
  ```ts
  export const FOLLOWUP_CONDITIONS = ['no_reply', 'qualification_pending'] as const;
  export type FollowupCondition = (typeof FOLLOWUP_CONDITIONS)[number];
  export const FOLLOWUP_CONTENT_MODES = ['template', 'ai'] as const;
  export type FollowupContentMode = (typeof FOLLOWUP_CONTENT_MODES)[number];
  export const FOLLOWUP_RUN_STATUSES = ['active', 'awaiting_approval', 'stopped', 'completed'] as const;
  export type FollowupRunStatus = (typeof FOLLOWUP_RUN_STATUSES)[number];
  export const FOLLOWUP_STOP_REASONS = ['customer_reply','opt_out','open_handoff','human_only','lead_won','lead_lost','manual','sequence_deleted','guard_blocked'] as const;
  export type FollowupStopReason = (typeof FOLLOWUP_STOP_REASONS)[number];
  export const FOLLOWUP_DEFER_REASONS = ['outside_business_hours', 'quiet_hours', 'daily_cap'] as const;
  export type FollowupDeferReason = (typeof FOLLOWUP_DEFER_REASONS)[number];
  export const GUARD_BLOCK_REASONS = ['invalid_sources','price_guard','custom_quote_guard','no_source_facts','human_guard'] as const;
  export type GuardBlockReason = (typeof GUARD_BLOCK_REASONS)[number];
  // Tipos de geração, declarados aqui para que o caso de uso da Task 7 os consuma
  // antes de a Task 9 existir (a implementação fica na Task 9):
  export interface GenerateInput {
    runId: string; stepId: string; stepPosition: number;
    conversationId: string; line: LineSlug | null;          // LineSlug importado (só tipo) de reference/ai-provider.ts
    contentMode: FollowupContentMode; templateText: string | null; aiPrompt: string | null;
    conversationAiMode: 'ai_active' | 'ai_suggest';
    contactFirstName: string; now: Date;
  }
  export type GenerateResult =
    | { kind: 'ready'; text: string }
    | { kind: 'awaiting_approval'; text: string }
    | { kind: 'blocked'; reason: GuardBlockReason };
  ```
- Produces: tabelas `followupSequences`, `followupSteps`, `followupRuns` e colunas novas `answer_traces.followup_run_id uuid NULL` e `outbox_messages.followup_run_id uuid NULL` (ambas com FK para `followup_runs(id)`).

- [ ] **Step 1: Escrever o teste falhoso**

```ts
// tests/integration/followups-schema.test.ts  (node:test + assert/strict, contentor Postgres vazio + migrações)
import assert from 'node:assert/strict';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db } from '../helpers/db'; // helper de testes da Fase 0 (alinhar nome)

test('creates the three followup tables with constraints', async () => {
  const rows = await db.execute(sql`
    select table_name from information_schema.tables
    where table_schema = 'public'
      and table_name in ('followup_sequences','followup_steps','followup_runs')`);
  assert.equal(rows.length, 3);
});

test('rejects a second active run for the same lead and sequence', async () => {
  // seed sintético: um lead, uma sequência, uma conversa, uma conta, um contacto
  await db.execute(sql`insert into followup_runs (id, lead_id, sequence_id, conversation_id, account_id, contact_id, status, current_step, next_run_at)
    values (${runId}, ${leadId}, ${seqId}, ${convId}, ${accId}, ${ctId}, 'active', 0, now())`);
  await assert.rejects(
    db.execute(sql`insert into followup_runs (id, lead_id, sequence_id, conversation_id, account_id, contact_id, status, current_step, next_run_at)
      values (${runId2}, ${leadId}, ${seqId}, ${convId}, ${accId}, ${ctId}, 'active', 0, now())`),
    /followup_runs_lead_sequence_active/u,
  );
});

test('outbox and answer traces carry the followup run id', async () => {
  const cols = await db.execute(sql`
    select table_name, column_name from information_schema.columns
    where column_name = 'followup_run_id'
      and table_name in ('outbox_messages','answer_traces')`);
  assert.equal(cols.length, 2);
});

test('db enums match the domain enum arrays', async () => {
  const labels = await db.execute(sql`
    select e.enumlabel as label from pg_enum e
    join pg_type t on t.oid = e.enumtypid where t.typname = 'followup_stop_reason'`);
  assert.deepEqual(labels.map((r) => r.label).sort(), [...FOLLOWUP_STOP_REASONS].sort());
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npm run test:integration -- tests/integration/followups-schema.test.ts`
Expected: FAIL — `Followup does not exist` / `Failed query: select ... followup_sequences` (as tabelas ainda não existem).

- [ ] **Step 3: Implementar os enums e o schema**

Criar `src/domain/followups/enums.ts` com os cinco arrays/tipos da secção Interfaces. Em `src/modules/followups/schema.ts`, definir (helpers `pk()`, `createdAt()`, `updatedAt()` e import de tabelas base como em `reference/knowledge.schema.ts`):

```ts
export const followupConditionEnum = pgEnum('followup_condition', FOLLOWUP_CONDITIONS);
export const followupContentModeEnum = pgEnum('followup_content_mode', FOLLOWUP_CONTENT_MODES);
export const followupRunStatusEnum = pgEnum('followup_run_status', FOLLOWUP_RUN_STATUSES);
export const followupStopReasonEnum = pgEnum('followup_stop_reason', FOLLOWUP_STOP_REASONS);

export const followupSequences = pgTable('followup_sequences', {
  id: pk(),
  line: text('line').notNull(),                  // 'software' | 'custom' | 'telecom' | 'cctv'
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdBy: uuid('created_by_id').references(() => users.id),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex('followup_sequences_line_name_uq').on(t.line, t.name)]);

export const followupSteps = pgTable('followup_steps', {
  id: pk(),
  sequenceId: uuid('sequence_id').notNull().references(() => followupSequences.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),                 // 1..3, contígua
  delayHours: integer('delay_hours').notNull(),            // desde o fim do passo anterior
  condition: followupConditionEnum('condition').notNull().default('no_reply'),
  contentMode: followupContentModeEnum('content_mode').notNull(),
  templateText: text('template_text'),                     // exige-se quando contentMode = 'template'
  aiPrompt: text('ai_prompt'),                             // exige-se quando contentMode = 'ai'
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('followup_steps_sequence_position_uq').on(t.sequenceId, t.position),
  check('followup_steps_delay_ck', sql`delay_hours > 0`),
  check('followup_steps_content_ck',
    sql`(content_mode = 'template' and template_text is not null) or (content_mode = 'ai' and ai_prompt is not null)`),
]);

export const followupRuns = pgTable('followup_runs', {
  id: pk(),
  leadId: uuid('lead_id').notNull().references(() => leads.id),
  sequenceId: uuid('sequence_id').notNull().references(() => followupSequences.id),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id),
  accountId: uuid('account_id').notNull().references(() => whatsappAccounts.id),
  contactId: uuid('contact_id').notNull().references(() => contacts.id),
  status: followupRunStatusEnum('status').notNull().default('active'),
  stopReason: followupStopReasonEnum('stop_reason'),
  currentStep: integer('current_step').notNull().default(0),   // 0 = nenhum passo enviado
  nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull(),
  lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
  pendingText: text('pending_text'),                           // preenchido em awaiting_approval
  pendingTraceId: uuid('pending_trace_id'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  stoppedAt: timestamp('stopped_at', { withTimezone: true }),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('followup_runs_lead_sequence_active_uq')
    .on(t.leadId, t.sequenceId)
    .where(sql`status in ('active','awaiting_approval')`),
  index('followup_runs_due_idx').on(t.status, t.nextRunAt),
  index('followup_runs_conversation_idx').on(t.conversationId),
  index('followup_runs_account_idx').on(t.accountId),
]);
```

Regra de migração: as tabelas de **outro módulo** só ganham a coluna nova (nunca mexer nas existentes); ordem na migração: `followup_*` primeiro, depois `outbox_messages.followup_run_id` e `answer_traces.followup_run_id`. `reference/` **não** é alterado.

- [ ] **Step 4: Correr e ver passar**

Run: `npm run db:generate && npm run db:migrate && npm run test:integration -- tests/integration/followups-schema.test.ts`
Expected: PASS nos 4 testes. Depois: `npm run db:migrate` numa base vazia nova (CI) → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/followups/enums.ts src/modules/followups/schema.ts src/modules/knowledge/schema.ts drizzle/
git commit -m "feat: add followup schema and migration"
```

---

### Task 2: Validação e escalonamento de passos (domínio)

**Files:**
- Create: `src/domain/followups/schedule.ts`
- Test: `tests/unit/followups/schedule.test.ts`

**Interfaces:**
- Consumes: `FollowupContentMode`/`FollowupCondition` da Task 1.
- Produces:
  ```ts
  export interface StepInput { position: number; delayHours: number }
  export type StepValidationCode =
    | 'too_many_steps' | 'positions_not_contiguous' | 'non_positive_delay' | 'delays_not_increasing';
  export function validateSteps(
    steps: readonly StepInput[],
    maxSteps: number,
  ): { ok: true } | { ok: false; code: StepValidationCode };
  export function dueAt(base: Date, delayHours: number): Date;
  export const DEFAULT_STEP_DELAYS_HOURS: readonly number[]; // [24, 48, 96]
  export const MAX_FOLLOWUP_STEPS_DEFAULT = 3;
  ```

- [ ] **Step 1: Escrever o teste falhoso**

```ts
// tests/unit/followups/schedule.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_STEP_DELAYS_HOURS, dueAt, validateSteps } from '../../../src/domain/followups/schedule';

test('default delays validate and are strictly increasing', () => {
  const steps = DEFAULT_STEP_DELAYS_HOURS.map((delayHours, i) => ({ position: i + 1, delayHours }));
  assert.deepEqual(validateSteps(steps, 3), { ok: true });
  assert.equal(DEFAULT_STEP_DELAYS_HOURS.length, 3);        // máximo 3 passos (docs/05 §9)
  assert.ok(DEFAULT_STEP_DELAYS_HOURS[0]! >= 24);           // primeiro passo ~24 h sem resposta
  for (let i = 1; i < DEFAULT_STEP_DELAYS_HOURS.length; i++) {
    assert.ok(DEFAULT_STEP_DELAYS_HOURS[i]! > DEFAULT_STEP_DELAYS_HOURS[i - 1]!, 'espaçamentos crescentes');
  }
});

test('rejects more than maxSteps', () => {
  const steps = [1, 2, 3, 4].map((position) => ({ position, delayHours: position * 24 }));
  assert.deepEqual(validateSteps(steps, 3), { ok: false, code: 'too_many_steps' });
});

test('rejects non-increasing, non-positive and gapped positions', () => {
  assert.deepEqual(validateSteps([{ position: 1, delayHours: 24 }, { position: 2, delayHours: 24 }], 3),
    { ok: false, code: 'delays_not_increasing' });
  assert.deepEqual(validateSteps([{ position: 1, delayHours: 0 }], 3), { ok: false, code: 'non_positive_delay' });
  assert.deepEqual(validateSteps([{ position: 2, delayHours: 24 }], 3), { ok: false, code: 'positions_not_contiguous' });
});

test('dueAt adds hours in UTC', () => {
  assert.equal(
    dueAt(new Date('2026-10-07T10:00:00.000Z'), 24).toISOString(),
    '2026-10-08T10:00:00.000Z',
  );
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npm test -- tests/unit/followups/schedule.test.ts`
Expected: FAIL — `Cannot find module '../../../src/domain/followups/schedule'`.

- [ ] **Step 3: Implementar `validateSteps`, `dueAt` e as constantes**

Assinaturas exatas acima. Corpo de `dueAt`: `new Date(base.getTime() + delayHours * 3_600_000)`. Corpo de `validateSteps`: verificar por esta ordem e devolver o **primeiro** código — tamanho (`steps.length > maxSteps` → `too_many_steps`), posições `1..n` contíguas (`positions_not_contiguous`), `delayHours > 0` (`non_positive_delay`), estritamente crescente (`delays_not_increasing`).

- [ ] **Step 4: Correr e ver passar**

Run: `npm test -- tests/unit/followups/schedule.test.ts && npm run typecheck`
Expected: PASS (4 testes), typecheck limpo.

- [ ] **Step 5: Commit**

```bash
git add src/domain/followups/schedule.ts tests/unit/followups/schedule.test.ts
git commit -m "feat: add followup step validation and due calculation"
```

---

### Task 3: Janelas horárias (horário comercial e `WA_QUIET_HOURS`)

**Files:**
- Create: `src/domain/followups/windows.ts`
- Test: `tests/unit/followups/windows.test.ts`

**Interfaces:**
- Consumes: configuração de horário de atendimento da Fase 3 (A6: `Africa/Luanda`, default Seg–Sex 08:00–17:00) e `WA_QUIET_HOURS` da Fase 4 (20:00–08:00). Se a Fase 3 expuser função/port para "está no horário?", **reutilizar a dela**; caso contrário usar `isInWindow`/`nextWindowStart` aqui, passando a janela lida da mesma tabela de configuração.
- Produces:
  ```ts
  export interface TimeWindow {
    days: number[];          // 0=Dom .. 6=Sáb; vazio = todos os dias
    startMinute: number;     // minutos desde a meia-noite local
    endMinute: number;       // endMinute < startMinute = janela noturna que transefere a meia-noite
  }
  export function isInWindow(at: Date, timezone: string, w: TimeWindow): boolean;
  export function nextWindowStart(at: Date, timezone: string, w: TimeWindow): Date;
  export function parseQuietHours(value: string, timezone: string): TimeWindow; // "20:00 a 08:00" -> janela
  export const DEFAULT_BUSINESS_HOURS: TimeWindow;  // dias [1..5], 480..1020
  export const DEFAULT_QUIET_HOURS: TimeWindow;     // dias [], 1200..480
  export const LUANDA_TIMEZONE = 'Africa/Luanda';
  ```

- [ ] **Step 1: Escrever o teste falhoso**

```ts
// tests/unit/followups/windows.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_BUSINESS_HOURS, DEFAULT_QUIET_HOURS, LUANDA_TIMEZONE,
  isInWindow, nextWindowStart, parseQuietHours,
} from '../../../src/domain/followups/windows';

test('business hours: Wednesday 09:00 local in, Saturday 10:00 local out', () => {
  assert.equal(isInWindow(new Date('2026-10-07T08:00:00.000Z'), LUANDA_TIMEZONE, DEFAULT_BUSINESS_HOURS), true);  // 09:00 Luanda
  assert.equal(isInWindow(new Date('2026-10-10T09:00:00.000Z'), LUANDA_TIMEZONE, DEFAULT_BUSINESS_HOURS), false); // sábado 10:00 Luanda
  assert.equal(isInWindow(new Date('2026-10-07T17:00:00.000Z'), LUANDA_TIMEZONE, DEFAULT_BUSINESS_HOURS), false); // 18:00 Luanda
});

test('quiet hours cross midnight: 21:00 and 07:00 local are quiet, 12:00 is not', () => {
  assert.equal(isInWindow(new Date('2026-10-07T20:00:00.000Z'), LUANDA_TIMEZONE, DEFAULT_QUIET_HOURS), true);   // 21:00
  assert.equal(isInWindow(new Date('2026-10-07T06:00:00.000Z'), LUANDA_TIMEZONE, DEFAULT_QUIET_HOURS), true);   // 07:00
  assert.equal(isInWindow(new Date('2026-10-07T11:00:00.000Z'), LUANDA_TIMEZONE, DEFAULT_QUIET_HOURS), false);  // 12:00
});

test('nextWindowStart: Saturday 10:00 local -> Monday 08:00 local (07:00Z)', () => {
  const next = nextWindowStart(new Date('2026-10-10T09:00:00.000Z'), LUANDA_TIMEZONE, DEFAULT_BUSINESS_HOURS);
  assert.equal(next.toISOString(), '2026-10-12T07:00:00.000Z');
});

test('parseQuietHours maps "20:00 a 08:00" to a wrap-around window', () => {
  const w = parseQuietHours('20:00 a 08:00', LUANDA_TIMEZONE);
  assert.deepEqual(w, { days: [], startMinute: 1200, endMinute: 480 });
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npm test -- tests/unit/followups/windows.test.ts`
Expected: FAIL — `Cannot find module '../../../src/domain/followups/windows'`.

- [ ] **Step 3: Implementar as janelas**

Assinaturas exatas acima. Corpo: converter `at` para dia-da-semana e minutos locais com `Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })` e `formatToParts` (sem dependência nova); `isInWindow` trata `endMinute < startMinute` como transefereço (`minutes >= start || minutes < end`); `nextWindowStart` avança minuto a minuto **por passos de 15 minutos** a partir de `at` até encontrar o primeiro minuto dentro da janela e devolve esse `Date` (algoritmo simples e testável; não otimizar). `parseQuietHours` rejeita formato inválido com `Error('invalid quiet hours: <valor>')`.

- [ ] **Step 4: Correr e ver passar**

Run: `npm test -- tests/unit/followups/windows.test.ts && npm run typecheck`
Expected: PASS (4 testes), typecheck limpo.

- [ ] **Step 5: Commit**

```bash
git add src/domain/followups/windows.ts tests/unit/followups/windows.test.ts
git commit -m "feat: add business and quiet hours window helpers"
```

---

### Task 4: Elegibilidade, paragem e adiamento (decisão)

**Files:**
- Create: `src/domain/followups/eligibility.ts`
- Test: `tests/unit/followups/eligibility.test.ts`

**Interfaces:**
- Consumes: enums da Task 1; `isInWindow`/`nextWindowStart`/`TimeWindow` da Task 3; `leadStatus: 'open' | 'won' | 'lost'` (mapeado no adaptador a partir do estado do lead da Fase 1 — alinhar com o enum real de `leads`; `docs/01` §6 chama-lhe `stage`/estado, ver lacuna no relatório).
- Produces:
  ```ts
  export interface StartContext {
    conversationStartedBy: 'customer' | 'outbound';   // primeira mensagem da conversa (direction/sender)
    contact: { marketingConsent: boolean; optedOutAt: Date | null };
    leadStatus: 'open' | 'won' | 'lost';
    leadLine: string;
    sequence: { enabled: boolean; line: string };
  }
  export function isEligibleToStart(c: StartContext): boolean;

  export interface RunContext {
    run: { status: 'active'; currentStep: number; nextRunAt: Date; lastSentAt: Date | null };
    conversation: { aiMode: 'ai_active' | 'ai_suggest' | 'human_only'; lastCustomerMessageAt: Date | null };
    contact: { optedOutAt: Date | null };
    leadStatus: 'open' | 'won' | 'lost';
    hasOpenHandoff: boolean;
    stepDelayHours: number;          // atraso do próximo passo
    dailyCapRemaining: number;
    businessHours: TimeWindow | null; // null = sem horário configurado -> sempre dentro
    quietHours: TimeWindow;
    timezone: string;
    now: Date;
  }
  export type FollowupAction =
    | { type: 'wait' }
    | { type: 'stop'; reason: FollowupStopReason }
    | { type: 'defer'; until: Date; reason: FollowupDeferReason }
    | { type: 'proceed' };
  export function evaluateRun(ctx: RunContext): FollowupAction;
  export function nextLuandaMidnight(now: Date, timezone: string): Date;
  ```

- [ ] **Step 1: Escrever o teste falhoso**

```ts
// tests/unit/followups/eligibility.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateRun, isEligibleToStart, nextLuandaMidnight, type RunContext } from '../../../src/domain/followups/eligibility';
import { DEFAULT_BUSINESS_HOURS, DEFAULT_QUIET_HOURS, LUANDA_TIMEZONE } from '../../../src/domain/followups/windows';

const inHours = new Date('2026-10-07T09:00:00.000Z');   // 10:00 Luanda, quarta
const outHours = new Date('2026-10-07T17:00:00.000Z');  // 18:00 Luanda

function ctx(patch: Partial<RunContext> = {}): RunContext {
  return {
    run: { status: 'active', currentStep: 1, nextRunAt: new Date('2026-10-07T08:00:00.000Z'), lastSentAt: new Date('2026-10-06T09:00:00.000Z') },
    conversation: { aiMode: 'ai_active', lastCustomerMessageAt: null },
    contact: { optedOutAt: null },
    leadStatus: 'open',
    hasOpenHandoff: false,
    stepDelayHours: 48,
    dailyCapRemaining: 5,
    businessHours: DEFAULT_BUSINESS_HOURS,
    quietHours: DEFAULT_QUIET_HOURS,
    timezone: LUANDA_TIMEZONE,
    now: inHours,
    ...patch,
  };
}

test('not due -> wait', () => {
  assert.deepEqual(evaluateRun(ctx({ run: { ...ctx().run, nextRunAt: new Date('2026-10-08T08:00:00.000Z') } })), { type: 'wait' });
});

test('customer replied after last follow-up -> stop customer_reply', () => {
  const c = ctx({ conversation: { aiMode: 'ai_active', lastCustomerMessageAt: new Date('2026-10-06T10:00:00.000Z') } });
  assert.deepEqual(evaluateRun(c), { type: 'stop', reason: 'customer_reply' });
});

test('opt-out, human_only, open handoff and closed lead all stop', () => {
  assert.deepEqual(evaluateRun(ctx({ contact: { optedOutAt: inHours } })), { type: 'stop', reason: 'opt_out' });
  assert.deepEqual(evaluateRun(ctx({ conversation: { aiMode: 'human_only', lastCustomerMessageAt: null } })), { type: 'stop', reason: 'human_only' });
  assert.deepEqual(evaluateRun(ctx({ hasOpenHandoff: true })), { type: 'stop', reason: 'open_handoff' });
  assert.deepEqual(evaluateRun(ctx({ leadStatus: 'won' })), { type: 'stop', reason: 'lead_won' });
  assert.deepEqual(evaluateRun(ctx({ leadStatus: 'lost' })), { type: 'stop', reason: 'lead_lost' });
});

test('stop beats defer: open handoff outside business hours still stops', () => {
  const a = evaluateRun(ctx({ now: outHours, hasOpenHandoff: true }));
  assert.deepEqual(a, { type: 'stop', reason: 'open_handoff' });
});

test('outside business hours defers until the next opening', () => {
  const a = evaluateRun(ctx({ now: outHours }));
  assert.equal(a.type, 'defer');
  assert.equal(a.type === 'defer' ? a.reason : '', 'outside_business_hours');
  assert.equal(a.type === 'defer' ? a.until.toISOString() : '', '2026-10-08T07:00:00.000Z'); // 08:00 Luanda de quinta
});

test('daily cap exhausted defers until Luanda midnight', () => {
  const a = evaluateRun(ctx({ now: new Date('2026-10-07T22:30:00.000Z'), dailyCapRemaining: 0 })); // 23:30 Luanda
  assert.deepEqual(a, { type: 'defer', until: new Date('2026-10-07T23:00:00.000Z'), reason: 'daily_cap' });
  assert.equal(nextLuandaMidnight(new Date('2026-10-07T22:30:00.000Z'), LUANDA_TIMEZONE).toISOString(), '2026-10-07T23:00:00.000Z');
});

test('all clear -> proceed', () => {
  assert.deepEqual(evaluateRun(ctx()), { type: 'proceed' });
});

test('start eligibility: customer-started always, outbound only with consent', () => {
  const base = {
    conversationStartedBy: 'customer' as const,
    contact: { marketingConsent: false, optedOutAt: null },
    leadStatus: 'open' as const, leadLine: 'telecom',
    sequence: { enabled: true, line: 'telecom' },
  };
  assert.equal(isEligibleToStart(base), true);
  assert.equal(isEligibleToStart({ ...base, conversationStartedBy: 'outbound' }), false);
  assert.equal(isEligibleToStart({ ...base, conversationStartedBy: 'outbound', contact: { marketingConsent: true, optedOutAt: null } }), true);
  assert.equal(isEligibleToStart({ ...base, contact: { marketingConsent: false, optedOutAt: inHours } }), false);
  assert.equal(isEligibleToStart({ ...base, leadStatus: 'lost' }), false);
  assert.equal(isEligibleToStart({ ...base, sequence: { enabled: false, line: 'telecom' } }), false);
  assert.equal(isEligibleToStart({ ...base, sequence: { enabled: true, line: 'software' } }), false);
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npm test -- tests/unit/followups/eligibility.test.ts`
Expected: FAIL — `Cannot find module '../../../src/domain/followups/eligibility'`.

- [ ] **Step 3: Implementar `isEligibleToStart`, `evaluateRun`, `nextLuandaMidnight`**

Ordem obrigatória de `evaluateRun` (fixada pelos testes): (1) `now < nextRunAt` → `wait`; (2) paragens por esta ordem — `contact.optedOutAt` → `opt_out`, `aiMode === 'human_only'` → `human_only`, `hasOpenHandoff` → `open_handoff`, `leadStatus` `won`/`lost` → `lead_won`/`lead_lost`, `lastCustomerMessageAt > lastSentAt` (e `lastSentAt !== null`) → `customer_reply`; (3) adiamentos por esta ordem — `dailyCapRemaining <= 0` → `defer` até `nextLuandaMidnight`, `isInWindow(now, tz, quietHours)` → `defer` até `nextWindowStart` da quiet, `businessHours !== null && !isInWindow(now, tz, businessHours)` → `defer` até `nextWindowStart` do horário; (4) `proceed`. **Paragens sempre antes de adiamentos.** `isEligibleToStart`: sequência `enabled` e `sequence.line === leadLine`, lead `open`, sem `optedOutAt`, e (`conversationStartedBy === 'customer'` **ou** `marketingConsent`).

- [ ] **Step 4: Correr e ver passar**

Run: `npm test -- tests/unit/followups/eligibility.test.ts && npm run typecheck`
Expected: PASS (9 testes), typecheck limpo.

- [ ] **Step 5: Commit**

```bash
git add src/domain/followups/eligibility.ts tests/unit/followups/eligibility.test.ts
git commit -m "feat: add followup eligibility and stop/defer decision"
```

---

### Task 5: Métricas e endpoint `/metrics`

**Files:**
- Create: `src/infra/metrics.ts`
- Create: `src/adapters/http/routes/metrics.ts`
- Modify: módulo `config` (Fase 0) — nova chave `METRICS_TOKEN` (obrigatória, ≥ 32 caracteres, só env)
- Modify: pontos de instrumentação existentes — caixa de entrada de webhooks, job de envio da outbox, chamada de IA/orquestrador, criação de handoff, registo de lacuna, job de envio (Fases 1–3; alinhar caminhos com os planos que os criaram)
- Test: `tests/unit/infra/metrics.test.ts`, `tests/integration/metrics-route.test.ts`

**Interfaces:**
- Consumes: Fastify (A1), config validado no arranque, contas/estados de sessão e filas via repositórios/ports das Fases 1–4.
- Produces:
  ```ts
  // src/infra/metrics.ts
  export function inc(name: MetricName, labels?: Record<string, string>, value?: number): void;
  export function observe(name: MetricName, value: number, labels?: Record<string, string>): void; // só histogramas
  export function setGauge(name: MetricName, value: number, labels?: Record<string, string>): void;
  export function renderMetrics(): string;   // Prometheus text exposition 0.0.4
  export function resetMetrics(): void;      // testes
  export function setGaugeFromSnapshot(name: MetricName, values: { labels: Record<string, string>; value: number }[]): void;
  ```
  Nomes obrigatórios (todos registados; nome desconhecido lança `Error('unknown metric: <nome>')`):
  ```
  contadores:  crm_messages_received_total{account}  crm_messages_sent_total{account}  crm_send_failed_total{account}
               crm_ai_requests_total{outcome="ok"|"error"}  crm_handoffs_total  crm_knowledge_gaps_total
               crm_followups_sent_total  crm_followups_blocked_total{reason}
  histograma:  crm_ai_latency_ms  buckets [50,100,250,500,1000,2000,5000,10000,20000]
  gauges:      crm_queue_depth{queue}  crm_queue_oldest_age_seconds{queue}  crm_dead_letter_size{queue}
               crm_session_state{account,state}
  ```

- [ ] **Step 1: Escrever o teste falhoso**

```ts
// tests/unit/infra/metrics.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { inc, observe, renderMetrics, resetMetrics, setGauge } from '../../../src/infra/metrics';

test('renders counters, histogram and gauges in Prometheus format', () => {
  resetMetrics();
  inc('crm_messages_sent_total', { account: 'acc-1' });
  inc('crm_messages_sent_total', { account: 'acc-1' });
  inc('crm_ai_requests_total', { outcome: 'error' });
  observe('crm_ai_latency_ms', 120);
  setGauge('crm_queue_depth', 7, { queue: 'outbox:acc-1' });
  const out = renderMetrics();
  assert.match(out, /crm_messages_sent_total\{account="acc-1"\} 2/u);
  assert.match(out, /crm_ai_requests_total\{outcome="error"\} 1/u);
  assert.match(out, /crm_ai_latency_ms_bucket\{le="250"\} 1/u);
  assert.match(out, /crm_queue_depth\{queue="outbox:acc-1"\} 7/u);
  assert.match(out, /# TYPE crm_ai_latency_ms histogram/u);
});

test('unknown metric names throw', () => {
  resetMetrics();
  assert.throws(() => inc('crm_not_a_metric'), /unknown metric/u);
  assert.throws(() => setGauge('crm_not_a_metric', 1), /unknown metric/u);
});
```

```ts
// tests/integration/metrics-route.test.ts
test('GET /metrics requires the token', async () => {
  const noToken = await app.inject({ method: 'GET', url: '/metrics' });
  assert.equal(noToken.statusCode, 401);
  const withToken = await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${config.METRICS_TOKEN}` } });
  assert.equal(withToken.statusCode, 200);
  assert.match(withToken.body, /crm_messages_received_total/u);
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npm test -- tests/unit/infra/metrics.test.ts`
Expected: FAIL — `Cannot find module '../../../src/infra/metrics'`.

- [ ] **Step 3: Implementar o módulo, a rota e a instrumentação**

Implementar `src/infra/metrics.ts` com um registry interno (contadores `Map<nome+labels, number>`, histogramas com `_bucket/_sum/_count`, gauges); nomes validados contra as constantes declaradas; `renderMetrics()` devolve linhas `# HELP`/`# TYPE` estáveis por nome. Rota `GET /metrics`: valida `Authorization: Bearer <METRICS_TOKEN>` em comparação de tempo constante, 401 sem/errado, 200 `text/plain; version=0.0.4` com `renderMetrics()`; **sem** dados de clientes (só agregados). Adicionar `METRICS_TOKEN` ao esquema de config (obrigatória; arranque falha se faltar) e ao `.env.example` como `METRICS_TOKEN=` (sem valor). Instrumentar os pontos existentes: entrada de mensagem → `crm_messages_received_total`; outbox enviada → `crm_messages_sent_total`, falha → `crm_send_failed_total`; chamada de IA → `crm_ai_requests_total{outcome}` + `observe('crm_ai_latency_ms', ...)`; handoff criado → `crm_handoffs_total`; lacuna registada → `crm_knowledge_gaps_total`. Os gauges de fila/sessão são alimentados na Task 12 (coletor) — aqui ficam declarados e com `setGaugeFromSnapshot` pronto.

- [ ] **Step 4: Correr e ver passar**

Run: `npm test -- tests/unit/infra/metrics.test.ts && npm run test:integration -- tests/integration/metrics-route.test.ts && npm run typecheck && npm run lint`
Expected: PASS nos 3 testes, typecheck e lint limpos.

- [ ] **Step 5: Commit**

```bash
git add src/infra/metrics.ts src/adapters/http/routes/metrics.ts tests/unit/infra/metrics.test.ts tests/integration/metrics-route.test.ts
git commit -m "feat: add internal metrics module and /metrics endpoint"
```

---

### Task 6: Início de sequências por mensagem de saída

**Files:**
- Create: `src/application/followups/start-followups.ts`
- Test: `tests/unit/followups/start-followups.test.ts`

**Interfaces:**
- Consumes: `isEligibleToStart` (Task 4), `DEFAULT_STEP_DELAYS_HOURS`/`dueAt` (Task 2), tabelas da Task 1, entidades `conversations`/`messages`/`leads`/`contacts` (Fase 1).
- Produces:
  ```ts
  export interface StartDeps {
    leadOfConversation(conversationId: string): Promise<{ id: string; line: string; status: 'open' | 'won' | 'lost' } | null>;
    conversationStartedBy(conversationId: string): Promise<'customer' | 'outbound'>; // primeira mensagem (direction/sender)
    contactOf(conversationId: string): Promise<{ id: string; marketingConsent: boolean; optedOutAt: Date | null }>;
    accountIdOf(conversationId: string): Promise<string>;
    sequencesForLine(line: string): Promise<{ id: string; enabled: boolean; line: string; firstDelayHours: number }[]>;
    activeRunExists(leadId: string, sequenceId: string): Promise<boolean>;
    createRun(input: { leadId: string; sequenceId: string; conversationId: string; accountId: string; contactId: string; startedAt: Date; nextRunAt: Date }): Promise<string>;
  }
  export async function startFollowupsForConversation(
    deps: StartDeps,
    input: { conversationId: string; sentAt: Date },
  ): Promise<{ createdRunIds: string[] }>;
  ```

- [ ] **Step 1: Escrever o teste falhoso**

```ts
// tests/unit/followups/start-followups.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { startFollowupsForConversation, type StartDeps } from '../../../src/application/followups/start-followups';

function harness(patch: Partial<Parameters<StartDeps['createRun']>[0]> = {}) { /* deps em memória com: lead open/telecom,
  primeira mensagem do cliente, contacto sem consentimento, 1 sequência enabled com firstDelayHours 24 */ }

test('first outbound message creates a run due in 24h', async () => {
  const h = harness();
  const { createdRunIds } = await startFollowupsForConversation(h.deps, { conversationId: 'conv-1', sentAt: new Date('2026-10-07T09:00:00.000Z') });
  assert.equal(createdRunIds.length, 1);
  assert.equal(h.created[0]?.nextRunAt.toISOString(), '2026-10-08T09:00:00.000Z');
});

test('second outbound while a run is active does not duplicate', async () => {
  const h = harness();
  await startFollowupsForConversation(h.deps, { conversationId: 'conv-1', sentAt: new Date('2026-10-07T09:00:00.000Z') });
  const again = await startFollowupsForConversation(h.deps, { conversationId: 'conv-1', sentAt: new Date('2026-10-07T10:00:00.000Z') });
  assert.deepEqual(again.createdRunIds, []);
  assert.equal(h.created.length, 1);
});

test('outbound-started conversation without consent is not eligible', async () => {
  const h = harness({ startedBy: 'outbound', marketingConsent: false });
  const r = await startFollowupsForConversation(h.deps, { conversationId: 'conv-1', sentAt: new Date('2026-10-07T09:00:00.000Z') });
  assert.deepEqual(r.createdRunIds, []);
});

test('a stopped run restarts on the next outbound message', async () => {
  const h = harness({ runAlreadyStopped: true });   // run anterior terminou por customer_reply
  const r = await startFollowupsForConversation(h.deps, { conversationId: 'conv-1', sentAt: new Date('2026-10-08T09:00:00.000Z') });
  assert.equal(r.createdRunIds.length, 1);
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npm test -- tests/unit/followups/start-followups.test.ts`
Expected: FAIL — `Cannot find module '../../../src/application/followups/start-followups'`.

- [ ] **Step 3: Implementar `startFollowupsForConversation`**

Corpo: carregar lead (se `null` ou estado não for elegível → `{ createdRunIds: [] }`); `Promise.all` de `conversationStartedBy`, `contactOf`, `accountIdOf`, `sequencesForLine(line)`; para cada sequência com `enabled && line === lead.line`, construir `StartContext` e, se `isEligibleToStart` e `!await activeRunExists(lead.id, seq.id)`, criar run com `startedAt = sentAt` e `nextRunAt = dueAt(sentAt, seq.firstDelayHours)` (primeiro passo ~24 h sem resposta). Reinício: um run **parado** não bloqueia a criação de um novo (a unicidade parcial da Task 1 só cobre `active`/`awaiting_approval`). Ponto de chamada: no fim do caso de uso que grava uma mensagem de saída (Fase 1; alinhar caminho), após a transação — nunca dentro de um handler HTTP.

- [ ] **Step 4: Correr e ver passar**

Run: `npm test -- tests/unit/followups/start-followups.test.ts && npm run typecheck`
Expected: PASS (4 testes), typecheck limpo.

- [ ] **Step 5: Commit**

```bash
git add src/application/followups/start-followups.ts tests/unit/followups/start-followups.test.ts
git commit -m "feat: start followup runs on outbound messages"
```

---

### Task 7: Job de follow-ups devidos (cap diário, serialização, idempotência)

**Files:**
- Create: `src/application/followups/process-due-followups.ts`
- Create: `src/adapters/queue/followup-jobs.ts`
- Modify: módulo `config` — nova chave `WA_FOLLOWUP_DAILY_CAP` (inteiro, default `20`, mínimo `1`)
- Test: `tests/unit/followups/process-due-followups.test.ts`, `tests/integration/followup-cap.test.ts`

**Interfaces:**
- Consumes: `evaluateRun` (Task 4), `validateSteps`/`dueAt` (Task 2), tipos `GenerateInput`/`GenerateResult` de `src/domain/followups/enums.ts` (Task 1 — a **implementação** `generateFollowupText` chega na Task 9; aqui entra como dependência injetada, permitindo testar este caso de uso com um fake), port de jobs da Fase 1 (BullMQ/pg-boss, `jobId` determinístico, lock de jobs recorrentes), outbox da Fase 1 (`idempotency_key` única, serialização por conta).
- Produces:
  ```ts
  export interface ProcessDeps {
    listDueRuns(now: Date, limit: number): Promise<string[]>;            // status active, nextRunAt <= now, ordenado por accountId
    loadRun(runId: string): Promise<RunContext | null>;                   // null se parada/concluída/inespécime
    countSentToday(accountId: string, now: Date, timezone: string): Promise<number>; // outbox com followup_run_id no dia local
    enqueueOutbox(input: { conversationId: string; accountId: string; contactId: string; text: string; followupRunId: string; idempotencyKey: string }): Promise<'queued' | 'duplicate'>; // adaptador fino sobre `outbox.enqueue` da Fase 1 (Task 17: `{ accountId, contactId, conversationId, sender, text, idempotencyKey, scheduledAt? } → { outboxId, duplicate }`); este wrapper escolhe `sender: 'ai'` (gerado) ou `'human'` (aprovado) e devolve `'queued' | 'duplicate'
    advanceRun(input: { runId: string; stepPosition: number; sentAt: Date | null; nextRunAt: Date | null; status: FollowupRunStatus; pendingText?: string | null; pendingTraceId?: string | null; stopReason?: FollowupStopReason }): Promise<void>;
    generate: (input: GenerateInput) => Promise<GenerateResult>;          // tipos da Task 1; implementação na Task 9
    incMetric: (name: 'crm_followups_sent_total' | 'crm_followups_blocked_total', labels?: Record<string, string>) => void;
  }
  export type ProcessOutcome = 'not_found' | 'already_done' | 'wait' | 'stopped' | 'deferred' | 'queued' | 'awaiting_approval' | 'blocked';
  export async function processDueRun(deps: ProcessDeps, runId: string, cfg: { now: Date; timezone: string; dailyCap: number }): Promise<ProcessOutcome>;
  export async function processDueRuns(deps: ProcessDeps, runIds: readonly string[], cfg: { now: Date; timezone: string; dailyCap: number }): Promise<ProcessOutcome[]>;
  ```

- [ ] **Step 1: Escrever o teste falhoso**

```ts
// tests/unit/followups/process-due-followups.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { processDueRun, processDueRuns, type ProcessDeps } from '../../../src/application/followups/process-due-followups';

function harness(opts: { capRemaining?: number; now?: Date } = {}) { /* deps em memória: um run devido, conta acc-1,
   countSentToday devolve dailyCap - capRemaining, generate devolve { kind: 'ready', text: 'Olá!' } */ }

test('processDueRun twice enqueues a single outbox row', async () => {
  const h = harness();
  const first = await processDueRun(h.deps, 'run-1', h.cfg);
  const second = await processDueRun(h.deps, 'run-1', h.cfg);
  assert.equal(first, 'queued');
  assert.equal(second, 'already_done');
  assert.equal(h.outbox.length, 1);
  assert.equal(h.outbox[0]?.idempotencyKey, 'followup:run-1:2'); // run:1 já enviado -> passo 2
});

test('processDueRun defers at Luanda midnight when daily cap is reached', async () => {
  const h = harness({ capRemaining: 0, now: new Date('2026-10-07T22:30:00.000Z') }); // 23:30 Luanda
  const out = await processDueRun(h.deps, 'run-1', h.cfg);
  assert.equal(out, 'deferred');
  assert.deepEqual(h.deferred, [{ runId: 'run-1', until: new Date('2026-10-07T23:00:00.000Z') }]); // 00:00 Luanda
});

test('processDueRuns caps a same-account batch without overshooting', async () => {
  const h = harness({ capRemaining: 2 });   // 5 runs devidos na conta acc-1
  const outs = await processDueRuns(h.deps, ['r1', 'r2', 'r3', 'r4', 'r5'], h.cfg);
  assert.deepEqual(outs, ['queued', 'queued', 'deferred', 'deferred', 'deferred']);
  assert.equal(h.outbox.length, 2);
  assert.equal(h.processedOrder.join(','), 'r1,r2,r3,r4,r5'); // serial, uma conta de cada vez, por ordem
});

test('stop conditions are honoured at send time', async () => {
  const h = harness();
  h.run.conversation.aiMode = 'human_only';
  assert.equal(await processDueRun(h.deps, 'run-1', h.cfg), 'stopped');
  assert.equal(h.outbox.length, 0);
});
```

```ts
// tests/integration/followup-cap.test.ts — Postgres real, outbox real
test('countSentToday only counts rows of the Luanda day', async () => {
  // 3 mensagens de follow-up criadas 2026-10-07T22:45:00Z (23:45 Luanda) e 1 criada 2026-10-07T23:30:00Z (00:30 Luanda, dia seguinte)
  const now = new Date('2026-10-07T22:50:00.000Z');
  assert.equal(await countSentToday('acc-1', now, 'Africa/Luanda'), 3);
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npm test -- tests/unit/followups/process-due-followups.test.ts`
Expected: FAIL — `Cannot find module '../../../src/application/followups/process-due-followups'`.

- [ ] **Step 3: Implementar o caso de uso, o repositório e o job**

`processDueRun`: `loadRun` → `null` → `not_found`; estado ≠ `active` → `already_done`; construir `RunContext` (incluindo `dailyCapRemaining = dailyCap - await countSentToday(...)`) e chamar `evaluateRun`; `wait`/`stopped` (`advanceRun` com `status: 'stopped'` + `stopReason`) / `deferred` (`advanceRun` mantendo `active` e `nextRunAt = until`) devolvem o respetivo outcome. Em `proceed`: passo `position = run.currentStep + 1` (se não existir → `advanceRun({ status: 'completed', nextRunAt: null })`); `generate(...)` → `ready`: `enqueueOutbox` com `idempotencyKey: \`followup:${runId}:${position}\`` e depois `advanceRun({ stepPosition: position, sentAt: now, nextRunAt: dueAt(now, próximoDelay), status: 'active' })` (conta `crm_followups_sent_total`); `awaiting_approval`: `advanceRun({ status: 'awaiting_approval', pendingText, pendingTraceId })`; `blocked`: `advanceRun({ stepPosition: position, sentAt: null, nextRunAt: dueAt(now, próximoDelay), status: 'active' })` e conta `crm_followups_blocked_total{reason}` — o passo é saltado, a sequência continua. `processDueRuns`: itera **sequencialmente** e, se um outcome for `deferred` por `daily_cap`, marca a conta como "cap esgotado" e devolve `deferred` para os restantes runs da mesma conta sem sequer gerar texto.

`src/adapters/queue/followup-jobs.ts`: exporta `createFollowupWorker(deps: ProcessDeps, cfg: { timezone: string; dailyCap: number })` — fila `followups`, **`concurrency: 1`** (garante a serialização exigida por `docs/04` §7 sem depender de grupos do BullMQ), job recorrente com `jobId` determinístico `followup-tick:<yyyy-MM-ddTHH:mmZ>` e lock; o handler busca runs devidos (`listDueRuns`, lote de 100) e chama `processDueRuns`. A construção do `ProcessDeps` **real** (incluindo `generate`) fica para a Task 9, depois de `generateFollowupText` existir. Repositório (`src/adapters/db/followup-repository.ts`): `countSentToday` conta `outbox_messages` com `followup_run_id = accountId` e `created_at` dentro do dia local (usar `sql` template com fuso; nunca concatenar).

- [ ] **Step 4: Correr e ver passar**

Run: `npm test -- tests/unit/followups/process-due-followups.test.ts && npm run test:integration -- tests/integration/followup-cap.test.ts && npm run typecheck`
Expected: PASS (5 testes unit + 1 integração), typecheck limpo.

- [ ] **Step 5: Commit**

```bash
git add src/application/followups/process-due-followups.ts src/adapters/queue/followup-jobs.ts src/adapters/db/followup-repository.ts tests/unit/followups/process-due-followups.test.ts tests/integration/followup-cap.test.ts
git commit -m "feat: add due followup job with daily cap and idempotency"
```

---

### Task 8: Paragem imediata por eventos

**Files:**
- Create: `src/application/followups/stop-followups.ts`
- Modify: caso de uso de entrada de mensagem (Fase 1), handler de opt-out (Fase 4), criação de handoff e transição para `human_only` (Fase 3/A6), atualização do estado do lead (Fase 1/2) — alinhar caminhos com os planos que os criaram
- Test: `tests/unit/followups/stop-followups.test.ts`

**Interfaces:**
- Consumes: enums da Task 1; tabela `followup_runs` da Task 1.
- Produces:
  ```ts
  export interface StopDeps {
    stopActiveRuns(filter: {
      conversationId?: string; contactId?: string; leadId?: string;
      after?: Date;
    }, reason: FollowupStopReason, at: Date): Promise<number>;
  }
  export async function onCustomerReply(deps: StopDeps, input: { conversationId: string; at: Date }): Promise<number>;
  export async function onOptOut(deps: StopDeps, input: { contactId: string; at: Date }): Promise<number>;
  export async function onHandoffOpened(deps: StopDeps, input: { conversationId: string; at: Date }): Promise<number>;
  export async function onConversationHumanOnly(deps: StopDeps, input: { conversationId: string; at: Date }): Promise<number>;
  export async function onLeadClosed(deps: StopDeps, input: { leadId: string; status: 'won' | 'lost'; at: Date }): Promise<number>;
  ```

- [ ] **Step 1: Escrever o teste falhoso**

```ts
// tests/unit/followups/stop-followups.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { onCustomerReply, onHandoffOpened, onOptOut, type StopDeps } from '../../../src/application/followups/stop-followups';

test('customer reply stops active runs of that conversation exactly once', async () => {
  const calls: { filter: unknown; reason: string }[] = [];
  const deps: StopDeps = { stopActiveRuns: async (filter, reason) => (calls.push({ filter, reason }), 1) };
  const at = new Date('2026-10-07T09:00:00.000Z');
  assert.equal(await onCustomerReply(deps, { conversationId: 'conv-1', at }), 1);
  assert.deepEqual(calls[0], { filter: { conversationId: 'conv-1' }, reason: 'customer_reply' });
  assert.equal(await onOptOut(deps, { contactId: 'ct-1', at }), 1);
  assert.equal(await onHandoffOpened(deps, { conversationId: 'conv-1', at }), 1);
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npm test -- tests/unit/followups/stop-followups.test.ts`
Expected: FAIL — `Cannot find module '../../../src/application/followups/stop-followups'`.

- [ ] **Step 3: Implementar as cinco funções e ligar os pontos de chamada**

Cada função delega em `stopActiveRuns(filter, reason, at)` e devolve o número de runs parados (idempotente: só `status = 'active'`). Pontos de chamada: após gravação da mensagem de entrada (`onCustomerReply`), no handler que marca `contacts.opted_out_at` (`onOptOut`), na criação de um handoff (`onHandoffOpened`), na transição de `conversations.ai_mode` para `human_only` (`onConversationHumanOnly`), na atualização de `leads` para ganho/perdido (`onLeadClosed`). Isto é redundante com a verificação de envio da Task 7 (defesa em profundidade): mesmo sem estes pontos, `evaluateRun` nunca enviaria — aqui o run fica **parado e auditável** de imediato.

- [ ] **Step 4: Correr e ver passar**

Run: `npm test -- tests/unit/followups/stop-followups.test.ts && npm run typecheck && npm run lint`
Expected: PASS (1 teste, 3 asserções), typecheck e lint limpos.

- [ ] **Step 5: Commit**

```bash
git add src/application/followups/stop-followups.ts tests/unit/followups/stop-followups.test.ts
git commit -m "feat: stop followup runs immediately on reply, opt-out, handoff and lead closure"
```

---

### Task 9: Texto de follow-up (template ou IA) com guardas, trace e aprovação

**Files:**
- Create: `src/ports/followup-trace-writer.ts`
- Create: `src/application/followups/generate-followup-text.ts`
- Create: `src/application/followups/approve-followup.ts`
- Test: `tests/unit/followups/generate-followup-text.test.ts`, `tests/unit/followups/approve-followup.test.ts`

**Interfaces:**
- Consumes: port `AIProvider` (Fase 3), as **cinco guardas determinísticas** do adaptador de IA (`docs/05` §6 — se a Fase 3 as expuser como função/port, chamar essa; caso contrário, criar `guardReply` no adaptador delegando na mesma implementação), `redactForLLM`, tipo `TraceInput` de `reference/ai-provider.ts`, tabela `answer_traces` com a coluna nova `followup_run_id` (Task 1), tipos `GenerateInput`, `GenerateResult`, `GuardBlockReason` de `src/domain/followups/enums.ts` (Task 1), `ProcessDeps`/`advanceRun`/`enqueueOutbox` da Task 7.
- Produces:
  ```ts
  // src/ports/followup-trace-writer.ts
  export interface FollowupTraceWriter {
    save(t: TraceInput & { followupRunId: string }): Promise<void>;
  }

  export interface GenerateDeps {
    ai: AIProvider;
    redact(text: string): string;
    guardReply(input: { text: string; sources: SourceRef[] }): { ok: true } | { ok: false; reason: GuardBlockReason };
    trace: FollowupTraceWriter;
  }
  export async function generateFollowupText(deps: GenerateDeps, input: GenerateInput): Promise<GenerateResult>;

  export interface ApproveDeps extends ProcessDeps {}   // reutiliza as dependências da Task 7
  export async function approveFollowupRun(
    deps: ApproveDeps, input: { runId: string; actorId: string; editedText?: string; now: Date },
  ): Promise<{ ok: true } | { ok: false; code: 'not_awaiting_approval' | 'stopped_by_rules' | 'guard_blocked' }>;
  ```

- [ ] **Step 1: Escrever o teste falhoso**

```ts
// tests/unit/followups/generate-followup-text.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { generateFollowupText, type GenerateDeps } from '../../../src/application/followups/generate-followup-text';

test('template renders the contact first name and is ready', async () => {
  const h = harness(); // trace em memória, ai nunca chamado
  const r = await generateFollowupText(h.deps, base({ contentMode: 'template', templateText: 'Olá {{contactFirstName}}, ficou alguma dúvida?' }));
  assert.deepEqual(r, { kind: 'ready', text: 'Olá Ana, ficou alguma dúvida?' });
  assert.equal(h.traces.length, 1);
  assert.equal(h.traces[0]?.followupRunId, 'run-1');   // auditável em answer_traces
});

test('AI text with a price outside catalog facts is blocked by the price guard', async () => {
  const h = harness({ aiReply: 'O plano custa 99.999 Kz.', answered: true, sources: [] });
  const r = await generateFollowupText(h.deps, base({ contentMode: 'ai', aiPrompt: 'lembrar da proposta' }));
  assert.deepEqual(r, { kind: 'blocked', reason: 'price_guard' });
  assert.equal(h.traces[0]?.answer, '');   // nada de texto bloqueado guardado como resposta
});

test('AI text claiming to be human is blocked', async () => {
  const h = harness({ aiReply: 'Sou eu, o João, a responder.', answered: true, sources: [srcChunk] });
  const r = await generateFollowupText(h.deps, base({ contentMode: 'ai', aiPrompt: 'x' }));
  assert.deepEqual(r, { kind: 'blocked', reason: 'human_guard' });
});

test('ai_suggest keeps generated text pending approval; ai_active returns ready', async () => {
  const h = harness({ aiReply: 'Claro, posso ajudar com o CCTV.', answered: true, sources: [srcChunk] });
  const sug = await generateFollowupText(h.deps, base({ contentMode: 'ai', aiPrompt: 'x', conversationAiMode: 'ai_suggest' }));
  assert.equal(sug.kind, 'awaiting_approval');
  const act = await generateFollowupText(h.deps, base({ contentMode: 'ai', aiPrompt: 'x', conversationAiMode: 'ai_active' }));
  assert.equal(act.kind, 'ready');
  assert.equal(h.redacted, true);   // redactForLLM sempre antes de ir ao fornecedor
});
```

```ts
// tests/unit/followups/approve-followup.test.ts
test('approving re-checks stop conditions before enqueueing', async () => {
  // run em awaiting_approval com handoff aberto -> { ok: false, code: 'stopped_by_rules' } e run parado
});
test('approving with edited text re-runs the guards', async () => {
  // editedText com preço fora do catálogo -> { ok: false, code: 'guard_blocked' } e nada enfileirado
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npm test -- tests/unit/followups/generate-followup-text.test.ts`
Expected: FAIL — `Cannot find module '../../../src/application/followups/generate-followup-text'`.

- [ ] **Step 3: Implementar geração, guardas, trace e aprovação**

`generateFollowupText`: renderiza template com `{{contactFirstName}}` **ou** (modo `ai`) monta o `AIRequest` mínimo da Fase 3 (`turns` da conversa, `rules`, chunks via `retrieve`, `mode: 'draft'`) com o texto do prompt do passo em turno de utilizador e `deps.redact` antes; sempre chama `deps.guardReply({ text, sources })` — falhou → `blocked` (trace com `answer: ''`); sucesso → `ready` se `conversationAiMode === 'ai_active'`, senão `awaiting_approval`. **Todo** o resultado grava `deps.trace.save` com `followupRunId`, `question: \`[followup] sequence:<sequenceId> step:<stepPosition>\``, `isTest: false`, `model` e `latencyMs` do `AIResponse` (`'template'` para templates). `approveFollowupRun`: carrega o run; se `status !== 'awaiting_approval'` → `not_awaiting_approval`; reavalia as regras de paragem com `evaluateRun` (parou → `advanceRun({ status:'stopped', stopReason })` e `stopped_by_rules`); texto editado ≠ `pendingText` → `guardReply` (falhou → `guard_blocked`); senão `enqueueOutbox` com `idempotencyKey: \`followup:${runId}:${stepPosition}\`` e `advanceRun({ status:'active', sentAt: now, ... })` como na Task 7.

Por fim, ligar tudo na montagem da aplicação (módulo de arranque/`app` da Fase 0): construir o `ProcessDeps` real (repositório da Task 7 + `generateFollowupText` + `enqueueOutbox` da outbox + `incMetric` da Task 5 + `FollowupTraceWriter` sobre `answer_traces`) e registar `createFollowupWorker(deps, cfg)` na fila `followups`.

- [ ] **Step 4: Correr e ver passar**

Run: `npm test -- tests/unit/followups/ && npm run typecheck`
Expected: PASS (6 testes), typecheck limpo.

- [ ] **Step 5: Commit**

```bash
git add src/ports/followup-trace-writer.ts src/application/followups/generate-followup-text.ts src/application/followups/approve-followup.ts tests/unit/followups/
git commit -m "feat: generate followup text with ai guards, traces and approval flow"
```

---

### Task 10: API REST das sequências e runs de follow-up

**Files:**
- Create: `src/adapters/http/routes/followups.ts`
- Create: `src/adapters/http/schemas/followups.ts`
- Test: `tests/integration/followups-api.test.ts`

**Interfaces:**
- Consumes: casos de uso das Tasks 7–9, RBAC da Fase 1 (`admin`, `editor`, `agent`), erros RFC 9457 e paginação por cursor da Fase 1.
- Produces (rotas, todas exceto a de listagem atrás de sessão + CSRF):
  ```
  POST   /v1/followup-sequences                admin    Idempotency-Key obrigatório -> 201 { id }
  GET    /v1/followup-sequences?line=<slug>    agent|admin -> 200 lista com passos
  PATCH  /v1/followup-sequences/:id            admin    { name?, enabled? } -> 200
  PUT    /v1/followup-sequences/:id/steps      admin    { steps: StepInput[] } -> 200 (validação total)
  DELETE /v1/followup-sequences/:id            admin    -> 204 e para runs ativos (reason 'sequence_deleted')
  GET    /v1/followups/runs?status=&cursor=&limit=  agent|admin -> 200 página (limite 50, cursor)
  GET    /v1/followups/runs/:id                agent|admin -> 200
  POST   /v1/followups/runs/:id/approve        agent|admin { text? } -> 200 | 409
  POST   /v1/followups/runs/:id/discard        agent|admin -> 200 (run -> stopped, reason 'manual')
  ```
  Esquema de criação (zod): `{ line: enum ['software','custom','telecom','cctv'], name: string 1..80, enabled?: boolean, steps: array 1..3 de { position: int 1..3, delayHours: int 1..168, condition: enum, contentMode: enum, templateText?: string, aiPrompt?: string } }` com refinamento: `validateSteps` tem de devolver `{ ok: true }`, `templateText` obrigatório se `contentMode = 'template'`, `aiPrompt` obrigatório se `contentMode = 'ai'`. Erros: 400 `application/problem+json` com `code` = `StepValidationCode`; 409 nome duplicado; 404 sequência/run inexistente.

- [ ] **Step 1: Escrever o teste falhoso**

```ts
// tests/integration/followups-api.test.ts — app Fastify real + Postgres real (contentor)
test('rejects a sequence with four steps', async () => {
  const res = await authedApp('admin').inject({ method: 'POST', url: '/v1/followup-sequences', headers: { 'idempotency-key': 'k-1' }, payload: validPayload({ steps: fourSteps }) });
  assert.equal(res.statusCode, 400);
  assert.equal(res.headers['content-type']?.includes('application/problem+json'), true);
  assert.match(res.body, /too_many_steps/u);
});

test('forbids agent from creating sequences but allows listing runs', async () => {
  const app = authedApp('agent');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/followup-sequences', headers: { 'idempotency-key': 'k-2' }, payload: validPayload() })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/followups/runs' })).statusCode, 200);
});

test('unauthenticated requests get 401', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/v1/followups/runs' })).statusCode, 401);
});

test('approve on a run that is not awaiting approval returns 409', async () => {
  const res = await authedApp('agent').inject({ method: 'POST', url: `/v1/followups/runs/${activeRunId}/approve`, payload: {} });
  assert.equal(res.statusCode, 409);
});

test('deleting a sequence stops its active runs', async () => {
  const res = await authedApp('admin').inject({ method: 'DELETE', url: `/v1/followup-sequences/${seqId}` });
  assert.equal(res.statusCode, 204);
  // repositório: runs ativos dessa sequência -> status stopped, stopReason sequence_deleted
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npm run test:integration -- tests/integration/followups-api.test.ts`
Expected: FAIL — `Route POST:/v1/followup-sequences not found`.

- [ ] **Step 3: Implementar rotas e esquemas**

Rotas só validam (zod), autorizam (papel + recurso, sempre no servidor) e chamam casos de uso; sem lógica de negócio (`docs/02` §8). `POST` exige `Idempotency-Key` (persistida como em qualquer outra criação sensível da Fase 1). OpenAPI gerado do código passa a incluir os novos schemas.

- [ ] **Step 4: Correr e ver passar**

Run: `npm run test:integration -- tests/integration/followups-api.test.ts && npm run typecheck && npm run lint`
Expected: PASS (5 testes), typecheck e lint limpos.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/http/routes/followups.ts src/adapters/http/schemas/followups.ts tests/integration/followups-api.test.ts
git commit -m "feat: add followup sequences and runs REST API"
```

---

### Task 11: Health checks `/health/live` e `/health/ready`

**Files:**
- Create: `src/adapters/http/routes/health.ts`
- Test: `tests/unit/http/health.test.ts`, `tests/integration/health-ready.test.ts`

**Interfaces:**
- Consumes: `MessagingProvider.health()` (contrato de `docs/04` §5), port de jobs da Fase 1, ligação de base da Fase 1.
- Produces:
  ```ts
  export interface HealthDeps { db(): Promise<boolean>; queue(): Promise<boolean>; messaging(): Promise<boolean> }
  export function liveHandler(): { statusCode: 200; body: { status: 'ok' } };
  export function readyHandler(deps: HealthDeps):
    Promise<{ statusCode: 200 | 503; body: { status: 'ready' | 'not_ready'; checks: { db: boolean; queue: boolean; messaging: boolean } } }>;
  // rotas: GET /health/live (pública), GET /health/ready (pública), sem autenticação, sem informação interna (só booleanos)
  ```

- [ ] **Step 1: Escrever o teste falhoso**

```ts
// tests/unit/http/health.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { liveHandler, readyHandler, type HealthDeps } from '../../../src/adapters/http/routes/health';

const allUp: HealthDeps = { db: async () => true, queue: async () => true, messaging: async () => true };

test('live is always 200', () => {
  assert.equal(liveHandler().statusCode, 200);
});

test('ready is 200 when every dependency is up', async () => {
  const r = await readyHandler(allUp);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { status: 'ready', checks: { db: true, queue: true, messaging: true } });
});

test('ready returns 503 when messaging is down while live stays 200', async () => {
  const down: HealthDeps = { ...allUp, messaging: async () => false };
  const r = await readyHandler(down);
  assert.equal(r.statusCode, 503);
  assert.deepEqual(r.body, { status: 'not_ready', checks: { db: true, queue: true, messaging: false } });
  assert.equal(liveHandler().statusCode, 200);
});

test('ready reports db failure without leaking internals', async () => {
  const r = await readyHandler({ ...allUp, db: async () => false });
  assert.equal(r.statusCode, 503);
  assert.equal(JSON.stringify(r.body).includes('error'), false);
  assert.equal(JSON.stringify(r.body).includes('stack'), false);
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npm test -- tests/unit/http/health.test.ts`
Expected: FAIL — `Cannot find module '../../../src/adapters/http/routes/health'`.

- [ ] **Step 3: Implementar rotas**

`readyHandler` com `Promise.all` dos três checks (cada um com timeout de 2000 ms e `catch` → `false`, nunca exceção propaga); devolve o `body` exato acima. Ligar: `db` = `select 1`, `queue` = `health()` do port de jobs, `messaging` = `MessagingProvider.health().ok`. Nenhuma rota exige sessão; nenhuma devolve `detail`, stack ou mensagens internas.

- [ ] **Step 4: Correr e ver passar**

Run: `npm test -- tests/unit/http/health.test.ts && npm run test:integration -- tests/integration/health-ready.test.ts && npm run typecheck`
Expected: PASS (4 unit + 1 integração com stack real: `/health/ready` → 200 e `/health/live` → 200).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/http/routes/health.ts tests/unit/http/health.test.ts tests/integration/health-ready.test.ts
git commit -m "feat: add liveness and readiness health checks"
```

---

### Task 12: Alertas operacionais (inclui dead-letter) com estado

**Files:**
- Create: `src/domain/alerts/evaluate-alerts.ts`
- Create: `src/modules/observability/schema.ts` (tabela `alert_state`) + migração gerada
- Create: `src/application/alerts/collect-snapshot.ts`, `src/application/alerts/reconcile-alerts.ts`
- Create: `src/adapters/queue/alert-jobs.ts`
- Modify: módulo `config` — chaves `ALERT_QUEUE_STALL_MS=300000`, `ALERT_SEND_FAILURE_RATE=0.3`, `ALERT_SEND_FAILURE_WINDOW=20`, `ALERT_AI_ERROR_RATE=0.2`, `ALERT_AI_ERROR_WINDOW=20`
- Test: `tests/unit/alerts/evaluate-alerts.test.ts`, `tests/integration/reconcile-alerts.test.ts`

**Interfaces:**
- Consumes: métricas da Task 5 (`setGaugeFromSnapshot`), contas WhatsApp e filas das Fases 1–4, port de notificação/Socket.IO.
- Produces:
  ```ts
  export type AlertCode =
    | 'session_disconnected' | 'session_suspected_ban' | 'queue_stalled'
    | 'dead_letter_not_empty' | 'send_failure_rate_high' | 'ai_provider_error';
  export interface AlertThresholds {
    queueStallMs: number; sendFailureRate: number; sendFailureWindow: number;
    aiErrorRate: number; aiErrorWindow: number;
  }
  export interface OperationalSnapshot {
    takenAt: Date;
    sessions: { accountId: string; status: 'connecting' | 'connected' | 'disconnected' | 'suspected_ban' }[];
    queues: { name: string; depth: number; oldestAgeMs: number; deadLetterSize: number }[];
    sendFailures: { accountId: string; windowSize: number; failures: number }[];
    ai: { windowSize: number; errors: number };
  }
  export interface AlertFinding { code: AlertCode; subject: string; severity: 'warning' | 'critical'; detail: string }
  export function evaluateAlerts(s: OperationalSnapshot, t: AlertThresholds): AlertFinding[];

  export interface AlertStore {
    active(): Promise<{ code: AlertCode; subject: string }[]>;
    activate(f: AlertFinding, at: Date): Promise<void>;
    resolve(code: AlertCode, subject: string): Promise<void>;
  }
  export interface AlertNotifier {
    raise(f: AlertFinding): Promise<void>;
    resolve(code: AlertCode, subject: string): Promise<void>;
  }
  export async function reconcileAlerts(
    findings: AlertFinding[], store: AlertStore, notifier: AlertNotifier, now: Date,
  ): Promise<{ raised: number; resolved: number }>;
  ```
  Tabela `alert_state`: `code text`, `subject text`, `severity text`, `detail text`, `fired_at timestamptz`, PK `(code, subject)`.
  Mapeamento de severidade: `session_disconnected`, `session_suspected_ban`, `dead_letter_not_empty` → `critical`; `queue_stalled`, `send_failure_rate_high`, `ai_provider_error` → `warning`.

- [ ] **Step 1: Escrever o teste falhoso**

```ts
// tests/unit/alerts/evaluate-alerts.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateAlerts, type OperationalSnapshot } from '../../../src/domain/alerts/evaluate-alerts';

const T = { queueStallMs: 300_000, sendFailureRate: 0.3, sendFailureWindow: 20, aiErrorRate: 0.2, aiErrorWindow: 20 };

test('detects disconnected session, suspected ban and dead letter', () => {
  const s: OperationalSnapshot = {
    takenAt: new Date('2026-10-07T09:00:00.000Z'),
    sessions: [{ accountId: 'acc-1', status: 'disconnected' }, { accountId: 'acc-2', status: 'suspected_ban' }],
    queues: [{ name: 'outbox:acc-1', depth: 5, oldestAgeMs: 600_000, deadLetterSize: 2 }],
    sendFailures: [], ai: { windowSize: 0, errors: 0 },
  };
  const codes = evaluateAlerts(s, T).map((f) => `${f.code}:${f.subject}`).sort();
  assert.deepEqual(codes, ['dead_letter_not_empty:outbox:acc-1', 'queue_stalled:outbox:acc-1', 'session_disconnected:acc-1', 'session_suspected_ban:acc-2']);
});

test('send failure rate fires only at >= 30% of a full window of 20', () => {
  const base = { takenAt: new Date('2026-10-07T09:00:00.000Z'), sessions: [], queues: [], ai: { windowSize: 0, errors: 0 } };
  const ok = evaluateAlerts({ ...base, sendFailures: [{ accountId: 'acc-1', windowSize: 20, failures: 5 }] }, T);
  assert.deepEqual(ok, []);
  const bad = evaluateAlerts({ ...base, sendFailures: [{ accountId: 'acc-1', windowSize: 20, failures: 6 }] }, T);
  assert.deepEqual(bad.map((f) => f.code), ['send_failure_rate_high']);
  const partial = evaluateAlerts({ ...base, sendFailures: [{ accountId: 'acc-1', windowSize: 12, failures: 12 }] }, T);
  assert.deepEqual(partial, []); // janela incompleta não conta
});

test('ai provider errors fire at >= 20% of the last 20 calls', () => {
  const base = { takenAt: new Date('2026-10-07T09:00:00.000Z'), sessions: [], queues: [], sendFailures: [] };
  assert.deepEqual(evaluateAlerts({ ...base, ai: { windowSize: 20, errors: 4 } }, T).map((f) => f.code), ['ai_provider_error']);
  assert.deepEqual(evaluateAlerts({ ...base, ai: { windowSize: 20, errors: 3 } }, T), []);
});
```

```ts
// tests/integration/reconcile-alerts.test.ts — Postgres real
test('raising twice notifies once, and recovery resolves the alert', async () => {
  const notifier = recorder();
  const f = { code: 'dead_letter_not_empty' as const, subject: 'outbox:acc-1', severity: 'critical' as const, detail: '2 itens' };
  await reconcileAlerts([f], store, notifier, new Date('2026-10-07T09:00:00.000Z'));
  await reconcileAlerts([f], store, notifier, new Date('2026-10-07T09:01:00.000Z'));
  assert.equal(notifier.raised.length, 1);              // sem spam: estado em alert_state
  await reconcileAlerts([], store, notifier, new Date('2026-10-07T09:02:00.000Z'));
  assert.equal(notifier.resolved.length, 1);
  assert.equal((await store.active()).length, 0);
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npm test -- tests/unit/alerts/evaluate-alerts.test.ts`
Expected: FAIL — `Cannot find module '../../../src/domain/alerts/evaluate-alerts'`.

- [ ] **Step 3: Implementar domínio, store, coletor e job**

`evaluateAlerts`: percorre sessões (`disconnected`/`suspected_ban`), filas (`oldestAgeMs > queueStallMs` → `queue_stalled`; `deadLetterSize > 0` → `dead_letter_not_empty`), falhas de envio (`windowSize === sendFailureWindow && failures / windowSize >= sendFailureRate`), erros de IA (idem com `aiErrorRate`). `reconcileAlerts`: `findings` contra `store.active()` — novo → `activate` + `notifier.raise`; ativo ausente dos findings → `resolve` + `notifier.resolve`; cada `raise` também escreve log estruturado `level: 'warn'`, `alertCode`, `subject` (sem telefones). `collect-snapshot.ts`: monta o `OperationalSnapshot` a partir das contas (`whatsapp_accounts.status`), do port de filas (`depth`, `oldestAgeMs`, `deadLetterSize`), das últimas 20 mensagens por conta (falhas) e dos contadores `crm_ai_requests_total` (via leitura do módulo de métricas); alimenta ainda os gauges da Task 5 (`crm_queue_*`, `crm_session_state`). Notificador: adapter Socket.IO — evento `alert.raised`/`alert.resolved` só na sala `admin` (autenticada na Fase 1) + log. Job `alerts-tick` recorrente a cada 60 s com `jobId` determinístico e lock.

- [ ] **Step 4: Correr e ver passar**

Run: `npm test -- tests/unit/alerts/evaluate-alerts.test.ts && npm run test:integration -- tests/integration/reconcile-alerts.test.ts && npm run typecheck`
Expected: PASS (3 unit + 1 integração), typecheck limpo.

- [ ] **Step 5: Commit**

```bash
git add src/domain/alerts/ src/modules/observability/ src/application/alerts/ src/adapters/queue/alert-jobs.ts tests/
git commit -m "feat: add operational alerts with persisted state"
```

---

### Task 13: Política de retenção e job testado

**Files:**
- Create: `src/application/privacy/run-retention.ts`
- Create: `src/adapters/queue/retention-jobs.ts`
- Modify: módulo `config` — `RETENTION_INACTIVE_MONTHS=12`, `RETENTION_INBOUND_EVENTS_DAYS=30`
- Create: `docs/retention-policy.md`
- Test: `tests/integration/retention.test.ts`

**Interfaces:**
- Consumes: `messages`, `conversations`, `answer_traces`, `inbound_events` (Fases 1–2).
- Produces:
  ```ts
  export interface RetentionConfig { inactiveMonths: number; inboundEventsDays: number; timezone: string }
  export interface RetentionStats {
    messagesScrubbed: number; tracesScrubbed: number; inboundEventsDeleted: number;
  }
  export async function runRetention(cfg: RetentionConfig, now: Date): Promise<RetentionStats>;
  ```

- [ ] **Step 1: Escrever o teste falhoso**

```ts
// tests/integration/retention.test.ts — Postgres real, dados sintéticos
test('scrubs content of conversations inactive for more than 12 months', async () => {
  // conv-antiga: last_message_at = now - 13 meses, com 2 mensagens e 1 answer_trace (isTest false)
  const stats = await runRetention({ inactiveMonths: 12, inboundEventsDays: 30, timezone: 'Africa/Luanda' }, now);
  assert.equal(stats.messagesScrubbed, 2);
  assert.equal(stats.tracesScrubbed, 1);
  assert.match(await messageBody('msg-1'), /^\[apagado por retenção\]$/u);
  assert.equal(await traceAnswer('tr-1'), '[apagado por retenção]');
  // conv-nova (30 dias) intacta; answer_trace de teste (isTest true) intacto
  assert.equal(await messageBody('msg-nova'), 'Olá, tenho uma dúvida sobre câmaras');
});

test('deletes processed inbound events older than 30 days but never unprocessed ones', async () => {
  const stats = await runRetention({ inactiveMonths: 12, inboundEventsDays: 30, timezone: 'Africa/Luanda' }, now);
  assert.equal(stats.inboundEventsDeleted, 1);
  assert.ok(await inboundEventExists('ev-antigo-sem-processar'));   // processed_at null sobrevive
});

test('is idempotent: a second run changes nothing', async () => {
  const first = await runRetention(cfg, now);
  const second = await runRetention(cfg, now);
  assert.deepEqual(second, { messagesScrubbed: 0, tracesScrubbed: 0, inboundEventsDeleted: 0 });
  assert.ok(first.messagesScrubbed > 0);
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npm run test:integration -- tests/integration/retention.test.ts`
Expected: FAIL — `runRetention is not a function` / módulo inexistente.

- [ ] **Step 3: Implementar o job e a política**

`runRetention` numa única transação: (1) conversas com `last_message_at < now - inactiveMonths` → `messages.body = '[apagado por retenção]'` (mantém linhas e estados, só remove conteúdo) e `answer_traces` dessas conversas com `is_test = false` → `question`/`answer = '[apagado por retenção]'` (mantém `sources`/`model` para métricas); (2) `inbound_events` com `processed_at is not null` e `received_at < now - inboundEventsDays` → apagar (payload contém telefones); (3) devolver contagens. Job recorrente diário (03:00 `Africa/Luanda`), `jobId` determinístico + lock. `docs/retention-policy.md`: o que é apagado/anonimizado, prazos (`RETENTION_INACTIVE_MONTHS=12`, `RETENTION_INBOUND_EVENTS_DAYS=30` — **valores iniciais a confirmar pelo dono e pelo jurista**, `docs/03` §7), quem decide alterações, e nota de que `knowledge_gaps` mantém perguntas normalizadas (risco residual assinalado ao dono).

- [ ] **Step 4: Correr e ver passar**

Run: `npm run test:integration -- tests/integration/retention.test.ts && npm run typecheck && npm run lint`
Expected: PASS (3 testes), typecheck e lint limpos.

- [ ] **Step 5: Commit**

```bash
git add src/application/privacy/run-retention.ts src/adapters/queue/retention-jobs.ts docs/retention-policy.md tests/integration/retention.test.ts
git commit -m "feat: add data retention policy and job"
```

---

### Task 14: Exportação dos dados de um contacto

**Files:**
- Create: `src/application/privacy/export-contact-data.ts`
- Create: `src/adapters/http/routes/contact-data.ts`
- Test: `tests/integration/export-contact-data.test.ts`

**Interfaces:**
- Consumes: entidades `contacts`, `leads`, `conversations`, `messages`, `answer_traces`, `handoffs`, `campaign_recipients`, `followup_runs`; `audit_log` e RBAC `admin` (Fase 1).
- Produces:
  ```ts
  export interface ContactDataExport {
    exportedAt: string;                       // ISO UTC
    contact: { id: string; phoneE164: string; name: string | null; marketingConsent: boolean;
               consentAt: string | null; consentSource: string | null; optedOutAt: string | null };
    leads: { id: string; line: string; status: string; qualification: unknown }[];
    conversations: { id: string; line: string | null; aiMode: string;
                     messages: { id: string; direction: string; sender: string; body: string | null; createdAt: string }[] }[];
    answerTraces: { id: string; question: string; answer: string; model: string; createdAt: string }[];
    handoffs: { id: string; reason: string; status: string; createdAt: string }[];
    campaignRecipients: { id: string; campaignId: string; status: string }[];
    followupRuns: { id: string; sequenceId: string; status: string; stopReason: string | null; currentStep: number }[];
  }
  export async function exportContactData(contactId: string): Promise<ContactDataExport | null>; // null -> 404
  // rota: GET /v1/contacts/:id/export  (admin) -> 200 application/json, Content-Disposition attachment
  ```

- [ ] **Step 1: Escrever o teste falhoso**

```ts
// tests/integration/export-contact-data.test.ts — Postgres real, dados sintéticos
test('export returns every dataset of the contact and audits the action', async () => {
  const data = await exportContactData(contactId);
  assert.ok(data);
  assert.equal(data.contact.phoneE164, '+244912345678');
  assert.equal(data.leads.length, 1);
  assert.equal(data.conversations.length, 1);
  assert.equal(data.conversations[0]?.messages.length, 2);
  assert.equal(data.answerTraces.length, 1);
  assert.equal(data.followupRuns.length, 1);
  const audit = await lastAuditRow();
  assert.equal(audit?.action, 'contact.export');
  assert.equal(audit?.entityId, contactId);
  assert.equal(JSON.stringify(audit).includes('912345678'), false); // audit_log sem PII
});

test('returns null for an unknown contact', async () => {
  assert.equal(await exportContactData('00000000-0000-0000-0000-000000000000'), null);
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npm run test:integration -- tests/integration/export-contact-data.test.ts`
Expected: FAIL — `exportContactData is not a function`.

- [ ] **Step 3: Implementar o caso de uso e a rota**

Consulta única por contacto com `with`/joins (sem N+1), tudo filtrado por `contactId` — nunca exporta dados de outros contactos; datas em ISO UTC; só campos listados (minimização). Rota: só `admin`, devolve `Content-Disposition: attachment; filename="contact-<uuid>-export.json"`, grava `audit_log` (`action: 'contact.export'`, entidade e papel, sem telefone). Falha de consulta → erro RFC 9457, nunca stack.

- [ ] **Step 4: Correr e ver passar**

Run: `npm run test:integration -- tests/integration/export-contact-data.test.ts && npm run typecheck`
Expected: PASS (2 testes), typecheck limpo.

- [ ] **Step 5: Commit**

```bash
git add src/application/privacy/export-contact-data.ts src/adapters/http/routes/contact-data.ts tests/integration/export-contact-data.test.ts
git commit -m "feat: add contact data export for data subject rights"
```

---

### Task 15: Apagamento dos dados de um contacto

**Files:**
- Create: `src/application/privacy/delete-contact-data.ts`
- Modify: `src/adapters/http/routes/contact-data.ts` — `DELETE /v1/contacts/:id`
- Test: `tests/integration/delete-contact-data.test.ts`

**Interfaces:**
- Consumes: todas as entidades com FK/PII do contacto (mensagem de baixo), `audit_log`, RBAC `admin`.
- Produces:
  ```ts
  export async function deleteContactData(contactId: string, actorId: string, now: Date):
    Promise<{ deleted: Record<string, number> } | null>;   // null -> 404
  // rota: DELETE /v1/contacts/:id  (admin) -> 204; sem corpo; auditoria obrigatória
  ```

- [ ] **Step 1: Escrever o teste falhoso**

```ts
// tests/integration/delete-contact-data.test.ts — Postgres real, dados sintéticos
test('deleteContactData leaves no residual rows or phone strings', async () => {
  const phone = '+244912345678';
  const res = await deleteContactData(contactId, adminId, now);
  assert.ok(res);
  assert.ok((res.deleted['messages'] ?? 0) >= 2);
  assert.equal(await countWhere('contacts', contactId), 0);
  assert.equal(await countWhere('conversations', conversationId), 0);
  assert.equal(await countWhere('leads', leadId), 0);
  assert.equal(await countWhere('followup_runs', runId), 0);
  assert.equal(await countWhere('answer_traces', traceId), 0);
  assert.equal(await countWhere('handoffs', handoffId), 0);
  assert.equal(await countWhere('outbox_messages', outboxId), 0);
  assert.equal(await countWhere('campaign_recipients', recipientId), 0);
  const leftovers = await db.execute(sql`
    select count(*)::int as n from inbound_events where payload::text like ${'%' + phone + '%'} or payload::text like ${'%' + phone.slice(4) + '%'}`);
  assert.equal(leftovers[0]?.n, 0);   // nem o payload bruto do webhook guarda o número
  const audit = await lastAuditRow();
  assert.equal(audit?.action, 'contact.delete');
  assert.equal(JSON.stringify(audit).includes('912345678'), false);
});

test('second delete returns 404 and changes nothing', async () => {
  assert.equal(await deleteContactData(contactId, adminId, now), null);
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npm run test:integration -- tests/integration/delete-contact-data.test.ts`
Expected: FAIL — `deleteContactData is not a function`.

- [ ] **Step 3: Implementar o apagamento numa transação**

Ordem explícita dentro de **uma** transação (se alguma FK falhar, o teste falha e acrescenta-se a tabela à lista): `messages` → `answer_traces` → `handoffs` → `knowledge_gaps` → `knowledge_suggestions` → `followup_runs` → `outbox_messages` → `inbound_events` (por conteúdo do payload, com `sql` parametrizado) → `campaign_recipients` → `leads` → `conversations` → `contacts`. Devolve contagens por tabela; grava `audit_log` (`action: 'contact.delete'`, `entityId`, contagens — **sem** telefone). `DELETE` rota: `admin`, 204, idempotente (segunda chamada 404). Confirmar no relatório: nova forma de tratar dados assinalada ao dono (`docs/03` §7, notificação à APD é tarefa do dono).

- [ ] **Step 4: Correr e ver passar**

Run: `npm run test:integration -- tests/integration/delete-contact-data.test.ts && npm run typecheck && npm run lint`
Expected: PASS (2 testes), typecheck e lint limpos.

- [ ] **Step 5: Commit**

```bash
git add src/application/privacy/delete-contact-data.ts src/adapters/http/routes/contact-data.ts tests/integration/delete-contact-data.test.ts
git commit -m "feat: add contact data deletion for data subject rights"
```

---

### Task 16: Backups cifrados com restauro testado

**Files:**
- Create: `scripts/backup.sh`
- Create: `scripts/restore.sh`
- Create: `docs/runbooks/backup-e-restauro.md`
- Test: `tests/integration/backup-restore.test.ts`

**Interfaces:**
- Consumes: `pg_dump`/`psql`/`openssl` do sistema, variáveis `PGURL`, `PGURL_RESTORE`, `BACKUP_PASSPHRASE` (nunca no repositório), contentores de teste da Fase 0.
- Produces:
  - `scripts/backup.sh <output.sql.enc>` — exige `BACKUP_PASSPHRASE` (sem ela: exit 2, sem dumper); fluxo `pg_dump "$PGURL" --no-owner --no-privileges | openssl enc -aes-256-cbc -pbkdf2 -salt -pass pass:"$BACKUP_PASSPHRASE" -out "$1"`.
  - `scripts/restore.sh <backup.sql.enc>` — exige `BACKUP_PASSPHRASE` e `PGURL_RESTORE`; fluxo `openssl enc -d -aes-256-cbc -pbkdf2 -in "$1" -pass pass:"$BACKUP_PASSPHRASE" | psql -v ON_ERROR_STOP=1 "$PGURL_RESTORE"`.
  - `docs/runbooks/backup-e-restauro.md` — agendamento, custódia da chave, procedimento de restauro passo a passo, verificação pós-restauro e nota de que o **estado das sessões do WA-AKG** (volume do WA-AKG, `docs/03` §5/§10) segue o mesmo procedimento de cifra e também tem de estar no backup (tarefa do dono de infraestrutura).

- [ ] **Step 1: Escrever o teste falhoso**

```ts
// tests/integration/backup-restore.test.ts — dois contentores Postgres reais
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

test('backup is encrypted and restores byte-equivalent rows', async () => {
  const file = `${tmpdir()}/crm-test-backup.sql.enc`;
  const env = { ...process.env, PGURL: urlA, BACKUP_PASSPHRASE: 'passphrase-de-teste-sintetica' };
  execFileSync('bash', ['scripts/backup.sh', file], { env });
  assert.ok(existsSync(file));
  assert.equal(readFileSync(file).toString('latin1').includes('INSERT INTO'), false, 'backup não pode ser texto plano');

  execFileSync('bash', ['scripts/restore.sh', file], { env: { ...process.env, PGURL_RESTORE: urlB, BACKUP_PASSPHRASE: 'passphrase-de-teste-sintetica' } });
  assert.equal(await countContacts(urlB), await countContacts(urlA));
  assert.equal(await firstContactName(urlB), 'Cliente Sintético');
});

test('backup refuses to run without a passphrase', async () => {
  const env = { ...process.env, PGURL: urlA }; delete env.BACKUP_PASSPHRASE;
  assert.throws(() => execFileSync('bash', ['scripts/backup.sh', `${tmpdir()}/nope.sql.enc`], { env }), /BACKUP_PASSPHRASE/u);
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npm run test:integration -- tests/integration/backup-restore.test.ts`
Expected: FAIL — `ENOENT: scripts/backup.sh`.

- [ ] **Step 3: Implementar os scripts, o runbook e os pré-requisitos**

Scripts com `set -euo pipefail`, sem echo da chave, sem segredos no ficheiro (a chave vem sempre do ambiente). Pré-requisito documentado na tarefa: `pg_dump`, `psql` e `openssl` no `PATH` (CI: instalar `postgresql-client`); o teste falha com mensagem clara se faltar. Runbook conforme a secção Interfaces, incluindo o restauro em base vazia e a verificação de contagens.

- [ ] **Step 4: Correr e ver passar**

Run: `npm run test:integration -- tests/integration/backup-restore.test.ts && npm run lint`
Expected: PASS (2 testes), lint limpo.

- [ ] **Step 5: Commit**

```bash
git add scripts/backup.sh scripts/restore.sh docs/runbooks/backup-e-restauro.md tests/integration/backup-restore.test.ts
git commit -m "feat: add encrypted backup and tested restore procedure"
```

---

### Task 17: Runbooks de falhas do `docs/04` §10

**Files:**
- Create: `docs/runbooks/sessao-desligada.md`
- Create: `docs/runbooks/suspected-ban.md`
- Create: `docs/runbooks/protocolo-whatsapp-mudou.md`
- Create: `docs/runbooks/wa-akg-em-baixo.md`
- Create: `docs/runbooks/fuga-de-segredo.md`
- Test: `tests/integration/runbooks.test.ts` (verificação estrutural, sem rede)

**Interfaces:**
- Consumes: tabela de `docs/04` §10, códigos de alerta da Task 12, endpoints da Task 11, métricas da Task 5, política de patches de `docs/04` §9.
- Produces: cinco runbooks com as secções obrigatórias `## Situação`, `## Sintomas e alertas`, `## Passos`, `## Verificação`, `## Escalação`, cada um citando: o código de alerta correspondente, o endpoint a consultar (`/health/ready` ou métrica concreta), a ação de operação e a proibição aplicável (ex.: `suspected_ban` → **sem** automação de recuperação nem troca de número; fuga → rodar segredos já e terminar sessões se o volume foi exposto).

- [ ] **Step 1: Escrever o teste falhoso**

```ts
// tests/integration/runbooks.test.ts (corre localmente, sem rede)
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';

const REQUIRED = ['## Situação', '## Sintomas e alertas', '## Passos', '## Verificação', '## Escalação'];
const EXPECTED = ['sessao-desligada.md','suspected-ban.md','protocolo-whatsapp-mudou.md','wa-akg-em-baixo.md','fuga-de-segredo.md','backup-e-restauro.md'];

test('every runbook exists with all required sections and cites alert codes or health endpoints', () => {
  const files = readdirSync('docs/runbooks');
  for (const name of EXPECTED) {
    assert.ok(files.includes(name), `em falta: docs/runbooks/${name}`);
    const body = readFileSync(`docs/runbooks/${name}`, 'utf8');
    for (const section of REQUIRED) assert.ok(body.includes(section), `${name} sem "${section}"`);
    assert.match(body, /(session_disconnected|session_suspected_ban|queue_stalled|dead_letter_not_empty|send_failure_rate_high|ai_provider_error|\/health\/ready|\/health\/live)/u, `${name} sem referência operacional`);
  }
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npm run test:integration -- tests/integration/runbooks.test.ts`
Expected: FAIL — `em falta: docs/runbooks/sessao-desligada.md`.

- [ ] **Step 3: Escrever os runbooks**

Um por situação de `docs/04` §10 (mais o de backups da Task 16, já escrita). Conteúdo mínimo por ficheiro: gatilho (alerta/métrica exata), diagnóstico (`/health/ready`, `crm_session_state`, `crm_queue_depth`, `crm_dead_letter_size`), passos numerados de recuperação, como verificar que ficou resolvido, quem escala (admin) e o que é proibido (ex.: não rodar números, não contornar limites, não editar o fork sem ADR — `docs/04` §9).

- [ ] **Step 4: Correr e ver passar**

Run: `npm run test:integration -- tests/integration/runbooks.test.ts && npm run lint`
Expected: PASS (1 teste), lint limpo.

- [ ] **Step 5: Commit**

```bash
git add docs/runbooks/ tests/integration/runbooks.test.ts
git commit -m "docs: add operational runbooks for wa-akg failure scenarios"
```

---

### Task 18: Revisão de segurança com a checklist de `docs/03` §11

**Files:**
- Create: `docs/security-review-fase5.md`
- Modify: `src/infra/logging.ts` (ou o módulo de logging da Fase 0) — mascaragem de telefones, se ainda não existir
- Test: `tests/unit/infra/logging.test.ts`

**Interfaces:**
- Consumes: checklist de `docs/03` §11, testes de segurança das Fases 1–4 (webhooks, RBAC, opt-out), `scripts/` de secret scan, `npm audit`.
- Produces: `docs/security-review-fase5.md` com os **9 itens** de `docs/03` §11, cada um com `[x]`, "Evidência:" (caminho de teste `ficheiro`, output de comando ou decisão justificada) e estado `OK`/`N/A (justificado)`; mais a nota de sinalização ao dono (APD/privacidade, `docs/03` §7).

- [ ] **Step 1: Escrever o teste falhoso**

```ts
// tests/unit/infra/logging.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { maskPhone, serializeLog } from '../../../src/infra/logging';

test('masks full phone numbers in structured logs', () => {
  assert.equal(maskPhone('+244912345678'), '+244 9** *** *78');
  const line = serializeLog({ level: 'info', msg: 'send ok', to: '+244912345678' });
  assert.equal(line.includes('912345678'), false);
  assert.match(line, /\+244 9\*\* \*\*\* \*78/u);
});

test('never logs secrets or full message bodies', () => {
  const line = serializeLog({ level: 'info', msg: 'received', apiKey: 'sk-1234567890abcdef', body: 'mensagem do cliente' });
  assert.equal(line.includes('sk-1234567890abcdef'), false);
  assert.equal(line.includes('mensagem do cliente'), false);
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npm test -- tests/unit/infra/logging.test.ts`
Expected: FAIL (ou `Cannot find module` se `maskPhone`/`serializeLog` não existirem).

- [ ] **Step 3: Implementar a mascaragem e executar a revisão**

Garantir `maskPhone(e164: string): string` (mantém `+244`, 1.º dígito e 2 últimos; resto `*`) aplicado a todos os campos de telefone no formatter de logs, e `serializeLog(record: Record<string, unknown>): string` que redige chaves sensíveis (`apiKey`, `password`, `token`, `secret`, `body`, `text`, `prompt`) antes de serializar JSON. Depois executar e colar o output no `docs/security-review-fase5.md`:

```bash
npm run lint && npm run typecheck && npm test && npm run test:integration
npm audit --audit-level=high
git grep -InE "(api[_-]?key|secret|password|token)[[:space:]]*[:=][[:space:]]*['\"][^'\"]{12,}" -- ':!.env.example' ':!docs/' ':!reference/'
```

Checklist `docs/03` §11 no ficheiro, nesta forma (9 itens): sem segredos (output do `git grep` vazio + `npm audit`); autorização por papel (citar teste RBAC da Fase 1); webhooks (citar teste de assinatura/idempotência da Fase 1); WA-AKG sem acesso público (evidência da auditoria da Fase 0, ou `N/A (ainda não verificado)` com justificação); logs sem telefones/mensagens (este teste); opt-out e consentimento (citar testes da Fase 4 + Task 4 deste plano); dados externos mínimos (`redactForLLM`, A11); backups cifrados e restauro testado (Task 16); dependências auditadas e fixadas (output do `npm audit`).

- [ ] **Step 4: Correr e ver passar**

Run: `npm test -- tests/unit/infra/logging.test.ts && [ "$(grep -c '^- \[ \]' docs/security-review-fase5.md)" = "0" ] && echo "checklist completa"`
Expected: PASS (2 testes) e `checklist completa` (nenhum item por marcar; todos com evidência ou `N/A` justificado).

- [ ] **Step 5: Commit**

```bash
git add src/infra/logging.ts tests/unit/infra/logging.test.ts docs/security-review-fase5.md
git commit -m "test: mask phone numbers in logs and record security review"
```

---

## Gate de fim de fase

`docs/01` §8 **não declara gate formal para a Fase 5** — ao contrário das Fases 0–4 (auditoria + schema, primeiro envio real, `ai_active`, primeira campanha), esta fase não tem gate humano próprio; os gates de campanha e de IA já foram decididos nas Fases 3 e 4. O que se exige é a **demonstração dos requisitos de aceitação**:

- [ ] `docs/01` §8 Fase 5: sequências de follow-up com condições de paragem — Tasks 1–10 (testes das regras de `docs/05` §9 todos a passar).
- [ ] `docs/02` §10: métricas mínimas, `/health/live` + `/health/ready`, alertas (inclui dead-letter e estado das sessões) — Tasks 5, 11, 12.
- [ ] `docs/03` §7: retenção testada, exportação e apagamento de um contacto testados — Tasks 13–15.
- [ ] `docs/03` §10: backups cifrados com restauro testado (procedimento em `docs/runbooks/`) — Task 16.
- [ ] `docs/04` §10: runbooks escritos — Task 17.
- [ ] `docs/03` §11: revisão de segurança executada com evidência — Task 18.
- [ ] Output real de `npm run lint`, `npm run typecheck`, `npm test` e `npm run test:integration` colado no relatório final, sem um único teste a falhar.

**Aprovações humanas que continuam pendentes (não são desta fase):** auditoria do WA-AKG (Fase 0), A5 (verificações do cPanel), A11 (dados reais para o LLM), e a revisão humana do `docs/security-review-fase5.md` antes da próxima janela de gate — assinalar ao dono, incluindo os valores iniciais por confirmar (`WA_FOLLOWUP_DAILY_CAP = 20`, `RETENTION_INACTIVE_MONTHS = 12`, `RETENTION_INBOUND_EVENTS_DAYS = 30`).
