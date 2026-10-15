// Schemas zod das respostas REAIS do WA-AKG (commit auditado c7dd01a0) —
// extraídos em src/adapters/wa-akg/README.md por inspecção do código.
// Tudo o que entra passa por aqui: formato inesperado ⇒ erro, nunca adivinhar
// (docs/04 §5). Nenhum tipo destes sai do directório.

import { z } from 'zod';
import type { SessionStatus } from '../../ports/messaging-provider.js';

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

// ---------------------------------------------------------------------------
// Webhooks (docs/wa-akg-audit.md §B — capturas do fork, campo a campo)
// ---------------------------------------------------------------------------

/** Envelope real `WebhookPayload` (fork `src/lib/webhook.ts`, interface
 *  `{ event, sessionId, timestamp, data }`; timestamp = `new Date().toISOString()`). */
export const webhookEnvelopeSchema = z.object({
  event: z.string().min(1),
  sessionId: z.string().min(1),
  timestamp: z.string().min(1),
  data: z.unknown(),
});

/** `message.received` (fork `webhook.ts` dispatch com `key`, `pushName`,
 *  `messageTimestamp`, `from`, `receiver`, `sender`, `isGroup`, `chatType`,
 *  `type`, `content`, `fileUrl`, `caption`, `quoted`). Consumidos: key.id,
 *  from, type, content, fileUrl, caption — os restantes são documentados e
 *  tolerados (`.nullish()`), campos novos são ignorados pelo strip do zod. */
export const messageReceivedDataSchema = z.object({
  key: z.object({ id: z.string().min(1) }),
  pushName: z.string().nullish(),
  messageTimestamp: z.union([z.number(), z.string()]).nullish(),
  from: z.string().min(1),
  receiver: z.string().nullish(),
  sender: z.union([z.string(), z.record(z.string(), z.unknown())]).nullish(),
  isGroup: z.boolean().nullish(),
  chatType: z.string().nullish(),
  type: z.string().min(1),
  content: z.string(),
  fileUrl: z.string().nullish(),
  caption: z.string().nullish(),
  quoted: z.unknown().nullish(),
});

/** `message.status` (fork `src/modules/whatsapp/store/index.ts` — `{ keyId, remoteJid, status }`). */
export const messageStatusDataSchema = z.object({
  keyId: z.string().min(1),
  remoteJid: z.string().nullish(),
  status: z.string().min(1),
});

/** `connection.update` (fork `webhook.ts` `onConnectionUpdate` — `{ status, qr }`). */
export const connectionUpdateDataSchema = z.object({
  status: z.string().min(1),
  qr: z.string().nullish(),
});

/** Mapeamento documentado em README.md — nunca adivinhar estados novos. */
const STATUS_MAP: Record<string, SessionStatus> = {
  CONNECTED: 'connected',
  SCAN_QR: 'qr_pending',
  STOPPED: 'disconnected',
  DISCONNECTED: 'disconnected',
  ZOMBIE: 'disconnected',
  FAILED: 'disconnected',
  LOGGED_OUT: 'logged_out',
};

export function mapSessionStatus(status: string): SessionStatus {
  return STATUS_MAP[status] ?? 'unknown';
}
