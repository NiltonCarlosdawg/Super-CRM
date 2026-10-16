# Design — Multitenancy (SaaS multi-tenant) do CRM MilVendas

Data: 2026-10-16
Estado: secções aprovadas por delegação do utilizador ("sim, auto aprova as próximas secções"); revisão integral deste ficheiro pendente antes do plano de implementação.

## 1. Contexto e propósito

O CRM era um produto interno da MilVendas: `docs/01-contexto-e-plano.md:12` — "não é um produto multi-tenant… (pode vir no futuro)" e decisão **D1 — "Sem multi-tenant por agora"**. O dono do produto mudou de decisão: a instalação única passa a servir **vários clientes**, cada um isolado. Isto reverte D1 e obriga a ADR (`docs/adr/0007-multitenancy.md`) e à actualização de `docs/01`.

Facto confirmado, para evitar trabalho inexistente: a BD **já é PostgreSQL** (`packages/backend/drizzle.config.ts` → `dialect: 'postgresql'`; `.env.example` → `DATABASE_URL=postgres://…`). A mudança é o **modelo de dados**, não o motor. O fork WA-AKG mantém MySQL e **não é alterado** (`docs/03 §5`, `docs/04`; alteração ao fork = gate).

## 2. Requisitos aprovados (decisões do dono do produto)

- **R1** — Tenant = empresa cliente; vários clientes na mesma instalação, isolados uns dos outros.
- **R2** — Auto-registo público cria tenant + admin do tenant (onboarding sem curl/CLI).
- **R3** — Os dados existentes migram para o tenant **"MilVendas"**; nada se perde.
- **R4** — **Platform admin** (equipa MilVendas) com acesso total a todos os tenants.
- **R5** — Modelo de isolamento: **schema único com `tenant_id`** (linhas etiquetadas); alternativas BD-por-tenant e schema-por-tenant avaliadas e recusadas (ops ×N / complexidade sem ganho à escala actual).

## 3. Não-objectivos (v1)

- Billing/cobrança de tenants.
- Verificação de email no registo (v1: rate limit + suspensão manual; SMTP = decisão à parte).
- Escrita de platform admin **dentro** de um tenant (impersonation) — v1: leitura (suporte) + gestão de ciclo de vida.
- Chaves de LLM/embeddings por tenant; taxonomia `business_lines` por tenant.
- Qualquer alteração ao código do WA-AKG (gate `docs/04`).

## 4. Modelo de dados (gate de schema base)

### 4.1 Nova tabela `tenants`

`id (uuid pk)`, `name (text notNull)`, `status (enum 'active'|'suspended' default 'active')`, `created_at`, `updated_at`.

### 4.2 Regra do `tenant_id`

Todas as tabelas de negócio ganham `tenant_id uuid REFERENCES tenants(id)` + índice. Por omissão **NOT NULL**, com cinco excepções justificadas:

| Tabela | `tenant_id` | Porquê |
|---|---|---|
| `tenants` | — | é o próprio tenant |
| `sessions` | — | infra de auth; a autoridade do tenant é a linha do `users`, lida **por pedido** |
| `business_lines` | — | dicionário global de slugs escrito só pelo seed oficial (se tenants criarem linhas próprias no futuro → ADR) |
| `audit_log` | **nullable** | `NULL` = ação de plataforma/sistema sem tenant (ex.: login de platform admin) |
| `inbound_events` | **nullable** | o evento é gravado antes de resolver a conta (`ingest-webhook.ts:29`); `tenant_id` é preenchido no job `inbound.process` quando a conta resolve; `NULL` = evento órfão |

Contagem: 28 tabelas existentes no Drizzle (`pgTable(` ×28) − 4 excepções = **24 com `tenant_id NOT NULL`**: `users`, `conversations`, `messages`, `contacts`, `leads`, `campaigns`, `campaign_recipients`, `campaign_accounts`, `whatsapp_accounts`, `outbox_messages`, `followup_sequences`, `followup_steps`, `followup_runs`, e as 11 de knowledge (`catalog_items`, `knowledge_docs`, `knowledge_chunks`, `rules`, `qualification_questions`, `handoff_triggers`, `handoffs`, `knowledge_gaps`, `knowledge_suggestions`, `knowledge_revisions`, `answer_traces`).

A coluna nos filhos (`messages`, `campaign_recipients`, `knowledge_chunks`, …) é **redundante por imposição mecânica**: um `WHERE tenant_id = …` idêntico em todas as queries, sem ter de provar caminhos de join. Índices: `(tenant_id)` simples; composto `(tenant_id, created_at)` onde a listagem ordena por data (conversations, messages, contacts, leads, audit_log, outbox).

### 4.3 `users` e `platform_admin`

- `user_role` enum ganha **`platform_admin`**. `ALTER TYPE … ADD VALUE` corre numa **migração separada** da que insere linhas com o valor novo (regra do Postgres sobre uso na mesma transacção).
- CHECK: `role = 'platform_admin' ⇔ tenant_id IS NULL`. Papéis de tenant (`admin|editor|agent`) têm `tenant_id NOT NULL`.
- `email` mantém **unicidade global** (`users.email` `.unique()`): login é email+password sem tenant-slug; v1 = uma pessoa, uma conta (não pode pertencer a dois tenants).

### 4.4 Migração com dados existentes

1. `CREATE TABLE tenants` + enum de status.
2. `INSERT` do tenant **"MilVendas"** (activo).
3. Por cada tabela: `ADD COLUMN tenant_id` → `UPDATE … SET tenant_id = <milvendas>` (as nullable: `UPDATE` onde a resolução existir) → `SET NOT NULL` + FK + índices.
4. `ALTER TYPE user_role ADD VALUE 'platform_admin'` + CHECK em `users` (ordem respeitada).
5. O admin actual (`admin@milvendas.local`) fica **admin do tenant MilVendas**; `scripts/create-user.ts` ganha `--platform` (cria `platform_admin` sem tenant) e `--tenant <id>` opcional. O primeiro platform admin cria-se por CLI (o registo público cria sempre admin de tenant).
6. Migrações geradas, revistas, e **a aplicar de zero numa BD vazia** (definição de pronto, AGENTS.md). O caminho de upgrade (passo 3) é o da validação actual.

### 4.5 Invariante de escrita

O `tenant_id` **nunca vem do corpo do pedido**. Os services derivam-no do registo pai já escopado (mensagem ← conversa/conta ← sessão) na mesma transacção. Frontend nunca envia `tenantId` (excepção: endpoints de plataforma, cujo parâmetro só é aceite de `platform_admin`).

## 5. Registo público, auth, sessão e RBAC

### 5.1 `POST /v1/auth/register` (público)

- Corpo: `{ tenantName, name, email, password }` — zod, email normalizado (lower+trim na fronteira), `assertPasswordPolicy` (12–100).
- Rate limit por IP com a mesma configuração do login (`auth.loginRateMax`/`loginRateWindowMs`) — nenhum campo de config novo.
- Transacção atómica: `INSERT tenant` → `INSERT users (role='admin', tenant_id=<novo>)` → `audit_log ('auth.register')`. Falha a meio ⇒ nada fica.
- **Sempre aberto** — não existe guard de "primeiro utilizador": cada registo cria o **seu** tenant (R2). Abuso controlado por rate limit + suspensão pelo platform admin.
- **Auto-login** no sucesso: chama o `LoginService` existente e devolve **a mesma resposta do login** (`mfa:'setup'` + cookies de sessão + `otpauthUrl`), para o frontend reutilizar o fluxo TOTP sem código novo.
- Erros: `409 email_already_exists` (unicidade global), `400` (validação/`weak_password`), `429 rate_limited`. O papel **nunca** vem do corpo (R2: admin do tenant criado).
- Não enviado: CSRF (mesma razão do login — não existe sessão).

### 5.2 Sessão e `authenticate`

- Cookies, TTL 72h, CSRF, `mfaPending`: **inalterados**.
- `authenticate` passa a resolver **por pedido**: linha `users` (`role`, `active`, `tenant_id`) + `tenants.status` → `request.auth = { userId, sessionId, role, tenantId | null, isPlatform }`. Sem cache de tenant na sessão (autoridade = BD).
- Tenant `suspended` → `403 tenant_suspended` no login **e** em qualquer pedido autenticado.
- MFA obrigatório para `admin` (`docs/03 §3`) mantém-se: o admin do tenant recém-registado é forçado a ativar TOTP no 1º login; o UI do registo avisa antes de submeter.

### 5.3 RBAC

- `agent|editor|admin`: semântica actual, agora **dentro do próprio tenant** (o servidor só enxerga a sessão do tenant).
- `platform_admin`: guard novo `requirePlatform` nas rotas `/v1/platform/*`.
- Superfície de plataforma (v1):
  - `GET /v1/platform/tenants` — lista (nome, estado, nº users/contas, criação).
  - `POST /v1/platform/tenants/:id/suspend` e `…/activate` — ciclo de vida (audit `tenant.suspend`/`tenant.activate`).
  - Leitura de suporte por tenant, **read-only**: `GET /v1/platform/tenants/:tenantId/{users,accounts,conversations}` e `…/conversations/:id` (thread). Acesso auditado (`platform.view_tenant`).
- Escrita dentro de tenant por platform admin = **403 em v1** (impersonation é trabalho futuro, com audit próprio).
- Rotas de tenant **nunca** aceitam parâmetro `tenantId` (invariante testado); toda a query cross-tenant responde **`404 not_found`** — nunca `403`, para não revelar existência de IDs alheios. `403 tenant_suspended` só quando o próprio tenant está suspenso.

### 5.4 Auditoria

`audit_log.tenant_id` nullable (4.2). Ações novas: `auth.register`, `tenant.suspend`, `tenant.activate`, `platform.view_tenant`. Padrão de `details`/`entityId` sem segredos, como já é.

## 6. Escopo nas queries (choke point)

- Todos os repositórios/adapters com acesso a tabelas de negócio passam a exigir um **`scope` explícito** (`{ tenantId }`) como parâmetro de entrada — função sem escopo não compila/nao corre.
- Primeira condição de qualquer `SELECT|UPDATE|DELETE` de negócio: `tenant_id = $scope`. A plataforma só fala nos endpoints `/v1/platform/*` (com `:tenantId` no path).
- **Webhooks WA-AKG**: resolução de conta → tenant via `whatsapp_accounts.tenant_id`; `inbound_events.tenant_id` nullable preenchido no job de processamento quando a conta resolve; mensagens/outbox herdam da conta. Fork intocado.
- **Idempotência**: chaves geradas pelo cliente (composer) passam a ser únicas por `(tenant_id, chave)`; chaves do provider (`providerEventId`, `providerMessageId`) mantêm-se globais — são únicas por natureza.
- **Fila/outbox**: sem mudança de ritmo; `outbox_messages.tenant_id` deriva da conta.

## 7. Frontend

- **`/register`** (público, fora do `RequireAuth`, ao lado de `/login`): "Nome da empresa", "Nome", "Email", "Password" (dica: mínimo 12 caracteres) → `POST` → se `mfa:'setup'`, segue o **mesmo** tratamento do login (ecrã de TOTP). Link no login: "Ainda não tens conta? Cria a tua empresa".
- `GET /v1/auth/me` ganha `scope: 'tenant' | 'platform'` (para o cliente decidir rotas).
- **`/platform`** (só `platform_admin`): lista de tenants com estado e acções suspender/activar (modal de confirmação) + drill read-only (users, contas, conversas com thread).
- Shell de tenant **inalterado** — o servidor já devolve só o tenant da sessão; nenhum componente precisa de filtrar.
- Sidebar: `platform_admin` vê apenas `/platform`; `admin|editor|agent` mantêm o actual.
- UI em PT-AO, tema dark existente, primitivas existentes (`Button`, `Toast`, `Modal`, `EmptyState`), **axe violations 0**.

## 8. Testes e critérios de aceitação

1. **Registo**: happy (tenant + admin + sessão + `mfa:'setup'`), `409`, `429`, `400` password, papel ignorado no corpo, transacção atómica (falha a meio não deixa tenant sem admin).
2. **Suite de isolamento** (peça central): tenants A/B com dados espelhados → **cada** rota existente com IDs do outro tenant devolve `404` (leitura e escrita); `platform_admin` em rota de tenant negado; tenant em `/v1/platform/*` negado; tenant suspenso → `403 tenant_suspended`.
3. **Migração**: aplicar de zero numa BD vazia; upgrade da BD de validação → todas as linhas no tenant MilVendas (contentor real, output colado no relatório).
4. **Frontend**: `/register` (happy/erros), `/platform` (lista, suspender, read-only), sidebar condicional; gates `lint && typecheck && test && build` verdes.
5. **Browser (hook global)**: `verify.sh` em `/register`, `/login`, `/platform` e páginas de tenant — 0 erros JS, axe 0, screenshots.

## 9. Docs, ADR e gates

- **ADR `docs/adr/0007-multitenancy.md`**: contexto, 3 opções de isolamento com trade-offs, decisão (R5), consequências.
- `docs/01`: **D1 revertido** + nota da mudança; `docs/03 §3`: RBAC com `platform_admin`; READMEs de módulo actualizados.
- Commits convencionais pequenos; gates verdes por commit; sem push.
- Gates AGENTS.md: o **schema base é aprovado nesta secção 4**; nenhum gate de envio real/campanha é atingido (contas WhatsApp não mudam de comportamento).

## 10. Riscos e decisões conscientes

- **Query esquecida = fuga de dados** → choke point + suite de isolamento obrigatória (critério de pronto).
- Ordem das migrações (enum vs uso do valor) → `ALTER TYPE` em migração separada.
- Email globalmente único: uma pessoa não pode ter contas em dois tenants (consciente, v1).
- Registo sempre aberto: abuso contido por rate limit + suspensão; verificação de email = futuro (requer decisão de SMTP).
- TOTP obrigatório no 1º login do admin do tenant (`docs/03`) — aviso no UI do registo.
- D1 revertido: `docs/01` actualizado no mesmo trabalho, com ADR.
- `audit_log`/`inbound_events` com `tenant_id` nullable: excepções justificadas em 4.2 (evidência `ingest-webhook.ts:29`).
