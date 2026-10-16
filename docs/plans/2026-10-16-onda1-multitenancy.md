# Onda 1 — Multitenancy + Gaps Fase 1: Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) ou superpowers:executing-plans para implementar este plano task a task. Steps usam sintaxe de checkbox (`- [ ]`) para tracking.

**Goal:** Transformar o CRM num SaaS multi-tenant (schema único com `tenant_id`, registo público que cria tenant, plataforma de gestão) e fechar os gaps de UI da Fase 1.

**Architecture:** Schema único PostgreSQL com `tenant_id` em todas as tabelas de negócio; a autoridade do tenant é a linha do `users`, lida por pedido no guard `authenticate`; todos os repositórios exigem `TenantScope` explícito; rota de registo pública cria tenant+admin numa transacção e auto-loga; rotas `/v1/platform/*` só para `platform_admin` (leitura de suporte + ciclo de vida). Frontend: `/register` reutiliza o fluxo TOTP do login; `/platform` novo; `/settings` e gaps de `/users` aproveitam APIs existentes.

**Tech Stack:** Fastify + Drizzle ORM + PostgreSQL + zod (backend, `packages/backend`); React 19 + React Router + Vitest/RTL + Tailwind (frontend, `packages/frontend`); testes de integração com contentores reais (`npm run test:integration`).

**Spec:** `docs/superpowers/specs/2026-10-16-multitenant-design.md` (ler ANTES de cada task — o plano argumenta dela).

## Global Constraints

- UI em PT-AO; código, identificadores e commits em inglês; commits convencionais (`feat:`, `fix:`, `test:`, `docs:`); sem `push --force`; sem commits com testes a falhar.
- TypeScript `strict`; sem `any` sem comentário a justificar; toda a entrada validada com zod na fronteira.
- Segredos nunca em código/commits/logs/fixtures; dados pessoais mascarados em logs (docs/03).
- UI dark: fundo `#0a0a0c`, superfície `#121215`, borda `#26262b`, acento `#3b6ef6`, raio 0px, sem sombras; fontes Outfit + IBM Plex Sans via `@fontsource`; só dark; `axe violations 0` em todas as páginas novas.
- Erros HTTP: problem+json `{type,title,status,detail}`; novos títulos registados em `src/adapters/http/errors.ts` (`tenant_suspended: [403, 'empresa suspensa']`).
- Rate limit de login/registo: `deps.cfg.auth.loginRateMax` / `loginRateWindowMs` (nenhum campo de config novo).
- Migrações: nunca editar uma migração aplicada; `npm run db:generate` + revisão manual; aplicar de zero numa BD vazia é critério de pronto; **`ALTER TYPE … ADD VALUE` vive sempre numa migração ANTERIOR e separada da que usa o valor** (Postgres: valor novo não é usável na mesma transacção).
- Nunca apagar ou enfraquecer um teste para o fazer passar.
- Gates por commit de backend: `npm run lint && npm run typecheck && npm test` (+ `npm run test:integration` nas tasks marcadas). Frontend: `npm run lint && npm run typecheck && npm test && npm run build`.
- O fork WA-AKG **não é alterado** (gate docs/04). Nenhum envio real de WhatsApp, campanha ou ativação de IA autónoma acontece neste plano.
- `tenant_id` nunca vem do corpo de um pedido (spec §4.5).
- Cross-tenant responde `404 not_found` (nunca 403, nunca 200/203).

## Review Focus

Falhas mais prováveis que os testes normais NÃO apanham — cada linha tem teste no task dono:

1. **Query esquecida no SQL cru do orquestrador** (`orchestrator-ports.ts`, joins com `business_lines`) — espera-se que uma mensagem de webhook nunca escreva dados visíveis a outro tenant → teste em Task 5 (webhook tenant A ↔ B).
2. **Ordem da migração com backfill** (`ADD COLUMN` → `INSERT/UPDATE` → `SET NOT NULL` → `FK` → índice) — espera-se que a BD de validação faça upgrade sem perder linhas → teste de constraints em Task 1 + **upgrade manual na BD de validação com output no relatório** (Task 1 e Task 12).
3. **Enum `platform_admin` na mesma transacção** — espera-se que aplicar de zero não falhe com "unsafe use of new value" → teste "migrations aplicam de zero" em Task 2.
4. **Sessão com papel/stale** — espera-se que, depois de um admin ser despromovido, a sessão viva deixe de ter poderes de admin no PRÓXIMO pedido → teste em Task 3 (autoridade = linha `users` por pedido).
5. **`mfaPending` a atravessar guards novos** — espera-se que uma sessão por confirmar TOTP não consiga ler `/v1/platform/*` nem dados de conversas → teste em Task 7 (allowlist não alargada) e Task 8.

---

### Task 1: Schema `tenants` + `tenant_id` em todas as tabelas + migração com backfill

**Files:**
- Create: `src/adapters/db/schema/tenants.schema.ts` (tabela `tenants`)
- Modify: `src/adapters/db/schema/enums.ts` (+ `tenantStatusEnum`)
- Modify: todos os `src/adapters/db/schema/*.schema.ts` e `src/modules/knowledge/knowledge.schema.ts` (24 tabelas NOT NULL + `audit_log`/`inbound_events` nullable; `sessions` e `business_lines` intocadas)
- Migrations: gerar com `npm run db:generate` e editar manualmente (ver passo 3)
- Test: `tests/integration/tenancy-migration.test.ts` (novo; contentor real)

**Interfaces:**
- Produces: `tenants` (`id uuid pk`, `name text notNull`, `status tenantStatus default 'active'`, `created_at`, `updated_at`); `MILVENDAS_TENANT_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'` (literal fixo, usado no backfill e citado nos docs); coluna `tenantId uuid('tenant_id') notNull().references(() => tenants.id)` em todas as tabelas de negócio; índices `(tenant_id)` e `(tenant_id, created_at)` nas tabelas de listagem (conversations, messages, contacts, leads, audit_log, outbox_messages, inbound_events).

- [ ] **Step 1: Escrever o teste de falha (integração)**

Em `tests/integration/tenancy-migration.test.ts`, com o harness de contentores existente:

```ts
test('migrações aplicam de zero e criam tenants + tenant_id obrigatório');
test('linhas novas sem tenant_id falham (NOT NULL) em users e conversations');
test('FK: tenant_id inexistente falha');
test('audit_log e inbound_events aceitam tenant_id NULL');
test('sessions e business_lines não têm coluna tenant_id');
```

- [ ] **Step 2: Correr e ver falhar**

Run: `npm run test:integration -- tenancy-migration`
Expected: FAIL (tabela `tenants` inexistente / coluna `tenant_id` inexistente).

- [ ] **Step 3: Schema + migrações**

1. Criar `tenants.schema.ts` e `tenantStatusEnum('tenant_status', ['active','suspended'])`; acrescentar `tenantId` às 24 tabelas NOT NULL e nullable a `audit_log`/`inbound_events` (+ índices). `onConflict`/existentes não mudam aqui.
2. `npm run db:generate` → ficheiro SQL gerado.
3. **Editar o SQL gerado** para o padrão por tabela: `ALTER TABLE … ADD COLUMN tenant_id uuid;` → `UPDATE … SET tenant_id = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';` (em `audit_log` também; `inbound_events` fica sem backfill — sem conta conhecida) → `ALTER COLUMN tenant_id SET NOT NULL` (as 24) → `ADD CONSTRAINT … FOREIGN KEY` → `CREATE INDEX`. No topo: `CREATE TYPE tenant_status` + `CREATE TABLE tenants` + `INSERT INTO tenants (id,name,status) VALUES ('6ba7b810-…','MilVendas','active');`.
4. Se o gerador emitir o `CREATE TYPE`/`INSERT` fora de ordem, **dividir o ficheiro em dois** e registar ambos em `drizzle/meta/_journal.json` (copiar a forma da entrada existente; ordem: tipos/tabela primeiro).

- [ ] **Step 4: Correr testes de integração e gates**

Run: `npm run test:integration -- tenancy-migration && npm run lint && npm run typecheck && npm test`
Expected: PASS em tudo (os unitários existentes não usam `tenant_id` ainda — schema-only não os parte).

- [ ] **Step 5: Upgrade manual na BD de validação (prova de dados)**

Run (com `set -a; . /tmp/opencode/fase1-crm.env; set +a`): `npm run db:migrate`; depois `psql "$DATABASE_URL" -c "select (select count(*) from users), (select count(*) from tenants), (select name from tenants);"`
Expected: migração aplica; contagem de users inalterada; tenant `MilVendas` presente. Colar output no relatório.

- [ ] **Step 6: Commit**

```bash
git add packages/backend/src packages/backend/drizzle packages/backend/tests
git commit -m "feat: add tenants table and tenant_id scoping columns"
```

---

### Task 2: `platform_admin` (enum + CHECK + CLI)

**Files:**
- Modify: `src/ports/auth.ts:5` (`Role`)
- Modify: `src/adapters/db/schema/users.schema.ts` (CHECK)
- Migrations: gerar + **separar** `ALTER TYPE user_role ADD VALUE 'platform_admin'` no ficheiro anterior (journal)
- Modify: `scripts/create-user.ts` (+ `--platform`, `--tenant <uuid>`)
- Test: `tests/integration/platform-admin.test.ts` (novo)

**Interfaces:**
- Produces: `Role = 'agent' | 'editor' | 'admin' | 'platform_admin'`; invariant CHECK `(role = 'platform_admin') = (tenant_id IS NULL)`; CLI: `create-user.ts --email … --name … --role admin [--tenant <uuid>]` ou `--role platform_admin` (sem tenant).

- [ ] **Step 1: Teste de falha**

```ts
test('criar platform admin via CLI deixa tenant_id NULL');
test('criar admin de tenant sem --tenant usa o tenant MilVendas (default)');
test('INSERT platform_admin COM tenant_id viola o CHECK');
test('migrações aplicam de zero (enum separado — sem unsafe use of new value)');
```

- [ ] **Step 2: Correr e ver falhar** — `npm run test:integration -- platform-admin` → FAIL.

- [ ] **Step 3: Implementar** — `Role` estendido; CHECK em `users.schema.ts` (`check('users_platform_tenant_check', …)`); migração gerada e **split manual** (enum no ficheiro A, CHECK no ficheiro B; journal actualizado); CLI com `--platform` (valida: `--role platform_admin` ⇒ sem `--tenant`; outros papéis ⇒ `--tenant` com default do tenant MilVendas).

- [ ] **Step 4: Gates** — `npm run test:integration -- platform-admin && npm run lint && npm run typecheck && npm test` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: add platform_admin role with tenant isolation check"`.

---

### Task 3: Auth — tenant por pedido, suspensão, `scope`

**Files:**
- Modify: `src/ports/auth.ts` (`AuthUserRepo` retorna `tenantId: string | null`)
- Create: `src/ports/tenancy.ts` (`TenantScope`, `TenancyPort`)
- Modify: `src/adapters/http/guards.ts` (`AuthContext` + `authenticate`)
- Modify: `src/adapters/db/auth.ts` (SELECTs com `tenant_id` + estado do tenant)
- Modify: `src/adapters/http/errors.ts` (+ `tenant_suspended`)
- Modify: `src/adapters/http/routes/auth.ts` (`/me` + `scope`)
- Test: `tests/unit/guards.test.ts` (existente, estender) + `tests/integration/auth-tenancy.test.ts` (novo)

**Interfaces:**
- Produces: `export interface AuthContext { sessionId; userId; role: Role; tenantId: string | null; isPlatform: boolean; mfaPending; ip }`; `export type TenantScope = { tenantId: string }`; `export interface TenancyPort { getStatus(tenantId: string): Promise<'active' | 'suspended' | null> }`; `/me` devolve `{ id, name, email, role, scope: 'tenant' | 'platform' }`.

- [ ] **Step 1: Testes de falha** — unit em guards (fakes de `SessionStore`/`AuthUserRepo`/`TenancyPort`):

```ts
test('platform_admin autentica com tenantId null e isPlatform true');
test('tenant suspenso → HttpError(403, tenant_suspended)');
test('papel vem da linha users por pedido, não da sessão (utilizador despromovido perde poderes no pedido seguinte)');
```

Integração: login → `/me` inclui `scope`; suspender o tenant na BD → qualquer pedido autenticado → 403 `tenant_suspended`.

- [ ] **Step 2: Correr e ver falhar** — `npm test -- guards` + `npm run test:integration -- auth-tenancy` → FAIL.

- [ ] **Step 3: Implementar** — `authenticate` ganha deps `{ sessions, users, tenancy }` (ajustar o factory em `src/adapters/http/app.ts`); lê a linha do user (`role`, `active`, `tenantId`) e `tenancy.getStatus` por pedido; plataforma = `role === 'platform_admin'` (tenantId null); suspensão → 403. `SessionRecord` mantém `role` só como snapshot de criação (não autoriza nada).

- [ ] **Step 4: Gates** — `npm run lint && npm run typecheck && npm test && npm run test:integration -- auth-tenancy` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: resolve tenant scope per request in auth guard"`.

---

### Task 4: Escopo nos repositórios HTTP e rotas

**Files:**
- Modify: `src/adapters/db/users.ts` (`UsersRepository`), `src/ports/accounts.ts` + `src/adapters/db/accounts.ts`, `src/ports/conversations.ts` + `src/adapters/db/conversations.ts`, `src/adapters/db/outbox.ts` (envio humano), `src/ports/audit.ts` + `src/adapters/db/audit-adapter.ts` (+ `tenantId: string | null` no input de `record`)
- Modify: `src/adapters/http/routes/users.ts`, `whatsapp-accounts.ts`, `conversations.ts`, `src/application/messaging.ts`
- Modify: `src/adapters/realtime/socket.ts` (handshake: papel vem da linha `users` por pedido — nunca do snapshot da sessão — e `tenancy.getStatus` rejeita sockets de tenants suspensos; descoberto no review da Task 3)
- Test: `tests/integration/repo-scope.test.ts` (novo) + actualização dos unitários com fakes

**Interfaces:**
- Consumes: `TenantScope` (Task 3).
- Produces: todo o método de leitura/escrita ganha `scope: TenantScope` como **primeiro** parâmetro (`list(scope, input)`, `get(scope, id) → null` se alheio); `Audit.record` ganha `tenantId: string | null` (null só para ações de plataforma, escritas pelas rotas Task 7). As rotas passam `{ tenantId: request.auth!.tenantId! }` (rotas de tenant nunca têm plataforma — `requirePlatform` separa).

- [ ] **Step 1: Teste de falha** — `tests/integration/repo-scope.test.ts`:

```ts
test('accounts.get(scopeA, contaDeB) → null');
test('conversations.list(scopeA) não devolve conversas de B');
test('users.list(scopeA) não devolve users de B');
test('PATCH /v1/users/:idDeB com sessão de A → 404');
test('GET /v1/conversations/:idDeB com sessão de A → 404');
test('handshake realtime com user despromovido não recebe papel antigo (papel vem da linha users)');
test('handshake realtime de tenant suspenso → rejeitado');
```

- [ ] **Step 2: Correr e ver falhar** — `npm run test:integration -- repo-scope` → FAIL (ids alheios ainda visíveis).

- [ ] **Step 3: Implementar** — primeiro parâmetro `scope` em todos os métodos; `where(and(eq(t.tenantId, scope.tenantId), …))` como primeira condição; rotas passam o scope da sessão; `messaging` deriva o scope da conversa/conta já escopada. No `socket.ts`: resolver o user na linha `users` no handshake e verificar `tenancy.getStatus` (suspensos → rejeitar). Atualizar fakes dos unitários existentes (sem apagar asserções).

- [ ] **Step 4: Gates** — `npm run lint && npm run typecheck && npm test && npm run test:integration -- repo-scope` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: require tenant scope in http repositories and realtime handshake"`.

---

### Task 5: Escopo nos jobs de fundo, `inbound_events` e idempotência de envio

**Files:**
- Modify: `src/application/ingest-webhook.ts`, `inbound-process.ts`, `handle-inbound.ts`, `message-status.ts`, `outbox-worker.ts`, `src/adapters/db/inbound.ts`, `src/adapters/db/orchestrator-ports.ts` (SQL cru), `src/adapters/db/outbox.ts`
- Modify: schema `outbox.schema.ts` (unique `(tenant_id, idempotency_key)`) + migração pequena (drop do unique antigo → composto)
- Test: `tests/integration/webhook-tenant.test.ts` (novo)

**Interfaces:**
- Consumes: `TenantScope` (Task 3); `inbound_events.tenantId` nullable (Task 1).
- Produces: `insertInboundEvent` sem mudança de assinatura; `markInboundTenant(eventId, tenantId)` novo em `inbound.ts`; o job `inbound.process` resolve a conta (`findByProviderSession`/`findByPhone` — **necessariamente sem scope: é resolução de tenant**, exceção documentada) e propaga o `tenantId` para conversa/mensagem/outbox/orquestrador; `enqueue`/`claim` da outbox usam o scope; unique `(tenantId, idempotencyKey)` e lookup composto (`outbox.ts:75,86` actualizados).

- [ ] **Step 1: Teste de falha** — `tests/integration/webhook-tenant.test.ts` (duas contas, dois tenants, HMAC do teste existente reutilizado):

```ts
test('mensagem inbound da conta A cria conversa/mensagem/outbox no tenant A e preenche inbound_events.tenant_id');
test('idempotency-key repetida em tenants diferentes → dois envios (unique composto)');
test('idempotency-key repetida no mesmo tenant → dedupe/409 como hoje');
test('SQL do orquestrador não escreve nem lê linhas de outro tenant (busca por line_id devolve só as do tenant)');
```

- [ ] **Step 2: Correr e ver falhar** — `npm run test:integration -- webhook-tenant` → FAIL.

- [ ] **Step 3: Implementar** — propagação do tenant resolvido nos jobs; `orchestrator-ports.ts`: toda a query ganha `AND tenant_id = $t` (o lookup de `business_lines` continua global, por design — dicionário); migração do unique composto.

- [ ] **Step 4: Gates** — `npm run lint && npm run typecheck && npm test && npm run test:integration` (suite completa) → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: scope background jobs and outbox idempotency by tenant"`.

---

### Task 6: `POST /v1/auth/register` (público)

**Files:**
- Create: `src/application/auth/register.ts` (`createRegisterService`)
- Modify: `src/adapters/http/routes/auth.ts` (+ rota; rate limit `deps.cfg.auth.loginRateMax/loginRateWindowMs`)
- Test: `tests/unit/register.test.ts` + `tests/integration/register.test.ts` (novos)

**Interfaces:**
- Consumes: `LoginService.login` (existente), `assertPasswordPolicy`, `DbClient` (transacção), `PasswordHasher`, `Audit`.
- Produces: `createRegisterService(deps: { db: DbClient; hasher: PasswordHasher; audit: Audit; login: ReturnType<typeof createLoginService>; now(): Date })` → `{ register(input: { tenantName: string; name: string; email: string; password: string; ip: string }): Promise<{ status: 'created'; sessionId: string; expiresAt: Date; otpauthUrl: string } | { status: 'email_exists' }> }`; rota `POST /v1/auth/register` devolve 200 `{ mfa: 'setup', otpauthUrl, expiresAt }` (igual ao login) ou 409 `email_already_exists`.

- [ ] **Step 1: Testes de falha**

Unit (fakes): `register cria tenant + admin e devolve mfa_setup`; `email repetido → email_exists`; `password de 11 caracteres → DomainError weak_password`; `o papel NÃO vem do corpo (role=admin fixo)`.
Integração: `POST /v1/auth/register` → 200 + cookies `session`/`csrf` + linha em `tenants` e `users` + `audit_log 'auth.register'`; falha forçada a meio (fake hasher que lança) → **nenhuma linha nova** (transacção).

- [ ] **Step 2: Correr e ver falhar** — `npm test -- register && npm run test:integration -- register` → FAIL (rota 404).

- [ ] **Step 3: Implementar** — transacção: insert tenant → insert user (`role: 'admin'`, `tenantId`) → audit; depois `login.login()` para auto-login (devolve `mfa_setup_required` → route mapeia como o login faz, `auth.ts:69-71`); email normalizado (lower+trim) na fronteira; CSRF: a rota é pública **e isenta** (como login — o guard global de CSRF só corre com sessão; confirmar comportamento e, se necessário, registar a isenção explícita como o login).

- [ ] **Step 4: Gates** — `npm run lint && npm run typecheck && npm test && npm run test:integration -- register` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: add public registration creating tenant and admin"`.

---

### Task 7: Rotas de plataforma `/v1/platform/*`

**Files:**
- Create: `src/adapters/db/tenants.ts` (`TenantsRepository`), `src/adapters/http/routes/platform.ts`
- Modify: `src/adapters/http/guards.ts` (`requirePlatform`), `src/adapters/http/app.ts:153` (registo), audit via `Audit.record` com `tenantId`
- Test: `tests/integration/platform.test.ts` (novo)

**Interfaces:**
- Consumes: `AuthContext.isPlatform` (Task 3), `TenancyPort`/repos com scope (Tasks 3–4).
- Produces: `requirePlatform(): preHandlerHookHandler` (403 `forbidden` se `!isPlatform`); `GET /v1/platform/tenants` → `[{ id, name, status, usersCount, accountsCount, createdAt }]`; `POST /v1/platform/tenants/:id/suspend` e `…/activate` → 204 + audit (`tenant.suspend`/`tenant.activate`); `GET /v1/platform/tenants/:tenantId/{users,accounts,conversations}` e `…/conversations/:id` (thread, read-only) + audit `platform.view_tenant` no primeiro acesso a cada tenant. Nenhuma rota de escrita dentro de tenant para plataforma.

- [ ] **Step 1: Testes de falha**

```ts
test('platform_admin lista tenants com contagens');
test('suspend → tenants.status suspended + audit tenant.suspend');
test('drill read-only devolve users/contas/conversas do tenant pedido');
test('sessão de tenant em /v1/platform/* → 403');
test('sessão mfaPending (mesmo platform_admin) em /v1/platform/* → 403 (fora do MFA_ALLOWLIST)');
test('platform_admin NÃO tem escrita dentro de tenant: POST /v1/users com sessão platform → 403');
```

- [ ] **Step 2: Correr e ver falhar** — `npm run test:integration -- platform` → FAIL.

- [ ] **Step 3: Implementar** — como acima; o drill usa os repos com `{ tenantId: params.tenantId }` (scope construído do path — única via de acesso cross-tenant, sempre auditada).

- [ ] **Step 4: Gates** — `npm run lint && npm run typecheck && npm test && npm run test:integration -- platform` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: add platform tenant management routes"`.

---

### Task 8: Suite de isolamento (critério de aceitação)

**Files:**
- Create: `tests/integration/isolation.test.ts`
- Modify: apenas código dos tasks donos se a suite encontrar fugas (commits `fix:` separados, com teste)

**Interfaces:**
- Consumes: tudo das Tasks 3–7.

- [ ] **Step 1: Escrever a matriz**

Dois tenants A/B com users (admin/agent), contas, conversas, mensagens, contactos, leads, campanhas, outbox **espelhados por inserts directos**. Para **cada** rota autenticada de tenant (users, accounts, conversations+thread+send, campaigns placeholder, …):
- leitura por id alheio → `404`;
- mutação por id alheio (PATCH/POST/DELETE) → `404`;
- listagens → nunca contêm linhas do outro tenant;
- rota de plataforma com sessão de tenant → `403`; rota de tenant com sessão plataforma → `403`;
- qualquer rota com sessão `mfaPending` → `403`.

- [ ] **Step 2: Correr** — `npm run test:integration -- isolation` → se falhar, corrigir no task dono com teste novo e commit `fix:`.

- [ ] **Step 3: Gates + Commit** — suite completa verde; `git commit -m "test: add cross-tenant isolation suite"`.

---

### Task 9: Frontend — `/register`

**Files:**
- Create: `src/pages/register.tsx` + `src/pages/register.test.tsx`
- Modify: `src/lib/auth.tsx` (`register()` no contexto, mesmas transições do login), `src/lib/types.ts`, `src/main.tsx` (rota pública), `src/pages/login.tsx` (link "Ainda não tens conta? Cria a tua empresa"), `src/lib/labels.ts` (copy PT-AO)

**Interfaces:**
- Consumes: `POST /v1/auth/register` (Task 6), máquina de estados do login (`mfa_setup`).
- Produces: `SessionValue.register(input: { tenantName; name; email; password }): Promise<void>` — igual a `login()` no tratamento da resposta (`mfa:'setup'` → estado `mfa_setup` com `otpauthUrl`).

- [ ] **Step 1: Testes RTL (falha)** — `register.test.tsx`: submissão happy → `mfa_setup` (ecrã TOTP); 409 → erro inline "email já registado"; password curta → 400 do servidor traduzido; link no login navega para `/register`; sem sessão não autenticada.
- [ ] **Step 2: Correr e ver falhar** — `npm test -- register` → FAIL.
- [ ] **Step 3: Implementar** — formulário com as primitivas existentes (`Field`, `Button`, `Toast`), copy PT-AO, dica "Mínimo de 12 caracteres (a validação é feita no servidor)", aviso TOTP para admin.
- [ ] **Step 4: Gates + browser** — `npm run lint && npm run typecheck && npm test && npm run build`; com o Vite a correr em `:3000`: `bash ~/.config/opencode/skills/agent-browser-verify/scripts/verify.sh http://localhost:3000/register` → 0 erros JS, axe 0, screenshot guardado; fechar browser.
- [ ] **Step 5: Commit** — `git commit -m "feat: add public registration page"`.

---

### Task 10: Frontend — `scope` + `/platform`

**Files:**
- Modify: `src/lib/types.ts` (`SessionUser.scope`), `src/lib/auth.tsx` (`/me` com `scope`), `src/components/guards.tsx` (+ `RequirePlatform`), `src/components/Sidebar.tsx`, `src/main.tsx`
- Create: `src/pages/platform.tsx` + `src/pages/platform.test.tsx`

**Interfaces:**
- Consumes: `/me.scope` (Task 3), `/v1/platform/*` (Task 7).
- Produces: `RequirePlatform` (redireciona não-plataforma para `/`); Sidebar: plataforma vê só "Plataforma" (+ sair); página `/platform`: tabela de tenants (nome, estado, users, contas, criado em) com acções "Suspender"/"Activar" (modal de confirmação) e drill read-only (users, contas, conversas + thread).

- [ ] **Step 1: Testes RTL (falha)** — `platform.test.tsx`: lista renderiza da resposta; suspender chama POST e mostra toast; modal cancela sem chamada; drill abre e lista; utilizador de tenant não vê link nem acede à rota (`RequirePlatform`).
- [ ] **Step 2: Correr e ver falhar** — `npm test -- platform` → FAIL.
- [ ] **Step 3: Implementar** — padrões das páginas existentes (tabela do `users.tsx`, modal do users, toasts).
- [ ] **Step 4: Gates + browser** — gates frontend verdes; verify.sh em `/platform` (com sessão platform admin — criar via CLI `--platform` e login) → axe 0, sem erros JS, screenshots; fechar browser.
- [ ] **Step 5: Commit** — `git commit -m "feat: add platform tenant management page"`.

---

### Task 11: Frontend — gaps Fase 1 (Definições, repor password, Contas admin-only)

**Files:**
- Create: `src/components/TotpSetup.tsx` (extrair o ecrã `mfa_setup` actual do `login.tsx`), `src/pages/settings.tsx` + `src/pages/settings.test.tsx`
- Modify: `src/pages/login.tsx` (usa o componente extraído; testes existentes verdes), `src/main.tsx` (`/settings` dentro do shell; `/users` e `/accounts` com `RequireAdmin`), `src/components/Sidebar.tsx` ("Contas" só admin; item "Definições"), `src/pages/users.tsx` (+ controlo "Repor palavra-passe" → modal → `PATCH /v1/users/:id {password}`) + `src/pages/users.test.tsx` (+ casos)

**Interfaces:**
- Consumes: `POST /v1/auth/password`, `POST /v1/auth/totp/setup|verify`, `PATCH /v1/users/:id` (já existem).
- Produces: página `/settings` (mudar password própria com confirmação de revogação de sessões + activar TOTP com o mesmo fluxo do login; nota honesta: "desactivar o TOTP não está disponível — contacte o suporte"); `/users` com repo de password (admin só, nunca mostra a password, aviso de revogação de sessões); `/accounts` admin-only no cliente com toast honesto a não-admin por URL directo.

- [ ] **Step 1: Testes RTL (falha)** — `settings.test.tsx`: mudar password chama POST e mostra sucesso/erro do servidor; TOTP setup renderiza QR e aceita código. `users.test.tsx` novo: controlo de repo visível só em admin; submit → PATCH + toast; linha do próprio utilizador continua sem acções (ruling T11). `main/Sidebar`: não-admin não chega a `/accounts` (redirect) e não vê o link.
- [ ] **Step 2: Correr e ver falhar** — `npm test` → FAIL nos novos.
- [ ] **Step 3: Implementar** — extrair `TotpSetup` sem mudar comportamento do login (testes existentes são a rede de segurança).
- [ ] **Step 4: Gates + browser** — gates frontend verdes; verify.sh em `/settings` e `/users` → axe 0, sem erros JS, screenshots; fechar browser.
- [ ] **Step 5: Commit** — `git commit -m "feat: add settings page and admin password reset control"`.

---

### Task 12: Docs, ADR, validação final

**Files:**
- Create: `docs/adr/0007-multitenancy.md` (template existente: contexto, opções R5 com trade-offs, decisão, consequências)
- Modify: `docs/01-contexto-e-plano.md` (D1 revertido + nota das ondas), `docs/03-seguranca.md` §3 (+ `platform_admin`), `packages/backend` README/módulo, `packages/frontend/src/README.md`, `AGENTS.md` (comandos/estrutura se aplicável)
- Nenhum código de produto novo (só `fix:` se a validação final revelar fugas)

- [ ] **Step 1: Docs** — ADR + actualizações; `git commit -m "docs: record multitenancy decision and revert D1"`.
- [ ] **Step 2: Migração de zero + upgrade, prova final** — BD vazia nova (contentor): `db:migrate` do zero → PASS; BD de validação: estado final com todos os dados em "MilVendas" + platform admin criado via CLI; output colado no relatório.
- [ ] **Step 3: Gates totais** — backend: `lint && typecheck && test && test:integration`; frontend: `lint && typecheck && test && build`. Capturar exit codes.
- [ ] **Step 4: Verificação browser final** — verify.sh em `/login`, `/register`, `/` (dashboard), `/conversations`, `/users`, `/settings`, `/platform` (sessão platform) → 0 erros JS, **axe 0 em todas**, screenshots; `agent-browser close --all`.
- [ ] **Step 5: Relatório final** — o que mudou, evidência (comandos+output), restos, riscos novos, decisões pendentes de humano; `git log --oneline` da onda.

---

## Notas de execução

- Ordem das tasks é **sequencial** (cada uma constrói sobre as interfaces da anterior). Tasks 9–11 (frontend) só começam depois da 6–7 (API).
- A BD de validação (`/tmp/opencode/fase1-crm.env`, Postgres `:5433`) é o alvo do upgrade manual; os testes de integração usam o contentor do `scripts/integration-test.sh`.
- Nenhum passo envia WhatsApp real, ativa campanhas ou muda o fork (gates AGENTS.md intactos).
