# Desenho — "Treinar agente": conhecimento self-service pelo painel (Fase 2)

- **Data:** 2026-10-25 · **Estado:** revisto (`builder-check` de 2026-10-25) e com respostas do dono incorporadas — **não construir até o dono aprovar este documento**.
- **Estado actual (2026-10-27):** aprovado 2026-10-25 → **implementado**; plano em `docs/superpowers/plans/2026-10-25-treinar-agente.md`.
- **Origem:** brainstorming com o dono (2026-10-25). Decisões do dono marcadas **[dono]**; chamadas minhas marcadas **[call]**.
- **Âmbito deste repo:** backend. A interface ("painel") é construída por fora — o contrato é a **API REST + guardas + eventos**.

## 1. Intenção e porquê

O conhecimento do CRM (preços, serviços, FAQ, regras, prazos) tem de ser adicionado e mantido **por quem gere a empresa, a partir do painel** — sem deploy, sem CLI, sem passar pela equipa técnica. Quem usa o fluxo é o **gerente ou atendente da empresa (tenant)** com o seu próprio login **[dono]**, com papel `editor` ou `admin` **[dono, 2026-10-25]**. A Fase 2 em `docs/01` previa "CRUD + publicação com versões"; esta conversa fechou o **fluxo completo** de arranque e manutenção em cima desse CRUD.

## 2. Objetivos

- Onboarding do conhecimento por **auto serviço**: o gerente treina o agente sozinho, sem intervenção da MilVendas.
- Duas vias até ao mesmo resultado: **carregar documento(s)** ou **passo a passo guiado** de perguntas **[dono]**.
- Verificação de compreensão: o agente devolve um **resumo em itens editáveis** (corrigir/apagar/completar) antes de qualquer coisa ficar activa **[dono]**.
- **Mini-chat de teste** ali mesmo, antes de validar **[dono]**.
- Manutenção de dia-a-dia **granular**: mudar um preço = editar um campo + confirmar **[dono]** — nunca re-carregar tudo.
- Carga nova depois do arranque é **aditiva**: novo entra, sobreposição **novo prevalece**, o que não foi tocado **permanece** **[dono]**.

## 3. Não-objetivos e anti-objetivos

- **Não** fazer o frontend (só as APIs; o ecrã "Treinar agente" é consumidor destas APIs).
- **Não** tocar no gate `ai_active` (publicar conhecimento **não** muda o `ai_mode` de nenhuma linha).
- **Não** mudar o runner nem as metas do eval (`docs/eval-metas.md`).
- **Fora desta entrega** (continuação da Fase 2, tarefa seguinte — **[dono, 2026-10-25]**): alertas de itens por rever (`reviewed_at`/`review_every_days`) e fila de sugestões de correções humanas (`knowledge_suggestions`).
- Anti-objetivos (falhas que contam): estado meio-ativo a atender clientes; fuga de conhecimento entre tenants; ter de re-uploar tudo para mudar um preço; a IA responder preços/prazos/cobertura fora do catálogo publicado (regra 8 dos AGENTS).

## 4. O fluxo (decidido com o dono)

1. O utilizador entra no ecrã **"Treinar agente"** (o painel chama as APIs deste desenho) **[dono]**.
2. Escolhe a via: **upload de documento(s)** ou **passo a passo guiado** — o sistema pergunta as informações que um bom atendimento precisa (o que vendem, preços, zonas, prazos, garantias, horários, como lidar com reclamações) **[dono]**.
   - **Formatos da v1 [dono, 2026-10-25]:** PDF de texto, TXT, Markdown e **imagens/PDF digitalizados com OCR**. **DOCX fora.** O OCR é dependência nova → **ADR curto antes de a dependência entrar** (regra 1 dos AGENTS), a decidir com o runtime dos embeddings (§11).
3. O agente extrai e devolve **itens estruturados editáveis** (catálogo, documentos/FAQ, regras). Ele corrige, apaga ou completa ali mesmo — isto é o "resumo do que entendeu" **[dono]**.
4. **Mini-chat de teste** na hora, contra a versão em rascunho, com as fontes visíveis **[dono]**.
5. **Validar** → publicação **atómica**: as conversas reais passam a usar a nova versão de uma vez, nunca um meio-estado **[call; presunção não contrariada 2×]**. O teste fala com o **rascunho**; o atendimento fica na **activa** até à validação **[call]**.
6. **Dia-a-dia:** editar ou acrescentar um item já activo = **confirmação e entra no atendimento** (sem ciclo resumo+teste) **[dono]**.
7. **Carga nova** (novo folheto, novo passo a passo): ciclo completo outra vez (3–5), mas na validação o resultado **soma-se** ao activo — sobreposição → novo prevalece; não referido → permanece **[dono]**.

## 5. Modelo de dados — usar o que já existe (`knowledge.schema.ts`)

| Peça do fluxo | Tabelas/enums já existentes |
|---|---|
| Estados do item | `knowledge_status`: `draft` → `published` → `archived` |
| Itens do catálogo (preços/serviços/planos) | `catalog_items` (`pricing_mode` fixed/from/quote_only, `availability`, kind) |
| Documentos/FAQ/políticas | `knowledge_docs` (`doc_type`: faq/policy/process/company_info/objection) |
| Recuperação semântica | `knowledge_chunks` (`chunk_source`: doc/catalog) + `embedding vector(1536)` |
| Regras e perguntas do guiado | `rules`, `qualification_questions` |
| Histórico e reversão | `knowledge_revisions` (por entidade) + registo de publicação (§6) |

Alterações de schema necessárias (migrações novas, nunca editar aplicadas):

- **[call] Correcção multitenancy:** `catalog_items` tem `UNIQUE("slug")` **global** (`drizzle/0001:271`) — o segundo tenant com o mesmo slug falha. Migração para `UNIQUE(tenant_id, slug)`; o slug passa também a ser a **identidade estável** do diff da §6 (dentro do tenant e da linha).
- **[call] Registo de publicação:** tabela nova `knowledge_publications` (id, tenant, quando, quem, chave de idempotência) e `publication_id` em `knowledge_revisions` — é o que dá idempotência à validação e permite `revert` "da última publicação" (o schema só tem revisões por entidade).
- **[call] Área de rascunho:** **um rascunho por tenant** (estados `draft` existentes + coluna/base de sessão), com **marcador de versão de origem** por item para detectar corridas (§6). Rascunhos concorrentes de dois utilizadores: o segundo recebe `409` com o diff — nunca merge silencioso entre si.

## 6. Semântica de mesclagem na validação (carga nova)

- A validação recebe o conjunto final de itens do rascunho; o backend calcula o **diff** contra o activo: `added` / `updated` / `unchanged` (correspondência por `tenant_id + slug` **[call]**; o painel mostra o diff e pede **uma** confirmação).
- **[call] Detecção de corrida:** se um item activo mudou **desde que o rascunho o copiou** (marcador de versão), a validação **não o sobrepõe em silêncio** — o diff marca `conflict` e o utilizador escolhe (manter activo / usar o do rascunho). A "sobreposição novo prevalece" aplica-se ao que o rascunho **criou a partir do fluxo**, não a edições rápidas feitas entretanto por outro utilizador.
- Aplicação numa **única transacção** dentro de um registo de publicação: `updated` substitui (novo prevalece), `added` entra, `unchanged` intocado, `archived` só com remoção explícita (ausência ≠ remoção — **[call]**, em linha com "o que não foi tocado permanece").
- Idempotência: a mesma validação repetida (retry) reutiliza a chave da publicação e não duplica itens.

## 7. Chat de teste

- `src/modules/knowledge/test-chat.ts` **já existe** (Fase 3, Task 17): `isTest: true`, sem handoffs/lacunas/bloqueios, devolve `{ reply, sources }` do `answer_trace`.
- Falta: **rota HTTP** + **modo rascunho** + suporte de substrate:
  - **[call]** parâmetro `target: 'draft' | 'published'` (omissão `published`, compatível com o uso actual) — o `retrieve` recebe o conjunto correspondente.
  - **[call] Substrate:** uma **conversa sintética por tenant** marcada de teste (`isTest`, sem contacto real — `conversations` exige `account_id`/`contact_id`, por isso conta/entidade de teste dedicadas), onde fica o histórico multi-turno do mini-chat. Sem handoffs, sem lacunas, sem notificações (registo do `isTest` mantido).
  - **[call] Contradição §7/§11 resolvida:** os chunks **e embeddings do rascunho são calculados na extração** (modelo local, custo zero), mas **a pesquisa de produção filtra só `published`** — o mini-chat em `target=draft` pesquisa o conjunto do rascunho. Embeddings nunca ficam por calcular na validação.

## 8. Superfície API [call — `docs/01` ainda não fixa endpoints de conhecimento]

Fastify (`src/adapters/http/routes/*.ts`), tudo `requireTenant` + **papéis `editor|admin`** (decisão do dono: `agent` fica de fora), zod em todas as entradas, erros pelo `errors.ts` existente:

| Método e rota | Função |
|---|---|
| `POST /v1/knowledge/train/documents` | upload (PDF-texto/TXT/MD/OCR) → job de extração → itens em rascunho |
| `POST /v1/knowledge/train/guided` | respostas do passo a passo → itens em rascunho |
| `GET /v1/knowledge/train/draft` | itens do rascunho (é o "resumo" editável) |
| `PATCH /v1/knowledge/train/draft/:id` / `DELETE …/:id` | corrigir/apagar item do rascunho |
| `POST /v1/knowledge/train/validate` | diff (+ `conflicts`) → confirmação → publicação atómica aditiva |
| `POST /v1/knowledge/chat/test` | mini-chat `isTest` (`target: draft\|published`) |
| `GET /v1/knowledge/items` + `PATCH /v1/knowledge/items/:id` | listagem e **edição rápida do dia-a-dia** (confirmação → publicar) |
| `GET /v1/knowledge/published` + `POST /v1/knowledge/published/revert` | ver activo e **reversão** (histórico por publicação) |

- Extração de documentos/passos usa o **`AIProvider`** com saída estruturada validada (zod) — nunca texto livre do modelo a decidir preços (regra 8).
- Job com idempotência e reprocessamento; falha visível ao utilizador, sem efeitos parciais no activo.
- **[call] Linha de negócio:** o extractor **propõe** a linha (das 4 globais: software/custom/telecom/cctv) e o utilizador **confirma no editor de itens**; a sessão pode pré-selecionar a linha no início. Item sem linha confirmável não é criável. Negócio fora das 4 linhas = ADR futuro (spec multitenant §4.2), fora deste desenho.

## 9. Papéis e acesso — decidido

- **[dono, 2026-10-25]: mantém `editor|admin`** para todo o conhecimento (treino e edição). O papel `agent` **não** escreve — `docs/01` e `docs/05` **não mudam**.
- `platform_admin` (equipa MilVendas): **[call]** leitura do estado do treino de cada tenant apenas via `/v1/platform/*` auditada (`platform.view_tenant`, já existente em `docs/03`); escrita dentro do tenant = 403 (regra de `docs/03` mantida).

## 10. Segurança e isolamento

- Todo o conhecimento carrega `tenant_id`; queries passam pelos guardas `requireTenant`; nenhuma leitura/escrita cruza tenants (ADR-0007); migração `UNIQUE(tenant_id, slug)` obrigatória (§5).
- Inputs validados com zod nas fronteiras; uploads com limites de tamanho/tipo; o conteúdo dos documentos **não** vai para logs.
- Dados pessoais de clientes continuam proibidos no conhecimento (o conhecimento é da empresa, não das conversas — as 20 conversas reais continuam proibidas).

## 11. Embeddings, OCR e chunking (decisões + ADR pendente)

- **[dono, 2026-10-25]:** entrega com **port `EmbeddingsProvider` + job de chunking já ligados**; o **runtime de inferência** (transformers.js/ONNX local, ~300–500 MB de RAM) decide-se num **ADR curto antes de activar**, com plano B se o host (A5) não aguentar.
- Consequência honesta: até esse ADR, a **busca semântica de chunks não fica activa em produção** — os itens estruturados (catálogo/regras via `lookup_catalog`) funcionam desde a primeira entrega; o mini-chat de teste em modo `draft` cobre primeiro o estruturado. Testes usam um embedder falso/determinístico.
- **[call]** Migração `vector(1536)` → `vector(384)` com `multilingual-e5-small` autorizada pela ADR-0002/A4; embeddings calculados na extração do rascunho (§7), pesquisa de produção só sobre `published`.
- **OCR (v1, decidido pelo dono):** dependência nova → **ADR curto** (motor: local vs serviço externo tem implicações de privacidade — documento da empresa sai do país num serviço externo, alinhado com o princípio do ADR-0002) **antes de a dependência entrar**.
- `searchChunks` + `retrieve` ligam-se aqui (o port diz "Fase 2/3"); default continua "nunca inventa fonte".

## 12. Prova (TDD)

- Unitários de decisão: diff de mesclagem (added/updated/unchanged/**conflict**/ausência≠remoção), transições draft→published, guarda `editor|admin` (e recusa de `agent`), chat de teste `target=draft` sem efeitos de handoff, idempotência da validação.
- Integração (PG+Redis reais): publicação atómica com concorrência (duas validações / validação+edição rápida), isolamento cross-tenant, job de chunking com embedder falso.
- Contrato: `eval:baseline` intocado; nenhum teste existente enfraquecido.

## 13. Fica para o builder (pode decidir sem voltar a perguntar)

Parâmetros de chunking; mecânica da fila/job (Redis) e retries; formato exacto dos payloads (zod) e paginação; prompt de extração (saída estruturada validada); se `rules`/`qualification_questions` entram pela mesma via de validação (default: sim); páginas/detalhe do histórico; polling vs eventos Socket.IO do painel (default: polling); implementação concreta do OCR e do runtime de embeddings **depois do respectivo ADR**.
