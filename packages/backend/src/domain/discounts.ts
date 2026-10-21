// Fase 3, Task 10: regra de desconto A7 (docs/05). O teto vem da regra
// `discount_limit` (linha > global); sem regra ou params inválidos → teto 0.
// O cálculo é feito em centavos com BigInt (sem floats), arredondamento half-up.

import type { RuleDef } from '../ports/ai-provider.js';

function readCapPct(r: RuleDef): number {
  const raw = r.params?.maxDiscountPct;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > 100) return 0;
  return raw;
}

export function resolveDiscountCap(rules: readonly RuleDef[]): number {
  const caps = rules
    .filter((r) => r.kind === 'discount_limit')
    .map((r) => ({ isLine: r.lineSlug !== null, pct: readCapPct(r) }));
  const lineCaps = caps.filter((c) => c.isLine);
  const pool = lineCaps.length > 0 ? lineCaps : caps.filter((c) => !c.isLine);
  if (pool.length === 0) return 0;
  return Math.max(...pool.map((c) => c.pct));
}

export function applyDiscount(price: string, pct: number): string {
  const [intPart = '0', fracPart = ''] = price.split('.');
  const cents = BigInt(intPart) * 100n + BigInt((fracPart + '00').slice(0, 2));
  const discounted = (cents * BigInt(100 - pct) + 50n) / 100n; // half-up para centavos
  const whole = discounted / 100n;
  const frac = discounted % 100n;
  return `${whole}.${frac.toString().padStart(2, '0')}`;
}
