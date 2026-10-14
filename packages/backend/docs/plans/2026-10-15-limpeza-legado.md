# Plano — Limpeza do legado e reparação do package.json (2026-10-15)

Aprovado pelo utilizador ("avance"). Âmbito: só limpeza/reparação; sem Fase 1.

## O que se encontrou (evidência no PR)

1. Commit `cea61d0` ("restore src/") corrompeu `src/application/orchestrator.ts`:
   substituiu o orquestrador real (337 linhas, `handleInbound`) por um stub de 83
   linhas. `tests/unit/orchestrator.test.ts` falha com `handleInbound is not a function`.
   A versão boa existe em `a4e7720:src/application/orchestrator.ts` (reference +
   só mudanças de imports).
2. Legado Prisma/Express/Next/Vitest fechado em `src/` (22 ficheiros importam
   `lib/prisma`; `src/app/api` usa Next; `src/gateway` usa Express não instalado;
   `src/test/__unit__/cache.test.ts` usa Vitest não instalado).
3. Dois ficheiros corrompidos com erros de sintaxe (43 erros `tsc`):
   `src/middleware/docs-middleware.ts`, `src/whatsapp/advanced.ts`.
4. `package.json` do backend é uma cópia do root (turbo/workspaces), inconsistente
   com o `package-lock.json` (deps reais). `@prisma/client` e `@types/express`
   são resíduos do legado.

## Passos

1. Restaurar `packages/backend/src/application/orchestrator.ts` de `a4e7720`
   (restauração byte-a-byte do conteúdo; só o orquestrador, nada mais).
2. Apagar o cluster legado fechado em `packages/backend/src/` (prisma/express/next/
   vitest + ficheiros corrompidos + `orchestrator.new.ts` + `src/test/`).
   Nada do vivo (infra, ports, adapters/db+queue, domain, application, modules/
   knowledge, tests, scripts) importa o legado — verificado por grep de imports.
3. Reescrever `packages/backend/package.json`: scripts reais (ADR-0005 + secção
   "Comandos" do AGENTS.md) e deps do lockfile sem `@prisma/client`/`@types/express`.
4. Regenerar o lockfile (`npm install`), removendo os resíduos.
5. Prova: `typecheck` 43 → 0 erros; `lint` limpo; `test` (unitários, incluindo os 17
   do orquestrador restaurado); `test:integration` com contentores se houver Docker.
6. Commits convencionais separados: `fix:` orquestrador, `chore:` legado,
   `fix:` package.json/lockfile.

## Fora de âmbito (reportar, não fazer)

- Árvore duplicada na raiz do repo (`/src`, `/tests`, `/reference`) — decisão do
  dono; reportar.
- Fase 1 (Fastify, auth, webhooks) — gate aprovação humana.
