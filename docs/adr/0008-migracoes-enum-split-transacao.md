# ADR 0008 — Migrações de enums: ADD VALUE e o seu "uso" em transações separadas

- Estado: proposto (a aguardar revisão humana — registado pela Task 2 da Onda 1)
- Data: 2026-10-16
- Autor: agente (Task 2, onda multitenancy)

## Contexto

A Task 2 da Onda 1 exige o valor `platform_admin` em `user_role` **e** o CHECK
`((role = 'platform_admin') = (tenant_id IS NULL))` em `users`. O PostgreSQL
proíbe **USAR** um valor novo de enum na mesma transação que o
`ALTER TYPE … ADD VALUE` ("unsafe use of new value", verificado em PG16: falha
inclusive em `ADD CONSTRAINT … CHECK` e em `NOT VALID` — a coerção do literal
para o tipo do enum acontece no parse).

O migrator do Drizzle — `drizzle-orm` `migrate()` (usado por
`tests/helpers/db.ts`) **e** `drizzle-kit migrate` (`npm run db:migrate`),
ambos via `PgDialect.migrate` — aplica **todas** as migrações pendentes numa
única transação (`session.transaction`). Logo o split em dois ficheiros/entradas
de journal (exigido pelo brief da Task 2) **por si só não cria** transações
separadas.

## Opções

1. Escrever o CHECK com `role::text = 'platform_admin'` — evade a coerção de
   enum, mas muda o texto da invariante exigida pelo contrato.
2. Aplicar as migrações em duas invocações do migrator (pasta temporária até ao
   enum, depois a pasta completa) — frágil, obriga operadores/scripts a dois
   passos e não funciona "de zero" num só `migrate()`.
3. Ficheiro A (`0005_warm_pyro.sql`) termina em `COMMIT;` explícito: o ADD VALUE
   fica commitado antes de o ficheiro B (`0006_users_platform_tenant_check.sql`,
   `BEGIN;` + CHECK) correr — cada ficheiro mantém a sua atomicidade e o texto
   da invariante é exatamente o do contrato.

## Decisão

Opção 3. O split em `0005_warm_pyro.sql` (enum, fecha a transação) e
`0006_users_platform_tenant_check.sql` (CHECK numa transação própria), com o
journal (`drizzle/meta/_journal.json`, idx 5 e 6, `when` estritamente crescente)
e snapshots encadeados (`0005_snapshot.json` = estado intermédio sem CHECK;
`0006_snapshot.json` = estado final). O `commit` final do migrator sobre uma
transação vazia é só WARNING em PG16 (verificado), nunca erro.

## Consequências

- Toda a migração futura que precise de **usar** um valor novo de enum (default,
  CHECK, insert) tem de separar transações da mesma forma: ADD VALUE isolado com
  `COMMIT` no fim do seu ficheiro; o uso no ficheiro seguinte.
- Se alguém gerar uma migração nova com `drizzle-kit generate` e o diff contiver
  `ALTER TYPE … ADD VALUE` **junto** ao seu uso, tem de voltar a fazer o split à
  mão (o drizzle-kit não o faz).
- Desfazer: reverter os ficheiros 0005/0006 (nunca editados depois de
  aplicados) com uma migração nova que faça o caminho inverso.
- Verificação: `tests/integration/platform-admin.test.ts` aplica as migrações de
  zero numa base vazia e prova o upgrade sobre um estado 0004 com users
  existentes.
