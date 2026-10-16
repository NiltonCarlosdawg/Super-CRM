# Plano de implementação — Frontend completo (estilo veranolabs.pages.dev)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Completar `packages/frontend` (Vite+React+Tailwind) ligado ao backend da Fase 1 em `:3001`, com o tema escuro medido na referência, incluindo login+TOTP, contas com QR, conversas com envio real e realtime.

**Architecture:** Camada de API única em `src/lib/api.ts` (fetch same-origin via proxy, CSRF, problem+json); sessão em contexto React com a máquina de estados do login+TOTP; Socket.IO do backend (cookie de sessão) com invalidação de estado por página; páginas verticais entregues por ordem de valor, testadas com vitest+jsdom e verificadas no browser contra a stack real.

**Tech Stack:** Vite 8 + React 18 + React Router 6 + Tailwind 3; vitest 5 + jsdom + @testing-library/react; socket.io-client; qrcode.react; @fontsource (Outfit, IBM Plex Sans).

**Spec:** `docs/plans/2026-10-16-frontend-completo.md` (desenho aprovado; os contratos abaixo foram extraídos do código real do backend, `packages/backend/src/adapters/http/routes/*` e `src/adapters/realtime/socket.ts`).

## Global Constraints

- Código e commits em inglês; UI em **PT-AO**; commits convencionais pequenos (`feat(frontend):`, `fix(frontend):`...); nunca `push --force`; commits só com lint/typecheck/test/build verdes.
- **Só frontend**: nenhum ficheiro de `packages/backend` muda; o backend corre em `:3001` (não reiniciar sem necessidade); `:3000` é o vite dev deste package; fork WA-AKG em `:3010` intocado.
- Não correr `npm run test:integration` do backend sem `KEEP_CONTAINERS=1` (trap apaga os contentores de teste).
- Docs/03 no frontend: **nunca** `console.log` de corpos de mensagens ou telefones; sem segredos (não há chaves no frontend — tudo same-origin via proxy).
- Sem dados falsos: campanhas fica placeholder marcado, sem mocks inventados.
- Tokens fixos do desenho (não "aproximar"): fundo `#0a0a0c`, superfície `#121215`, borda `#26262b`, texto `#f2f2f3`, secundário `#c6c6c6`, acento `#3b6ef6`, raio **0px**, sem sombras; Outfit (corpo) + IBM Plex Sans peso 300 (display).
- Dependências novas já justificadas no desenho (nada fora desta lista): `socket.io-client`, `qrcode.react`, `@fontsource/outfit`, `@fontsource/ibm-plex-sans`, `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`, `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`, `eslint-plugin-react-hooks`.
- Labels PT obrigatórios: roles admin/editor/agent → Administrador/Editor/Agente; conta connecting/connected/disconnected/suspected_ban → A ligar/Ligada/Desligada/Suspeita de ban; mensagem queued/sent/delivered/read/failed → Na fila/Enviada/Entregue/Lida/Falhou; aiMode ai_active/ai_suggest/human_only → IA activa/IA sugere/Só humano; purpose support/sales/campaigns → Suporte/Vendas/Campanhas.

## Review Focus

Inputs/falhas que mais provavelmente mordem (cada linha tem teste na tarefa dona):

1. **Mutação sem header `x-csrf-token`** → 403 do guard global → teste `api.test.ts: envia x-csrf-token nas mutações` (Task 1).
2. **Dois desvios de MFA** (`mfa:'setup'` e `mfa:'required'`) → teste `auth.test.ts: mfa required sem otpauthUrl` e `... mfa setup com otpauthUrl` (Task 2).
3. **Retry a gerar chave nova** → duplicaria envio no WhatsApp → teste `composer.test.ts: retry reutiliza a mesma Idempotency-Key` (Task 10).
4. **Polling do QR que nunca pára** após `connected` (tráfego inútil + estado velho) → teste `accounts.test.ts: poll do QR pára quando a conta liga` com fake timers (Task 7).
5. **409 `idempotency_conflict`** (chave reutilizada com corpo diferente) → teste `composer.test.ts: 409 mostra conflito sem reenviar` (Task 10).

## Estrutura de ficheiros

- Criar: `src/lib/{api.ts,types.ts,auth.tsx,socket.ts}`, `src/components/ui/{Button,Card,Field,Badge,Modal,EmptyState,Toast,Spinner}.tsx`, `src/components/{AppShell,Sidebar,Header}.tsx` (novo Header), `src/pages/{dashboard.tsx,users.tsx}` + reescrever `src/pages/{login,accounts,campaigns}.tsx` e criar `src/pages/conversations.tsx`, `vitest.config.ts`, `src/test-setup.ts`, `.eslintrc.cjs`, `tests/` junto aos módulos (`src/lib/*.test.ts(x)`, `src/pages/*.test.tsx`).
- Modificar: `vite.config.ts` (proxy), `tailwind.config.ts` (tokens), `src/globals.css` (paleta dark), `src/main.tsx` (providers+rotas), `package.json` (deps).
- Apagar: `src/pages/register.tsx` (substituída por users), componentes antigos que ficarem sem uso (`Header.tsx` antigo, `CampaignCard.tsx` se não servir o placeholder) — regra: sem UI órfã.

---

### Task 1 — Toolchain + `lib/api.ts` + `lib/types.ts`

**Files:**
- Create: `vitest.config.ts`, `src/test-setup.ts`, `.eslintrc.cjs`, `src/lib/api.test.ts`
- Modify: `tsconfig.json` (remover `ignoreDeprecations: "6.0"` — causa do TS5103; paths → `"@/*": ["src/*"]`), `vite.config.ts` (proxy), `package.json`
- Create: `src/lib/api.ts`, `src/lib/types.ts`

**Interfaces:**
- Produces (toda a app consome): `ApiError { status, title, detail? }`; `api.get<T>(path): Promise<T>`, `api.post<T>(path, body?, opts?: { idempotencyKey?: string }): Promise<T>`, `api.patch<T>(path, body): Promise<T>`, `api.del<T>(path): Promise<T>` (204 → resolve); tipos em `types.ts`: `Role = 'admin'|'editor'|'agent'`, `SessionUser {id,name,email,role}`, `AccountStatus`, `AccountPurpose`, `AccountRow {id,label,phoneE164,providerSessionId,status,purpose}`, `AiMode`, `ConversationView {id,accountId,contactId,contactPhone,leadId,line,aiMode,missStreak,lastMessageAt,createdAt}`, `MessageStatus`, `MessageView {id,conversationId,direction,sender,kind,body,status,mediaRef,createdAt}`, `Page<T> {items:T[], nextCursor:string|null}`.

- [ ] **Step 1: Setup do toolchain (deps + configs)**
  Instalar devDeps: `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`, `@typescript-eslint/parser@^7`, `@typescript-eslint/eslint-plugin@^7`, `eslint-plugin-react-hooks` (`npm i -D ...` em `packages/frontend`). Criar `vitest.config.ts` (`environment: 'jsdom'`, `setupFiles: ['./src/test-setup.ts']`, `globals: false`), `src/test-setup.ts` (`import '@testing-library/jest-dom'`), `.eslintrc.cjs` (parser `@typescript-eslint/parser`, extends `eslint:recommended`, `plugin:@typescript-eslint/recommended`, `plugin:react-hooks/recommended`). Em `vite.config.ts`: `server.proxy = { '/v1': 'http://localhost:3001', '/socket.io': { target: 'http://localhost:3001', ws: true } }`.

- [ ] **Step 2: Escrever o teste falhador**
  `src/lib/api.test.ts` — com `vi.stubGlobal('fetch', ...)` (mock devolve `Response`):
  - `envia x-csrf-token nas mutações`: com `document.cookie = 'csrf=abc123'`, chamar `api.post('/v1/x', {a:1})`; assert: segunda chamada de fetch tem headers com `x-csrf-token: 'abc123'` e `content-type: application/json`.
  - `mapeia problem+json para ApiError`: resposta `400` com corpo `{"title":"validation_failed","detail":"x"}`; assert rejeita com `ApiError` (`err.status===400`, `err.title==='validation_failed'`, `err.detail==='x'`).
  - `GET sem header csrf`: `api.get('/v1/x')`; assert headers **sem** `x-csrf-token`.
  - `204 resolve sem corpo`: `api.del('/v1/x')` com `204`; assert resolve `undefined`.

- [ ] **Step 3: Correr e ver falhar**
  Run: `npx vitest run src/lib/api.test.ts`
  Expected: FAIL (módulo `api` não existe).

- [ ] **Step 4: Implementar `src/lib/api.ts` e `src/lib/types.ts`**
  `fetch` com `credentials: 'same-origin'`; header CSRF lido do cookie `csrf` (não-GET); resposta não-ok → tenta JSON `{title,detail}` → `throw new ApiError(status, title, detail)`; falha de rede → `ApiError(0,'network')`. `opts.idempotencyKey` → header `Idempotency-Key`. `types.ts` com os tipos do bloco Interfaces (valores pinados no desenho §3/§5).

- [ ] **Step 5: Correr gates e commit**
  Run: `npm run lint && npm run typecheck && npm test && npm run build`
  Expected: verdes (o `typecheck` deixa de falhar com TS5103).
  ```bash
  git add packages/frontend && git commit -m "feat(frontend): add api client, types and fix toolchain"
  ```

### Task 2 — `lib/auth.tsx`: sessão + máquina do login com TOTP

**Files:**
- Create: `src/lib/auth.test.tsx`, `src/lib/auth.tsx`

**Interfaces:**
- Consumes: `api`, `ApiError`, `SessionUser`, `Role` (Task 1).
- Produces: `SessionProvider`; `useSession(): { status: 'loading'|'anon'|'mfa_setup'|'mfa_required'|'authed'; user: SessionUser|null; otpauthUrl: string|null; error: string|null; login(email: string, password: string): Promise<void>; verifyTotp(code: string): Promise<void>; logout(): Promise<void> }`.

- [ ] **Step 1: Testes falhadores** (`src/lib/auth.test.tsx`, render com `SessionProvider` + `renderHook` do testing-library):
  - `me 200 autentica no arranque` → estado final `authed`, user `{id:'u1',name:'A',email:'a@b.c',role:'admin'}`.
  - `me 401 fica anon` → `anon`.
  - `login completo autentica` → `login('a@b.c','pw')` com resposta `{user, expiresAt}` → `authed`.
  - `mfa setup com otpauthUrl` → resposta `{mfa:'setup',otpauthUrl:'otpauth://totp/X'}` → estado `mfa_setup`, `otpauthUrl` guardado.
  - `mfa required sem otpauthUrl` → `{mfa:'required'}` → `mfa_required`.
  - `verifyTotp faz verify e re-login` → verify `{ok:true}` depois login `{user}` → `authed`; assert: chamadas `POST /v1/auth/totp/verify` com `{code:'123456'}` e depois novo `POST /v1/auth/login`.
  - `verifyTotp invalido mostra erro e não sai do mfa` → verify 400 → estado mantém, `error` preenchido.
  - `logout volta a anon` → 204 → `anon`.
- [ ] **Step 2: Correr e ver falhar** — Run: `npx vitest run src/lib/auth.test.tsx` → FAIL.
- [ ] **Step 3: Implementar** `SessionProvider` com `useEffect` no `me`; `login` guarda `otpauthUrl` no caso `setup`; `verifyTotp` só chama re-login no sucesso; erros → `error` com `title`+`detail` (sem corpo de problema crú no toast).
- [ ] **Step 4: Gates + commit** — `npm run lint && npm run typecheck && npm test` → verdes; `git commit -m "feat(frontend): add session context with totp login flow"`.

### Task 3 — `lib/socket.ts`: cliente do painel + `useEvent`

**Files:**
- Create: `src/lib/socket.ts`, `src/lib/socket.test.ts`

**Interfaces:**
- Produces: `type PanelEventName = 'handoff.created'|'handoff.updated'|'message.created'|'message.status'|'account.status'`; payloads `{v:1, ...}`: message.created/status → `{messageId,conversationId,accountId,sender,status,providerMessageId?}`, account.status → `{accountId,status:AccountStatus}`, handoff.* → `{handoffId,conversationId,priority,reason?}`; `createPanelSocket(ioFactory): { on(name, handler): () => void; disconnect(): void }` (injecção do `io` para teste); `PanelSocketProvider` + `usePanelSocket()`; `useEvent(name, handler)` (unsubscribe no cleanup).

- [ ] **Step 1: Testes falhadores** (`socket.test.ts` com um emitter falso `{ on, emit, off }` injectado):
  - `subscricao recebe o payload do evento` — emit `message.created` com payload → handler chamado com ele.
  - `unsubscribe deixa de receber` — após `off`, emit não chama handler.
  - `useEvent renova a subscricao no cleanup` — unmount → `off` chamado.
- [ ] **Step 2: Correr e ver falhar** — `npx vitest run src/lib/socket.test.ts` → FAIL. Instalar `socket.io-client` (`npm i socket.io-client`, justificado: protocolo do backend).
- [ ] **Step 3: Implementar** — `io()` same-origin com cookie (default `withCredentials` same-origin ✓); liga só quando chamado (o Provider liga em `authed` — Task 5).
- [ ] **Step 4: Gates + commit** — verdes; `git commit -m "feat(frontend): add panel socket client and event hook"`.

### Task 4 — Tokens, fontes e primitivas de UI

**Files:**
- Modify: `tailwind.config.ts`, `src/globals.css`, `src/main.tsx` (import de fontes)
- Create: `src/components/ui/{Button,Card,Field,Badge,Spinner,EmptyState,Modal,Toast}.tsx` + `src/components/ui/ui.test.tsx`
- Deps: `@fontsource/outfit`, `@fontsource/ibm-plex-sans`

**Interfaces:**
- Produces: `Button({variant:'solid'|'outline'|'ghost', ...buttonProps})`; `Card`, `Spinner`, `EmptyState({title, description, children?})`; `Field({label, error?, ...inputProps})` (erro com `aria-invalid` + texto); `Badge({tone:'success'|'info'|'warning'|'danger'|'neutral', icon, children})` — **texto sempre presente**; `Modal({open, title, onClose, children})`; `ToastProvider` + `toast.show(message)`/`toast.error(message)` + `Toaster` render.

- [ ] **Step 1: Testes falhadores** (`ui.test.tsx`): Button sólido tem estilo primary e `type="button"` por omissão; Field mostra o `error` com `aria-invalid="true"`; Badge renderiza texto + ícone (nunca só cor); Toast mostra mensagem e some no dismiss.
- [ ] **Step 2: Correr e ver falhar** → FAIL.
- [ ] **Step 3: Implementar** — `tailwind.config.ts`: substituir paleta por hex fixos do Global Constraints; `borderRadius: { DEFAULT:'0', ... }`; fontFamily `sans:['Outfit',...]`, `display:['IBM Plex Sans','Outfit',...]`. `globals.css`: variáveis dark (`--background:#0a0a0c`...), `body{background:#0a0a0c;color:#f2f2f3;font-family:Outfit}`, `border-radius:0` global. `main.tsx`: imports `@fontsource/outfit/400.css`, `/500.css`, `@fontsource/ibm-plex-sans/300.css`, `/400.css`.
- [ ] **Step 4: Gates + commit** — verdes; `git commit -m "feat(frontend): add dark design tokens and ui primitives"`.

### Task 5 — Shell, rotas e guardas

**Files:**
- Create: `src/components/AppShell.tsx`, `src/components/Sidebar.tsx` (novo), `src/components/TopBar.tsx` (substitui o Header antigo), `src/components/guards.tsx`, `src/components/guards.test.tsx`
- Modify: `src/main.tsx` (providers + rotas); Delete: `src/pages/register.tsx`, `src/components/Header.tsx`

**Interfaces:**
- Consumes: `SessionProvider`, `useSession` (Task 2), `PanelSocketProvider` (Task 3), primitivas (Task 4).
- Produces: rotas `/login` (LoginPage, sem shell) e dentro de `RequireAuth`: `/` DashboardPage, `/accounts`, `/conversations`, `/conversations/:id`, `/users` (+`RequireAdmin`), `/campaigns`; `RequireAuth` (redirect `/login` quando `anon`; spinner em `loading`); `RequireAdmin` (redirect `/` se papel ≠ admin); Sidebar com os itens + Badge do papel.

- [ ] **Step 1: Testes falhadores** (`guards.test.tsx`, mock de `useSession` com `vi.mock`): RequireAuth renderiza children em `authed`; redireciona para `/login` em `anon`; RequireAdmin redireciona `/users`→`/` para papel `agent`.
- [ ] **Step 2: Correr e ver falhar** → FAIL.
- [ ] **Step 3: Implementar** — `main.tsx`: `ToastProvider > SessionProvider > PanelSocketProvider > BrowserRouter`; páginas placeholder "a seguir" para as ainda não construídas (só se o typecheck exigir — cada página nova substitui na sua task). `PanelSocketProvider` liga o socket apenas quando `status==='authed'` e desconecta no `anon`.
- [ ] **Step 4: Gates + commit** → verdes; `git commit -m "feat(frontend): add app shell, routes and role guards"`.
- [ ] **Step 5: Verificação browser (hook)** — `agent-browser open http://localhost:3000/` → redireciona para `/login`; consola sem erros de JS.

### Task 6 — Página de Login com TOTP

**Files:**
- Create: `src/pages/login.tsx` (reescrever), `src/pages/login.test.tsx`; Deps: `qrcode.react`

**Interfaces:**
- Consumes: `useSession` (Task 2), `Button/Field` (Task 4).
- Produces: `LoginPage` — estados: `anon` (email+palavra-passe → "Entrar"), `mfa_setup` (QR `<QRCodeSVG value={otpauthUrl}/>` + campo código 6 dígitos → "Confirmar"), `mfa_required` (só campo código), erro visível (`invalid_credentials` → "Email ou palavra-passe incorrectos").

- [ ] **Step 1: Testes falhadores** (`login.test.tsx`, mock de `useSession`): mostra email/palavra-passe; submete `login`; em `mfa_setup` mostra QR (svg) e campo de código; chama `verifyTotp('123456')` no submit; erro do contexto aparece na página.
- [ ] **Step 2: Correr e ver falhar** → FAIL.
- [ ] **Step 3: Implementar** — layout centrado, superfície `#121215`, título display IBM Plex Sans 300 ("Painel MilVendas"), labels PT-AO.
- [ ] **Step 4: Gates + commit** → verdes; `git commit -m "feat(frontend): add login page with totp step"`.
- [ ] **Step 5: Verificação browser (hook)** — login real com o admin de validação (credenciais no ficheiro local de segredos, nunca no ecrã nem no repo), TOTP calculado como no `fase1-rebuild.sh`; entra no shell; screenshot.

### Task 7 — Página de Contas (lista, QR, criar, logout)

**Files:**
- Create: `src/pages/accounts.tsx`, `src/pages/accounts.test.tsx`
- Delete sem uso ao final: `src/components/AccountCard.tsx` (substituído pela UI da página)

**Interfaces:**
- Consumes: `api` (`GET/POST /v1/whatsapp-accounts`, `GET :id`, `POST :id/logout`), `useEvent('account.status')`, `QRCodeSVG`.
- Produces: `accountStatusLabel(status)`, `accountTone(status)`, `useAccountQr(id, status): {qr: string|null}` (poll `GET /v1/whatsapp-accounts/:id` de **4s enquanto `status==='connecting'`**, pára em qualquer outro estado; socket `account.status` força refetch imediato).

- [ ] **Step 1: Testes falhadores**: `accountStatusLabel` cobre os4 estados; `poll do QR pára quando a conta liga` (fake timers:2 polls em `connecting`,0 chamadas após mudar para `connected`); formulário criar conta envia `{label, purpose}` e o select tem os3 rótulos PT.
- [ ] **Step 2: Correr e ver falhar** → FAIL.
- [ ] **Step 3: Implementar** — lista com Badge de estado + telefone; detalhe com QR (`QRCodeSVG value={qr}`, renova por poll) enquanto "A ligar"; botão "Desligar conta" com confirmação (`Modal`); criar conta → abre detalhe; erros `provider_unavailable` → toast.
- [ ] **Step 4: Gates + commit** → verdes; `git commit -m "feat(frontend): add whatsapp accounts page with qr flow"`.
- [ ] **Step 5: Verificação browser (hook)** — a conta de validação (`5bqrhv`, "A ligar") aparece com QR visível; screenshot.

### Task 8 — Conversas: fila (lista + paginação)

**Files:**
- Create: `src/pages/conversations.tsx`, `src/pages/conversations.test.tsx`
- Delete sem uso: `src/components/ConversationsQueue.tsx`, `src/components/RhythmWarning.tsx` (lógica absorvida pela fila)

**Interfaces:**
- Consumes: `api.get('/v1/conversations', {cursor,limit})` → `Page<ConversationView>`; `aiModeLabel(mode)`.
- Produces: `useConversations(): {items, loadMore, loading}` (cursor: anexa páginas; ordenação por `lastMessageAt` desc do backend); rota `/conversations` (fila) e `/conversations/:id` (mesmo ficheiro, thread na Task 9).

- [ ] **Step 1: Testes falhadores**: `aiModeLabel` (3 rótulos PT); `loadMore anexa a segunda pagina` (mock de api com2 páginas →2 itens... itera até6); fila mostra telefone e hora relativa (`Intl` pt-AO).
- [ ] **Step 2: Correr e ver falhar** → FAIL.
- [ ] **Step 3: Implementar** — coluna escura com divisórias, linha activa destacada (azul/10), vazio "Sem conversas ainda".
- [ ] **Step 4: Gates + commit** → verdes; `git commit -m "feat(frontend): add conversations queue with cursor pagination"`.

### Task 9 — Thread de mensagens + eventos realtime

**Files:**
- Modify: `src/pages/conversations.tsx`, `src/pages/conversations.test.tsx`

**Interfaces:**
- Consumes: `api.get('/v1/conversations/:id/messages')` → `Page<MessageView>`; `useEvent('message.created'|'message.status'|'handoff.created'|'handoff.updated')`.
- Produces: `applyThreadEvent(thread, event): thread` (puro: anexa `message.created` **se** `conversationId` igual, actualiza status em `message.status` por `messageId`); `messageStatusLabel(status)`; banner de handoff (prioridade + razão) quando chega `handoff.*` da conversa aberta.

- [ ] **Step 1: Testes falhadores**: `messageStatusLabel` (5 rótulos PT); `applyThreadEvent anexa only se conversationId igual`; `applyThreadEvent actualiza status por messageId`; "carregar mais antigos" prepend (página nova com cursor vai **antes**).
- [ ] **Step 2: Correr e ver falhar** → FAIL.
- [ ] **Step 3: Implementar** — bolhas: inbound à esquerda (superfície), outbound à direita (azul/10 + estado em texto); datas relativas; scroll preso ao fundo em mensagem nova.
- [ ] **Step 4: Gates + commit** → verdes; `git commit -m "feat(frontend): add message thread with realtime updates"`.

### Task 10 — Composer: envio real com Idempotency-Key e retry

**Files:**
- Modify: `src/pages/conversations.tsx`, `src/pages/composer.test.tsx` (teste do controller), componente `Composer` no ficheiro da página

**Interfaces:**
- Consumes: `api.post('/v1/conversations/:id/messages', {text}, {idempotencyKey})` → `{message, replayed}` ou 409 `{title:'idempotency_conflict'}`.
- Produces: `createComposer()` lógica pura testável: `key` gerada **uma vez** por mensagem lógica (`crypto.randomUUID()`); estado optimista `queued`; sucesso/replayed → reconcilia com `message`; falha de rede/5xx → `failed` + ação `retry` que **reutiliza a mesma chave**; 409 → `conflict` (sem reenvio).

- [ ] **Step 1: Testes falhadores** (`composer.test.tsx`):
  - `envia com Idempotency-Key nova` — assert header igual ao `key` devolvido.
  - `retry reutiliza a mesma Idempotency-Key` — falha → retry → mesmo header.
  - `sucesso reconcilia a bolha optimista` — estado final igual ao `message` do servidor.
  - `409 mostra conflito sem reenviar` — `conflict` chamado, fetch do envio chamado1x.
- [ ] **Step 2: Correr e ver falhar** → FAIL.
- [ ] **Step 3: Implementar** — textarea (Enter envia, Shift+Enter quebra linha), botão "Enviar"; estado `Falhou` com botão "Repetir"; vazio não envia; toast no conflito.
- [ ] **Step 4: Gates + commit** → verdes; `git commit -m "feat(frontend): add message composer with idempotent retry"`.
- [ ] **Step 5: Verificação browser parcial (hook)** — thread visível com o QR da conta ligada; sem envio ainda (falta o "oi" inbound — fechado na Task 13).

### Task 11 — Utilizadores (CRUD admin)

**Files:**
- Create: `src/pages/users.tsx`, `src/pages/users.test.tsx`; Delete: `src/pages/register.tsx` já removido na Task 5 — confirmar ausência.

**Interfaces:**
- Consumes: `api.get('/v1/users')` → `{users:[{id,name,email,role,active}]}`, `api.post('/v1/users',{name,email,role,password})`, `api.patch('/v1/users/:id',{role?,active?,password?,name?})`.
- Produces: `roleLabel(role)`; tabela com acções desactivadas **na linha do próprio utilizador** (o backend recusa `cannot_modify_self`); modal de criação (nome, email, papel, palavra-passe com dica da política); erro `last_admin` → toast.

- [ ] **Step 1: Testes falhadores**: `roleLabel` (3 rótulos); criação envia payload exacto `{name,email,role,password}`; linha do próprio (`user.id === session.user.id`) sem botões de papel/estado; patch envia `{role:'agent'}`.
- [ ] **Step 2: Correr e ver falhar** → FAIL.
- [ ] **Step 3: Implementar** — só acessível com `RequireAdmin` (já na rota).
- [ ] **Step 4: Gates + commit** → verdes; `git commit -m "feat(frontend): add admin users management page"`.
- [ ] **Step 5: Verificação browser (hook)** — lista os utilizadores reais; criação validada (pode criar e apagar/deactivar um utilizador de teste `tmp@milvendas.local` — deixar inactivo... não apagar (não há DELETE): **criar, verificar, deixar marcado como inactivo** e mencionar no relatório).

### Task 12 — Dashboard com métricas derivadas

**Files:**
- Create: `src/pages/dashboard.tsx`, `src/pages/dashboard.test.tsx`; Delete sem uso: `src/components/{TopCards,DashboardHeader}.tsx` (absorvidos)
- Modify: `src/main.tsx` (rota `/` → DashboardPage, remover `pages/index.tsx`)

**Interfaces:**
- Consumes: `api.get('/v1/whatsapp-accounts')`, `api.get('/v1/conversations?limit=50')`, `useEvent('account.status')` (refetch).
- Produces: `deriveMetrics(accounts, conversations): {porEstado: Record<AccountStatus, number>, totalConversas: number, ultimas: ConversationView[]}` (puro, testado).

- [ ] **Step 1: Testes falhadores**: `deriveMetrics` cobre contagem por estado e "últimas5" ordenadas por `lastMessageAt` desc com nulos no fim.
- [ ] **Step 2: Correr e ver falhar** → FAIL.
- [ ] **Step 3: Implementar** —4 cartões (Contas ligadas/A ligar/Desligadas/Suspeitas), total de conversas, lista "Últimas conversas" clicável para a thread; título display tipo referência.
- [ ] **Step 4: Gates + commit** → verdes; `git commit -m "feat(frontend): add dashboard with derived metrics"`.

### Task 13 — Campanhas placeholder, README, varredura final e verificação completa

**Files:**
- Modify: `src/pages/campaigns.tsx` (reescrever como placeholder), Create: `src/README.md`
- Modify: relatório final (mensagem ao utilizador, não é ficheiro do repo)

**Interfaces:**
- Consumes: `EmptyState`.
- Produces: página Campanhas com "Campanhas — fase seguinte" + controlos visíveis **desactivados e marcados** (sem dados falsos); README com comandos (`npm run dev|lint|typecheck|test|build`, proxy).

- [ ] **Step 1: Implementar placeholder + README + varredura** — apagar todo o componente/ficheiro sem uso (`npm run lint` sem unused warnings; `grep` de imports órfãos); confirmar `register.tsx` inexistente.
- [ ] **Step 2: Gates** — `npm run lint && npm run typecheck && npm test && npm run build` → verdes; commit `feat(frontend): add campaigns placeholder and module readme`.
- [ ] **Step 3: Verificação final browser (hook) + fecho do gate do primeiro envio real**
  Com a stack real (`:3000`/`:3001`/`:3010`): login+TOTP → dashboard → contas (QR visível) → **pedir ao utilizador escanear o QR** (página de contas ou `127.0.0.1:3020`) com o +244957907120 → conta passa a "Ligada" → utilizador envia **"oi"** → conversa aparece na fila → abrir thread → **responder** → mensagem real entregue (estado "Enviada/Entregue" chega por `message.status`) → utilizadores → campanhas → `agent-browser errors`/`console` limpos → screenshots.
- [ ] **Step 4: Relatório** — entregar ao utilizador: o que mudou, gates (output real dos4 comandos), screenshots, fecho do gate do primeiro envio real (ids, timestamps, estados) e notas de auditoria (o que a validação apanhou).

---

## Auto-revisão (writing-plans)

1. **Cobertura do desenho:** arquitetura/api (T1), auth+TOTP (T2), socket (T3), design system (T4), shell/rotas (T5), login (T6), contas+QR (T7), fila (T8), thread (T9), composer (T10), utilizadores (T11), dashboard (T12), campanhas+verificação (T13). Proxy e tsconfig dentro de T1 (setup dobrado no primeiro consumidor). ✓
2. **Passos:** cada passo é uma acção verificável; corpos de código só quando a assinatura/teste não os determinam (ex.: lógica de poll e composer ficam pelas assinaturas+testes). ✓
3. **Consistência de tipos:** `AccountRow`, `ConversationView`, `MessageView`, `SessionUser`, `PanelEventName` usados igual em todas as tarefas; payloads dos eventos copiados do `notifySink` real (`outbox.ts:98`, `message-status.ts:43`, `orchestrator.ts:306`, `account-lifecycle.ts`). ✓
4. **Review Focus:**5 inputs mapeados a tarefa+teste. ✓
5. **Proporção:** blocos de código mínimos; decisões (valores, rótulos, contratos) pinadas, implementação por omissão. ✓
