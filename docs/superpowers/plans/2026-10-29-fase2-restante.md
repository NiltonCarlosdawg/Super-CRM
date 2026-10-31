# Implementação restante da Fase 2
Objetivo/arquitectura/stack/spec: cumprir `docs/01` §8 no backend existente, com APIs multi-tenant, migrações Drizzle e adaptadores locais; desenho em `docs/superpowers/specs/2026-10-29-fase2-restante-design.md`.
Restrições/review focus: TDD em cada mudança; `tenant_id` em toda query, validação de entradas, sem dados reais, ADR antes de deps; cobrir fuga cross-tenant, concorrência/stale version, embeddings indisponíveis, chunks obsoletos e uploads grandes/malformados; final: lint, typecheck, unit, integração e `eval:baseline`.
### Task 1: [ ] ADR-0014 + runtime local de embeddings, config/flags e fake determinístico; provar prefixos `query:`/`passage:` e operação sem rede.
### Task 2: [ ] Retrieve publicado pgvector+FTS, backfill, wiring do orquestrador/chat e reconciliação de chunks; provar tenant, publicação, validade e linha.
### Task 3: [ ] Validade/revisão de regras e API de alertas/carimbo; provar vencimento, edição, publicação e revisão manual.
### Task 4: [ ] CRUD de perguntas, unicidade tenant/linha, snapshots/reversão optimista e testes RBAC/isolamento.
### Task 5: [ ] CRUD de gatilhos, unicidade por âmbito, snapshots/reversão, seed não sobrescreve alterações e testes do orquestrador.
### Task 6: [ ] API de lacunas/sugestões; aprovar cria/actualiza rascunho, rejeitar mantém histórico; provar fluxo até publicação e isolamento.
### Task 7: [ ] Por último: ADR-0015 + PDF/OCR local, ingestão assíncrona limitada, bytes apagados, testes com fakes, smoke sintético, docs e relatório.
