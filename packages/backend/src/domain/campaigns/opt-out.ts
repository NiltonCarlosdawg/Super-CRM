// Fase 4, Task 7: detecção de opt-out por palavra inteira, com a mesma
// normalização do resto do CRM (NFD sem diacríticos + minúsculas).

const normalize = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function detectOptOut(text: string, keywords: readonly string[]): boolean {
  if (keywords.length === 0) return false;
  const normalized = normalize(text);
  return keywords.some((keyword) => new RegExp(`\\b${escapeRegex(normalize(keyword))}\\b`).test(normalized));
}
