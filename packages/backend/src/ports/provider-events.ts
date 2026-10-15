// Schema de runtime JUNTO ao tipo do port (fronteira) — usado pelo adaptador
// (Task 12) e pelo job de webhook para validar o evento normalizado antes de o
// registar (docs/04 §5). Os payloads CRUS do WA-AKG são validados no adaptador
// (src/adapters/wa-akg/schemas.ts); aqui valida-se apenas o contrato do port.

import { z } from 'zod';
import { WebhookError, type ProviderEvent } from './messaging-provider.js';

export type { ProviderEvent, SessionStatus } from './messaging-provider.js';

const providerMessageSchema = z.object({
  kind: z.enum(['text', 'audio', 'image', 'video', 'document', 'other']),
  text: z.string().optional(),
  mediaRef: z.string().optional(),
});

export const providerEventSchema: z.ZodType<ProviderEvent> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message.received'),
    providerEventId: z.string().min(1),
    sessionId: z.string().min(1),
    providerMessageId: z.string().min(1),
    from: z.string().min(1),
    timestamp: z.date(),
    message: providerMessageSchema,
  }),
  z.object({
    type: z.literal('message.status'),
    providerEventId: z.string().min(1),
    sessionId: z.string().min(1),
    providerMessageId: z.string().min(1),
    status: z.enum(['sent', 'delivered', 'read', 'failed']),
    timestamp: z.date(),
  }),
  z.object({
    type: z.literal('session.status'),
    providerEventId: z.string().min(1),
    sessionId: z.string().min(1),
    status: z.enum(['connecting', 'qr_pending', 'connected', 'disconnected', 'logged_out', 'unknown']),
  }),
  z.object({
    type: z.literal('session.qr'),
    providerEventId: z.string().min(1),
    sessionId: z.string().min(1),
    qr: z.string().min(1),
  }),
]);

/** Valida um evento normalizado. Inválido ⇒ `WebhookError('payload_invalid')`. */
export function parseProviderEvent(payload: unknown): ProviderEvent {
  const parsed = providerEventSchema.safeParse(payload);
  if (!parsed.success) throw new WebhookError('payload_invalid');
  return parsed.data;
}
