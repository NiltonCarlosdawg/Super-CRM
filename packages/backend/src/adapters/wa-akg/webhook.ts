// Verificação de webhook do WA-AKG sobre o corpo BRUTO (docs/04 §5):
// 1) assinatura HMAC-SHA256 exatamente como o fork a calcula (docs/wa-akg-audit.md
//    §B6, `sendWebhookRequest`): header `x-webhook-signature: sha256=<hex>` sobre
//    o corpo serializado; comparação em tempo constante (tamanhos diferentes ⇒
//    inválido); sem janela de timestamp (o esquema real não tem).
// 2) envelope `{ event, sessionId, timestamp, data }` validado por zod.
// 3) tipos consumidos (message.received | message.status | connection.update)
//    convertidos ao contrato do port; qualquer outro tipo com assinatura válida
//    → ignorado com log, nunca lança; payload inválido → `payload_invalid`.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { normalizePhoneE164 } from '../../domain/phone.js';
import type { ProviderEvent } from '../../ports/messaging-provider.js';
import { WebhookError } from '../../ports/messaging-provider.js';
import { parseProviderEvent } from '../../ports/provider-events.js';
import {
  connectionUpdateDataSchema,
  mapSessionStatus,
  messageReceivedDataSchema,
  messageStatusDataSchema,
  webhookEnvelopeSchema,
} from './schemas.js';

/** Structural (compatível com o pino de `src/infra/logger.ts`). */
export interface WebhookLogger {
  warn(obj: object, msg: string): void;
}

/** Header real do fork: `X-Webhook-Signature` (lookup case-insensitive). */
const SIGNATURE_HEADER = 'x-webhook-signature';

/** `message.status` reais do fork: SENT/DELIVERED/READ (+PENDING que fica de fora). */
const MESSAGE_STATUS_MAP: Record<string, 'sent' | 'delivered' | 'read' | 'failed'> = {
  SENT: 'sent',
  DELIVERED: 'delivered',
  READ: 'read',
  FAILED: 'failed',
};

/** `type` reais do fork (`extractMessageContent`): TEXT/AUDIO/IMAGE/VIDEO/DOCUMENT
 *  (+ CONTACT/LOCATION/STICKER/UNKNOWN e futuros ⇒ 'other', docs/04 §5). */
const KIND_MAP: Record<string, 'text' | 'audio' | 'image' | 'video' | 'document'> = {
  TEXT: 'text',
  AUDIO: 'audio',
  IMAGE: 'image',
  VIDEO: 'video',
  DOCUMENT: 'document',
};

function headerValue(headers: Record<string, string | undefined>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/** Comparação em tempo constante; comprimentos diferentes ⇒ falso (nunca lança). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** `244923111222@s.whatsapp.net` → `+244923111222` pela função única de E.164;
 *  não normalizável ⇒ null (o chamador rejeita com `payload_invalid`). */
function fromToE164(from: string): string | null {
  const local = from.split('@')[0] ?? '';
  if (local.length === 0) return null;
  return normalizePhoneE164(local.startsWith('+') ? local : `+${local}`);
}

export function verifyAndParseWebhook(
  secret: string,
  headers: Record<string, string | undefined>,
  rawBody: Buffer,
  log: WebhookLogger | undefined,
): ProviderEvent[] {
  // 1) assinatura
  const given = headerValue(headers, SIGNATURE_HEADER);
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  if (given === undefined || !safeEqual(given, expected)) {
    throw new WebhookError('invalid_signature');
  }

  // 2) envelope
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new WebhookError('payload_invalid');
  }
  const envelope = webhookEnvelopeSchema.safeParse(payload);
  if (!envelope.success) throw new WebhookError('payload_invalid');
  const { event, sessionId, timestamp } = envelope.data;
  const ts = new Date(timestamp);
  if (Number.isNaN(ts.getTime())) throw new WebhookError('payload_invalid');

  // O WA-AKG não envia id de evento: id determinístico sobre o corpo para que
  // um redelivery idêntico deduplique no job (`sha256:evento:index`).
  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  const events: ProviderEvent[] = [];
  const makeId = (): string => `${bodyHash}:${event}:${events.length}`;

  // 3) conversão por evento
  switch (event) {
    case 'message.received': {
      const d = messageReceivedDataSchema.safeParse(envelope.data.data);
      if (!d.success) throw new WebhookError('payload_invalid');
      const from = fromToE164(d.data.from);
      if (from === null) throw new WebhookError('payload_invalid');
      const kind = KIND_MAP[d.data.type.toUpperCase()] ?? 'other';
      const message: { kind: string; text?: string; mediaRef?: string } = { kind };
      if (kind === 'text' && d.data.content.length > 0) message.text = d.data.content;
      if (d.data.fileUrl !== undefined && d.data.fileUrl !== null && d.data.fileUrl.length > 0) {
        message.mediaRef = d.data.fileUrl;
      }
      events.push(parseProviderEvent({
        type: 'message.received',
        providerEventId: makeId(),
        sessionId,
        providerMessageId: d.data.key.id,
        from,
        timestamp: ts,
        message,
      }));
      break;
    }
    case 'message.status': {
      const d = messageStatusDataSchema.safeParse(envelope.data.data);
      if (!d.success) throw new WebhookError('payload_invalid');
      const status = MESSAGE_STATUS_MAP[d.data.status];
      if (status === undefined) {
        // ex.: PENDING — fora do union do port; nunca mapear à força
        log?.warn({ event, status: d.data.status }, 'wa-akg: estado de mensagem fora do union — ignorado');
        break;
      }
      events.push(parseProviderEvent({
        type: 'message.status',
        providerEventId: makeId(),
        sessionId,
        providerMessageId: d.data.keyId,
        status,
        timestamp: ts,
      }));
      break;
    }
    case 'connection.update': {
      const d = connectionUpdateDataSchema.safeParse(envelope.data.data);
      if (!d.success) throw new WebhookError('payload_invalid');
      events.push(parseProviderEvent({
        type: 'session.status',
        providerEventId: makeId(),
        sessionId,
        status: mapSessionStatus(d.data.status),
      }));
      const qr = d.data.qr;
      if (qr !== undefined && qr !== null && qr.length > 0) {
        events.push(parseProviderEvent({
          type: 'session.qr',
          providerEventId: makeId(),
          sessionId,
          qr,
        }));
      }
      break;
    }
    default:
      // tipo desconhecido (ou conhecido e não consumido: message.sent, group.*…)
      log?.warn({ event }, 'wa-akg: evento de webhook desconhecido — ignorado');
  }

  return events;
}
