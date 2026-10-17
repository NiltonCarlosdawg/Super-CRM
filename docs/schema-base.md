# Schema base — Fase 0 (proposta) + Fase 1, Task 1 (gate respondido e aplicação)

> **Estado:** **APLICADO de zero** pela Fase 1, Task 1 — migrações `0000`→`0002` (a `0002` acrescenta
> `lead_stage` e as colunas da Fase 1: `totp_secret`/`totp_enabled_at`, `mfa_pending`,
> `ai_claimed_at`, `media_ref`; elimina `leads.status`). As 8 perguntas do gate estão **respondidas
> em §4**. `CREATE EXTENSION IF NOT EXISTS vector;` é a migração personalizada `0000`, anterior a
> qualquer tabela (`docs/02` §5).

## 1. Âmbito e ficheiros

**Incluído (16 tabelas base + suporte + colunas da Fase 1):**

| Ficheiro | Conteúdo |
|---|---|
| `drizzle.config.ts` | config do drizzle-kit (`dialect: postgresql`, `out: ./drizzle`, `strict`) |
| `src/adapters/db/schema/enums.ts` | único sítio dos enums da base (10 `pgEnum`) |
| `src/adapters/db/schema/users.schema.ts` | `users` |
| `src/adapters/db/schema/sessions.schema.ts` | `sessions` |
| `src/adapters/db/schema/whatsapp-accounts.schema.ts` | `whatsapp_accounts` |
| `src/adapters/db/schema/contacts.schema.ts` | `contacts` |
| `src/adapters/db/schema/leads.schema.ts` | `leads` |
| `src/adapters/db/schema/conversations.schema.ts` | `conversations` |
| `src/adapters/db/schema/messages.schema.ts` | `messages` |
| `src/adapters/db/schema/inbound-events.schema.ts` | `inbound_events` |
| `src/adapters/db/schema/outbox.schema.ts` | `outbox_messages` |
| `src/adapters/db/schema/campaigns.schema.ts` | `campaigns`, `campaign_recipients`, `campaign_accounts` |
| `src/adapters/db/schema/followups.schema.ts` | `followup_sequences`, `followup_steps`, `followup_runs` |
| `src/adapters/db/schema/audit.schema.ts` | `audit_log` |
| `src/adapters/db/schema/index.ts` | re-exporta as 16 tabelas base + `enums.ts` |
| `tests/unit/schema-coverage.test.ts` | cobertura: 16 base + 12 do módulo de conhecimento |
| `drizzle/0000_vector_extension.sql` | `CREATE EXTENSION IF NOT EXISTS vector;` (personalizada) |
| `drizzle/0001_*.sql` + `drizzle/meta/` | tabelas e enums (gerados, revistos) |
| `drizzle/0002_*.sql` | Fase 1 Task 1: `lead_stage`, colunas da Fase 1, `DROP leads.status` (gerado, revisto) |
| `tests/helpers/db.ts` | helpers de integração: `migrateFromEmptyDb`, `resetDb`, `migratedDb`, `columnNames` |
| `package.json` | script `db:generate` (drizzle-kit generate) |

**Não incluído (fora do âmbito desta tarefa):** alterações ao módulo de conhecimento
(`src/modules/knowledge/knowledge.schema.ts` — os seus 12 exports são cobertos pelo teste mas não
são alterados). As colunas da Fase 1 (`totp_*`, `mfa_pending`, `ai_claimed_at`, `media_ref`)
entraram pela migração `0002` (Fase 1, Task 1).

**Convenções (Global Constraints):** PK `uuid` com `defaultRandom()`; todos os instantes em
`timestamptz` (UTC); sem colunas monetárias nas 16 tabelas base (o `numeric(14, 2)` aplica-se ao
catálogo do módulo de conhecimento); FKs e índices para cada filtro/ordenação frequente
(`docs/02` §5).

## 2. Inventário

### 2.1 Tabelas base (16)

| Tabela | Colunas-chave | Constraints | Índices |
|---|---|---|---|
| `users` | `name`, `email`, `password_hash` (argon2id), `role` (`user_role`: admin/editor/agent), `active` (default `true`), `totp_secret`/`totp_enabled_at` (Fase 1, nulos até ativar) | `UNIQUE (email)` | — |
| `sessions` | `user_id` → `users`, `expires_at`, `mfa_pending` (default `false`, Fase 1) | PK é o valor do cookie (ver §3) | `sessions_user_idx (user_id)`, `sessions_expires_idx (expires_at)` |
| `whatsapp_accounts` | `label`, `phone_e164`, `provider` (default `wa-akg`), `provider_session_id`, `status` (`whatsapp_account_status`), `purpose` (`whatsapp_purpose`), `daily_send_cap` | `UNIQUE (phone_e164)`, `UNIQUE (provider_session_id)` | `whatsapp_accounts_status_idx (status)`, `whatsapp_accounts_purpose_idx (purpose)` |
| `contacts` | `phone_e164`, `name`, `marketing_consent` (default `false`), `consent_at`, `consent_source`, `opted_out_at` | **`UNIQUE (tenant_id, phone_e164)`** (`contacts_tenant_phone_unique`, fixo R17 Task 5: o mesmo número é um contacto por tenant) | `contacts_consent_optout_idx (marketing_consent, opted_out_at)` — audiência de campanha |
| `leads` | `contact_id` → `contacts`, `line_id` → `business_lines` (nulo), `stage` (`lead_stage`, default `open`), `owner_id` → `users` (nulo), `qualification` (jsonb, default `'{}'`) | FKs; `stage` é `lead_stage NOT NULL DEFAULT 'open'` (§4 Q1); `status`/estado **eliminada** (§4 Q2) | `leads_contact_idx`, `leads_line_idx`, `leads_owner_idx` |
| `conversations` | `account_id` → `whatsapp_accounts`, `contact_id` → `contacts`, `lead_id` → `leads` (nulo), `line_id` → `business_lines` (nulo), `ai_mode` (`ai_mode`, default **`ai_suggest`** por D13), `miss_streak` (default 0), `last_message_at` | **`UNIQUE (account_id, contact_id)`** (ver §3) | `conversations_lastmsg_idx (last_message_at, id)` ← **cursor global**, `conversations_account_lastmsg_idx (account_id, last_message_at)` ← cursor por conta, `conversations_contact_idx (contact_id)` |
| `messages` | `conversation_id` → `conversations`, `account_id` → `whatsapp_accounts` (denormalizado), `direction` (`message_direction`), `sender` (`message_sender`), `kind` (`message_kind`, default `text`), `body` (nulo = mídia sem legenda), `media_ref` (só a referência da mídia recebida, Fase 1), `provider_message_id` (nulo até aceite), `status` (`message_status`, default `queued`) | **`UNIQUE (account_id, provider_message_id)`** (`docs/01` §6 — únicas por conta; `NULL`s não conflitam) | `messages_conversation_created_idx (conversation_id, created_at, id)` ← **cursor** |
| `inbound_events` | `provider_event_id`, `payload` (jsonb), `received_at`, `processed_at`, `ai_claimed_at` (claim de idempotência, Fase 1) | `UNIQUE (provider_event_id)` — idempotência do webhook | `inbound_events_pending_idx (received_at) WHERE processed_at IS NULL` (parcial) |
| `outbox_messages` | `message_id` → `messages`, `account_id` → `whatsapp_accounts`, `idempotency_key`, `priority` (default 1), `scheduled_at` (default now), `attempts` (default 0), `status` (`outbox_status`: queued/sending/sent/failed/**unknown_delivery**), `last_error` | **`UNIQUE (tenant_id, idempotency_key)`** (`outbox_messages_tenant_idempotency_uq` — Onda 1 Task 5: a mesma chave noutro tenant é outro envio) | `outbox_messages_claim_idx (status, priority, scheduled_at)` ← claim `FOR UPDATE SKIP LOCKED`, `outbox_messages_account_status_idx (account_id, status)` ← pendentes por conta |
| `campaigns` | `name`, `message_template`, `status` (`campaign_status`, default `draft`), `daily_limit` (nulo — §4), `scheduled_at`, `created_by_id` → `users` | FKs | `campaigns_status_idx (status)` |
| `campaign_recipients` | `campaign_id` → `campaigns`, `contact_id` → `contacts`, `account_id` → `whatsapp_accounts`, `step` (default 1), `status` (`campaign_recipient_status`, default `pending`), `outbox_key`, `enqueued_at`, `replied_at`, `opted_out_at` | **`UNIQUE (campaign_id, contact_id, step)`** | `campaign_recipients_account_status_idx (account_id, status, enqueued_at)`, `campaign_recipients_campaign_status_idx (campaign_id, status)` |
| `campaign_accounts` | `campaign_id` → `campaigns`, `account_id` → `whatsapp_accounts` | **`UNIQUE (campaign_id, account_id)`** | `campaign_accounts_account_idx (account_id)` (consulta inversa) |
| `followup_sequences` | `line_id` → `business_lines`, `name`, `enabled` (default `true`), `created_by_id` → `users` | **`UNIQUE (line_id, name)`** — sequência por linha | — (o único cobre `line_id`) |
| `followup_steps` | `sequence_id` → `followup_sequences` (`onDelete: cascade`), `position`, `delay_hours`, `condition` (text), `content_mode` (text), `template_text`, `ai_prompt`, `active` | `UNIQUE (sequence_id, position)`, `CHECK (delay_hours > 0)` | — (o único cobre `sequence_id`) |
| `followup_runs` | `lead_id` → `leads`, `sequence_id` → `followup_sequences`, `conversation_id` → `conversations`, `account_id` → `whatsapp_accounts`, `contact_id` → `contacts`, `status` (text), `stop_reason` (text), `current_step` (default 0), `next_run_at`, `last_sent_at`, `pending_text`, `pending_trace_id`, `started_at`, `stopped_at` | FKs; `status`/`stop_reason` são `text` (§4) | `followup_runs_due_idx (status, next_run_at)`, `followup_runs_lead_idx (lead_id)`, `followup_runs_conversation_idx (conversation_id)`, `followup_runs_account_idx (account_id)` |
| `audit_log` | `actor_id` → `users` (nulo = ação da IA/sistema), `action` (text), `entity_id`, `ip`, `details` (jsonb) | append-only (sem `updated_at`) | `audit_log_created_idx (created_at)` ← cursor, `audit_log_actor_idx (actor_id)`, `audit_log_entity_idx (entity_id)` |

### 2.2 Módulo de conhecimento (12, já definidos)

`business_lines`, `catalog_items`, `knowledge_docs`, `knowledge_chunks`, `rules`,
`qualification_questions`, `handoff_triggers`, `handoffs`, `knowledge_gaps`,
`knowledge_suggestions`, `knowledge_revisions`, `answer_traces` — em
`src/modules/knowledge/knowledge.schema.ts`, não alterados nesta tarefa.
A **paginação por cursor** de `handoffs` usa `handoffs_queue_idx (status, priority, created_at)`
(`docs/02` §5). Cobertos por `tests/unit/schema-coverage.test.ts` (28 pares: 16 + 12).

## 3. Decisões de design

1. **`line` modelado como FK `line_id` → `business_lines`.** O esboço de `docs/01` §6 escreve
   `line` (texto) em `leads`, `conversations` e (em `docs/05` §9) `followup_sequences`; modelar como
   FK dá integridade na base (`docs/02` §5) e uma só fonte de verdade para os nomes das linhas.
   É anulável em `leads`/`conversations` (a conversa/lead pode ser criado antes de a linha estar
   identificada — fluxo da Fase 1) e obrigatório em `followup_sequences` (sequência *por linha*).
2. **`sessions` por A2** (`docs/06`): sessões server-side em PostgreSQL, PK `uuid` = valor do cookie
   (`randomUUID()` gerado pela aplicação), `expires_at` obrigatório; logout/revogação = `DELETE`.
   `mfa_pending` entra na Fase 1 (Task 15) como coluna nova.
3. **Junção `campaign_accounts`** deriva de "contas permitidas" (`docs/01` §6): tabela de junção com
   FKs + `UNIQUE (campaign_id, account_id)` em vez de array `uuid[]` — a unicidade e a existência das
   contas ficam garantidas pela base, não pela aplicação.
4. **`outbox` transacional com ligação a `messages` em estado `queued`**: o caso de uso grava a
   mensagem (`status = 'queued'`) e a linha de outbox na **mesma transação**; nenhum handler chama
   `send()` diretamente (`docs/04` §7, regra 6 do `AGENTS.md`). `idempotency_key` única **por tenant**
   (`UNIQUE (tenant_id, idempotency_key)`, Onda 1 Task 5) garante que
   o re-envio com a mesma chave não duplica; `message_id` é FK porque a outbox existe para transportar
   uma mensagem concreta.
5. **`daily_send_cap` é o limite por conta, por baixo da config global**: coluna anulável;
   `null` = aplica-se só a config global (`WA_CAMPAIGN_RAMP` e afins, `docs/04` §7); valor definido
   sobrepõe-se à config para essa conta. Os limites são impostos no código do CRM, nunca confiados ao
   WA-AKG (`docs/04` §7).
6. **`UNIQUE (account_id, contact_id)` em `conversations`** — uma conversa por conta+contacto ("o
   fio de mensagens", `docs/01` §6); necessária ao upsert da Fase 1 (Task 19) e ao
   `findOrCreateForCampaign` da Fase 4 (decisão pedida pela Fase 1, Task 1, passo 4).
7. **Enums: fonte única.** Os enums da base vivem em `src/adapters/db/schema/enums.ts`;
   `conversations.ai_mode` **importa `aiModeEnum` do módulo de conhecimento** (o próprio ficheiro o
   marca "A usar na tabela de conversas da base") e arranca em `ai_suggest` por D13 — passar a
   `ai_active` exige gate (`docs/01` §8). Os vocabulários vêm todos de docs (fonte em comentário em
   `enums.ts`): `user_role`/`whatsapp_account_status`/`whatsapp_purpose`/`message_sender`/
   `message_status` de `docs/01` §6 e `docs/04` §6/§8; `message_kind` do contrato `docs/04` §5;
   `message_direction` dos literais da Fase 1; `outbox_status` de `docs/04` §5 + Fase 1;
   `campaign_status`/`campaign_recipient_status` de `docs/01` §6 + Fase 4.
8. **`drizzle.config.ts` usa um array de glob** (`./src/**/*.schema.ts` **mais**
   `./src/adapters/db/schema/enums.ts`): o `enums.ts` não termina em `.schema.ts` e, sem entrar no
   glob, o drizzle-kit referenciava os 10 tipos nas tabelas sem emitir os `CREATE TYPE`
   (migração que falhava de zero — verificado e corrigido na geração; 25 `CREATE TYPE` no `0001`).
9. **`inbound_events` não tem `created_at` separado**: `received_at` (com `defaultNow()`) *é* o
   momento de criação — duas colunas para o mesmo facto violariam "uma só fonte de verdade por
   facto" (`docs/05` §5).
10. **FKs cruzadas:** a base → conhecimento só via `line_id → business_lines`. As colunas
    `conversation_id`/`message_id` do módulo de conhecimento ficam sem FK para a base — o próprio
    `knowledge.schema.ts` o documenta ("ligar com `.references()` na integração") e este trabalho não
    altera ficheiros do módulo.

## 4. Perguntas para o gate

Nenhuma resposta abaixo foi tomada unilateralmente: os vocabulários **não definidos nos docs**
ficaram como `text NOT NULL` (ou `text`), **sem valores inventados**.

1. **`leads.stage`** — vocabulário? (A Fase 1 propõe `lead_stage` = `open` | `won` | `lost`,
   consumido como `leadStatus` na Fase 5 — a decidir aqui antes de virar `pgEnum`.)
   > **Respondido (Fase 1, Task 1): `lead_stage` = `open` | `won` | `lost`** (`open` = em curso,
   > `won` = fechada ganha, `lost` = fechada perdida); consumido como `leadStatus` na Fase 5.
   > `pgEnum` criado em `src/adapters/db/schema/enums.ts` e aplicado pela migração `0002`.
2. **`leads.status` (o campo "estado" de `docs/01` §6)** — vocabulário? E é **redundante com
   `stage`** (uma só fonte de verdade por facto, `docs/05` §5)? A Fase 1 prevê eliminá-la; confirmar
   (o teste da Fase 1 verifica que a coluna `estado` não existe).
   > **Respondido (Fase 1, Task 1): eliminada** — redundante com `stage` (uma só fonte de verdade
   > por facto, `docs/05 §5`); `DROP COLUMN` na migração `0002` e o teste de migrações verifica que
   > a coluna não existe.
3. **`followup_runs.status` e `followup_runs.stop_reason`** — vocabulários? Enquanto não existirem
   não é possível fechar a unicidade parcial de "run ativo por `(lead_id, sequence_id)`" (só há
   índice normal `followup_runs_lead_idx`); transições e `stop_reason` são da Fase 5.
   > **Respondido (Fase 1, Task 1): para a Fase 5** — mantêm `text`; os vocabulários (e com eles a
   > unicidade parcial de run ativo) fecham na Fase 5 (`docs/plans/...fase5`).
4. **`followup_steps.condition` e `followup_steps.content_mode`** — vocabulários? (`docs/05` §9 dá
   o conceito — condição, "modelo ou geração pela IA" — mas não os valores; a Fase 5 os enumera como
   `followup_condition`/`followup_content_mode`.) O `CHECK` de conteúdo
   (`content_mode = template ⇒ template_text`, `ai ⇒ ai_prompt`) também depende destes valores e por
   isso não foi incluído.
   > **Respondido (Fase 1, Task 1): mantêm `text`** — vocabulários e `CHECK` de conteúdo ficam para
   > a Fase 5, quando enumerar `followup_condition`/`followup_content_mode`.
5. **`audit_log.action`** — manter livre (texto) ou fechar vocabulário em `pgEnum`? Os planos já
   usam `auth.login`, `user.created`, `campaign.started`, `contact.delete`…
   > **Respondido (Fase 1, Task 1): manter livre (texto)** — os planos já usam ações em texto
   > (`auth.login`, `user.created`, …); fechar em `pgEnum` exigiria migration por ação nova.
6. **Colunas de limites em `campaigns`** — proposta atual: só `daily_limit` (inteiro, por conta, por
   dia; `null` = só a ramp/config global). Quais as restantes colunas de limites? (A Fase 4 define
   aqui as suas.)
   > **Respondido (Fase 1, Task 1): só `daily_limit` nesta fase** (inteiro, por conta, por dia;
   > `null` = só a ramp/config global); restantes colunas de limites → Fase 4.
7. **`unknown_delivery` em `outbox_status`** — incluído porque `docs/04` §5/§7 o define (timeout de
   envio → **nunca** retry automático → alerta para reconciliação). Confirmar a necessidade e a
   semântica de reconciliação antes do primeiro envio real.
   > **Respondido (Fase 1, Task 1): confirmado** — `unknown_delivery` fica em `outbox_status`
   > (usado pela Task 18); a semântica de reconciliação confirma-se **antes do primeiro envio real**
   > (gate).
8. **`vector(1536)`** em `knowledge_chunks.embedding` — mantido até à Fase 2 por ADR-0002 (mudança
   para `vector(384)` com `multilingual-e5-small`, migração nova em pré-produção). Não afeta as 16
   tabelas base; fica registado para revisão no gate.
   > **Respondido (Fase 1, Task 1): mantido até à Fase 2** por ADR-0002; não afeta as 16 tabelas
   > base.

## 5. Comandos usados (geração e aplicação)

```bash
npm run db:generate -- --custom --name=vector_extension   # cria drizzle/0000_vector_extension.sql
# (editar 0000: uma linha → CREATE EXTENSION IF NOT EXISTS vector;)
npm run db:generate                                       # cria drizzle/0001_*.sql com as 28 tabelas
npm run db:generate                                       # Fase 1 Task 1: cria drizzle/0002_*.sql
npm run db:generate                                       # "No schema changes, nothing to migrate" (idempotente)
npm run db:migrate                                        # Fase 1 Task 1: aplicadas de zero numa base vazia
```

`drizzle/meta/_journal.json` lista `0000_vector_extension` (idx 0) antes de `0001_*` (idx 1) e
`0002_*` (idx 2): a extensão é aplicada antes de qualquer tabela. As migrações foram **aplicadas de
zero numa base vazia pela Fase 1, Task 1** (`drizzle-kit migrate`, exit 0; também coberto por
`tests/integration/migrations.test.ts`).
