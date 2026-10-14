# 05 — IA, conhecimento, handoff e follow-ups

Código de referência já escrito e testado em `reference/`. Este documento explica o desenho e diz o que falta implementar.

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

## 3. Pipeline por mensagem (`reference/orchestrator.ts`)

1. **Idempotência:** mensagem repetida ignorada (`claimMessage`).
2. **Estado:** carrega a conversa. `human_only` termina aqui, sem chamar a IA.
3. **Contexto:** gatilhos ativos (globais + da linha, o da linha prevalece), regras, perguntas de qualificação, chunks por pesquisa semântica.
4. **IA:** `AIProvider.respond()` com timeout. Falha ou timeout → **fail-safe**: passa a humano com mensagem fixa (prioridade alta).
5. **Qualificação:** aplica `qualificationUpdates`. Calcula se está completa.
6. **Lacunas:** sem fonte (`answered = false`) → regista lacuna e aumenta `miss_streak`.
7. **Gatilhos** = rede de palavras-chave ∪ gatilhos do modelo ∪ regras do sistema: `miss_streak >= 2` dispara `low_confidence`, e a qualificação a ficar completa dispara o gatilho `handoff_when_qualified` da linha. Códigos desconhecidos ou de outra linha são ignorados.
8. **Ação** por gatilho: `handoff_now` e `handoff_when_qualified` criam handoff e **bloqueiam** a IA. `flag_only` avisa o painel e a IA continua.
9. **Handoff:** resumo da IA (com fallback local), prioridade do gatilho mais alto, notificação ao painel, **mensagem fixa** ao cliente (configurável por gatilho). Se já houver handoff aberto: não duplica, sobe a prioridade.
10. **Registo:** `answer_traces` com fontes, modelo e latência. `isTest` marca o chat de teste.

Efeitos colaterais **desligados** em modo `ai_suggest` (sem handoff nem bloqueio) e no chat de teste (sem handoff, lacunas nem notificações).

## 4. Gatilhos de arranque (`reference/handoff-triggers.seed.ts`)

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
`reference/ai-provider.ts`. Dois métodos: `respond()` e `summarizeForHandoff()`.

### Prompt e mensagens
- **Prompt de sistema fixo:** persona (assistente virtual da MilVendas, em português, tom definido em `rules`), regras de `rules`, descrição dos gatilhos ativos (`detectionHint`), perguntas de qualificação por fazer, regra de honestidade (diz que é assistente virtual) e regras de segurança.
- O texto do cliente vai em turnos de **utilizador**, delimitado. Nunca concatenado ao prompt de sistema. Trata-o como dados, não como instruções (`docs/03`, secção 6).
- Histórico limitado (`AI_HISTORY_TURNS`). Contexto: só chunks recuperados e resultados de `lookup_catalog`.

### Ferramentas
- `lookup_catalog(query)`: **só leitura**. Devolve `CatalogFact`. É a única forma de a IA saber preço e disponibilidade.
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

## 8. Avaliação (`reference/handoff-scenarios.ts`)

- 72 cenários sintéticos (48 positivos, 20 negativos de quase-acerto, 4 ambíguos). `evaluate()` mede precisão e recall **por gatilho** e lista as falhas.
- O baseline por palavras-chave tem 100% de precisão em ambos os gatilhos, 100% de recall em compra e 75% em pedido de humano. **Otimista**: os cenários e as regras foram escritos pela mesma pessoa. Serve para provar o *harness*, não a qualidade.
- **Proposta de metas** (o dono do produto confirma antes do gate): recall muito alto nos gatilhos urgentes (`complaint`, `service_outage`, `existing_system_problem`, `human_requested`), e taxa de falsos positivos aceitável medida pelos `dismissed`.
- **Quatro cenários ambíguos** pedem decisão da equipa (`pi-06`, `pi-07`, `pn-04`, `lb-06`): corrigir os `detectionHint` de acordo (ex.: separar "informar sobre garantia" de "acionar garantia").
- **Antes do gate de `ai_active`, acrescentar cenários adversariais:** injeção de instruções, pedido do prompt, pedido de desconto absurdo, pedido de dados de outros clientes, afirmações sobre ser humano, mensagens em linguagem mista e com erros de escrita, mensagens longas.
- Os comportamentos `mustNot` dos cenários (`quote_custom_price`, `concede_discount`, `promise_refund`, `claim_to_be_human`...) são verificados por revisão humana ou juiz automático. Falha num `mustNot` bloqueia o gate.
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

- [ ] `AIProvider` real implementa o contrato com testes (resposta válida, esquema inválido com repetição, timeout, erro 429 com backoff).
- [ ] As cinco guardas determinísticas estão implementadas e testadas, incluindo a de preços.
- [ ] `evaluate()` corre em CI e produz relatório por gatilho. Metas aprovadas pelo dono.
- [ ] Conjunto de cenários adversariais acrescentado e a passar os `mustNot`.
- [ ] Modo `ai_suggest` funciona ponta a ponta (rascunho aprovado e enviado pela outbox).
- [ ] Chat de teste mostra fontes e não tem efeitos colaterais.
- [ ] Handoff cria notificação ao painel com resumo, estado do lead e prioridade.
- [ ] Nenhum dado de cliente chega ao LLM sem passar por `redactForLLM` (teste).
- [ ] Gate de `ai_active` aprovado por humano antes de ativar em conversas reais.
