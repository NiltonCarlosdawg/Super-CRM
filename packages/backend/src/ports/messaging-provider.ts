// Contrato interno MessagingProvider — cópia VERBATIM de docs/04 §5. O port é
// só tipos + classes de erro; os nomes e formatos reais do WA-AKG são mapeados
// dentro do adaptador (adapters/wa-akg/), depois da auditoria (docs/04 §5).

export type SessionStatus =
  | 'connecting' | 'qr_pending' | 'connected' | 'disconnected' | 'logged_out' | 'unknown';

export interface SendResult {
  providerMessageId: string | null;
  /** 'unknown' = o envio pode ter ocorrido (timeout). NUNCA fazer retry automático. */
  outcome: 'accepted' | 'rejected' | 'unknown';
  error?: string;
}

export type ProviderEvent =
  | { type: 'message.received'; providerEventId: string; sessionId: string;
      providerMessageId: string; from: string; timestamp: Date;
      message: { kind: 'text' | 'audio' | 'image' | 'video' | 'document' | 'other';
                 text?: string; mediaRef?: string } }
  | { type: 'message.status'; providerEventId: string; sessionId: string;
      providerMessageId: string; status: 'sent' | 'delivered' | 'read' | 'failed';
      timestamp: Date }
  | { type: 'session.status'; providerEventId: string; sessionId: string; status: SessionStatus }
  | { type: 'session.qr'; providerEventId: string; sessionId: string; qr: string };

export interface MessagingProvider {
  readonly name: string;
  health(): Promise<{ ok: boolean; detail?: string }>;
  createSession(input: { label: string }): Promise<{ sessionId: string }>;
  getSession(sessionId: string): Promise<{ status: SessionStatus; phone?: string }>;
  getQr(sessionId: string): Promise<{ qr: string; expiresAt?: Date } | null>;
  logout(sessionId: string): Promise<void>;
  sendText(input: { sessionId: string; to: string; text: string; idempotencyKey: string }): Promise<SendResult>;
  sendMedia(input: { sessionId: string; to: string; mediaUrl: string; caption?: string;
                     mimeType: string; idempotencyKey: string }): Promise<SendResult>;
  /** Verifica a assinatura sobre o corpo BRUTO e devolve eventos normalizados. Lança se inválido. */
  verifyAndParseWebhook(headers: Record<string, string | undefined>, rawBody: Buffer): ProviderEvent[];
}

/** Rede/5xx/circuit breaker → transitório: a outbox pode tentar mais tarde. */
export class ProviderUnavailableError extends Error {
  readonly transient = true;
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

/** Breaker aberto → adiar sem gastar tentativa (docs/04 §7). */
export class CircuitOpenError extends Error {
  readonly transient = true;
  constructor(message: string) {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

/** Assinatura ou payload do webhook inválidos (docs/04 §5): rejeitar sem registar evento. */
export class WebhookError extends Error {
  readonly code: 'invalid_signature' | 'payload_invalid';
  constructor(code: 'invalid_signature' | 'payload_invalid', message?: string) {
    super(message ?? `webhook rejeitado: ${code}`);
    this.name = 'WebhookError';
    this.code = code;
  }
}
