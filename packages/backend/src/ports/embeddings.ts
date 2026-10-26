// Port de embeddings — CRM MilVendas (Fase 2, Task 2). Só tipos, sem lógica.
// É a fronteira entre o CRM e o modelo que transforma texto em vetores (OpenAI,
// Ollama, ...). A implementação concreta (HTTP, auth, normalização) fica em
// src/adapters/ e troca-se sem tocar no CRM. O `model` gravado em
// knowledge_chunks.embedding_model vem daqui, não do chamador.

export interface EmbeddingsProvider {
  /** Identificador do modelo; fica registado em knowledge_chunks.embedding_model. */
  readonly model: string;
  /** Dimensão dos vetores; tem de coincidir com a coluna vector do schema. */
  readonly dimensions: number;

  /**
   * Gera um vetor por cada texto, **pela mesma ordem da entrada**: o resultado
   * `[i]` corresponde sempre a `texts[i]`. O comprimento do resultado é igual
   * ao de `texts`.
   *
   * `signal` cancela o pedido ao fornecedor quando o job é abortado.
   */
  embedTexts(
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly number[][]>;
}
