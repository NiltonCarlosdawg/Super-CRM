# Desenho — "Treinar agente": conhecimento self-service pelo painel (Fase 2)

- **Data:** 2026-10-25 · **Estado:** em revisão (`builder-check`) — **não construir até o dono aprovar**.
- **Origem:** conversa de brainstorming com o dono (2026-10-25). Decisões do dono marcadas **[dono]**; chamadas minhas marcadas **[call]**; presunções minhas marcadas **[presunção]**.
- **Âmbito deste repo:** backend. A interface ("painel") é construída por fora — o contrato deste desenho é a **API REST + guardas + eventos**.

## 1. Intenção e porquê

O conhecimento do CRM (preços, serviços, FAQ, regras, prazos) tem de ser adicionado e mantido **por quem gere a empresa, a partir do painel** — sem deploy, sem CLI, sem passar pela equipa técnica. Quem usa o fluxo é o **gerente ou o atendente da empresa (tenant)** com o seu próprio login **[dono]**. A Fase 2 em `docs/01` previa "CRUD + publicação com versões"; esta conversa fechou o **fluxo completo** de arranque e manutenção em cima desse CRUD.

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
- Anti-objetivos (falhas que contam): estado meio-ativo a atender clientes; fuga de conhecimento entre tenants; ter de re-uploar tudo para mudar um preço; a IA responder preços/prazos/cobertura fora do catálogo publicado (regra 8 dos AGENTS).

## 4. O fluxo (decidido com o dono)

1. O utilizador entra no ecrã **"Treinar agente"** (o painel chama as APIs deste desenho) **[dono]**.
2. Escolhe a via: **upload de documento(s)** (documentação toda da empresa) ou **passo a passo guiado** — o sistema pergunta as informações que um bom atendimento precisa (o que vendem, preços, zonas, prazos, garantias, horários, como lidar com reclamações) **[dono]**.
3. O agente extrai e devolve **itens estruturados editáveis** (catálogo, documentos/FAQ, regras). Ele corrige, apaga ou completa ali mesmo — isto é o "resumo do que entendeu" **[dono]**.
4. **Mini-chat de teste** na hora, contra a versão em rascunho, com as fontes visíveis **[dono]**.
5. **Validar** → publicação **atómica**: as conversas reais passam a usar a nova versão de uma vez, nunca um meio-estado **[presunção, não contrariada 2×]**. O teste fala com o **rascunho**; o atendimento fica na **activa** até à validação **[presunção, não contrariada]**.
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
| Revisão periódica | `reviewed_at` + `review_every_days` (alertas — `docs/01` Fase 2) |
| Correcções humanas | `knowledge_gaps`, `suggestions` (pending/approved/rejected) |
| Histórico e reversão | `docs/01` Fase 2: "publicação com histórico de versões e reversão" **[call: histórico por publicação, não por micro-edição]** |

- **[call]** Publicação aditiva = **transacção** sobre o conjunto `published` do tenant; o histórico guarda o snapshot anterior para reversão.
- **[call]** Itens estruturados (preços, prazos) são a **fonte de verdade** que alimentam `lookup_catalog`/regras; texto longo vira **chunks** para busca semântica. Só `published` é pesquisável.
- **[call]** Migração `vector(1536)` → `vector(384)` com `multilingual-e5-small` local, já autorizada pela ADR-0002/A4.

## 6. Semântica de mesclagem na validação (carga nova)

- A validação recebe o conjunto final de itens do rascunho; o backend calcula o **diff** contra o activo: `added` / `updated` / `unchanged` (correspondência por identidade estável do item — [call]: nome/chave normalizado dentro da linha de negócio; o painel mostra o diff e pede **uma** confirmação).
- Aplicação numa **única transacção**: `updated` substitui (novo prevalece), `added` entra, `unchanged` intocado, `archived` só se o utilizador marcar remoção explícita (remoção não é implícita pela ausência — [call], em linha com "o que não foi tocado permanece").
- Idempotência: a mesma validação repetida (retry) não duplica itens (chave de idempotência por publicação).

## 7. Chat de teste

- `src/modules/knowledge/test-chat.ts` **já existe** (Fase 3, Task 17): `isTest: true`, sem handoffs/lacunas/bloqueios, devolve `{ reply, sources }` lidos do `answer_trace`.
- Falta: **rota HTTP** e **modo rascunho** — [call]: parâmetro `target: 'draft' | 'published'` no qual o `retrieve` lê o conjunto correspondente; por omissão `published` (compatível com o uso actual).

## 8. Superfície API [call — `docs/01` ainda não fixa endpoints de conhecimento]

Fastify (`src/adapters/http/routes/*.ts`), tudo `requireTenant` + roles, zod em todas as entradas, erros pelo `errors.ts` existente:

| Método e rota | Função |
|---|---|
| `POST /v1/knowledge/train/documents` | upload de documento(s) → job de extração → itens em rascunho |
| `POST /v1/knowledge/train/guided` | respostas do passo a passo → itens em rascunho |
| `GET /v1/knowledge/train/draft` | itens do rascunho (é o "resumo" editável) |
| `PATCH /v1/knowledge/train/draft/:id` / `DELETE …/:id` | corrigir/apagar item do rascunho |
| `POST /v1/knowledge/train/validate` | diff + confirmação → publicação atómica (aditiva) |
| `POST /v1/knowledge/chat/test` | mini-chat `isTest` (`target: draft\|published`) |
| `GET /v1/knowledge/items` + `PATCH /v1/knowledge/items/:id` | listagem e **edição rápida do dia-a-dia** (confirmação → publicar) |
| `GET /v1/knowledge/published` + `POST /v1/knowledge/published/revert` | ver activo e **reversão** (histórico) |

- Extração de documentos/passos usa o **`AIProvider`** com saída estruturada validada (zod) — nunca texto livre do modelo a decidir preços (regra 8).
- Estados de documento em processamento: idempotência no job, reprocessável, falha visível ao utilizador (sem efeitos parciais no activo).

## 9. Papéis e acesso — **pergunta ao dono**

- `docs/01` Fase 2 diz CRUD com papéis **`editor`, `admin`**; o dono descreveu **"gerente ou atendente"**. Se "atendente" = papel `agent` (quem responde conversas), o desenho actualiza `docs/01` para `agent|editor|admin` no fluxo de treino; se não, mantém-se `editor|admin`.
- `platform_admin` (equipa MilVendas): **[call]** leitura do estado do treino de cada tenant apenas via `/v1/platform/*` auditada (`platform.view_tenant`, já existente em `docs/03`); escrita dentro do tenant = 403 (regra de `docs/03` mantida).

## 10. Segurança e isolamento

- Todo o conhecimento carrega `tenant_id`; queries passam pelos guardas `requireTenant` existentes; nenhuma leitura/escrita cruza tenants (ADR-0007).
- Inputs validados com zod nas fronteiras; uploads com limites de tamanho/tipo; o conteúdo dos documentos **não** vai para logs.
- Dados pessoais de clientes continuam proibidos no conhecimento (o conhecimento é da empresa, não das conversas — as 20 conversas reais continuam proibidas).

## 11. Embeddings e chunking (job da Fase 2)

- Job: documento → pedaços → `knowledge_chunks` com embedding local `multilingual-e5-small` (384) **[call — ADR-0002/A4]**; embeddings calculados **só na publicação** (rascunho não pesquisável).
- `searchChunks` + `retrieve` ligam-se aqui (o port diz "Fase 2/3 ligam searchChunks e embeddings"); default continua "nunca inventa fonte".
- Sem dependência de rede/API externa de embeddings (ADR-0002).

## 12. Prova (TDD)

- Unitários de decisão: diff de mesclagem (added/updated/unchanged/ausência≠remoção), transições de estado draft→published, guarda de papéis, chat de teste `target=draft` sem efeitos de handoff, idempotência da validação.
- Integração (PG+Redis reais): publicação atómica com concorrência (duas validações simultâneas), isolamento cross-tenant, job de chunking.
- Contrato: `eval:baseline` intocado; nenhum teste existente enfraquecido.

## 13. Fica para o builder (pode decidir sem voltar a perguntar)

Parâmetros de chunking; mecânica da fila/job (Redis) e retries; formato exacto dos payloads (zod) e paginação; prompt de extração (com saída estruturada validada); quem notifica o painel (eventos Socket.IO só se o fluxo os exigir — default: polling da rota); se `rules`/`qualification_questions` entram pela mesma via de validação (default: sim); paginas/detalhe do histórico de versões.
