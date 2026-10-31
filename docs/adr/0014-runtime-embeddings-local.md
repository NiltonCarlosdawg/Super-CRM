# ADR 0014 — Runtime local para embeddings

- Estado: aceite
- Data: 2026-10-29
- Autor: agente; execução autorizada pelo dono no âmbito da Fase 2

## Contexto

A ADR-0002/A4 já escolheu embeddings locais `multilingual-e5-small` com dimensão 384; falta executar a inferência no backend Node do cPanel sem enviar texto a um fornecedor externo. O runtime precisa de cache local, batching e operação degradada quando o modelo não está disponível.

## Opções

1. `@huggingface/transformers` no processo Node, ONNX CPU — menos infra e API de feature extraction; consome RAM/CPU do backend e descarrega os pesos na primeira utilização se o cache estiver vazio.
2. Serviço local separado — isola memória, mas acrescenta processo, deploy e comunicação entre serviços, sem Docker no host escolhido.
3. API externa — reduz carga local, mas contradiz A4 e envia embeddings de conhecimento para fora.

## Decisão

Escolher `@huggingface/transformers` `^4.3.2` no processo Node, modelo `Xenova/multilingual-e5-small`, ONNX CPU com `dtype: 'q8'`, pooling `mean` e normalização L2. Prefixar conteúdos com `passage: ` e queries com `query: `. A versão `4.3.2` era a última publicada no npm consultado em 2026-10-29; a API oficial documenta `pipeline('feature-extraction', ...)`, pooling/normalização e `env.cacheDir`.

`EMBEDDINGS_ENABLED=false` por omissão. Com a flag desligada ou runtime indisponível, retrieve usa FTS em português; publicação guarda chunks sem vetor para reembed posterior. O cache fica em `EMBEDDINGS_CACHE_DIR`; para hosts sem acesso de saída, é pré-semeado com os pesos do modelo. Texto do tenant só é processado localmente, nunca incluído em pedidos HTTP.

## Consequências

- Uma dependência directa, sem novo serviço; o lockfile fixa a versão efectivamente instalada.
- O primeiro carregamento requer internet ou cache pré-semeado e pode consumir centenas de MB de RAM; validar no host antes de activar em produção.
- Testes CI injectam uma pipeline falsa; o smoke com pesos reais é manual e só usa texto sintético.
- Desactivar embeddings não impede pesquisa por texto nem edição/publicação de conhecimento.

## Evidência consultada

- npm registry: `npm view @huggingface/transformers version` → `4.3.2` em 2026-10-29.
- Model card/API: <https://huggingface.co/api/models/Xenova/multilingual-e5-small> → público, `feature-extraction`, dimensão base 384, variantes ONNX quantizadas.
- API feature extraction: <https://huggingface.co/docs/transformers.js/api/pipelines#module_pipelines.FeatureExtractionPipeline> → `pooling: 'mean'`, `normalize: true`.
- Cache local: <https://huggingface.co/docs/transformers.js/en/api/env> → `env.cacheDir` em Node.
