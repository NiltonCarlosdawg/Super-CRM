# ADR-0017 — Migrações em produção aplicadas sem pgvector (coluna `embedding` adiada)

- **Estado:** aplicado em produção (2026-11-12); desvio pendente de confirmação do dono
- **Data:** 2026-11-12
- **Autor:** agente
- **Decide:** como aplicar o schema drizzle num servidor PostgreSQL 13.23 **sem** a extensão `vector`

## Contexto

O login/registo em `api.supercrm.milvendas.ao` devolvia 500: a base `milvendas_supercrm`
nunca existia (migrações nunca aplicadas — Gate de `docs/adr/0016` §Migrations adiadas).
Para desbloquear (pedido do dono, 2026-11-12), foi preciso aplicar as migrações 0000–0017.

O servidor **não tem pgvector**: `pg_available_extensions` devolve só `plpgsql`
(medido em 2026-11-12), não há biblioteca `vector.so` no filesystem, e instalar a
exigiria root — indisponível na conta cPanel.

## Opções

1. **Aplicar tudo, adaptando só os statements que exigem `vector`** — `CREATE EXTENSION`,
   os índices `hnsw` e os `ALTER ... SET DATA TYPE vector(...)` são saltados; a coluna
   `"embedding" vector(...)` sai do `CREATE TABLE knowledge_chunks`.
2. Adiar as migrações até o alojamento instalar pgvector — mantém o login em 500 (inaceitável).
3. Root no servidor para instalar pgvector — sem root; decisão do alojamento.

## Decisão

**Opção 1**, com registo em `drizzle.__drizzle_migrations` (hash original de cada ficheiro,
para o drizzle-kit não os voltar a correr). Script usado ficou no servidor só durante a
execução e foi removido; o comportamento é reproduzível: dividir cada ficheiro por
`--> statement-breakpoint` e saltar/reescrever os statements acima.

## Consequências

- **`knowledge_chunks` existe SEM a coluna `embedding`** e sem índice HNSW — o módulo de
  conhecimento (retrieval por embeddings) **não funciona** em produção até:
  1. o alojamento instalar a extensão `vector` no PostgreSQL 13.23 (ou migrar para PG com
     pgvector disponível), **e**
  2. correr uma migração futura que faça
     `ALTER TABLE knowledge_chunks ADD COLUMN embedding vector(384)` + índice HNSW
     (dimensão 384 = ADR-0002/A4, migração `0011`).
- Login/registo/sessão, contas WhatsApp, conversas, outbox e campanhas **não** usam
  `vector` — ficam todos operacionais (verificado: 34 tabelas, API e UI a funcionar).
- `deploy.sh` continua **sem** correr migrations (mantém-se o gate de `docs/adr/0016`).
- Risco: se alguém correr `drizzle-kit migrate` num sítio com pgvector a partir do zero,
  o schema final terá a coluna; o desvio aplica-se **só** a esta base de produção.

## Evidência

- `pg_available_extensions` → `plpgsql` (1 registo) em `milvendas_supercrm`.
- Migrações aplicadas: `ok: 0000…0017` (18/18, 3 adaptadas por pgvector), 34 tabelas.
- API: `POST /v1/auth/register` 200, `POST /v1/auth/login` 200, `/health/ready` `db:ok`.
