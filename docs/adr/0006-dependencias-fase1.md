# ADR 0006 — Dependências novas da Fase 1

- Estado: proposto (revisão por `docs/02` §12; aprovação humana antes de merge se exigida)
- Data: 2026-10-15
- Autor: agente (regra 5 do `AGENTS.md`: toda a dependência nova tem justificação escrita)
- Decide: dependências que a Fase 1 adiciona ao `package.json` do backend

## Contexto

A Fase 1 (núcleo WhatsApp) precisa de hashing de palavras-passe (Task 6), validação e
framework HTTP (Task 9, Fastify já decidido em ADR-0001) e eventos em tempo real (Task 15,
Socket.IO decidido em D8 de `docs/01`/`docs/06`). Tudo MIT, versões fixadas no lockfile,
`npm audit` obrigatório (`docs/02` §12, `docs/03` §2).

## Dependências

| Dependência | Tarefa | Justificação | Licença |
|---|---|---|---|
| `argon2` | Task 6 | argon2id conforme `docs/03` ( OWASP: m=19456 KiB, t=2, p=1 ); binding oficial | MIT |
| `zod` (v4, já instalada) | Task 9 | validação de entrada na fronteira (`docs/02` §3) | MIT |
| `@fastify/cookie` | Task 9 | cookies HttpOnly de sessão + CSRF double-submit (A2) | MIT |
| `@fastify/rate-limit` | Task 9 | rate limiting por IP (`HTTP_RATE_*` da Task 4) | MIT |
| `@fastify/swagger` | Task 9 | OpenAPI a partir do código (`docs/02` §8, `openapi.yaml`) | MIT |
| `socket.io` | Task 15 | eventos em tempo real ao painel (D8) | MIT |
| `socket.io-client` (dev) | Task 15 | testes de integração do Socket.IO | MIT |

## Não-dependências (decisões explícitas)

- **TOTP (Task 8): sem dependência** — `node:crypto` puro, RFC 6238.
- **Fastify**: decidido em ADR-0001 (A1); esta ADR só cobre os plugins.
- **Socket.IO**: decidido em D8 (Fase 0); `ws` (dev) já existente mantém-se para o eco de teste.

## Nota de verificação pendente (Task 9)

`zod` v4 expõe `z.toJSONSchema` para gerar o OpenAPI directamente; se não cobrir o caso,
usa-se `zod-to-json-schema`. Verificar com `npm ls zod` na Task 9 e registar a escolha
final nesta ADR.

## Consequências

- `argon2` é módulo nativo (node-gyp): precisa de toolchain de build no host de produção
  (cPanel, A5) — registado como risco de deploy, sem impacto no CI.
- Todas as dependências são MIT e mínimas para o âmbito; nenhuma toca em dados de clientes
  nem fala com serviços externos (nenhuma decisão de privacidade nova — ADR-0002 mantém-se).
