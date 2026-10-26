// Treinar agente, Task 4: parsers de upload → texto.
// A v1 aceita só texto puro e Markdown (UTF-8). PDF de texto e OCR exigem
// dependência nova e ficam para o ADR pendente (spec §4/§11) — a rota mapeia
// `UnsupportedFormatError` para 415 com essa mensagem, nunca finge suportar.

/** Formato sem parser registado (PDF/OCR/DOCX) — a rota responde 415. */
export class UnsupportedFormatError extends Error {
  constructor(readonly mediaType: string) {
    super(`formato não suportado: ${mediaType}`);
    this.name = 'UnsupportedFormatError';
  }
}

/** Normaliza `text/plain; charset=utf-8` → `text/plain` (minúsculas). */
function baseMediaType(mediaType: string): string {
  return (mediaType.split(';')[0] ?? '').trim().toLowerCase();
}

const PARSERS: Readonly<Record<string, (content: Buffer) => string>> = {
  'text/plain': (content) => content.toString('utf8'),
  'text/markdown': (content) => content.toString('utf8'),
};

/** Tipos aceites na v1 (a rota usa isto para recusar cedo, antes de gravar). */
export function isSupportedMediaType(mediaType: string): boolean {
  return Object.hasOwn(PARSERS, baseMediaType(mediaType));
}

/**
 * Converte o conteúdo de um upload em texto UTF-8.
 * Tipo fora do registry → `UnsupportedFormatError`.
 */
export function parseUpload(mediaType: string, content: Buffer): { text: string } {
  const parser = PARSERS[baseMediaType(mediaType)];
  if (parser === undefined) throw new UnsupportedFormatError(mediaType);
  return { text: parser(content) };
}
