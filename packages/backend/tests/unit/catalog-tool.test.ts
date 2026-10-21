// Fase 3, Task 10: ferramenta lookup_catalog com regra de desconto A7.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  discountRejectedHint,
  runCatalogLookup,
} from '../../src/adapters/ai/catalog-tool.js';
import type { CatalogFact, RuleDef } from '../../src/ports/ai-provider.js';

const globalRule = (pct: number): RuleDef => ({
  id: 'r-g',
  kind: 'discount_limit',
  title: 'Desconto',
  instruction: '',
  lineSlug: null,
  params: { maxDiscountPct: pct },
});
const fact = (priceAmount: string | null, pricingMode: 'fixed' | 'quote_only' = 'fixed'): CatalogFact => ({
  id: 'k1',
  name: 'Plano Base',
  summary: '',
  pricingMode,
  priceAmount,
  currency: 'AOA',
  availability: 'available',
  version: 1,
});

test('pedido acima do teto → rejeição, facts vazios', async () => {
  const r = await runCatalogLookup({
    query: 'plano',
    discountPct: 30,
    rules: [globalRule(10)],
    lookup: async () => [fact('250.00')],
  });
  assert.deepEqual(r, { ok: false, error: 'DESCONTO_ACIMA_DO_LIMITE', capPct: 10 });
});

test('pedido dentro do teto → preço devolvido como fato do catálogo', async () => {
  const r = await runCatalogLookup({
    query: 'plano',
    discountPct: 10,
    rules: [globalRule(10)],
    lookup: async () => [fact('250.00')],
  });
  assert.equal(r.ok && r.facts[0]!.priceAmount, '225.00');
  assert.equal(r.ok && r.appliedDiscountPct, 10);
});

test('quote_only não tem preço para descontar', async () => {
  const r = await runCatalogLookup({
    query: 'sistema',
    discountPct: 5,
    rules: [globalRule(10)],
    lookup: async () => [fact(null, 'quote_only')],
  });
  assert.equal(r.ok && r.facts[0]!.priceAmount, null);
});

test('sem regra: discountPct 1 → rejeição; 0 ou ausente → facts intactos', async () => {
  const rejected = await runCatalogLookup({
    query: 'plano',
    discountPct: 1,
    rules: [],
    lookup: async () => [fact('250.00')],
  });
  assert.deepEqual(rejected, { ok: false, error: 'DESCONTO_ACIMA_DO_LIMITE', capPct: 0 });

  const zero = await runCatalogLookup({
    query: 'plano',
    discountPct: 0,
    rules: [],
    lookup: async () => [fact('250.00')],
  });
  assert.equal(zero.ok && zero.facts[0]!.priceAmount, '250.00');

  const absent = await runCatalogLookup({
    query: 'plano',
    rules: [],
    lookup: async () => [fact('250.00')],
  });
  assert.equal(absent.ok && absent.appliedDiscountPct, 0);
});

test('discountRejectedHint nomeia o teto e pede price_negotiation', () => {
  assert.ok(discountRejectedHint(10).includes('DESCONTO_ACIMA_DO_LIMITE (teto 10%)'));
  assert.ok(discountRejectedHint(10).includes('firedTriggers ["price_negotiation"]'));
});
