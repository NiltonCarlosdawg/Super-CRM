// Fase 3, Task 10: domínio de descontos (A7) — cap por regra e cálculo half-up.

import assert from 'node:assert/strict';
import test from 'node:test';

import { applyDiscount, resolveDiscountCap } from '../../src/domain/discounts.js';
import type { RuleDef } from '../../src/ports/ai-provider.js';

const globalRule = (pct: number): RuleDef => ({
  id: 'r-g',
  kind: 'discount_limit',
  title: 'Desconto',
  instruction: '',
  lineSlug: null,
  params: { maxDiscountPct: pct },
});
const lineRule = (pct: number): RuleDef => ({ ...globalRule(pct), id: 'r-l', lineSlug: 'software' });

test('cap: a regra da linha prevalece sobre a global; sem regra → 0', () => {
  assert.equal(resolveDiscountCap([globalRule(5), lineRule(15)]), 15);
  assert.equal(resolveDiscountCap([globalRule(5)]), 5);
  assert.equal(resolveDiscountCap([]), 0);
  assert.equal(resolveDiscountCap([{ ...globalRule(0), params: { maxDiscountPct: 'dez' } }]), 0);
});

test('applyDiscount half-up sem floats', () => {
  assert.equal(applyDiscount('1000.00', 10), '900.00');
  assert.equal(applyDiscount('199.99', 15), '169.99');
  assert.equal(applyDiscount('1000.00', 0), '1000.00');
});
