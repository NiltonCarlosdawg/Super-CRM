# Desenho — Frontend completo (CRM interno), estilo veranolabs.pages.dev

Data: 2026-10-16 · Estado: desenho aprovado pelo utilizador (brainstorming, 5 secções)
Backend alvo: Fase 1 concluída (`main`, `b014b49`) — APIs `/v1/*` + Socket.IO a correr em `:3001`.

## 1. Pedido e âmbito

Completar `packages/frontend` (hoje: esqueleto Vite+React+Tailwind,5 páginas finas,
`src/lib` vazio, **0 chamadas de rede**, `typecheck` a falhar,0 testes), usando o **estilo
visual de https://veranolabs.pages.dev/** como referência.

Decisões do utilizador (question tool):

| Pergunta | Decisão |
|---|---|
| Âmbito | Tudo o que o backend suporta; campanhas como placeholder estilizado |
| Página register | Substituída por **gestão de utilizadores admin** (`/v1/users`) |
| Tema | **Só dark** (como a referência; sem modo claro) |
| Abordagem | **A — camada de API + fatos verticais** (mantém Vite; sem SSR; sem mocks) |

Fora de âmbito: modo claro, SSR/migração de framework, mocks/MSW, endpoints novos no
backend, páginas de IA/handoffs próprias (só avisos no fio), app mobile-first,
qualquer alteração ao backend.

## 2. Arquitetura e camada de API

- **Stack mantida:** Vite + React 18 + React Router 6 + Tailwind (já em `packages/frontend`).
- **Dependência nova, justificada:** `socket.io-client` — o backend fala Socket.IO
  (`src/adapters/realtime/socket.ts`, docs/01 D8), autenticado por cookie de sessão.
- **Proxy dev** (em `vite.config.ts`, hoje sem proxy):
  - `/v1` → `http://localhost:3001`
  - `/socket.io` → `http://localhost:3001` com `ws: true`
  - Resultado: same-origin no browser → cookies + CSRF sem CORS. Produção: `dist`
    servido no mesmo host do backend (ou proxy equivalente).
- **`src/lib/`** (hoje vazio):
  - `api.ts` — único ponto de rede: `api.get/post/patch/delete`, envio do header CSRF a
    partir do cookie, mapeamento de `application/problem+json` → erro tipado
    `{ title, status, detail }`, timeout. Proibido `fetch` solto no resto do código.
  - `types.ts` — modelos escritos à mão conforme as respostas reais: `User`+`Role`,
    `WhatsappAccount`, `Conversation`, `Message`, `Page<T>` (cursor). Sem codegen.
  - `auth.tsx` — `SessionProvider`: arranque com `GET /v1/auth/me`; `login()` trata o
    desvio de TOTP (`mfa_setup_required` → QR otpauth + código → `POST /v1/auth/totp/verify`
    → re-login); `logout()`; `user` + `hasRole()` para guardas e menus.
  - `socket.ts` — ligação via proxy (cookie, sem token), mapa dos5 eventos, helper
    `useEvent(nome, handler)` com unsubscribe.
- Convenções: estados loading/erro/vazio em toda a vista; copy PT-AO; ao utilizador só
  `title`+`detail` do problem+json; no console só códigos de erro (docs/03).

## 3. Design system (tokens extraídos da referência)

Medidos no site real (`getComputedStyle`), não inferidos:

| Token | Valor |
|---|---|
| Fundo | `#0a0a0c` |
| Superfície | `#121215` |
| Borda | `#26262b` / `#393939`, 1px — **sem sombras** |
| Texto | `#f2f2f3` / secundário `#c6c6c6` |
| Acento | azul `#3b6ef6` (+hover, `/10` soft) |
| Semânticos | verde conectado · âmbar a ligar · azul qr_pending · vermelho erro/ban — **sempre com texto/ícone, nunca só cor** |
| Raio | **0px** em tudo |
| Tipografia | `Outfit` (corpo) + `IBM Plex Sans` peso **300** (display; `clamp(2.5rem→4.5rem)`, line-height1.1); eyebrow 12px maiúsculas tracking largo azul |

- Fontes via `@fontsource/outfit` e `@fontsource/ibm-plex-sans` (self-hosted, npm) —
  visual igual à referência **sem chamadas a CDNs de terceiros**.
- Primitivas em `src/components/ui/`: Button (sólido/contornado/fantasma), Input+Field
  com erro, Card, Table, Badge, Modal, EmptyState, Toast, Skeleton.
- Os9 componentes existentes (`Sidebar`, `Header`, `DashboardHeader`, `TopCards`,
  `AccountCard`, `CampaignCard`, `ConversationsQueue`, `RhythmWarning`, `Badge`) são
  re-estilizados com os tokens dentro do novo shell — sem UI órfã.

## 4. Páginas e navegação

Shell autenticado: Sidebar (Dashboard · Contas · Conversas · Campanhas · Utilizadores
\[só admin\]) + Header (utilizador/papel, sair). Desktop-first; colapsa em ecrã estreito.

| Rota | Conteúdo | APIs |
|---|---|---|
| `/login` | email+password → etapa TOTP (setup: QR otpauth + código; verify → re-login) | `auth/login`, `totp/setup`, `totp/verify`, `auth/me` |
| `/` | métricas derivadas: contas por estado, total de conversas, últimas conversas (preview/hora), contadores vivos | `whatsapp-accounts`, `conversations` |
| `/accounts` | lista + estados; detalhe com **QR real** (a conta de validação `5bqrhv` aparece aqui); criar conta → QR → transições por `account.status` com fallback de refetch; logout de conta | `whatsapp-accounts`, `:id`, `:id/logout` |
| `/conversations` | fila (cursor50) + thread; composer com Idempotency-Key; realtime; aviso de handoff no fio | `conversations`, `:id/messages` |
| `/users` | tabela, criar utilizador, mudar papel/estado — só admin no UI (o backend decide a sério) | `users`, `users/:id` |
| `/campaigns` | placeholder honesto: EmptyState "Campanhas — fase seguinte", controlos visíveis desactivados e marcados, **sem dados falsos** | — |

Guardas: sem sessão → `/login`; `/users` admin only; resto para qualquer papel
autenticado. Subscrever eventos `handoff.*` para avisos.

## 5. Realtime e dados

- Socket autenticado pelo **cookie de sessão** (mesmo origin via proxy); liga após `me`;
  reconexão automática do cliente.
- Estado explícito por página + invalidação por evento (sem TanStack Query):

  | Evento | Reacção |
  |---|---|
  | `message.created` | anexa à thread visível + actualiza preview/ordem da fila |
  | `message.status` | actualiza bolha (sending → sent/delivered/failed) |
  | `account.status` | refresh da conta; esconde QR em `connected` |
  | `handoff.created/updated` | aviso no fio + realce na fila |

- Fallbacks: refetch em `reconnect`/`visibilitychange`; **polling de4s só enquanto a
  conta estiver `connecting`/`qr_pending`** (renovar QR), pára em `connected`.
- Composer: bolha optimista `sending`; `201` ou `200 replayed` reconcilia; erro →
  `failed` + toast + Retry **com a MESMA Idempotency-Key** (`crypto.randomUUID()` por
  mensagem lógica) — o backend nunca duplica.
- Paginação por cursor (fila e "carregar mais antigos" no fio). Datas com `Intl` pt-AO.
- Docs/03 no frontend: nunca `console.log` de corpos de mensagens ou telefones.

## 6. Qualidade e verificação

- Corrigir `tsconfig.json:26` (`ignoreDeprecations: "6.0"` → TS5103) e `strict` em
  paridade com o backend.
- Testes vitest com lógica de decisão primeiro: `api` (CSRF, problem+json, replay),
  máquina de estados login+TOTP, mapeamento de eventos do socket, retry/Idempotency-Key,
  smoke das primitivas. Dev-deps novas justificadas: `@testing-library/react`, `jsdom`.
- Gates por commit: `lint`, `typecheck`, `test`, `build` verdes.
- Verificação obrigatória no browser (hook global) com `agent-browser` contra a stack
  real: login+TOTP real, QR nas Contas, envio real em Conversas, Utilizadores,
  Campanhas placeholder, consola limpa, screenshots no relatório.
- Commits convencionais pequenos; sem segredos; relatório com evidência.

## 7. Critérios de aceitação

1. `npm run lint && npm run typecheck && npm test && npm run build` verdes em
   `packages/frontend`.
2. Login completo (com TOTP) e sessão persistente por cookie contra `:3001`.
3. QR visível e renovado no `/accounts`; estado acompanha `connected` via socket.
4. Mensagem enviada de `/conversations` chega ao WhatsApp (fecha a validação do primeiro
   envio real) e os estados de entrega actualizam em tempo real.
5. `/users` cria e altera utilizadores (admin); `/campaigns` mostra o placeholder.
6. Consola do browser sem erros; verificação com screenshots registada.

## 8. Riscos e pontos a confirmar na implementação

- Formatos exactos (confirmar no código do backend, nunca inventar): corpo de
  `mfa_setup_required`, campos de `POST/PATCH /v1/users`, nomes do cookie/header CSRF,
  enum de estados das mensagens, payload dos5 eventos Socket.IO.
- Cookies em dev via proxy: se o backend marcar `Secure`, testar em `localhost` (pode
  exigir flag condicional por host — decisão só com ADR se necessário).
- A suíte de integração do backend apaga contentores (trap `down -v`) — não correr
  `test:integration` do backend durante o trabalho sem `KEEP_CONTAINERS=1`.
- Validação pendente (gate do primeiro envio real): fecha-se **dentro** desta tarefa,
  pela página de Conversas (passos: scan do QR + "oi" do +244957907120).
