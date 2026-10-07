// Rede de segurança determinística para os dois gatilhos mais caros de falhar:
// human_requested e purchase_intent. Corre ANTES do classificador do modelo e nunca
// o substitui: apanha os casos óbvios de forma barata e previsível.
// Cobre só frases explícitas. Pedidos indiretos ficam para o modelo.

import type { TriggerCode, Turn } from './ai-provider';

export const SAFETY_NET_COVERS = ['human_requested', 'purchase_intent'] as const;

// Minúsculas e sem acentos, para não depender de como o cliente escreve.
const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

const HUMAN_REQUESTED: RegExp[] = [
  /\b(atendente|humano|pessoa real|pessoa de verdade|operador|gerente)\b/,
  /\bfalar com (alguem|uma pessoa|um humano|o comercial|a equipa|um tecnico|um responsavel|o responsavel|o gerente)\b/,
  /\bliguem-?me\b|\b(me|nos) liguem\b|\b(podem|pode|quero que)( me| nos)? ligar\b/,
  /\bprefiro (falar )?(por |numa )?(chamada|telefone|ligacao)\b/,
];

const PURCHASE_INTENT: RegExp[] = [
  /\bcomo (e que )?(eu )?(posso )?pago\b|\bonde (e que )?(eu )?(posso )?pago\b|\bcomo (faco|fazer) (o )?pagamento\b/,
  /\bquero (comprar|contratar|levar|fechar|avancar|adquirir)\b|\bvou (levar|comprar|contratar|fechar)\b/,
  /\b(pode|podem|vamos) (fechar|avancar)\b|\bfechado\b/,
  /\baceito (o |a |os |as )?(proposta|preco|valor|oferta|orcamento)\b/,
  /\b(iban|nib|dados (de|para) pagamento|dados bancarios|referencia de pagamento)\b/,
];

const lastCustomerText = (turns: readonly Turn[]): string => {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].from === 'customer') return normalize(turns[i].text);
  }
  return '';
};

export function keywordSafetyNet(turns: readonly Turn[]): TriggerCode[] {
  const text = lastCustomerText(turns);
  const hits: TriggerCode[] = [];
  if (HUMAN_REQUESTED.some((re) => re.test(text))) hits.push('human_requested');
  if (PURCHASE_INTENT.some((re) => re.test(text))) hits.push('purchase_intent');
  return hits;
}
