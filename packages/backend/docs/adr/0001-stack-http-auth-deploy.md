# ADR 0001 — Stack HTTP, autenticação e topologia de deploy

- Estado: aceite
- Data: 2026-10-07
- Autor: agente (aprovado pelo dono do produto)
- Decide: A1, A2, A5 de `docs/01` (detalhe em `docs/06`)

## Contexto

Escolher framework HTTP, autenticação do painel e onde corre tudo, dentro das restrições:
BullMQ + Socket.IO (D6/D7/D8), OpenAPI do código, raw body para webhook, e a restrição
de infraestrutura do dono: **cPanel partilhado sem Docker**. WA-AKG nunca público.

## Opções

1. **Node LTS + Fastify, sessões server-side, 2 apps Node no cPanel** — tudo maduro e
   testado; exige verificar capacidades reais do host (pgvector, Redis, websockets, RAM).
2. Bun + Elysia — rápido, mas histórico de problemas com BullMQ e ecosystem menor.
3. VPS + Docker Compose — topologia ideal, mas **fora da restrição escolhida** (cPanel).

## Decisão

Opção 1. Com planos B explícitos: sem `pgvector` → FTS atrás de `searchChunks()`;
sem Redis → `pg-boss` atrás do port de jobs. Verificações com evidência na Fase 0.

## Consequências

- Se o host não tiver um dos ingredientes, muda só o adaptador — ports intactos.
- Sem rede privada entre contentores: WA-AKG isolado por bind em `127.0.0.1` + ausência
  de porta pública (frágil em partilhado → verificado na auditoria/Fase 0).
- Só um servidor: ponto único de falha aceite para uso interno.
- Desfaz-se migrando o compose para uma VPS; os ports não mudam.
