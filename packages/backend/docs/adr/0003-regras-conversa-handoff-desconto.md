# ADR 0003 — Regras de conversa: horário, IA fora de horas, desconto e devolução à IA

- Estado: aceite
- Data: 2026-10-07
- Autor: agente (aprovado pelo dono do produto)
- Decide: A6, A7, A10 de `docs/01` (detalhe em `docs/06`)

## Contexto

`docs/05` §3 diz que `handoff_now`/`handoff_when_qualified` criam handoff e **bloqueiam
a IA** (`human_only`). O dono quer: horário de atendimento **configurável no painel**,
**IA a responder fora de horas** até o handoff ser aceite, **teto de desconto
percentual configurável** (acima → humano), e regra clara de **devolução à IA**.

## Opções

1. **Horário configurável + IA fora de horas com handoff em fila + teto de desconto
   validado pelo adaptador + devolução por resolução/botão** — mantém o orquestrador
   como única fonte de decisão (D11) e a guarda de preços intacta.
2. Status quo (IA para-se sempre no handoff) — contraria o pedido do dono.
3. Teto de desconto decidido pelo modelo — viola D11 e a guarda de preços.

## Decisão

Opção 1, com estas regras:

- **Fora de horas:** handoff criado na fila (prioridade para a abertura) e a conversa
  **não** muda de `ai_mode`; à abertura, se por aceitar → alerta + `human_only`.
  Urgentes alertam `admin` de imediato. Durante o horário útil, comportamento de
  `docs/05` inalterado. Mensagem fixa fora de horas **configurável** no painel.
- **Desconto:** `rules.kind = 'discount_limit'`, `params.maxDiscountPct` (global +
  override por linha; sem regra → 0). O **adaptador** valida o teto e o preço descontado
  vem de `lookup_catalog` (fato do catálogo). Acima do teto → `price_negotiation` → handoff.
- **Devolução à IA:** handoff marcado como **resolvido** → regressa ao `ai_mode` por
  defeito; existe **botão manual**. Ambos auditados. Sem expiração automática.

## Consequências

- `reference/orchestrator.ts` ganha o ramo "fora de horas" e o fluxo de devolução —
  **alteração autorizada por este ADR**, a implementar e testar na Fase 3.
- `docs/05` §3, §6 e `docs/01` §7 (fluxo de handoff) serão atualizados na implementação.
- Novas configurações: horário, mensagem fixa fora de horas, `maxDiscountPct`,
  SLA (15 min / 2 h) — tabela de configurações do painel.
- Desfaz-se voltando a bloquear sempre no handoff (mantém-se possível: respeitar o
  horário por defeito = fora de horas IA não responde em handoffs).
