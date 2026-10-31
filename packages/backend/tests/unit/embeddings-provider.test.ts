import assert from 'node:assert/strict';
import test from 'node:test';

import { createLocalEmbeddingsProvider } from '../../src/adapters/ai/embeddings-provider.js';

test('local embedder adds E5 prefixes, pools and normalizes without network', async () => {
  const calls: Array<{ texts: string[]; pooling: string; normalize: boolean }> = [];
  const pipelineLoads: Array<{ model: string; dtype: string; cacheDir?: string }> = [];
  const provider = createLocalEmbeddingsProvider({
    cacheDir: '/tmp/embeddings-test',
    loadPipeline: async (model, options) => {
      pipelineLoads.push({ model, ...options });
      return async (texts, inferenceOptions) => {
        calls.push({ texts, ...inferenceOptions });
        return {
          dims: [texts.length, 384],
          tolist: () => texts.map(() => [1, ...Array<number>(383).fill(0)]),
        };
      };
    },
  });

  const [query, passage] = await Promise.all([
    provider.embedTexts(['qual o preço?'], { kind: 'query' }),
    provider.embedTexts(['Plano fibra'], { kind: 'passage' }),
  ]);

  assert.deepEqual(pipelineLoads, [
    { model: 'Xenova/multilingual-e5-small', dtype: 'q8', cacheDir: '/tmp/embeddings-test' },
  ]);
  assert.deepEqual(calls.map((call) => call.texts), [['query: qual o preço?'], ['passage: Plano fibra']]);
  assert.ok(calls.every((call) => call.pooling === 'mean' && call.normalize));
  assert.equal(query?.[0]?.length, 384);
  assert.equal(passage?.[0]?.[0], 1);
});

test('local embedder batches large input and preserves vector order', async () => {
  const batchSizes: number[] = [];
  const provider = createLocalEmbeddingsProvider({
    loadPipeline: async () => async (texts) => {
      batchSizes.push(texts.length);
      return {
        dims: [texts.length, 384],
        tolist: () => texts.map((text) => [Number(text.slice(-2)), ...Array<number>(383).fill(0)]),
      };
    },
  });

  const vectors = await provider.embedTexts(Array.from({ length: 17 }, (_, i) => `text-${i}`));

  assert.deepEqual(batchSizes, [16, 1]);
  assert.equal(vectors.length, 17);
  assert.equal(vectors[16]?.[0], 16);
});
