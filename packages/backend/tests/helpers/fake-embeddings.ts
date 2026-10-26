// Fase 2, Task 2: EmbeddingsProvider falso e determinístico, para testes sem
// rede nem segredos. Mesmo texto → mesmo vetor; textos diferentes → vetores
// diferentes. Os vetores são normalizados (norma 1) para o cosine da Task 8.

import type { EmbeddingsProvider } from '../../src/ports/embeddings.js';

const DEFAULT_DIMENSIONS = 384;

/** Hash FNV-1a de 32 bits sobre as unidades UTF-16 do texto. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** PRNG mulberry32: sequência determinística a partir de uma semente 32 bits. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function embed(text: string, dimensions: number): number[] {
  const next = mulberry32(fnv1a(text));
  const vector = Array.from({ length: dimensions }, () => next() * 2 - 1);

  let norm = Math.hypot(...vector);
  if (norm === 0) {
    // Praticamente impossível, mas evita divisão por zero num vetor degenerado.
    vector[0] = 1;
    norm = 1;
  }
  return vector.map((value) => value / norm);
}

export function fakeEmbeddings(dimensions = DEFAULT_DIMENSIONS): EmbeddingsProvider {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new RangeError('dimensions tem de ser um inteiro maior que zero');
  }

  return {
    model: `fake-embeddings-${dimensions}`,
    dimensions,
    async embedTexts(
      texts: readonly string[],
      signal?: AbortSignal,
    ): Promise<readonly number[][]> {
      signal?.throwIfAborted();
      return texts.map((text) => embed(text, dimensions));
    },
  };
}
