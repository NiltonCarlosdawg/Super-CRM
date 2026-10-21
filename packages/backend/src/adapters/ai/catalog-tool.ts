// Fase 3, Task 10: ferramenta `lookup_catalog` com a regra de desconto A7.
// Um desconto pedido acima do teto da regra é rejeitado ANTES de consultar o
// catálogo; dentro do teto, o preço devolvido já vem descontado como fato.

import { applyDiscount, resolveDiscountCap } from '../../domain/discounts.js';
import type { CatalogFact, RuleDef } from '../../ports/ai-provider.js';
import type { LLMTool } from '../../ports/llm-transport.js';

/** Tool que o modelo chama para consultar o catálogo (preço/disponibilidade). */
export const LOOKUP_CATALOG_TOOL: LLMTool = {
  name: 'lookup_catalog',
  description:
    'Consulta o catálogo publicado (preço, disponibilidade). Usa sempre antes de dar preço ou prazo.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Termo de pesquisa.' },
      discountPct: { type: 'number', description: 'Percentagem de desconto pedida (0-100).' },
    },
    required: ['query'],
  },
};

export type CatalogToolResult =
  | { ok: true; facts: CatalogFact[]; appliedDiscountPct: number }
  | { ok: false; error: 'DESCONTO_ACIMA_DO_LIMITE'; capPct: number };

export async function runCatalogLookup(input: {
  query: string;
  discountPct?: number;
  rules: readonly RuleDef[];
  lookup: (query: string) => Promise<CatalogFact[]>;
}): Promise<CatalogToolResult> {
  const cap = resolveDiscountCap(input.rules);
  const pct = input.discountPct ?? 0;
  if (pct > cap) {
    return { ok: false, error: 'DESCONTO_ACIMA_DO_LIMITE', capPct: cap };
  }

  const facts = await input.lookup(input.query);
  if (pct > 0) {
    const discounted = facts.map((f) =>
      f.priceAmount !== null && f.pricingMode !== 'quote_only'
        ? { ...f, priceAmount: applyDiscount(f.priceAmount, pct), appliedDiscountPct: pct }
        : f,
    );
    return { ok: true, facts: discounted, appliedDiscountPct: pct };
  }
  return { ok: true, facts, appliedDiscountPct: 0 };
}

export function discountRejectedHint(capPct: number): string {
  return `DESCONTO_ACIMA_DO_LIMITE (teto ${capPct}%). Não podes conceder desconto acima do teto. Responde com answered=false e firedTriggers ["price_negotiation"].`;
}
