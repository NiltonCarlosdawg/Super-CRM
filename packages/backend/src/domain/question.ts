// Normalização de perguntas para agrupar lacunas de conhecimento repetidas
// (docs/05 §5). Partilhado com a Fase 2 — eles reutilizam, não redefinem.
// Domínio puro: sem I/O, sem dependências (docs/02 §1).

/** trim + minúsculas + espaços colapsados. */
export function normalizeQuestion(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}
