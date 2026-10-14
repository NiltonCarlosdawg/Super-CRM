# ADR 0004 — Qualificação por linha e fecho do ciclo das lacunas

- Estado: aceite
- Data: 2026-10-07
- Autor: agente (aprovado pelo dono do produto)
- Decide: A8, A9 de `docs/01` (detalhe em `docs/06`)

## Contexto

`docs/05` §7 traz hipóteses de campos de qualificação por linha (a confirmar, A8) e
§5 descreve lacunas de conhecimento sem fecho de ciclo com o cliente (A9): a IA diz
"vou confirmar" e ninguém regressa.

## Opções

1. **Seed dos campos dos docs (15, todos `required`, editáveis no painel) + lacuna
   preenchida gera sugestão de resposta na conversa, com aprovação humana.**
2. Campos mínimos — qualificação completa mais cedo, handoff mais cedo, menos contexto
   para o humano.
3. Envio automático ao cliente quando a lacuna é preenchida — sem revisão, risco de
   casamento errado lacuna↔conversa.

## Decisão

Opção 1.

- Qualificação: seed a partir de `docs/05` §7, tudo editável em
  `qualification_questions`; uma pergunta de cada vez; `required` define a completude
  que dispara `handoff_when_qualified` (detecção no orquestrador, D11).
- Lacunas: ao publicar conhecimento com `gapId` associado → job cria sugestão de
  resposta na conversa original (fontes via `answer_trace`); agente aprova e envia.
  Envio sem clique só em `ai_active` futuro, por config.

## Consequências

- Seed idempotente a acrescentar ao das migrações (junto de `handoff-triggers.seed.ts`).
- Nova ligação `knowledge_gaps → conversa → sugestão` a modelar no schema.
- Sem envios autónomos: mantém o princípio "humano aprova primeiro" (D13) e a regra
  de que sugestões de conhecimento só entram após aprovação humana (`docs/05` §5).
