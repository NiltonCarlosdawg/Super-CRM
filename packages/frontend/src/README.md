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
  lib/                # api.ts (cliente único), auth.tsx, socket.tsx, labels.ts, time.ts, types.ts
  components/
    ui/               # primitivas: Button, Field, Badge, Modal, Spinner, Toast, EmptyState, Card
    AppShell, Sidebar, TopBar, guards
  pages/              # login, dashboard, accounts, conversations (+ thread/composer), users, campaigns
```

Notas:

- **Sessão** por cookie httpOnly (arranque: `GET /v1/auth/me` → `anon`/`mfa_required`/`authed`).
- **Tempo real**: eventos `account.status`, `message.created`, `message.status`,
  `handoff.created`, `handoff.updated` (Socket.IO autenticado por cookie).
- **Vocabulário PT-AO** vive em `lib/labels.ts` — acrescentar rótulos novos aí, com teste.
- **Campanhas** é um placeholder honesto (fase seguinte); os restos da landing
  antiga (dados falsos) foram removidos na Task 13.
