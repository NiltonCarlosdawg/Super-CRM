# Desenho — Fase 2 completa: o que falta depois do "Treinar agente"

- **Data:** 2026-10-29 · **Estado:** desenho e plano aprovados pelo dono; `builder-check` por subagente bloqueado por limite de modelos gratuitos e feito manualmente.
- **Origem:** brainstorming com o dono (2026-10-29), depois da entrega do "Treinar agente" (`docs/superpowers/specs/2026-10-25-treinar-agente-conhecimento-design.md`, implementado).
- **Decisões do dono** marcadas **[dono]**; chamadas minhas marcadas **[call]**; chamadas revistas nesta data marcadas **[call revista]**.
- **Âmbito:** backend. Sem frontend; o contrato é a API REST + guardas. O gate `ai_active` **não** é tocado.

## 1. Contexto e âmbito

O dono pediu para **cumprir todos os critérios da Fase 2** de `docs/01` §8, incluindo PDF/OCR ainda que seja a última task **[dono, 2026-10-29]**. O "Treinar agente" já entregou: fluxo de upload/guizado, rascunho, diff, publicação atómica com histórico/reversão, edição rápida, chat de teste `draft` e RBAC `editor|admin`.

Falta, por critério de `docs/01` §8:

| Critério | Estado actual | O que este desenho acrescenta |
|---|---|---|
| CRUD do catálogo, documentos, regras, **perguntas de qualificação** e **gatilhos** | catálogo/docs/regras pelo treino e edição rápida; perguntas e gatilhos só por seed | CRUD próprio das perguntas e dos gatilhos |
| Publicação com histórico e reversão | feito | reconciliação dos chunks na edição rápida e na reversão (necessária para a pesquisa semântica ser verdadeira) |
| Job de chunking e **embeddings**; pesquisa semântica só em publicados e válidos | chunking feito; embeddings sempre `null`; `retrieve` de produção devolve `[]` | runtime local de embeddings, backfill, `retrieve` publicado com tenant + `published` + validade |
| Registo de lacunas e **fila de sugestões** | lacunas registadas; sugestões sem lógica; sem API de leitura/decisão | API de lacunas (listar/resolver/ignorar) e de sugestões (criar/listar/aprovar/rejeitar) |
| Chat de teste com fontes | feito; `published` devolve vazio | `published` passa a usar o retrieve real |
| **Alertas de itens por rever** | colunas `reviewed_at`/`review_every_days` em catálogo/docs; sem uso; regras sem colunas | endpoint de vencidos, marcar revisto, carimbo automático ao publicar/editar |
| Formatos da v1 do "Treinar agente" | TXT/MD; PDF/OCR respondem 415 | extracção de PDF de texto, OCR de imagens e PDF digitalizado |

**Decisões já fixadas que este desenho não reabre:** embeddings locais `multilingual-e5-small` (384) via `@huggingface/transformers`/ONNX CPU (ADR-0002/A4, `docs/06`); alvo cPanel partilhado sem Docker (ADR-0001/A5); `editor|admin` escrevem conhecimento e `agent` só lê (spec do treino §9); nenhum dado de cliente em conhecimento; sem frontend.

## 2. Não-objetivos

- Frontend, campanhas, follow-ups, `ai_active`, eval/runner e metas (intocados).
- DOCX. Serviço externo de embeddings ou OCR (o documento não sai do país; ADR-0002).
- Reproduzir conversas reais ou usá-las em testes/prompts (mantém-se proibido).
- Notificações push de revisão: **[call revista]** o alerta é o endpoint `GET /v1/knowledge/reviews`; um evento Socket.IO exigiria um sweep com estado de deduplicação por dia e o painel não existe neste repo. O painel decide a cadência de polling/notificação.

## 3. Perguntas de qualificação (CRUD)

### 3.1 Dados e migração

- **[call] Correcção multitenancy:** o índice `qualification_questions_line_key_uq` é `(line_id, key)` **global**; dois tenants com a mesma linha não podem ter a mesma pergunta. Migração: drop do índice antigo + `UNIQUE(tenant_id, line_id, key)`.
- `version int not null default 1` para histórico/reversão. `active=false` é a remoção (nunca `DELETE` físico: as respostas das conversas referenciam `key`).

### 3.2 API (`editor|admin`, `requireTenant`)

| Rota | Função |
|---|---|
| `GET /v1/knowledge/qualification-questions?lineSlug=&includeInactive=` | lista por linha (posição, key); `includeInactive` default `false` |
| `POST /v1/knowledge/qualification-questions` | cria `{ lineSlug, key, question, answerType, choices?, required?, position? }` |
| `PATCH /v1/knowledge/qualification-questions/:id` | edita `question`, `answerType`, `choices`, `required`, `position`, `active`; `key`/`lineSlug` imutáveis |
| `DELETE /v1/knowledge/qualification-questions/:id` | desactiva (`active=false`), idempotente |

Regras:

- `key` `/^[a-z][a-z0-9_]{2,39}$/`; duplicado no mesmo `(tenant, linha)` → `409 duplicate_key`.
- `version` começa em 1; cada mutação escreve snapshot na `knowledge_revisions` (`entity_type='qualification_question'`) antes de incrementar a versão.
- `answerType=choice` exige `choices` (1..50 strings não vazias, sem duplicados); nos outros tipos `choices` tem de ser `null`/ausente → `400 invalid_choices`.
- `position` inteiro 0..1000; empates ordenam por `key`.
- Cross-tenant/inexistente → `404 not_found` (nunca 403).
- Auditar `knowledge.qualification_created|updated|deactivated` (entity `qualification_question`).
- O orquestrador já lê `active=true` por linha e ordena por `position,key`; não muda.
- Histórico/reversão pelo endpoint comum `GET /v1/knowledge/config-revisions?entityType=qualification_question&entityId=` e `POST /v1/knowledge/config-revisions/:revisionId/revert` (`expectedVersion` obrigatório). Restaurar o snapshot `absent` da criação desactiva a pergunta, sem apagar fisicamente; conflito de versão → 409.

## 4. Gatilhos de handoff (CRUD)

### 4.1 Dados e migração

- Sem unique hoje: CRUD pode criar duplicados do mesmo `code` no mesmo âmbito e o merge do orquestrador fica ambíguo. Migração com **dois índices parciais**:
  - `UNIQUE(tenant_id, line_id, code) WHERE line_id IS NOT NULL`
  - `UNIQUE(tenant_id, code) WHERE line_id IS NULL`
- O seed actual (`handoff-triggers.seed.ts`) já é idempotente por `(lineId, code)` em código; os índices apenas o tornam impossível de violar.

### 4.2 API (`editor|admin`)

| Rota | Função |
|---|---|
| `GET /v1/knowledge/triggers?lineSlug=&includeInactive=` | lista globais + da linha (quando `lineSlug`), com âmbito explícito |
| `POST /v1/knowledge/triggers` | cria `{ lineSlug?, code, description, detectionHint, action, priority, active? }` |
| `PATCH /v1/knowledge/triggers/:id` | edita `description`, `detectionHint`, `action`, `priority`, `active`; `code`/`lineSlug` imutáveis |
| `DELETE /v1/knowledge/triggers/:id` | desactiva (`active=false`), idempotente |

Regras:

- `code` `/^[a-z][a-z0-9_]{2,39}$/` (igual aos seeds: `purchase_intent`); duplicado no âmbito → `409 duplicate_trigger`. Código novo passa a valer no prompt/orquestrador sem deploy (era o objectivo do `docs/05`).
- `version` começa em 1; cada mutação escreve snapshot na `knowledge_revisions` (`entity_type='handoff_trigger'`) antes de incrementar a versão.
- `description` 1..300; `detectionHint` 1..2000; `action` e `priority` nos enums actuais.
- `lineSlug` desconhecido → `404 line_not_found` (mesma ruling do treino).
- Auditar `knowledge.trigger_created|updated|deactivated`.
- Sem apagar histórico: handoffs antigos referenciam `trigger_id` (FK) — desactivar preserva.
- O seed actual também actualiza descrição/hint quando encontra diferenças. Para não desfazer edições humanas, alterá-lo para **inserir apenas os que faltam**, sem sobrescrever os já existentes.
- Histórico/reversão usa os endpoints comuns de `config-revisions` acima; restaurar o snapshot `absent` da criação desactiva o gatilho, sem apagar fisicamente. `expectedVersion` é obrigatório e divergência devolve 409.

## 5. Revisão periódica e alertas

### 5.1 Dados e migração

- `rules` não tem validade nem revisão. Migração: `valid_from`, `valid_until`, `reviewed_at` (nullable) e `review_every_days` (int not null default 90) — alinha as regras com catálogo/docs (`docs/05` §5).
- `orchestrator-ports.rules()` passa a filtrar validade (`valid_from <= now <= valid_until`), tal como catálogo/docs; sem dados existentes com validade, o comportamento não muda.

### 5.2 Semântica

- **Vencido** = `status='published'` e `COALESCE(reviewed_at, updated_at) + review_every_days dias <= now()`.
- **Carimbo automático [call]:** publicar (validação do treino e reversão) e editar rapidamente marcam `reviewed_at=now()` nos itens afectados — publicar é uma validação humana. Itens antigos com `reviewed_at=null` usam `updated_at` como base (não aparecem todos vencidos no dia 1).
- `review_every_days` 1..3650, editável na edição rápida dos três tipos.
- Itens expirados (`valid_until < now`) continuam a aparecer na lista de revisão (com `validUntil`), mas **não** são servidos pela pesquisa/retrieve.

### 5.3 API (`editor|admin`)

| Rota | Função |
|---|---|
| `GET /v1/knowledge/reviews?limit=` | itens vencidos dos três tipos, ordenados por dias em atraso (desc) |
| `POST /v1/knowledge/reviews/:entityType/:id` | marca revisto (`reviewed_at=now`) e devolve o item |

- `entityType` ∈ `catalog_item|knowledge_doc|rule`.
- Resposta: `{ items: [{ entityType, id, slug, title, lineSlug, reviewedAt, reviewEveryDays, daysOverdue, validUntil }] }`.
- Cross-tenant/inexistente → `404 item_not_found`; não publicado → `409 not_published`.
- Auditar `knowledge.reviewed` com `{ entityType, id, daysOverdue }`.
- A edição rápida (`PATCH /v1/knowledge/items/:id`) ganha `reviewEveryDays`, `validFrom`, `validUntil` nos patches dos três tipos (ISO 8601 ou `null`); `applyQuickPatch` mapeia `validFrom/validUntil` e carimba `reviewedAt`.

## 6. Lacunas e sugestões

### 6.1 Lacunas (API mínima)

| Rota | Função |
|---|---|
| `GET /v1/knowledge/gaps?status=open&limit=` | lista lacunas do tenant, mais frequentes primeiro (`occurrences desc, last_seen_at desc`) |
| `POST /v1/knowledge/gaps/:id/resolve` | marca `resolved` (`resolved_by_id`, `resolved_at`) |
| `POST /v1/knowledge/gaps/:id/ignore` | marca `ignored` |

- Sem texto livre de nota: apenas a transição de estado entra no audit (`knowledge.gap_resolved|ignored`).
- Idempotente: repetir a mesma decisão devolve o mesmo estado, sem novo audit.
- `knowledge_gaps.normalized_question` já agrupa repetições; a API não expõe SQL nem junta tenants.

### 6.2 Sugestões — modelo

Falta o que transforma uma correção humana em conhecimento. **[dono, 2026-10-29]:** aprovar uma sugestão **entra como item de rascunho**; o gerente valida pelo fluxo normal ("Treinar agente"), com pré-visualização e conflitos. Não há publicação directa.

Migração em `knowledge_suggestions`:

- `created_by_id uuid` (nullable para legado; o serviço escreve sempre);
- `proposed_line_slug text` (só para criação nova; `null` = documento global);
- `proposed_doc_type doc_type` (default `faq` na criação nova);
- `staged_item_id uuid` (item de rascunho resultante, para idempotência e rastreio);

Sem captura automática de conversas: **[call]** uma sugestão é sempre criada explicitamente pela API pelo painel (`editor|admin`), com texto de conhecimento escrito por uma pessoa. A conversa/mensagem são referências opcionais de rastreio, nunca fonte do texto — evita arrastar dados pessoais de clientes para a base de conhecimento (regra 13 dos AGENTS).

### 6.3 API (`editor|admin`)

| Rota | Função |
|---|---|
| `POST /v1/knowledge/suggestions` | cria `{ humanAnswer, proposedTitle, proposedBody, aiAnswer?, targetDocId?, proposedLineSlug?, proposedDocType?, conversationId?, messageId?, gapId? }` |
| `GET /v1/knowledge/suggestions?status=pending&limit=` | fila (default `pending`), mais recentes primeiro |
| `POST /v1/knowledge/suggestions/:id/approve` | valida e coloca/actualiza o item no **rascunho**; `stagedItemId` |
| `POST /v1/knowledge/suggestions/:id/reject` | rejeita (`rejected`) |

Regras de criação:

- `humanAnswer` 1..4000; `proposedTitle` 1..200; `proposedBody` 1..20000; `aiAnswer` opcional ≤4000.
- `targetDocId` presente → actualização desse documento **publicado** do tenant (`404 not_found` se não existir; `409 not_published` se não estiver publicado); `proposedLineSlug/proposedDocType` ignorados (herdados).
- Sem `targetDocId` → criação de documento: `proposedDocType` default `faq`, `proposedLineSlug` validado (desconhecido → `404 line_not_found`; `null` = global).
- `conversationId`/`messageId`/`gapId` opcionais: existência e tenant verificados; `messageId` só com `conversationId` e pertença à conversa (senão `404 not_found`). Não são copiados para o conhecimento.
- Auditar `knowledge.suggestion_created`.

Regras de aprovação (uma transacção):

1. CAS `pending → approved`; já decidida → `409 already_reviewed` (o painel recarrega a fila).
2. Construir o item de rascunho:
   - `targetDocId`: `op=update`, `slug` do documento, `payload` completo do documento com `title=proposedTitle`, `body=proposedBody` e os restantes campos do activo (`type`, `lineSlug`, validade, `reviewEveryDays`); `baseVersion=version` activa. Se já existe rascunho com esse `slug`, substitui-se o payload (`op=update`) e recalculam-se os chunks; conflito de identidade não existe porque o alvo é o mesmo.
   - sem alvo: `op=create`, `slug` derivado do título (`slugify`, ≤80, fallback `sugestao-<8 hex>`); se já existe **activo** ou **rascunho** com esse slug → `409 slug_conflict` (usar `targetDocId` para actualizar). Nunca se sobrepõe em silêncio.
3. Chunks: recalcular com `chunkText`/`chunkCatalogItemText` (documento) e embedding `passage` quando existe embedder; sem embedder, `embedding: null` (o retrieve cai em lexical; a validação re-embeda o que faltar, §7.5).
4. `staged_item_id`, `status=approved`, `reviewed_by_id`, `reviewed_at`; audit `knowledge.suggestion_approved`.
5. A publicação continua a ser `POST /v1/knowledge/train/validate` — nenhum caminho novo de publicação.

Rejeição: CAS `pending → rejected`, `reviewed_*`, audit `knowledge.suggestion_rejected`; já decidida → `409 already_reviewed`. Não se armazena motivo em texto livre.

## 7. Embeddings, pesquisa semântica e chunks

### 7.1 Runtime (ADR-0014 antes da dependência)

- Dependência nova: `@huggingface/transformers` `^4.3.2` (ADR-0014, ONNX Runtime, CPU). Modelo `Xenova/multilingual-e5-small`, 384 dimensões, `dtype: 'q8'`, cache em disco (`EMBEDDINGS_CACHE_DIR`).
- Prefixos e5 obrigatórios: `passage: ` para conteúdo indexado, `query: ` para a pergunta. O port passa a distinguir os dois; `draft-retrieval` também usa `kind: 'query'` ao embutir perguntas.
- Config validada no arranque (nunca segredos): `EMBEDDINGS_ENABLED` (default `false`), `EMBEDDINGS_MODEL`, `EMBEDDINGS_CACHE_DIR`, `EMBEDDINGS_BATCH_SIZE` (default 16, 1..64), `EMBEDDINGS_TIMEOUT_MS` (default 30000), `EMBEDDINGS_WARMUP` (default `false`).
- Carregamento preguiçoso e singleton; erro de carga/embedding não derruba a app: o retrieve cai em lexical e o job/rota devolvem `503 embeddings_unavailable` quando o efeito é indispensável (ex.: reembed explícito).
- Memória estimada 300–500 MB (A4). Se o host não aguentar, `EMBEDDINGS_ENABLED=false` mantém tudo funcional em lexical (plano B documentado).
- CI sem rede: testes usam embedder falso determinístico; o adaptador real testa prefixos/pooling/normalização com uma `pipeline` injectada. Smoke real: script `npm run embeddings:smoke` (manual, documentado), fora do CI.

### 7.2 Port

`EmbeddingsProvider.embedTexts(texts, opts?)` com `opts: { kind?: 'query'|'passage'; signal?: AbortSignal }` (default `passage`). Nenhum chamador actual passa `signal` posicionalmente; fakes passam a ignorar `kind`. O adaptador aplica o prefixo e valida `dimensions === 384`.

### 7.3 Backfill e ligação

- O embedder passa a ser montado em `main.ts` (hoje é omitido) e injectado no extract job, no `TrainDeps` das rotas e nos ports.
- `POST /v1/knowledge/reembed` (`editor|admin`, 202) enfileira `knowledge.reembed {tenantId}`; o job:
  - selecciona chunks do tenant com `embedding IS NULL OR embedding_model <> modelo` em lotes de 32, embeda `passage`, actualiza `embedding`/`embedding_model`; repete até esgotar (limite de 100 lotes por execução, resto fica para a próxima).
  - não toca em staging; a validação re-embeda o que faltar (§7.5).
  - audit `knowledge.reembedded` (contagem) e log sem conteúdo.
- A validação (`validateDraft`) tenta re-embeddar chunks staged sem vector/modelo actual antes de materializar. Falha do embedder **não bloqueia publicação/edição humana**: grava-se o chunk sem vector/modelo e o retrieve usa FTS até o job de reembed o preencher. Só a rota/job explícito de reembed devolve erro de indisponibilidade. A transacção de publicação continua atómica quanto aos itens e chunks.

### 7.4 Retrieve publicado

Novo módulo `published-retrieval.ts`:

- Pesquisa semântica em SQL tenant-scoped sobre `knowledge_chunks`, com join ao pai, exigindo `chunk.tenant_id=tenant`, `parent.tenant_id=tenant`, `active`, `published`, validade e linha (`doc.line_id IS NULL OR doc.line_id=linha`; catálogo exige linha). Usa `ORDER BY embedding <=> queryVector LIMIT topK` para aproveitar HNSW; não carrega corpus inteiro para Node.
- Sem embedder ou sem vector correspondente: fallback PostgreSQL FTS em português (`to_tsvector('portuguese', content)` / `plainto_tsquery` + `ts_rank`), com os mesmos filtros de tenant/publicação/validade/linha, conforme plano B de `docs/06`.
- Limiar semântico `AI_RETRIEVAL_MIN_SIMILARITY` (default 0.75); o FTS tem ranking próprio, não reutiliza limiar cosseno. Nunca inventa fontes: sem resultados → `[]`.
- Devolve `RetrievedChunk` com `id` do chunk, `source`, `sourceId` (doc/catálogo), `content`, `similarity` e `version` do item.
- Chunks com modelo diferente do actual são ignorados com embedder (incomparáveis) e contam para o backfill.
- `orchestrator-ports` recebe `retrieve` real em `main.ts`; sem embedder funcionam em lexical (a flag não bloqueia a entrega).
- Chat de teste: `target=published` passa a usar `retrievePublished` e `lookupCatalogPublished`; o body ganha `lineSlug?`. Sem linha, segue o comportamento real (`lookupCatalog=[]`, só docs globais); com linha, catálogo e docs respeitam essa linha. `target=draft` fica como está.
- **[call] Reconciliação de chunks (correcção necessária):** a limitação aceite "edição rápida/reversão não regeneram chunks" deixa de ser segura com pesquisa activa (serviria texto antigo, incluindo preços). Edição rápida e reversão passam a apagar e recriar os chunks da entidade a partir do estado final, dentro da mesma transacção; se a inferência falhar, os chunks ficam sem vector e são servidos via FTS até reembed. Arquivar continua a desactivar chunks; reactivar volta a gerar chunks se faltarem.

### 7.5 Publicação e validade

- Publicar materializa chunks `active=true` (já existe); validade expirada é filtrada no retrieve, sem job de desactivação.
- Arquivar desactiva chunks (já existe). Reverter reactiva os chunks do snapshot; como o texto pode ter mudado, a reversão também reconcilia chunks (§7.4) e carimba `reviewed_at`.

## 8. PDF e OCR (última task — decisão do dono)

### 8.1 ADR-0015 antes das dependências

Dependências novas (todas locais, nada sai do país):

- `pdfjs-dist` (legacy build) para texto e rasterização de páginas;
- `@napi-rs/canvas` (binários pré-compilados, sem compilação nativa) para rasterizar;
- `tesseract.js` (WASM) com dados de língua `por+eng` em cache (`OCR_CACHE_DIR`), pré-semeáveis para uso offline.

Alternativas rejeitadas no ADR: serviço externo de OCR (privacidade/ADR-0002); `tesseract` de sistema (não existe em cPanel partilhado); DOCX (fora de âmbito).

### 8.2 Ingestão assíncrona

- Hoje a rota extrai texto sincronamente e guarda `text`. PDF/OCR são pesados: a rota passa a guardar os **bytes** e o job extrai.
- Migração `knowledge_train_uploads`: nova coluna `content bytea`; `text` passa a nullable (preenchido pelo job). Linhas antigas continuam válidas (têm `text`); o job usa `content` quando existe e `text` como legado.
- Rota: valida tipo por `isSupportedMediaType` (agora inclui `application/pdf`, `image/png`, `image/jpeg`, `image/webp`), limite por documento 10 MiB, total binário 25 MiB, máx. 10 documentos por pedido; bodyLimit da rota ≥36 MiB para base64 (+33%) e JSON. Rejeita cedo (415/413) antes de gravar.
- Job: `extractDocument(content, mediaType)` → texto; limita 1 000 000 caracteres (`document_too_large`). Depois segue o pipeline actual (`extractKnowledge`).
- Privacidade: `content` é apagado (`null`) no fim, sucesso ou erro; fica só o texto extraído, como hoje. Nunca se loga conteúdo nem nome de ficheiro com dados.
- Códigos de erro visíveis no upload (`error`, mensagem curta): `unsupported_format` (415 na rota), `pdf_invalid`, `pdf_without_text` (PDF sem texto e OCR desligado), `ocr_disabled`, `ocr_failed`, `ocr_timeout`, `document_too_large`.

### 8.3 Extracção

- PDF: texto por página; páginas individuais com menos de 20 caracteres úteis são tratadas como digitalizadas e passam por OCR, mesmo num PDF misto.
- OCR de PDF: rasteriza no máximo 20 páginas a 150 DPI; OCR sequencial (concorrência 1 por processo) com timeout total de 120 s; exceder → `ocr_timeout` (nunca fica em retry infinito).
- Imagens: OCR directo, mesmos limites.
- Limites configuráveis: `DOCUMENT_MAX_BYTES` (10 MiB), `DOCUMENT_MAX_TOTAL_BYTES` (25 MiB), `DOCUMENT_MAX_PAGES` (20), `OCR_TIMEOUT_MS` (120000), `OCR_LANGS` (`por+eng`), `OCR_CACHE_DIR`, `OCR_ENABLED` (default `true`; `false` → PDF digitalizado/imagem responde `ocr_disabled` sem carregar o motor).
- Testes: motor e renderizador atrás de interfaces, com fakes nos testes; valida magic bytes além do MIME declarado (PDF `%PDF-`, PNG/JPEG/WebP); adaptador real só num smoke manual documentado.

## 9. Alterações de dados (migrações novas, revistas)

1. `qualification_questions`: índice único `(tenant_id, line_id, key)` + `version int not null default 1`.
2. `handoff_triggers`: dois índices únicos parciais (linha e global) + `version int not null default 1`.
3. `rules`: `valid_from`, `valid_until`, `reviewed_at`, `review_every_days` (default 90).
4. `knowledge_suggestions`: `created_by_id`, `proposed_line_slug`, `proposed_doc_type`, `staged_item_id`.
5. `knowledge_train_uploads`: `content bytea`, `text` nullable.

Todas aditivas ou de constraint; nenhuma edita migração aplicada. Migrações correm do zero numa base vazia e sobre uma base com dados (prova no relatório, como na `0011`).

## 10. Segurança e isolamento

- Toda a query com `tenant_id` da sessão; cross-tenant = 404. As rotas novas repetem `authenticate + requireTenant + requireAnyRole('editor','admin')`.
- Validação zod em todas as fronteiras; sem `any` sem justificação.
- Uploads: tipo por allowlist, tamanho, páginas, timeout; conteúdo nunca em logs; bytes apagados após extracção.
- Sugestões não copiam conversas; referências só depois de verificar pertença ao tenant.
- Auditoria de todas as mutações; detalhes sem conteúdo de documentos nem dados pessoais.
- `EMBEDDINGS_ENABLED=false` e `OCR_ENABLED=false` são kill-switches operacionais; nada disto abre o gate `ai_active`.

## 11. Provas (TDD)

- **Unitários:** validação de perguntas (choices/key), unicidade/erros de gatilhos, cálculo de vencidos (COALESCE, validade), CAS de sugestões, derivação de slug, staging de sugestão (update vs create, conflito), prefixos/pooling do embedder (pipeline injectada), `slugify`, extracção (deteccao de PDF sem texto), reconciliação de chunks na edição rápida/reversão.
- **Integração (PG+Redis reais):** migrações do zero e sobre base com dados; CRUD com isolamento cross-tenant; aprovação de sugestão → rascunho → validação → publicado; rejeição; lacunas; revisões carimbadas; retrieve publicado só devolve publicados+válidos+do tenant (com fake embedder determinístico); chat test `published` devolve fontes; reembed job idempotente; upload PDF/OCR com extractor falso (job assíncrono, `content` apagado).
- **Contrato/eval:** `eval:baseline` intocado; nenhum teste enfraquecido.
- **Smoke manual documentado (não CI):** `embeddings:smoke` com o modelo real; extracção de um PDF sintético e de uma imagem sintética com OCR real. Evidência no relatório final.

## 12. Riscos e operação

- **RAM/CPU no cPanel:** embeddings e OCR são os maiores consumidores; flags permitem desligar sem perder funcionalidade (lexical/415). Verificação do host continua pendente e é do dono; o desenho não a substitui.
- **Latência:** edição rápida com embedder passa a ter uma chamada de inferência; reversão de muitas entidades pode demorar. Limite aceite e documentado.
- **Qualidade lexical:** o fallback FTS não é semântico; o retrieve devolve `[]` quando nada passa o ranking (nunca inventa).
- **Dados:** `content` de uploads é apagado no fim; texto extraído é conhecimento da empresa, não conversas.
- **Migração com dados:** os índices únicos novos podem falhar se existirem duplicados criados fora do seed; o plano inclui verificação prévia no ambiente de desenvolvimento.

## 13. Ordem de execução (base para o plano)

1. ADR-0014 + port/adaptador/config de embeddings + testes com fake.
2. Ligar embedder (extracção/validação) + job/rota de reembed + reconciliação de chunks na edição rápida/reversão.
3. Retrieve publicado + wiring dos ports + chat test `published`.
4. CRUD de perguntas de qualificação (+ migração).
5. CRUD de gatilhos (+ migração).
6. Revisões/alertas (+ migração das regras, endpoints, carimbos).
7. Lacunas + sugestões (+ migração, staging no rascunho).
8. ADR-0015 + extracção de PDF de texto (bytes no upload, job assíncrono).
9. OCR de imagens e PDF digitalizado + limites + docs.
10. Verificação final (typecheck/lint/unit/integração/eval), README/`.env.example`/runbook e relatório com evidência.

## 14. Decisões e chamadas

- **[dono, 2026-10-29]** cumprir todos os critérios da Fase 2; PDF/OCR incluído, como última task.
- **[dono, 2026-10-29]** aprovar sugestão → item de rascunho, validado pelo fluxo normal.
- **[call]** CRUD próprio de perguntas e gatilhos, separado do fluxo de treino.
- **[call]** alertas por endpoint de revisão; sem evento/Socket.IO nesta entrega (revista).
- **[call]** `EMBEDDINGS_ENABLED` com degradação lexical; modelo local já decidido na A4.
- **[call]** reconciliação de chunks na edição rápida e reversão (sem ela, a pesquisa serviria texto antigo).
- **[call]** sugestões criadas explicitamente (sem capturar conversas) para não arrastar dados pessoais.
- **[call]** OCR/PDF locais (`pdfjs-dist` + canvas + tesseract.js), extracção assíncrona no job, bytes apagados no fim.
- **Fica para o builder:** nomes exactos de helpers/rotas internas, formato de paginação, limites finos de batch/timeout, layout dos ficheiros, prompts (não há prompt novo), detalhes de logging.

## 15. Decisão confirmada pelo dono

Em 2026-10-29, o dono confirmou que **perguntas e gatilhos devem ter histórico**. A interpretação aplicada, comunicada antes do plano, inclui reversão: CRUD continua com efeito imediato, cada mutação grava snapshots em `knowledge_revisions`, e a rota comum de `config-revisions` lista e restaura snapshots com controlo `expectedVersion`. A reversão de uma criação desactiva o registo; nunca o apaga fisicamente.
