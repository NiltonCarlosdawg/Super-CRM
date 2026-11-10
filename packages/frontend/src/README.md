# MilVendas CRM — frontend

Painel interno (tema escuro, UI em PT-AO) para o CRM WhatsApp da MilVendas.
Todo o acesso aos dados passa pelo backend em `packages/backend` — este módulo
não tem lógica de negócio nem acesso directo à base de dados.

## Comandos (correr a partir de `packages/frontend`)

| Comando             | O que faz                                            |
| ------------------- | ---------------------------------------------------- |
| `npm run dev`       | Servidor de desenvolvimento (Vite, porta **3000**)   |
| `npm run lint`      | ESLint (`.js`, `.jsx`, `.ts`, `.tsx`)                |
| `npm run typecheck` | `tsc --noEmit`                                       |
| `npm test`          | Testes (Vitest + Testing Library, jsdom)             |
| `npm run build`     | Build de produção em `dist/`                         |
| `npm start`         | Pré-visualização do build (`vite preview`)           |

## Proxy (mesma origem, sem CORS)

O dev server do Vite encaminha para o backend (`vite.config.ts`):

- `/v1` → `http://localhost:3001` (REST)
- `/socket.io` → `http://localhost:3001` (WebSocket, `ws: true`)

Cookies de sessão e CSRF funcionam por isso ser mesma origem — o frontend
nunca guarda tokens em `localStorage`.

## Estrutura

```
src/
  main.tsx            # rotas + providers (Session, Toast, Socket no AppShell)
  lib/                # api.ts (cliente único), auth.tsx, socket.tsx, labels.ts, campaigns.ts,
                      # knowledge.ts, time.ts, types.ts
  components/
    ui/               # primitivas: Button, Field, Badge, Modal, Spinner, Toast, EmptyState, Card, TotpSetup
    AppShell, Sidebar, TopBar, guards (RequireAuth/Admin/Role/Platform)
  pages/              # login, register, dashboard, accounts, conversations (+ thread/composer/rascunhos),
                      # handoffs, campaigns, knowledge (treino/publicado/lacunas/configuração/teste),
                      # users, settings, platform
```

Notas:

- **Sessão** por cookie httpOnly (arranque: `GET /v1/auth/me` → `anon`/`mfa_required`/`authed`).
  O `/me` devolve `scope: 'tenant' | 'platform'`: um `platform_admin` vê apenas
  `/platform` na sidebar; as rotas `/v1/platform/*` nunca são chamadas com
  sessão de tenant (o servidor recusa, o cliente também).
- **Registo público** (`/register`, Onda 1 multitenancy): cria tenant + admin e
  segue o mesmo fluxo TOTP do login (`mfa:'setup'` → `otpauthUrl` → verify).
- **Definições** (`/settings`, Onda 1): mudança da password própria e ativação
  de TOTP (`POST /v1/auth/totp/setup` → `verify`; o backend recusa com 409 se o
  TOTP já estiver ativo — sem desativação em v1, nota honesta no UI).
- **Tempo real**: eventos `account.status`, `message.created`, `message.status`,
  `handoff.created`, `handoff.updated` (Socket.IO autenticado por cookie).
- **Permissões**: `/accounts` e `/campaigns` são `RequireAdmin`; `/handoffs` é
  `RequireRole(['agent','admin'])` (igual ao RBAC do servidor); `/knowledge` é
  `RequireRole(['editor','admin'])`. A sidebar esconde os itens sem papel.
  A sidebar esconde o que o papel não pode usar — a autoridade continua a ser o backend.
- **Conversas**: além da thread e do composer, mostra rascunhos pendentes da IA
  (aprovar/rejeitar com motivo) e “Devolver à IA” quando `aiMode === 'human_only'`.
- **Campanhas** (Fase 4): lista paginada, criação com contas `purpose=campaigns`,
  detalhe com contagens e iniciar/agendar, pausar e retomar (admin).
- **Handoffs** (Fase 3): fila por prioridade, aceitar (409 recarrega), resolver e
  abrir a conversa; recarrega por Socket.IO.
- **Conhecimento** (Fases 2–4): cinco separadores — Treino (documentos texto/markdown,
  passo-a-passo, rascunho, diff, publicação atómica), Publicado (edição rápida,
  publicações/reverter, revisões, reembed), Lacunas (resolver/ignorar, sugestões),
  Configuração (perguntas e gatilhos versionados + revisões) e Teste (chat real
  contra rascunho ou publicado).
- **Vocabulário PT-AO** vive em `lib/labels.ts` (conhecimento em `lib/knowledge.ts`)
  — acrescentar rótulos novos aí, com teste.
- **Campanhas reais** substituíram o placeholder antigo; os restos da landing
  antiga (dados falsos) foram removidos na Task 13.

