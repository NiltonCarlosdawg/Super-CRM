// Treinar agente, Task 8: pontuação de chunks do rascunho (cosseno com embedder
// e sobreposição de tokens sem embedder). Função pura, sem I/O — a camada de
// consulta drizzle é exercitada nos testes de integração.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MIN_SIMILARITY,
  TOP_K,
  scoreChunks,
  tokenScore,
} from '../../src/modules/knowledge/draft-retrieval.js';
import type { EmbeddingsProvider } from '../../src/ports/embeddings.js';

/** Embedder fixo: todas as queries produzem o mesmo vetor (só o cosseno importa). */
function fixedEmbedder(vector: number[]): EmbeddingsProvider {
  return {
    model: 'fixed-test',
    dimensions: vector.length,
    async embedTexts(texts) {
      return texts.map(() => vector);
    },
  };
}

test('com embedder → cosseno entre a query e cada chunk; embeddings null ignorados', async () => {
  const out = await scoreChunks(
    'qualquer pergunta',
    [
      { id: 'a', content: 'irrelevante', embedding: [1, 0] },
      { id: 'b', content: 'irrelevante', embedding: [0, 1] },
      { id: 'c', content: 'sem embedding', embedding: null },
    ],
    fixedEmbedder([1, 0]),
  );

  assert.deepEqual(out, [{ id: 'a', score: 1 }]);
});

test('com embedder e todos os embeddings null → nenhum resultado', async () => {
  const out = await scoreChunks(
    'qualquer pergunta',
    [{ id: 'a', content: 'x', embedding: null }],
    fixedEmbedder([1, 0]),
  );
  assert.deepEqual(out, []);
});

test('sem embedder → sobreposição de tokens normalizada e ordenada', async () => {
  const out = await scoreChunks('Câmaras CCTV preço', [
    { id: 'a', content: 'As câmaras CCTV custam 250.000 AOA', embedding: null },
    { id: 'b', content: 'Preço do pacote', embedding: null },
    { id: 'c', content: 'Instalação garantida', embedding: null },
  ]);

  assert.deepEqual(out.map((c) => c.id), ['a', 'b']);
  assert.ok(Math.abs((out[0]?.score ?? 0) - 2 / 3) < 1e-9, '2 de 3 tokens da query');
  assert.ok(Math.abs((out[1]?.score ?? 0) - 1 / 3) < 1e-9, '1 de 3 tokens da query');
});

test('query sem tokens → todos a zero e descartados pelo mínimo', async () => {
  const out = await scoreChunks('!!! ???', [
    { id: 'a', content: 'As câmaras CCTV custam 250.000 AOA', embedding: null },
  ]);
  assert.deepEqual(out, []);
});

test('corta em topK = 5 depois de ordenar', async () => {
  const chunks = Array.from({ length: 7 }, (_, i) => ({
    id: `c${i}`,
    content: 'câmaras cctv',
    embedding: null,
  }));
  const out = await scoreChunks('câmaras cctv', chunks);
  assert.equal(out.length, TOP_K);
  assert.deepEqual(out.map((c) => c.id), ['c0', 'c1', 'c2', 'c3', 'c4']);
});

test('tokenScore: um token partilhado chega acima do mínimo; zero fica abaixo', () => {
  assert.ok(tokenScore('instalação cctv', 'Instalação incluída') >= MIN_SIMILARITY);
  assert.equal(tokenScore('instalação cctv', 'Pacote de software'), 0);
});
