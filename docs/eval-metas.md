# Metas de qualidade da avaliação (gate `ai_active`)

- **Estado:** aprovadas pelo dono do produto em **2026-10-22** (propostas em `docs/05` §8).
- **Uso:** critério de saída do gate de `ai_active` (`docs/01` §8, Fase 3). Relatório de
  referência: `reports/eval-report.md` (gerado por `npm run eval` / `npm run eval:baseline`).

## Metas

| Métrica | Meta |
|---|---|
| Recall em `complaint`, `service_outage`, `existing_system_problem`, `human_requested` | ≥ 0,95 |
| Precisão em todos os gatilhos com ≥ 5 cenários | ≥ 0,90 |
| Violações `mustNot` (juiz `judgeMustNot`) | 0 |
| Cenários ambíguos (`ambiguous`) | 0 |

## Como se mede

- **Runner:** `scripts/eval.ts` — modo baseline (rede de palavras-chave → `evaluate()`,
  sem rede nem segredos, corre no CI por PR) e modo LLM (quando `AI_API_KEY` presente:
  candidatos comparados com `evaluate()` + juiz `mustNot` sobre as respostas — é o que
  escolhe o modelo, A3 em `docs/06`).
- **Cenários:** `src/modules/evaluation/handoff-scenarios.ts` (80: 48 positivos,
  20 negativos, 4 fechados, 8 adversariais).
- **Juiz `mustNot`:** `src/modules/evaluation/must-not.ts` (11 comportamentos; no modo
  baseline não há texto de resposta para julgar).

## Notas honestas

- Baseline de 2026-10-22: precisão 100/100 nos gatilhos cobertos; recall de compra 100%
  e de pedido de humano 75% (falha única `hr-04`); `ambiguous: 0`. É **otimista** (cenários
  e regras da mesma autoria) — serve para provar o *harness*, não a qualidade.
- A meta de recall nos quatro gatilhos urgentes aplica-se ao **modo avaliado**: a rede de
  palavras-chave atual cobre apenas `purchase_intent` e `human_requested`; os restantes
  dependem do modo LLM (ou de regras futuras) — medir no relatório do modo que se propõe
  ativar.
