// Fase 2, Task 2: chunking de documentos e de itens de catálogo, e o fake de
// embeddings usado nos testes. Primitivos puros — sem DB, sem rede.

import assert from 'node:assert/strict';
import test from 'node:test';

import { chunkCatalogItemText, chunkText } from '../../src/modules/knowledge/chunking.js';
import { fakeEmbeddings } from '../helpers/fake-embeddings.js';

/** Parágrafo sintético de palavras distintas (facilita detectar cortes a meio). */
function paragraph(prefix: string, words: number): string {
  return Array.from({ length: words }, (_, i) => `${prefix}w${i}`).join(' ');
}

test('chunkText divide 3 parágrafos longos em chunks dentro do limite', () => {
  const paragraphs = [paragraph('a', 120), paragraph('b', 120), paragraph('c', 120)];
  const text = paragraphs.join('\n\n');

  // overlap 0 para poder reconstruir os parágrafos por concatenação.
  const chunks = chunkText(text, { maxChars: 400, overlapChars: 0 });

  assert.ok(chunks.length >= 3, `esperava >= 3 chunks, veio ${chunks.length}`);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 400, `chunk com ${chunk.length} caracteres > 400`);
    assert.ok(chunk.length > 0, 'chunk vazio');
  }

  const joined = chunks.join(' ');
  for (const p of paragraphs) {
    assert.ok(joined.includes(p), 'parágrafo ausente dos chunks');
  }

  // Nenhuma palavra cortada: todos os tokens dos chunks existem no texto original.
  const words = new Set(text.split(/\s+/));
  for (const chunk of chunks) {
    for (const word of chunk.split(/\s+/)) {
      assert.ok(words.has(word), `palavra cortada no limite: ${word}`);
    }
  }
});

test('chunkText repete os últimos overlapChars do chunk anterior', () => {
  const chunks = chunkText(paragraph('x', 200), { maxChars: 300, overlapChars: 50 });

  assert.ok(chunks.length >= 2, 'esperava mais do que um chunk');
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i] ?? '';
    assert.ok(chunk.length <= 300, `chunk ${i} com ${chunk.length} caracteres > 300`);
    if (i === 0) continue;
    const tail = (chunks[i - 1] ?? '').slice(-50);
    assert.ok(chunk.includes(tail), `chunk ${i} não contém os últimos 50 caracteres do anterior`);
  }
});

test('chunkText de texto curto devolve um único chunk', () => {
  assert.deepEqual(chunkText('texto curto'), ['texto curto']);

  // Texto vazio ou só espaços não produz chunks.
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('  \n\n \t '), []);

  // Opções inválidas falham alto, em vez de gerar chunks sem sentido.
  assert.throws(() => chunkText('texto', { maxChars: 0 }), RangeError);
  assert.throws(() => chunkText('texto', { maxChars: -1 }), RangeError);
  assert.throws(() => chunkText('texto', { maxChars: 100, overlapChars: -1 }), RangeError);
  assert.throws(() => chunkText('texto', { maxChars: 100, overlapChars: 100 }), RangeError);
});

test('chunkCatalogItemText inclui name, summary e details num único chunk', () => {
  const chunks = chunkCatalogItemText({
    name: 'Plano Fibra 100',
    summary: 'Internet fibra até 100 Mbps',
    details: { price: '25.000 Kz', coverage: 'Luanda' },
  });

  assert.equal(chunks.length, 1);
  const [chunk] = chunks;
  assert.ok(chunk?.includes('Plano Fibra 100'), 'falta o name');
  assert.ok(chunk?.includes('Internet fibra até 100 Mbps'), 'falta o summary');
  assert.ok(chunk?.includes('25.000 Kz'), 'falta um valor de details');
  assert.ok(chunk?.includes('Luanda'), 'falta um valor de details');

  // Sem details, a parte é omitida.
  assert.deepEqual(chunkCatalogItemText({ name: 'Plano X', summary: 'Resumo Y' }), [
    'Plano X — Resumo Y',
  ]);
  assert.deepEqual(
    chunkCatalogItemText({ name: 'Plano X', summary: 'Resumo Y', details: null }),
    ['Plano X — Resumo Y'],
  );
});

test('fakeEmbeddings é determinístico, distingue textos e respeita dimensions', async () => {
  const provider = fakeEmbeddings();
  assert.equal(provider.dimensions, 384);

  const [same1] = await provider.embedTexts(['plano fibra 100']);
  const [same2] = await provider.embedTexts(['plano fibra 100']);
  const [different] = await provider.embedTexts(['plano satélite 20']);

  assert.ok(same1 !== undefined && same2 !== undefined && different !== undefined);
  assert.deepEqual(same2, same1, 'mesmo texto tem de dar o mesmo vetor');
  assert.notDeepEqual(different, same1, 'textos diferentes têm de dar vetores diferentes');
  assert.equal(same1.length, 384, 'dimensão default');
  assert.ok(Math.abs(Math.hypot(...same1) - 1) < 1e-9, 'vetor tem de estar normalizado');

  const small = fakeEmbeddings(8);
  const [vector] = await small.embedTexts(['plano fibra 100']);
  assert.equal(small.dimensions, 8);
  assert.equal(vector?.length, 8, 'dimensão pedida ao fake');

  // A ordem dos vetores segue a ordem dos textos.
  const [first, second] = await small.embedTexts(['a', 'b']);
  const [onlyB] = await small.embedTexts(['b']);
  assert.deepEqual(second, onlyB);
  assert.notDeepEqual(first, second);
});
