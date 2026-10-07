# 06 — Decisões fechadas (A1–A11)

- Estado: **aprovado pelo dono do produto** (brainstorming de 2026-10-07)
- Substitui a secção 4 "Decisões em aberto" de `docs/01-contexto-e-plano.md`
- Cada decisão tem ADR em `docs/adr/` (ver matriz no fim)

Todas as 11 decisões em aberto de `docs/01` foram decididas e aprovadas.
Este documento é a fonte de verdade dessas decisões; os ADRs guardam o porquê.

---

## A1 — Framework HTTP e runtime

**Decisão:** Node LTS + **Fastify**.

- Fastify cobre: raw body para verificação de webhook (`docs/02` §7), geração de
  OpenAPI a partir do código (`docs/02` §8), rate limiting, cookies/CSRF.
- BullMQ (D7), Socket.IO (D8) e testes com contentores correm nativamente em Node.
- Alternativas rejeitadas: Bun+Elysia (incompatibilidades históricas do BullMQ,
  ecosystem menor — risco sem ganho para um CRM interno); Hono (mais peças soltas).

## A2 — Autenticação do painel

**Decisão:** **Sessões server-side** em PostgreSQL + cookie `HttpOnly`/`Secure`/`SameSite`
+ proteção CSRF (double-submit); palavras-passe **argon2id**; **TOTP obrigatório para
`admin`**, opcional para os restantes.

- Revogação imediata (logout = apagar sessão), rotação e invalidação tal como
  `docs/03` §3 exige. Sem IdP externo (coerente com D2).
- JWT e IdP externos rejeitados: mais código/dependência para o mesmo efeito.

## A3 — Modelo de LLM e fornecedor

**Decisão:** **API externa**, modelo escolhido por **`evaluate()`** contra os 72 cenários
de `reference/handoff-scenarios.ts`, entre 2–3 candidatos (mínimo: um OpenAI, um Anthropic).
Configurável por env (`AI_MODEL`).

- Só avança para dados reais após o gate **A11**.
- Desenvolvimento e benchmark usam **apenas dados sintéticos**.
- Auto-hospedado rejeitado como plano A (qualidade de structured output inferior;
  operação extra) — não é plano B obrigatório.

## A4 — Embeddings (zero custo)

**Decisão:** **`multilingual-e5-small` local** via `@huggingface/transformers` (ONNX, CPU),
atrás do port `EmbeddingsProvider`. Schema muda de `vector(1536)` → **`vector(384)`**
(migração nova; pré-produção, sem chunks para re-embeddar).

- Zero custo por token e **nenhuma query sai do país** — retira embeddings da equação A11.
- A mudança de dimensão em `reference/knowledge.schema.ts` fica **autorizada por este
  ADR/decisão** (regra 14 do `AGENTS.md`), a aplicar na Fase 2.
- Se RAM apertar no cPanel: modelo `MiniLM` (~90 MB) como variante de configuração.
- Port atrás do qual um dia se troca para API externa sem mexer no resto.

## A5 — Topologia de deploy (cPanel partilhado, sem Docker)

**Decisão:** tudo no **cPanel partilhado**, duas apps Node persistentes (Passenger/PM2):

```
cPanel (partilhado)
├── App Node 1: Backend CRM (API + Socket.IO)   → exposto
├── App Node 2: WA-AKG                          → SOLO 127.0.0.1, dashboard/Swagger off
├── PostgreSQL do host: base do CRM + base separada do WA-AKG (credenciais distintas)
└── Redis (se disponível): BullMQ
```

**Planos B embutidos (não bloqueiam o arranque):**

| Se faltar | Alternativa (atrás do mesmo port) |
|---|---|
| `pgvector` | Pesquisa por palavras-chave + FTS Postgres (`tsvector`, português) em `searchChunks()` |
| `Redis` | Fila em Postgres (`pg-boss`) no port de jobs; outbox/idempotência/limites mantêm-se |

**Verificações obrigatórias com evidência (Fase 0, antes de avançar):**

1. `SELECT name FROM pg_available_extensions WHERE name = 'vector';` → existe?
2. Redis disponível no plano?
3. Websockets (Socket.IO) atravessam o proxy do cPanel? (teste echo real)
4. RAM/CPU do plano aguenta 2 apps Node + modelo de embeddings (~300–500 MB)?

Estado: **pendente de verificação pelo dono** — os planos B cobrem os resultados.

## A6 — Handoff, horário e SLA (versão v2)

**Decisão:**

1. **Encaminhamento:** fila única de handoffs visível a `agent`+`admin`; claim com lock
   (primeiro que aceitar fica). Sem round-robin nesta fase (`handoffs.owner_id` já existe).
2. **Horário de atendimento:** **configurável no painel** (tabela de config + API),
   fuso `Africa/Luanda`, default **Seg–Sex 08:00–17:00**.
3. **Fora de horas — a IA continua ativa:**
   - conversas sem handoff: IA responde com todas as guardas atuais;
   - `handoff_now` fora de horas → handoff **criado e na fila** com prioridade para a
     abertura; mensagem fixa **configurável** ao cliente (default: *"Registei o teu pedido —
     a equipa responde no próximo dia útil. Entretanto posso ajudar com outras perguntas."*);
     a conversa **não** passa a `human_only` — a IA continua até um humano aceitar;
   - à **abertura do horário**, se ninguém aceitou: alerta + conversa → `human_only`;
   - urgentes (`complaint`, `service_outage`, `existing_system_problem`): alerta imediato
     aos `admin` mesmo fora de horas;
   - **durante o horário útil: comportamento de `docs/05` inalterado** (handoff → `human_only`).
4. **SLA:** alerta se um handoff passar **15 min** sem aceitação (só em horário útil);
   meta de **2 h úteis** até primeira resposta humana.

⚠️ Altera a regra de `docs/05` §3 ("`handoff_now` bloqueia a IA") fora de horas —
autorizado por ADR-0003; `docs/05` será atualizado na implementação.

## A7 — Regra de desconto da IA (versão v2)

**Decisão:** **teto percentual configurável**, nunca desconto "de cabeça".

- Regra `discount_limit` em `rules`, `params: { "maxDiscountPct": N }`, global com
  **override por linha** (a da linha prevalece). **Sem regra publicada → teto 0.**
- Pedido **≤ teto**: a IA chama `lookup_catalog(query, discountPct)` → o **adaptador
  valida o teto deterministamente** (fora do modelo) e devolve o preço já descontado
  **como fato do catálogo** → guarda de preços de `docs/05` §6 funciona sem exceções.
- Pedido **> teto**: o adaptador rejeita a chamada; o modelo devolve
  `firedTriggers: ["price_negotiation"]` → orquestrador cria **handoff ao humano** (D11 mantém-se).

## A8 — Perguntas de qualificação por linha

**Decisão:** campos de `docs/05` §7 aprovados como **seed inicial** (15 campos, todos
`required`), editáveis no painel (`qualification_questions`: `required`, ordem, tipo).
A IA continua a perguntar **uma de cada vez**.

- `software`: empresa, nº de utilizadores, necessidade principal
- `custom`: problema, âmbito, nº de utilizadores, prazo desejado, quem decide
- `telecom`: serviço pretendido, tipo (casa/empresa), morada
- `cctv`: nº de câmaras, interior/exterior, tipo de local, localização

## A9 — Ciclo das lacunas de conhecimento

**Decisão (opção B):** publicar conhecimento que case com uma lacuna aberta cria uma
**sugestão de resposta na conversa original** (com fontes/`answer_trace` ligada à lacuna);
o agente **aprova e envia**. Sem envios autónomos. Em `ai_active` futuramente poderá
enviar sem clique (config), mas a implementação começa com aprovação humana.

## A10 — Devolver a conversa à IA após handoff

**Decisão:** **resolução do handoff** → conversa regressa ao `ai_mode` por defeito da
linha/conta; **botão manual** "devolver à IA" a qualquer momento. Ambos com registo em
`audit_log` (`docs/03` §3). **Sem expiração automática por inatividade** (risco de a IA
"acordar" numa conversa fria).

## A11 — Base legal: conversas → LLM externo

**Decisão (gate de produção + redação):**

- `redactForLLM` **sempre ativo e testado** em 100% das chamadas (remove telefone,
  morada, identificadores); envia-se só turnos + contexto recuperado, nunca a base.
- **Antes de ir a produção com dados reais:** (1) parecer do jurista sobre base legal,
  (2) notificação/autorização à APD (Lei 22/11), (3) DPA/contrato com o fornecedor do LLM.
- **Tarefas do dono do produto** (o agente só sinaliza): ver `docs/03` §7.
- Enquanto isso: desenvolvimento, testes e `evaluate()` **só com dados sintéticos**.
- As 20 conversas existentes continuam proibidas.

---

## Impacto em documentos e código

| O que muda | Quando |
|---|---|
| `docs/01` §4 passa a "todas fechadas → ver `docs/06`" | já feito com este documento |
| `reference/knowledge.schema.ts`: `vector(1536)` → `vector(384)` | Fase 2, autorizado por ADR-0002 |
| `reference/orchestrator.ts`: regra de IA fora de horas (A6) | Fase 3, autorizado por ADR-0003 |
| `docs/05`: atualizar §3 (handoff fora de horas), §7 (campos seed aprovados), §6 (desconto) | com a implementação |
| AGENTS.md "Comandos" | Fase 0 |

## Gates que permanecem (inalterados)

Auditoria WA-AKG, schema base, primeiro envio real, campanha em produção, `ai_active`,
patches ao WA-AKG, dados a serviços externos novos — mais os dois novos:
**verificações do cPanel (A5)** e **A11 antes de produzir com dados reais**.

## Matriz de ADRs

| Decisão | ADR |
|---|---|
| A1, A2, A5 | `docs/adr/0001-stack-http-auth-deploy.md` |
| A3, A4, A11 | `docs/adr/0002-fornecedores-ia-privacidade.md` |
| A6, A7, A10 | `docs/adr/0003-regras-conversa-handoff-desconto.md` |
| A8, A9 | `docs/adr/0004-qualificacao-lacunas.md` |
