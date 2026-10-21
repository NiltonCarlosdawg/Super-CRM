// Fase 3, Task 11: as cinco guardas determinísticas (docs/05 §6).
// (1) fontes fora de `allowedSourceIds` são descartadas (não bloqueiam);
// (2)–(5) bloqueiam → reply null, answered false, UMA razão. Ordem de avaliação
// 3 → 2 → 4 → 5: um preço inventado em `custom` conta como custom_price_or_deadline,
// não como price_mismatch.

import type { AIRequest, CatalogFact, LineSlug, SourceRef } from '../ports/ai-provider.js';

export type BlockReason =
  | 'price_mismatch'
  | 'custom_price_or_deadline'
  | 'facts_without_source'
  | 'claims_to_be_human';

export const HUMAN_CLAIM_PATTERNS: readonly RegExp[] = [
  /\bsou (um |uma )?(humano|pessoa real|atendente|operador|empregado[a]?)\b/i,
  /\bfalo (consigo|contigo)[^.\n]{0,30}como (um |uma )?(humano|pessoa)\b/i,
  // `\b` final não casa após `ô` (não é `\w`); lookahead Unicode mantém token completo.
  /\bn[aã]o (sou|é) (um |uma )?(robot|rob[oô]|bot|inteligência artificial|ia)(?!\p{L})/iu,
  /\baqui (fala|responde|está) (um |uma )?(humano|pessoa real)\b/i,
  /\bde pessoa para pessoa\b/i,
];

export function allowedSourceIds(
  req: AIRequest,
  catalogFacts: readonly CatalogFact[],
): Set<string> {
  const ids = new Set<string>();
  for (const c of req.chunks) ids.add(c.id);
  for (const f of catalogFacts) ids.add(f.id);
  for (const r of req.rules) ids.add(r.id);
  return ids;
}

export function filterSources(
  sources: readonly SourceRef[],
  allowed: ReadonlySet<string>,
): SourceRef[] {
  return sources.filter((s) => allowed.has(s.id));
}

const MONEY_RE = /\d{1,3}(?:\.\d{3})+(?:,\d{2})?|\d+,\d{2}|\d+\s*(?:AOA|Kw|Kwanza\b|kwanzas\b)/gi;

export function extractMoney(text: string): string[] {
  return text.match(MONEY_RE) ?? [];
}

export function normalizeMoney(token: string): string {
  const s = token.replace(/\s*(?:AOA|Kwanzas?|Kw|Kz)\s*$/i, '').trim();
  let int: string;
  let frac: string | null = null;
  const commaIdx = s.lastIndexOf(',');
  const dotIdx = s.lastIndexOf('.');
  if (commaIdx >= 0) {
    int = s.slice(0, commaIdx).replace(/\./g, ''); // '.' antes da vírgula = milhares
    frac = s.slice(commaIdx + 1);
  } else if (dotIdx >= 0 && !/^\d{1,3}(?:\.\d{3})+$/.test(s)) {
    int = s.slice(0, dotIdx); // ponto decimal (não padrão de milhares)
    frac = s.slice(dotIdx + 1);
  } else {
    int = s.replace(/\./g, ''); // milhares ou inteiro simples
  }
  if (frac === null || frac === '') return `${int}.00`;
  return `${int}.${frac.padEnd(2, '0').slice(0, 2)}`;
}

const DATE_RE = /\b(amanhã|hoje|próxim[oa]s?|dias?|semanas?|meses?|segunda|terça|quarta|quinta|sexta)\b/i;
const PROMISE_RE = /\b(prometo|garanto|asseguro|ficar[áa]|ser[áa]|estará|vai estar)\b/i;

export function hasFacts(text: string): boolean {
  return /\d/.test(text) || DATE_RE.test(text) || PROMISE_RE.test(text);
}

export function applyBlockingGuards(input: {
  line: LineSlug | null;
  reply: string;
  answered: boolean;
  sources: readonly SourceRef[];
  catalogPrices: readonly string[];
}): { reply: string | null; answered: boolean; blocked: BlockReason[] } {
  const { line, reply, answered, sources, catalogPrices } = input;
  const block = (reason: BlockReason): { reply: null; answered: false; blocked: BlockReason[] } => ({
    reply: null,
    answered: false,
    blocked: [reason],
  });

  // Guarda 3 (custom): qualquer preço OU prazo — antes da 2.
  if (line === 'custom') {
    const money = extractMoney(reply).length > 0;
    const deadline =
      /\b(?:\d{1,3}\s*(?:dias?|semanas?|meses?)|(?:em|até|dentro de)\s+\d{1,3})\b/i.test(reply);
    if (money || deadline) return block('custom_price_or_deadline');
  }

  // Guarda 2: preço fora do catálogo (catálogo vazio → qualquer preço bloqueia).
  const allowed = new Set(catalogPrices.map(normalizeMoney));
  for (const token of extractMoney(reply)) {
    if (!allowed.has(normalizeMoney(token))) return block('price_mismatch');
  }

  // Guarda 4: factos sem fonte (preço vindo do catálogo É fonte).
  if (answered && sources.length === 0 && catalogPrices.length === 0 && hasFacts(reply)) {
    return block('facts_without_source');
  }

  // Guarda 5: fingir ser humano.
  if (HUMAN_CLAIM_PATTERNS.some((re) => re.test(reply))) return block('claims_to_be_human');

  return { reply, answered, blocked: [] };
}
