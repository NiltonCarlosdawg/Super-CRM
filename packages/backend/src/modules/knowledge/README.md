# Módulo `knowledge` — "Treinar agente"

Conhecimento self-service por tenant: o gerente carrega documentos ou responde ao
passo a passo, corrige o que a IA entendeu, testa e só depois publica. Nada fica
activo antes da validação atómica.

Desenho: `docs/superpowers/specs/2026-10-25-treinar-agente-conhecimento-design.md`.
Plano: `docs/superpowers/plans/2026-10-25-treinar-agente.md`.

## Fluxo

1. **Entrada** — `POST /v1/knowledge/train/documents` (TXT/MD em base64) ou
   `POST /v1/knowledge/train/guided` (perguntas/respostas). Ambos criam um
   `knowledge_train_uploads` com `status='pending'` e enfileiram o job
   `knowledge.extract` com **só** `{ uploadId }`.
2. **Extração** — o job faz CAS `pending → processing`, chama
   `AIProvider.extractKnowledge` e escreve os itens em `knowledge_draft_items`
   (o activo nunca é tocado). Sucesso → upload `done`; falha → upload `error`
   com motivo curto (sem conteúdo do documento e sem rethrow, para não entrar em
   retry infinito).
3. **Rascunho editável** — `GET /v1/knowledge/train/draft`,
   `PATCH .../draft/:id` (merge raso no `payload`, re-cálculo de chunks) e
   `DELETE .../draft/:id` (cancela a alteração staged).
4. **Diff** — `GET /v1/knowledge/train/diff` classifica cada slug em
   `added` / `updated` / `unchanged` / `conflict` / `archived` e devolve os
   slugs com linha por confirmar.
5. **Validar** — `POST /v1/knowledge/train/validate` publica numa única
   transacção: cria `knowledge_publications`, aplica os itens, cria revisões
   ligadas à publicação e limpa o staging. Repetir o mesmo conteúdo devolve a
   publicação existente (`idempotent: true`).
6. **Publicado** — `GET /v1/knowledge/published` lista os itens activos;
   `PATCH /v1/knowledge/items/:id` faz a edição rápida do dia-a-dia;
   `GET /v1/knowledge/publications` e `POST /v1/knowledge/published/revert`
   dão histórico e reversão.
7. **Chat de teste** — `POST /v1/knowledge/chat/test` corre o orquestrador com
   `isTest: true` (sem handoff, lacunas ou envios) contra `target:'draft'` ou
   `target:'published'` e devolve `{ reply, sources }`.

## Tabelas

| Tabela | Papel |
|---|---|
| `knowledge_train_uploads` | Um upload (documento ou passo a passo), texto extraído, `status` (`pending`/`processing`/`done`/`error`) e `error` curto. |
| `knowledge_draft_items` | Área de rascunho: um item por `(tenant_id, slug)`, `op` (`create`/`update`/`delete`), `payload` validado, `chunks`, `base_version` (detecção de corrida). |
| `knowledge_publications` | Registo da publicação atómica (`kind`: `train`/`quick_edit`/`revert`), chave de idempotência e contagens `applied`. |
| `knowledge_revisions.publication_id` | Nova coluna que liga cada revisão à publicação que a aplicou (permite reverter a última publicação). |
| `catalog_items` | Unique passa a `(tenant_id, slug)` — o slug é a identidade estável por tenant. |
| `conversations.is_test` | Marca a conversa sintética do chat de teste. |

As migrações são as `drizzle/0010_light_veda.sql` e `0011_powerful_stranger.sql`.

## Semântica de mesclagem

- **Novo prevalece**: um item do rascunho com o mesmo `(entity_type, slug)` do
  activo substitui-o.
- **Não tocado permanece**: itens activos que não aparecem no rascunho ficam
  como estão.
- **Ausência ≠ remoção**: só um `op:'delete'` explícito no rascunho arquiva.
- **Conflitos exigem aceitação explícita**: se o activo mudou depois de o
  rascunho o ter copiado (`base_version`), a validação devolve `409
  draft_conflicts` com as entradas; só avançam os slugs enviados em
  `acceptConflicts`.
- **Linhas por confirmar**: catálogo exige `lineSlug` confirmada; caso contrário
  `422 lines_unconfirmed` com `unconfirmedSlugs`.
- **Reversão**: tudo-ou-nada; se algum item mudou depois da publicação →
  `409 stale_revert` e nada muda. Reverter uma reversão → `409 not_revertible`.

## Rotas

Todas exigem sessão com tenant. Escrita (`POST`/`PATCH`/`DELETE`): papel
`editor` ou `admin`; o papel `agent` recebe `403`. Todas as queries são scoped
pelo `tenant_id` da sessão.

| Rota | Pedido (exemplo) | Resposta |
|---|---|---|
| `POST /v1/knowledge/train/documents` | `{"lineSlug":"cctv","documents":[{"filename":"precos.md","mediaType":"text/markdown","contentBase64":"U2VydmljbyBYOiAxMDAgQU9B"}]}` | `202 {"uploadIds":["…"]}` |
| `POST /v1/knowledge/train/guided` | `{"lineSlug":"software","answers":[{"question":"O que vendem?","answer":"Sistemas de gestão à medida."}]}` | `202 {"uploadIds":["…"]}` |
| `GET /v1/knowledge/train/draft` | — | `200 {"items":[{"slug":"camaras-cctv","entityType":"catalog_item","op":"create","payload":{…}}]}` |
| `GET /v1/knowledge/train/diff` | — | `200 {"entries":[{"slug":"camaras-cctv","classification":"added",…}],"unconfirmedSlugs":[],"digest":"…"}` |
| `POST /v1/knowledge/train/validate` | `{"acceptConflicts":["camaras-cctv"]}` | `200 {"publicationId":"…","applied":{"added":1,"updated":0,"archived":0},"idempotent":false}` |
| `PATCH /v1/knowledge/train/draft/:id` | `{"payload":{"priceAmount":"120000"},"lineSlug":"cctv","confirmLine":true}` | `200 {"item":{…}}` |
| `DELETE /v1/knowledge/train/draft/:id` | — | `204` |
| `PATCH /v1/knowledge/items/:id` | `{"entityType":"catalog_item","patch":{"priceAmount":"120000"}}` | `200 {"publicationId":"…"}` |
| `GET /v1/knowledge/published?limit=50` | — | `200 {"items":[{"entityType":"catalog_item","slug":"camaras-cctv","name":"Câmaras CCTV","version":3,…}]}` |
| `GET /v1/knowledge/publications?limit=50` | — | `200 {"publications":[{"id":"…","kind":"train","applied":{…},…}]}` |
| `POST /v1/knowledge/published/revert` | `{"publicationId":"…"}` | `200 {"reverted":2}` |
| `POST /v1/knowledge/reembed` | — | `202 {"queued":true}` (com `EMBEDDINGS_ENABLED=true`; senão `503 embeddings_unavailable`) |
| `POST /v1/knowledge/chat/test` | `{"text":"Quanto custa a instalação de CCTV?","target":"draft"}` | `200 {"reply":"…","sources":[{"type":"chunk","id":"staged:chunk:camaras-cctv:0","score":0.82}]}` |
| `GET /v1/knowledge/reviews?limit=50` | — | `200 {"items":[{"entityType":"rule","id":"…","daysOverdue":12,…}]}` |
| `POST /v1/knowledge/reviews/:entityType/:id` | — | `200 {"entityType":"rule","reviewedAt":"…"}` (`entityType` = `catalog_item`/`knowledge_doc`/`rule`) |
| `GET /v1/knowledge/qualification-questions?lineSlug=cctv` | — | `200 {"items":[{"key":"camera_count","question":"…","version":1,…}]}` |
| `POST /v1/knowledge/qualification-questions` | `{"lineSlug":"cctv","key":"camera_count","question":"Quantas câmaras?","answerType":"number"}` | `201 {…}`; duplicado no mesmo tenant/linha → `409 duplicate_key` |
| `PATCH /v1/knowledge/qualification-questions/:id` | `{"question":"…","expectedVersion":1}` | `200 {…,"version":2}`; versão antiga → `409 stale_version` |
| `DELETE /v1/knowledge/qualification-questions/:id?expectedVersion=2` | — | `204` (soft-delete: `active=false`) |
| `GET /v1/knowledge/triggers?lineSlug=software&includeInactive=false` | — | `200 {"items":[…]}` — globais + da linha |
| `POST /v1/knowledge/triggers` | `{"lineSlug":"software","code":"demo_request","description":"…","detectionHint":"…"}` | `201 {…}`; `lineSlug` omitido = gatilho global |
| `PATCH /v1/knowledge/triggers/:id` | `{"priority":"high","expectedVersion":1}` | `200 {…}`; `code`/`lineSlug` imutáveis |
| `DELETE /v1/knowledge/triggers/:id?expectedVersion=1` | — | `204` (soft-delete) |
| `GET /v1/knowledge/config-revisions?entityType=qualification_question&entityId=…` | — | `200 {"items":[{"version":1,"snapshot":{…}}]}` |
| `POST /v1/knowledge/config-revisions/:revisionId/revert` | `{"expectedVersion":2}` | `200 {…,"version":3}` |
| `GET /v1/knowledge/gaps?status=open` | — | `200 {"items":[{"question":"…","occurrences":3,…}]}` (criadas pelo orquestrador; a API só lista e decide) |
| `POST /v1/knowledge/gaps/:id/resolve` / `.../ignore` | — | `200 {…,"status":"resolved"\|"ignored"}` |
| `GET /v1/knowledge/suggestions?status=pending` | — | `200 {"items":[{"proposedTitle":"…","status":"pending",…}]}` |
| `POST /v1/knowledge/suggestions` | `{"humanAnswer":"…","proposedTitle":"FAQ CCTV","proposedBody":"…","targetDocId":"…"}` | `201 {…}` |
| `POST /v1/knowledge/suggestions/:id/approve` | — | `200 {…,"status":"approved","stagedItemId":"…"}` — cria rascunho, nunca publica |
| `POST /v1/knowledge/suggestions/:id/reject` | — | `200 {…,"status":"rejected"}` |

Erros são `application/problem+json`. Códigos principais: `400
invalid_content_base64`/`invalid_patch`, `404 line_not_found`/`item_not_found`/
`publication_not_found`, `409 draft_conflicts`/`stale_revert`/`not_revertible`,
`415 unsupported_media_type`, `422 lines_unconfirmed`/`line_required`/
`invalid_draft_payload`, `503 knowledge_ports_unavailable`.

## Limites e formatos

- Upload: corpo JSON até **36 MiB**, até **10 documentos** por pedido, **10 MiB**
  por documento e **25 MiB** no total (configurável por `DOCUMENT_MAX_BYTES` e
  `DOCUMENT_MAX_TOTAL_BYTES`).
- Formatos: `text/plain`, `text/markdown` (UTF-8), PDF (texto ou digitalizado,
  até 20 páginas) e imagens (`image/png`, `image/jpeg`) por OCR local. DOCX →
  `415 unsupported_media_type`. Os bytes são validados por magic bytes, não pelo
  MIME declarado. OCR desliga-se com `OCR_ENABLED=false`; aí imagens e PDF sem
  texto falham de forma explícita.
- Preços/prazos/cobertura saem sempre do catálogo publicado — a extração só
  aceita valor explícito (`fixed`/`from`) ou `quote_only` com `null`.
- O bundle é montado no arranque (`src/infra/main.ts`) **mesmo sem
  `AI_API_KEY`**: as rotas respondem, mas a extração falha e o upload fica
  `status='error'`, `error='llm_error'` (o provider indisponível lança
  `ai_unavailable`). Com `AI_API_KEY`, usa-se o LLM real e o gate
  `AI_LLM_DATA_APPROVED` continua a decidir se os dados podem sair.
- `embedder` montado só com `EMBEDDINGS_ENABLED=true` (ADR-0014, runtime
  local `Xenova/multilingual-e5-small`): vectoriza os chunks no staging e na
  validação. Sem a flag (ou com falha de inferência) os chunks guardam-se
  sem vetor e a pesquisa cai em FTS português. Backfill: `POST
  /v1/knowledge/reembed` (job `knowledge.reembed`, também só com a flag on).

## Limitações conhecidas da v1

- `catalog_item.kind` assume `'service'` quando o extractor não traz um
  `product|service|plan|package` válido.
- Reverter uma reversão devolve `409 not_revertible`.
- O chat de teste cria uma conta sintética `chat-de-teste` (e um contacto/
  conversa `is_test`) visível em `whatsapp_accounts`; fica `disconnected` e
  nunca contacta o WA-AKG. É reutilizada entre chamadas.
- `line_not_found` é `404` em todas as rotas de treino.
- Sem cursor de paginação: `GET /v1/knowledge/published` e
  `/v1/knowledge/publications` paginam só por `limit` (máx. 200).

## Fase 2 — o que entrou depois do "Treinar agente"

Guião de qualificação e gatilhos de handoff editáveis (`/v1/knowledge/qualification-questions`,
`/v1/knowledge/triggers`, com histórico e reversão em `/v1/knowledge/config-revisions`),
alertas de itens por rever (`/v1/knowledge/reviews`) e a fila de lacunas/sugestões
(`/v1/knowledge/gaps`, `/v1/knowledge/suggestions`). Aprovar uma sugestão escreve em
`knowledge_draft_items`; publicar continua a exigir `/v1/knowledge/train/validate`.
O painel/frontend não faz parte deste repositório.
