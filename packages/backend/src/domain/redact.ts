// Fase 3, Task 4: redacção de PII antes de QUALQUER chamada ao LLM (docs/03 §4, A11).
// Função pura, sem dependências. Ordem de aplicação: (1) e-mails, (2) IBAN/cartões,
// (3) telefones, (4) moradas. Os telefones usam SÓ formatos que não podem ser um
// preço (com país, agrupados com espaço/traço, locais 9########) — nunca um
// `\d[\d .-]{7,}` genérico, que comeria `1.500.000,00 Kz`. Nenhuma passagem toca
// texto já mascarado (os marcadores não contêm dígitos nem palavras-chave).

export const REDACTED = {
  phone: '[TELEFONE]',
  address: '[MORADA]',
  email: '[EMAIL]',
  identifier: '[IDENTIFICADOR]',
} as const;

export function redactForLLM(text: string): string {
  let s = text;

  // (1) e-mails
  s = s.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, REDACTED.email);

  // (2) IBAN e cartões → identificador
  s = s.replace(/\b[A-Z]{2}\d{2}(?:[ ]?\d{4}){3,}(?:[ ]?\d{1,3})?\b/gi, REDACTED.identifier);
  s = s.replace(/\b(?:\d[ -]?){13,19}\b/g, REDACTED.identifier);

  // (3) telefones (formatos não-confundíveis com preços)
  s = s.replace(/\+\d[\d .-]{7,}\d/g, REDACTED.phone); // com país
  s = s.replace(/\b\d{3}[ .-]\d{3}[ .-]\d{3,4}\b/g, REDACTED.phone); // agrupados
  s = s.replace(/\b9\d{8}\b/g, REDACTED.phone); // local angolano

  // (4) moradas
  s = s.replace(
    /\b(?:rua|avenida|av\.?|estrada|travessa|largo|bairro)\b[^,.\n]*(?:,\s*n[ºo.]?\s*\d+)?/gi,
    REDACTED.address,
  );

  return s;
}
