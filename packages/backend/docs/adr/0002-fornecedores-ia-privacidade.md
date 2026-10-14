# ADR 0002 — Fornecedores de IA e privacidade (LLM e embeddings)

- Estado: aceite
- Data: 2026-10-07
- Autor: agente (aprovado pelo dono do produto)
- Decide: A3, A4, A11 de `docs/01` (detalhe em `docs/06`)

## Contexto

Escolher fornecedor de LLM e de embeddings com **zero custo adicional preferido**,
dentro de D9/D10/D11 e do enquadramento legal de `docs/03` §7 (Lei 22/11, APD,
transferência internacional de dados).

## Opções

1. **LLM por API externa escolhido por `evaluate()` + embeddings locais
   (`multilingual-e5-small`, 384) + gate de produção para dados reais** — melhor
   qualidade de structured output onde importa (o orquestrador), custo zero nos
   embeddings, queries de pesquisa nunca saem do país.
2. Tudo auto-hospedado — qualidade de structured output insuficiente nos modelos
   pequenos; `evaluate()` provavelmente falha.
3. Tudo por API — perde o zero custo e envia queries de pesquisa para fora.

## Decisão

Opção 1. `redactForLLM` sempre ativo e testado; **antes de produzir com dados reais**:
parecer de jurista, notificação/autorização à APD e DPA com o fornecedor (tarefas do dono).
Benchmark e desenvolvimento só com dados sintéticos.

## Consequências

- `reference/knowledge.schema.ts`: `vector(1536)` → `vector(384)` — **migração autorizada
  por este ADR** (regra 14 do `AGENTS.md`), a fazer na Fase 2 (pré-produção, sem re-embedding).
- Embeddings atrás do port `EmbeddingsProvider`: trocar para API externa = só adaptador.
- Se A11 bloquear o LLM externo: `AIProvider` fica em mock/chat de teste até decisão;
  não há plano auto-hospedado automático — nova decisão.
- RAM no cPanel: ~300–500 MB para o modelo; alternativa `MiniLM` (~90 MB) por config.
- Risco aceite: qualidade de embeddings local ligeiramente inferior à OpenAI —
  aceitável para RAG de FAQ/catálogo; medir com o chat de teste antes das metas.
