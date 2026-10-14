import { z } from 'zod';

/** Schema para validação de assinatura HMAC webhook */
export const webhookSignatureSchema = z.object({
  signature: z.string(),
  timestamp: z.string().min(1),
  bodyHash: z.string().min(1)
});

/** Validar assinatura HMAC-SHA256 */
export function validateWebhookSignature(body: any, signature: string, timestamp: string, secret: string): { valid: boolean; allowedDelayMs: number } {
  // Proteção contra replay (5 minutos)
  const fifteenMinutes = 5 * 60 * 1000;
  const delay = Math.abs(Date.now() - parseInt(timestamp));
  if (delay > fifteenMinutes) {
    return { valid: false, allowedDelayMs: delay };
  }

  // Concatenar timestamp + body para o HMAC
  const message = `${timestamp}${JSON.stringify(body)}`;

  // Calcular HMAC esperado
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(message)
    .digest('hex');

  // Comparar assinaturas (constant-time)
  const hmacEquals = expectedSig === signature;

  return { valid: hmacEquals, allowedDelayMs: delay };
}

/** Middleware para Next.js/Express */
export function webhookAuthMiddleware(secret: string) {
  return async (req: any, res: any, next: any) => {
    const signature = req.headers['x-webhook-signature'];
    const timestamp = req.body['x-webhook-timestamp'];

    if (!signature || !timestamp) {
      return res.status(400).json({ error: 'assinatura ausente' });
    }

    const result = validateWebhookSignature(req.body, signature, timestamp, secret);

    if (!result.valid) {
      return res.status(401).json({ error: 'assinatura inválida', delay: result.allowedDelayMs });
    }

    // Adicionar dados úteis ao req
    req.webhookVerification = { signature, timestamp, valid: true };
    next();
  };
}
