// Chunking de conhecimento — CRM MilVendas (Fase 2, Task 2). Primitivo puro:
// divide texto em pedaços para embedding, sem DB nem rede. A extracção (Task 4)
// usa `chunkText` para documentos e `chunkCatalogItemText` para itens de
// catálogo, e passa o resultado ao EmbeddingsProvider.

const DEFAULT_MAX_CHARS = 1200;
const DEFAULT_OVERLAP_CHARS = 150;

export interface ChunkOptions {
  /** Tamanho máximo de cada chunk, em caracteres. Default 1200. */
  maxChars?: number;
  /**
   * Caracteres repetidos do fim do chunk anterior no início do seguinte.
   * Default 150. Tem de ser menor que `maxChars`; com `maxChars` pequeno o
   * default é reduzido para `maxChars - 1`.
   */
  overlapChars?: number;
}

export interface CatalogItemText {
  name: string;
  summary: string;
  details?: Record<string, unknown> | null;
}

/**
 * Divide `text` em chunks de, no máximo, `maxChars` caracteres.
 *
 * - Separa primeiro por parágrafo (`\n\s*\n`); junta parágrafos enquanto cabem.
 * - Um parágrafo maior que o limite é partido no último espaço antes do limite
 *   (nunca a meio de uma palavra; só um "word" maior que `maxChars` é cortado).
 * - Entre chunks consecutivos repete os últimos `overlapChars` caracteres do
 *   anterior, recuando ao início da palavra para não começar a meio.
 * - Texto vazio ou só espaços devolve `[]`.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    throw new RangeError('maxChars tem de ser um inteiro maior que zero');
  }

  const overlapChars = opts.overlapChars ?? Math.min(DEFAULT_OVERLAP_CHARS, maxChars - 1);
  if (!Number.isInteger(overlapChars) || overlapChars < 0) {
    throw new RangeError('overlapChars tem de ser um inteiro não negativo');
  }
  if (overlapChars >= maxChars) {
    throw new RangeError('overlapChars tem de ser menor que maxChars');
  }

  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paragraphs.length === 0) return [];

  const normalized = paragraphs.join('\n\n');
  if (normalized.length <= maxChars) return [normalized];

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + maxChars, normalized.length);
    if (end < normalized.length) end = findBreak(normalized, start, end);

    const chunk = normalized.slice(start, end).trim();
    if (chunk.length > 0) chunks.push(chunk);
    if (end >= normalized.length) break;

    start = nextStart(normalized, start, end, overlapChars);
  }

  return chunks;
}

/**
 * Serializa um item de catálogo num único chunk: `name — summary — details`.
 * `details` só entra quando existe, serializado em JSON.
 */
export function chunkCatalogItemText(item: CatalogItemText): string[] {
  const parts = [item.name.trim(), item.summary.trim()];
  if (item.details) parts.push(JSON.stringify(item.details));
  return [parts.join(' — ')];
}

/**
 * Escolhe o fim do chunk antes de `end`: prefere uma fronteira de parágrafo e,
 * se não houver, o último espaço. Sem espaço (palavra maior que `maxChars`),
 * devolve `end` e a palavra é inevitavelmente cortada.
 */
function findBreak(text: string, start: number, end: number): number {
  const window = text.slice(start, end);
  const paragraphBreak = window.lastIndexOf('\n\n');
  if (paragraphBreak > 0) return start + paragraphBreak;

  const space = window.lastIndexOf(' ');
  if (space > 0) return start + space;

  return end;
}

/**
 * Início do chunk seguinte: `end - overlap`, recuado ao início da palavra para
 * não começar a meio. Se o overlap cobrisse o chunk inteiro (chunk anterior
 * mais curto que o overlap), avança sem sobreposição para garantir progresso.
 */
function nextStart(text: string, start: number, end: number, overlap: number): number {
  if (overlap === 0) return end;

  let candidate = Math.max(start, end - overlap);
  while (candidate > start && !isBreakChar(text[candidate - 1])) candidate--;

  if (candidate <= start) return end;
  return candidate;
}

function isBreakChar(char: string | undefined): boolean {
  return char === ' ' || char === '\n';
}
