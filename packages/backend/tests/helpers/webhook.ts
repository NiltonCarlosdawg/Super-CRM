// Espelho EXACTO do esquema de assinatura do WA-AKG (docs/wa-akg-audit.md §B6;
// fork `src/lib/webhook.ts` `sendWebhookRequest`): header `x-webhook-signature`
// com `sha256=<hex>` do HMAC-SHA256 sobre o corpo BRUTO, sem janela de timestamp.

import { createHmac } from 'node:crypto';

export function signWebhook(
  rawBody: Buffer,
  secret: string,
  opts?: { at?: Date },
): Record<string, string> {
  // O esquema real não tem timestamp/janela — `opts` mantido por compatibilidade
  // com a interface do plano e ignorado de propósito.
  void opts;
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
  return {
    'x-webhook-signature': `sha256=${signature}`,
    'content-type': 'application/json',
  };
}
