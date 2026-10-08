# ADR 0005 — Toolchain de fundação (Node, TypeScript, testes, lint, dependências)

- Estado: aceite
- Data: 2026-10-08
- Autor: agente (decisões de âmbito de toolchain; alinhado com `docs/01` §8 Fase 0)
- Decide: stack de tooling da Fase 0; justifica cada dependência nova (regra 5 do `AGENTS.md`)

## Contexto

A Fase 0 precisa de comandos de arranque (`npm test`, `npm run lint`, `npm run typecheck`)
que correm localmente e em CI, com a estrutura hexagonal de `docs/02` §1 e as restrições
de `docs/01`–`docs/03`: TypeScript estrito, sem segredos, `npm audit` + `gitleaks` em CI
(`docs/02` §12, `docs/03` §2), produção sem Docker (A5) e frameworks escolhidos em A1/A3.

## Opções

1. **Node ≥ 24 LTS + `node:test`/`tsx` + ESLint flat não type-aware** — zero frameworks
   novos, mesmo runner dos testes já existentes em `reference/`; lint rápido e suficiente
   para fronteiras de camadas e estilo. Custo: regras que exigem árvore de tipos ficam de
   fora (o `tsc --noEmit` cobre tipos em CI).
2. **Node 22 LTS** — ainda suportado, mas A1 (`docs/06`) fecha "Node LTS" e a Fase 0 exige
   ≥ 24 com CI em 24; desvantagem: sair do suporte mais cedo.
3. **Vitest/Jest** — DX rica, mas framework novo apesar de `reference/orchestrator.test.ts`
   já usar `node:test` (viola "zero dependências sem justificação", regra 5 do `AGENTS.md`).
4. **ESLint type-aware (`projectService`)** — regras mais poderosas, mas lint multi-segundo
   e config frágil num monorepo em construção; não é preciso para as regras da Fase 0.

## Decisão

Toolchain fixada em `package.json`/`tsconfig.json`/`eslint.config.mjs`, com lockfile
commitado. Justificação de cada dependência:

| Dependência | Papel | Justificação |
|---|---|---|
| `typescript@6.0.3` | `tsc --noEmit` (typecheck obrigatório em CI) | `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax` (plano, Global Constraints). **TypeScript 6.0.3 em vez de 7.x porque `typescript-eslint@8.71.1` exige peer `>=4.8.4 <6.1.0` (escolha registada em 2026-10-08; upgrade para 7.x quando houver suporte).** |
| `tsx` | executar/ testar TS sem build | runner de `npm test` e `npm run dev`; usado hoje por `reference/orchestrator.test.ts` |
| `node:test` + `node:assert/strict` | framework de testes | built-in do Node — `reference/orchestrator.test.ts` já o usa; **zero framework de testes novo** |
| `eslint` + `typescript-eslint` + `@eslint/js` | lint | ESLint flat **não type-aware**: rápido, sem projeto type-aware; impõe a regra de camadas (`no-restricted-imports` em `src/domain/**` e `src/application/**`, `docs/02` §1) e `no-console`/`eqeqeq` |
| `@types/node`, `@types/pg` | tipos | sem eles, `strict` não resolve `node:`/`pg` |
| `drizzle-orm` + `drizzle-kit` | ORM + migrações | migrações versionadas geradas (`docs/01`); nunca `drizzle-kit push` fora de dev local |
| `pg` | driver Postgres | exigido pelo Drizzle e pelos testes de integração com Postgres real |
| `ioredis` (Task 5) | cliente Redis | testes de integração com Redis real em contentor (`tests/integration/redis-ready.test.ts`); **sem opção `{ url }` — a URL entra como argumento posicional, a API documentada (bug do brief corrigido pela ruling 9 do ledger); sem ela ligaria ao Redis/Valkey do sistema em 6379 em vez do contentor em 6380** |
| `zod` | validação nas fronteiras | HTTP, webhooks, jobs, env e saída do LLM (`docs/02` §3) |
| `pino` | logging | JSON estruturado + redaction de dados pessoais (`docs/02` §10) |
| `bullmq` (Task 7) | fila | plano A de jobs atrás do port (D7/A5); plano B `pg-boss` se o Redis falhar na verificação A5 |
| `ws` (Task 2) | sonda de websockets | A5 exige provar websockets no cPanel antes de fechar Socket.IO |
| Docker Compose (`docker-compose.test.yml`) | só testes | A5: produção é cPanel **sem Docker**; conteúdores reais `pgvector/pgvector:pg16` e `redis:7.4-alpine` |
| CI (GitHub Actions) | gates | Node **24** no CI (A1); `npm audit` + `gitleaks` em CI (`docs/02` §12, `docs/03` §2) |

## Consequências

- `reference/` é ignorado pelo lint enquanto lá estiver (código congelado, só muda por
  `git mv` na integração); após o movimento para `src/modules/knowledge/` o override
  `warn` dos 2 ficheiros aplica-se e o lint volta a cobri-los.
- O lint **não** verifica tipos: qualquer regra que precise de tipos espera um ADR
  (mudança para type-aware) — o `npm run typecheck` é o gate de tipos.
- Se `typescript-eslint` passar a suportar TS 7.x, upgrade do `typescript` numa task
  dedicada (com ADR se mudar o comportamento do typecheck).
- `pg-boss` e `ws` só entram se a evidência da A5 os exigir/permitir — o port de jobs
  isola a troca.
- O `package-lock.json` é a fonte de versões exatas; `npm ci` em CI.
- Ao mover os ficheiros de `reference/` para `src/`/`tests/` (Task 6), o typecheck passou a
  cobri-los e expôs 19 erros pré-existentes de `noUncheckedIndexedAccess` que estavam latentes
  porque o `include` do tsconfig nunca alcançou `reference/`; foram corrigidos só com construços
  de tipo (non-null assertions `!`), com zero mudança de runtime — o comportamento fica provado
  pelos 17 testes do orquestrador e pela suite completa (34 testes, `fail 0`) antes e depois,
  conforme a ruling 8 do ledger da Fase 0 (`.superpowers/sdd/2026-10-07-fase0-fundacoes-auditoria/progress.md`).
