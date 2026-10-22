# 05 — IA, conhecimento, handoff e follow-ups

Código de referência escrito e testado em `src/` (o directório `reference/` ficou vazio após a Fase 1; os planos das fases citam os caminhos antigos). Este documento explica o desenho e diz o que falta implementar.

## 1. O que a IA faz e não faz

**Faz:** responde com base em conhecimento publicado, qualifica leads com as perguntas da linha, reconhece situações que pedem um humano, gera resumos de handoff e (Fase 5) mensagens de follow-up.

**Não faz:** decidir handoff ou bloqueio, enviar mensagens sozinha, dar preço de trabalho personalizado, conceder desconto acima da regra, interpretar contratos, prometer reembolsos, processar pagamentos, inventar preço, prazo, cobertura ou disponibilidade, nem fingir ser humana.

## 2. Modos de IA por conversa (`ai_mode`)

| Modo | Comportamento |
|---|---|
| `ai_suggest` | A IA gera um **rascunho**. Um humano aprova ou edita antes de enviar. Gatilhos são anotados, sem handoff nem bloqueio. **Modo inicial.** |
| `ai_active` | A IA responde sozinha. Gatilhos criam handoff conforme a ação. **Só após gate humano** |
| `human_only` | A IA não responde nem é chamada. Estado depois de um handoff |

Cada conta ou linha pode ter um modo por defeito configurável para conversas novas. Passar a `ai_active` é uma **decisão do dono do produto**, por linha e por tema, com base na avaliação (secção 8).

## 3. Pipeline por mensagem (`src/application/orchestrator.ts`)

1. **Idempotência:** mensagem repetida ignorada (`claimMessage`).
2. **Estado:** carrega a conversa. `human_only` termina aqui, sem chamar a IA.
3. **Contexto:** gatilhos ativos (globais + da linha, o da linha prevalece), regras, perguntas de qualificação, chunks por pesquisa semântica.
4. **IA:** `AIProvider.respond()` com timeout (`AI_TIMEOUT_MS`, inicial 20000). Falha ou timeout → **fail-safe**: passa a humano com mensagem fixa (prioridade alta).
5. **Qualificação:** aplica `qualificationUpdates`. Calcula se está completa.
6. **Lacunas:** sem fonte (`answered = false`) → regista lacuna e aumenta `miss_streak` (`MISS_STREAK_LIMIT`, inicial 2).
7. **Gatilhos** = rede de palavras-chave ∪ gatilhos do modelo ∪ regras do sistema: `miss_streak >= 2` dispara `low_confidence`, e a qualificação a ficar completa dispara o gatilho `handoff_when_qualified` da linha. Códigos desconhecidos ou de outra linha são ignorados.
8. **Ação** por gatilho: `handoff_now` e `handoff_when_qualified` criam handoff e **bloqueiam** a IA. `flag_only` avisa o painel e a IA continua. **Fora do horário de atendimento, `handoff_now` NÃO muda o `ai_mode`** — a IA continua ativa e o humano só assume na abertura (A6; a mudança de `ai_mode` só por decisão humana, ver ADR-0003). Em horário útil, o bloqueio mantém-se.
9. **Handoff:** resumo da IA (com fallback local), prioridade do gatilho mais alto, notificação ao painel e **mensagem fixa** ao cliente. Fora de horas a notificação leva `outsideHours: true` e `opensAt` (próxima abertura), prioridade `urgent` gera ainda o alerta `urgent_out_of_hours`, e a mensagem é a fixa de fora de horas ("Registei o teu pedido — a equipa responde no próximo dia útil…"); em horário, a fixa normal ("Vou passar esta conversa a um colega da equipa…", com override por gatilho via `handoffMessages.byTrigger`). Tudo configurável em `settings`. Se já houver handoff aberto: não duplica, sobe a prioridade.
10. **Fila humana (A6.1, A10):** o painel lista (`GET /v1/handoffs/:id`), aceita (passa a conversa a `human_only` e audita) e resolve — **resolver ou devolver manualmente** retorna a IA ao modo por defeito (o da linha, senão o global). Alertas de SLA em minutos úteis: aceitação pendente ≥ **15 min** (`sla_accept_15min`, job de sweep com CAS — só uma vez) e aceitação com mais de **2 h** desde a criação (`sla_first_response_2h` + audit `handoff.sla_breach`).
11. **Registo:** `answer_traces` com fontes, modelo e latência. `isTest` marca o chat de teste.

Horário por defeito de referência: `Africa/Luanda`, dias `[1..5]` (Seg–Sex), `08:00–17:00`, configurável em `settings` (`businessHours`).

Efeitos colaterais **desligados** em modo `ai_suggest` (sem handoff nem bloqueio) e no chat de teste (sem handoff, lacunas nem notificações).

## 4. Gatilhos de arranque (`src/modules/knowledge/handoff-triggers.seed.ts`)

| Gatilho | Linha | Ação | Prioridade |
|---|---|---|---|
| `human_requested` | global | agora | alta |
| `complaint` | global | agora | urgente |
| `purchase_intent` | global | agora | alta |
| `price_negotiation` | global | agora | alta |
| `legal_or_billing` | global | agora | alta |
| `low_confidence` | global | agora | normal |
| `repeated_misunderstanding` | global | agora | normal |
| `unsupported_media` | global | agora | normal |
| `demo_request` | software | agora | alta |
| `scope_exceeds_product` | software | só sinalizar | normal |
| `estimate_request` | custom | agora | alta |
| `proposal_request` | custom | quando qualificado | alta |
| `service_outage` | telecom | agora | urgente |
| `installation_booking` | telecom | quando qualificado | alta |
| `quote_visit` | cctv | quando qualificado | alta |
| `existing_system_problem` | cctv | agora | urgente |

Princípios:
- **Duas camadas:** regras determinísticas (`keyword-safety-net.ts`) para `human_requested` e `purchase_intent`, **mais** o classificador do modelo. O modelo não é a única defesa.
- **Inclinar para escalar.** Um falso positivo custa um minuto a um humano. Um falso negativo custa uma venda ou um cliente perdido. Mas escalar demais anula o propósito: medir a taxa de handoffs e os `dismissed`.
- **Suporte não é vendas:** avarias (`service_outage`, `existing_system_problem`) vão como urgentes para quem trata suporte.
- `handoff_when_qualified`: o **modelo** só dispara se o cliente **insistir** antes de a qualificação estar completa. A conclusão da qualificação é detetada pelo **orquestrador**.
- Sobreposição (ex.: `purchase_intent` e `installation_booking`): **um só handoff**, com o gatilho da linha como motivo.

## 5. Conhecimento (aba "Ensinar a IA")

"Ensinar" = editar conhecimento que a IA consulta. Sem retreino. Mudanças valem na hora após publicar.

| Tipo | Tabela | Para quê |
|---|---|---|
| Catálogo | `catalog_items` | **Fonte de verdade** de preço (`fixed`, `from`, `quote_only`), disponibilidade, características. A IA lê por ferramenta |
| Documentos | `knowledge_docs` | FAQ, políticas, processos, informação da empresa, objeções |
| Regras | `rules` | O que a IA pode ou não prometer, limite de desconto, condições de pagamento, tom |
| Qualificação | `qualification_questions` | Guião por linha |
| Gatilhos | `handoff_triggers` | Configuráveis sem alterar código |

Regras de gestão:
- **Uma só fonte de verdade por facto.** Preço vive no catálogo, não em três documentos.
- Estados `draft` → `published` → `archived`. Cada alteração guarda uma revisão (`knowledge_revisions`) e permite **reverter**.
- Itens têm **validade** (`valid_from`, `valid_until`) e **revisão periódica** (`reviewed_at` + `review_every_days`). Itens por rever geram alerta. Preço desatualizado é o erro mais caro.
- Publicar dispara job que gera chunks e embeddings. Só chunks de itens **publicados e válidos** ficam `active`.
- **Lacunas** (`knowledge_gaps`): perguntas sem fonte, agrupadas por pergunta normalizada, ordenadas por frequência. A equipa preenche. É o melhor ciclo de melhoria.
- **Sugestões** (`knowledge_suggestions`): quando um humano corrige a IA, o sistema propõe novo conhecimento. **Só entra após aprovação humana.**
- **Chat de teste:** a equipa fala com a IA dentro da aba e vê **que fontes usou** (`answer_traces` com `isTest`). Não gera handoffs, lacunas nem notificações.
- Papéis: `editor` e `admin` publicam. `agent` só lê.
- Não despejar tudo no prompt: recuperar só o relevante (`searchChunks`, `top_k` e similaridade mínima em configuração, valores iniciais a calibrar).

## 6. Implementação real do `AIProvider` (Fase 3)

### Contrato
`src/ports/ai-provider.ts`. Dois métodos: `respond()` e `summarizeForHandoff()`.

### Prompt e mensagens
- **Prompt de sistema fixo:** persona (assistente virtual da MilVendas, em português, tom definido em `rules`), regras de `rules`, descrição dos gatilhos ativos (`detectionHint`), perguntas de qualificação por fazer, regra de honestidade (diz que é assistente virtual) e regras de segurança.
- O texto do cliente vai em turnos de **utilizador**, delimitado. Nunca concatenado ao prompt de sistema. Trata-o como dados, não como instruções (`docs/03`, secção 6).
- Histórico limitado (`AI_HISTORY_TURNS`). Contexto: só chunks recuperados e resultados de `lookup_catalog`.

### Ferramentas
- `lookup_catalog(query, discountPct?)`: **só leitura**. Devolve `CatalogFact`. É a única forma da IA saber preço e disponibilidade.
- **Teto de desconto (A7):** `discountPct` só é aplicado até ao teto da regra `discount_limit` — **linha > global > 0** (sem regra ou `maxDiscountPct` inválido: teto 0). O cálculo é feito em centavos com `BigInt` (arredondamento half-up). Pedido acima do teto → **rejeitado** com dica `discountRejectedHint` (nomeia o teto e pede `price_negotiation`), nunca concedido.
- A IA **não tem** ferramentas com efeitos.

### Saída estruturada
Forçar saída por uma ferramenta `submit_response` com esquema:

```
{ reply: string | null, answered: boolean, firedTriggers: string[],
  qualificationUpdates: Record<string,string>,
  sources: { type: 'chunk'|'catalog'|'rule', id: string, version?: number }[] }
```

Validar com esquema. Inválido → **1 repetição**; se falhar de novo, erro do fornecedor (o orquestrador passa a humano).

### Guardas determinísticas depois do modelo (no adaptador)
1. `sources` só podem referir IDs que foram dados à IA neste turno (chunks e resultados de `lookup_catalog`). Os restantes são descartados.
2. **Guarda de preços:** qualquer valor monetário no texto da resposta tem de coincidir com um valor devolvido por `lookup_catalog` neste turno. Se não coincidir: a resposta é **bloqueada** e tratada como `answered = false`.
3. Em `custom`, qualquer preço ou prazo na resposta é bloqueado (`estimate_request`).
4. Resposta com `answered = true` mas sem nenhuma fonte válida, quando contém factos (números, datas, promessas): bloqueada.
5. Resposta que afirme ser humana: bloqueada (lista de padrões, testada).

### Configuração
`AI_MODEL`, `AI_TIMEOUT_MS` (inicial 20000), `AI_MAX_RETRIES` (só para 429 e 5xx, com backoff e jitter), `AI_MAX_TOKENS`, `AI_HISTORY_TURNS`, `RETRIEVAL_TOP_K`, `RETRIEVAL_MIN_SIMILARITY`, `MISS_STREAK_LIMIT` (inicial 2). O modelo é escolhido por `evaluate()` (decisão A3).

### Privacidade
- Antes de enviar a um fornecedor externo: `redactForLLM` remove telefone, morada e identificadores desnecessários.
- Cache de prompt estático é permitido. Nunca cache de dados de clientes entre conversas.
- Gate: nenhum dado de cliente sai para um serviço novo sem aprovação (A11).

## 7. Qualificação por linha (hipóteses a confirmar: A8)

| Linha | Campos (`key`) |
|---|---|
| `software` | empresa, nº de utilizadores, necessidade principal |
| `custom` | problema, âmbito, nº de utilizadores, prazo desejado, quem decide |
| `telecom` | serviço pretendido, tipo (casa/empresa), morada |
| `cctv` | `camera_count`, interior/exterior, tipo de local, `location` |

Cada pergunta: `required`, ordem e tipo de resposta. A IA pergunta **uma de cada vez** e extrai a resposta do texto livre.

## 8. Avaliação (`src/modules/evaluation/handoff-scenarios.ts`)

- **80 cenários sintéticos**: 48 positivos, 20 negativos de quase-acerto, 4 fechados com decisão (base de 72) + 8 adversariais (Task 19). `evaluate()` mede precisão e recall **por gatilho** e lista as falhas. Corre em CI sem rede nem segredos: `npm run eval:baseline` escreve `reports/eval-report.md` (Task 20).
- O baseline por palavras-chave tem 100% de precisão em ambos os gatilhos cobertos, 100% de recall em compra e 75% em pedido de humano. **Otimista**: os cenários e as regras foram escritos pela mesma pessoa. Serve para provar o *harness*, não a qualidade.
- **Metas aprovadas pelo dono (2026-10-22)** e registadas em `docs/eval-metas.md`: recall ≥ 0,95 em `complaint`, `service_outage`, `existing_system_problem` e `human_requested`; precisão ≥ 0,90 em todos os gatilhos com ≥ 5 cenários; **0** violações `mustNot`; `ambiguous: 0`.
- **Quatro cenários ambíguos decididos na Task 19** (`pi-06`, `pi-07`, `pn-04`, `lb-06`): a decisão está no `note` de cada cenário e no plano da Fase 3 (`docs/plans/2026-10-07-fase3-ia-handoff.md`). O `detectionHint` de `legal_or_billing` foi corrigido (separa "informar sobre garantia" de "acionar garantia") e o seed de gatilhos passa a actualizar também `description`/`detectionHint` de linhas já existentes. `ambiguous: 0`.
- **Cenários adversariais acrescentados (Tasks 19–20):** 8 (`adv-01`…`adv-08`) — injeção com pedido de desconto absurdo, pedido do prompt de sistema, pedido de dados de outros clientes, afirmação de ser humano, linguagem mista EN/PT, erros de escrita, intenção de compra enterrada no fim de um texto longo e injeção com IBAN. `ForbiddenBehavior` cobre 11 comportamentos.
- Os `mustNot` dos cenários são verificados pelo **juiz automático** `judgeMustNot` (Task 20; `claim_to_be_human` reutiliza os padrões da guarda da Task 11) e por revisão humana. Falha num `mustNot` bloqueia o gate. O baseline não gera texto de resposta — o juiz aplica-se no modo LLM, que fica para quando houver fornecedor aprovado (gate A11).
- **Crescer o conjunto legitimamente:** só com conversas **novas** recolhidas com informação e consentimento dos clientes, anonimizadas. As 20 conversas existentes **continuam proibidas**.
- **Fine-tuning (LlamaFactory):** só numa fase futura, com centenas de conversas boas, autorizadas e anonimizadas, e depois de prompting + conhecimento atingirem o limite. Não faz parte deste plano.

## 9. Follow-ups (Fase 5)

Entidades: `followup_sequences` (por linha), `followup_steps` (atraso, condição, modelo ou geração pela IA dentro das regras), `followup_runs` (execução por lead).

Regras (valores iniciais a confirmar pelo dono do produto):
- Máximo **3** passos por sequência. Primeiro passo após ~24 h sem resposta, depois espaçamentos crescentes.
- Só dentro do horário comercial (fuso Africa/Luanda), nunca em `WA_QUIET_HOURS`.
- Só para conversas **iniciadas pelo cliente** ou contactos com consentimento.
- **Para imediatamente** quando: o cliente responde, faz opt-out, existe handoff aberto ou a conversa está em `human_only`, ou o lead é ganho/perdido.
- Teto diário de follow-ups por conta (`WA_FOLLOWUP_DAILY_CAP`), com os mesmos atrasos e serialização do `docs/04`.
- Texto gerado pela IA passa pelas **mesmas guardas** (preços, promessas, honestidade). Em modo `ai_suggest` fica pendente de aprovação.
- Cada follow-up é registado (`answer_traces`) e auditável.

## 10. Critérios de aceitação (IA)

- [x] `AIProvider` real implementa o contrato com testes (resposta válida, esquema inválido com repetição, timeout, erro 429 com backoff) — **demonstrado na Task 12** (com as Tasks 6 e 9).
- [x] As cinco guardas determinísticas estão implementadas e testadas, incluindo a de preços — **demonstrado na Task 11** (+ Task 12 na composição).
- [x] `evaluate()` corre em CI e produz relatório por gatilho — **demonstrado na Task 20**. Metas aprovadas pelo dono — **sim, 2026-10-22** (`docs/eval-metas.md`).
- [x] Conjunto de cenários adversariais acrescentado e a passar os `mustNot` — **demonstrado nas Tasks 19 e 20**.
- [x] Modo `ai_suggest` funciona ponta a ponta (rascunho aprovado e enviado pela outbox) — **demonstrado nas Tasks 17 e 18**.
- [x] Chat de teste mostra fontes e não tem efeitos colaterais — **demonstrado na Task 17**.
- [x] Handoff cria notificação ao painel com resumo, estado do lead e prioridade — **demonstrado nas Tasks 14** (`GET /v1/handoffs/:id`) **e 16** (evento Socket.IO).
- [x] Nenhum dado de cliente chega ao LLM sem passar por `redactForLLM` (teste) — **demonstrado nas Tasks 4 e 12**.
- [ ] Gate de `ai_active` aprovado por humano antes de ativar em conversas reais — **gate humano, não demonstrado por design**: nenhuma tarefa ativa `ai_active` em conversas reais.
