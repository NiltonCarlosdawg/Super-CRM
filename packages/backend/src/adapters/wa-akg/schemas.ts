// Schemas zod das respostas REAIS do WA-AKG (commit auditado c7dd01a0) —
// extraídos em src/adapters/wa-akg/README.md por inspecção do código.
// Tudo o que entra passa por aqui: formato inesperado ⇒ erro, nunca adivinhar
// (docs/04 §5). Nenhum tipo destes sai do directório.

import { z } from 'zod';

/** Envelope de gestão/envio: `{ status: true, message?, data }`. */
export const okEnvelope = <T extends z.ZodType>(data: T) =>
  z.object({ status: z.literal(true), message: z.string().optional(), data });

/** Logout responde `{ status: true, message }` SEM `data`. */
export const okOnlySchema = z.object({ status: z.literal(true), message: z.string().optional() });

/** Envelope de erro `{ status: false, message?, error? }` — leitura tolerante
 *  (qualquer corpo 4xx pode chegar; só precisamos do texto para `SendResult.error`). */
export const errorTextSchema = z.object({
  message: z.string().optional(),
  error: z.string().optional(),
});

export const sessionDataSchema = z.object({
  sessionId: z.string().min(1),
  status: z.string().min(1),
  qr: z.string().nullable().optional(),
});

export const createSessionDataSchema = z.object({ sessionId: z.string().min(1) });

export const listSessionsDataSchema = z.array(z.unknown());

/** QR real: `{ success: true, qr, base64 }`. */
export const qrSuccessSchema = z.object({
  success: z.literal(true),
  qr: z.string().min(1),
  base64: z.string().optional(),
});

/** Envio real: `data` = resultado do `sendMessage` do Baileys, com `key.id`. */
export const sendDataSchema = z.object({ key: z.object({ id: z.string().min(1) }) });
