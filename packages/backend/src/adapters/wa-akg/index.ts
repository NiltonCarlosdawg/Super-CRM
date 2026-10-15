// Adaptador WA-AKG do port MessagingProvider (docs/04 §5). Só os tipos do port
// saem daqui; os formatos reais (envelopes, jid, estados) vivem em README.md e
// são validados por zod em schemas.ts. Circuit breaker por instância:
// `cbThreshold` falhas consecutivas (ProviderUnavailableError ou envio 'unknown')
// abrem o breaker durante `cbCooldownMs`; depois uma única chamada de teste
// (meia-abertura): sucesso fecha, falha reabre.

import { normalizePhoneE164 } from '../../domain/phone.js';
import type { MessagingProvider, SendResult } from '../../ports/messaging-provider.js';
import {
  CircuitOpenError,
  ProviderUnavailableError,
} from '../../ports/messaging-provider.js';
import {
  type WaAkgOptions,
  downloadMedia,
  errorText,
  isAbortError,
  readJson,
  throwIfUnavailable,
  waFetch,
} from './http.js';
import {
  createSessionDataSchema,
  listSessionsDataSchema,
  mapSessionStatus,
  okEnvelope,
  okOnlySchema,
  qrSuccessSchema,
  sendDataSchema,
  sessionDataSchema,
} from './schemas.js';
import { verifyAndParseWebhook as verifyWebhook } from './webhook.js';

/** `image/*|video/*|audio/*` → tipo do fork; resto → document. */
function waMediaType(mimeType: string): string {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'document';
}

function fileNameOf(mediaUrl: string): string {
  try {
    const last = new URL(mediaUrl).pathname.split('/').pop();
    return last !== undefined && last.length > 0 ? last : 'arquivo';
  } catch {
    return 'arquivo';
  }
}

class CircuitBreaker {
  private failures = 0;
  private openedAtMs: number | null = null;
  private halfOpen = false;

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => Date,
  ) {}

  /** Lança CircuitOpenError sem tocar na rede quando aberto. */
  before(): void {
    if (this.openedAtMs === null) return;
    if (this.halfOpen) throw new CircuitOpenError('wa-akg: breaker em meia-abertura (tentativa em curso)');
    const elapsed = this.now().getTime() - this.openedAtMs;
    if (elapsed >= this.cooldownMs) {
      this.halfOpen = true; // uma única chamada de teste
      return;
    }
    const waitMs = this.cooldownMs - elapsed;
    throw new CircuitOpenError(`wa-akg: breaker aberto; nova tentativa em ${Math.ceil(waitMs / 1000)}s`);
  }

  success(): void {
    this.failures = 0;
    this.openedAtMs = null;
    this.halfOpen = false;
  }

  failure(): void {
    if (this.halfOpen) {
      this.halfOpen = false;
      this.openedAtMs = this.now().getTime(); // reabre com cooldown novo
      return;
    }
    this.failures += 1;
    if (this.failures >= this.threshold) this.openedAtMs = this.now().getTime();
  }
}

export function createWaAkgAdapter(opts: WaAkgOptions): MessagingProvider {
  const o = opts;
  const breaker = new CircuitBreaker(o.cbThreshold, o.cbCooldownMs, o.now ?? (() => new Date()));

  /** Consultas/gestão: sucesso fecha; ProviderUnavailableError conta falha. */
  const guard = async <T>(run: () => Promise<T>): Promise<T> => {
    breaker.before();
    try {
      const out = await run();
      breaker.success();
      return out;
    } catch (e) {
      if (e instanceof ProviderUnavailableError) breaker.failure();
      throw e;
    }
  };

  /** Envios: 'unknown' conta como falha (não respondeu a tempo); 'rejected' é
   *  resposta do provider ⇒ fecha. */
  const sendOp = async (run: () => Promise<SendResult>): Promise<SendResult> => {
    breaker.before();
    try {
      const out = await run();
      if (out.outcome === 'unknown') breaker.failure();
      else breaker.success();
      return out;
    } catch (e) {
      if (e instanceof ProviderUnavailableError) breaker.failure();
      throw e;
    }
  };

  const queryTimeout = async <T>(op: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (isAbortError(e)) throw new ProviderUnavailableError(`wa-akg: ${op} expirou`);
      throw e;
    }
  };

  /** Classificação comum dos envios (texto e mídia). */
  const classifySend = async (res: Response, op: string): Promise<SendResult> => {
    if (res.status === 401 || res.status >= 500) {
      throw new ProviderUnavailableError(`wa-akg: ${op} HTTP ${res.status}`);
    }
    const body = await readJson(res);
    if (!res.ok) {
      return { providerMessageId: null, outcome: 'rejected', error: errorText(body, res.status) };
    }
    const parsed = okEnvelope(sendDataSchema).safeParse(body);
    if (!parsed.success) {
      // 2xx sem id reconhecível: não inventar id nem repetir automaticamente
      return { providerMessageId: null, outcome: 'unknown', error: 'resposta inesperada do wa-akg (sem id)' };
    }
    return { providerMessageId: parsed.data.data.key.id, outcome: 'accepted' };
  };

  const sendPath = (sessionId: string, jidDigits: string, tail: string): string =>
    `/api/messages/${encodeURIComponent(sessionId)}/${encodeURIComponent(`${jidDigits}@s.whatsapp.net`)}/${tail}`;

  return {
    name: 'wa-akg',

    async health() {
      return guard(async () => {
        const res = await waFetch(o, { path: '/api/sessions', timeoutMs: o.sendTimeoutMs });
        if (!res.ok) throw new ProviderUnavailableError(`wa-akg: health HTTP ${res.status}`);
        const parsed = okEnvelope(listSessionsDataSchema).safeParse(await readJson(res));
        if (!parsed.success) {
          throw new ProviderUnavailableError('wa-akg: resposta inesperada em health');
        }
        return { ok: true };
      });
    },

    async createSession({ label }) {
      return guard(async () => {
        const res = await waFetch(o, {
          path: '/api/sessions',
          init: {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: label }),
          },
          timeoutMs: o.sendTimeoutMs,
        });
        throwIfUnavailable(res, 'createSession');
        const body = await readJson(res);
        if (!res.ok) throw new Error(`wa-akg: createSession rejeitado (${errorText(body, res.status)})`);
        const parsed = okEnvelope(createSessionDataSchema).safeParse(body);
        if (!parsed.success) {
          throw new ProviderUnavailableError('wa-akg: resposta inesperada em createSession');
        }
        return { sessionId: parsed.data.data.sessionId };
      });
    },

    async getSession(sessionId) {
      return guard(async () => {
        const res = await queryTimeout('getSession', () =>
          waFetch(o, { path: `/api/sessions/${encodeURIComponent(sessionId)}`, timeoutMs: o.sendTimeoutMs }),
        );
        throwIfUnavailable(res, 'getSession');
        const body = await readJson(res);
        if (!res.ok) throw new Error(`wa-akg: getSession rejeitado (${errorText(body, res.status)})`);
        const parsed = okEnvelope(sessionDataSchema).safeParse(body);
        if (!parsed.success) {
          throw new ProviderUnavailableError('wa-akg: resposta inesperada em getSession');
        }
        return { status: mapSessionStatus(parsed.data.data.status) };
      });
    },

    async getQr(sessionId) {
      return guard(async () => {
        const res = await queryTimeout('getQr', () =>
          waFetch(o, { path: `/api/sessions/${encodeURIComponent(sessionId)}/qr`, timeoutMs: o.sendTimeoutMs }),
        );
        throwIfUnavailable(res, 'getQr');
        // 400 = sessão ligada; 404 = sem QR agora — em ambos não há QR (README)
        if (res.status === 400 || res.status === 404) return null;
        const body = await readJson(res);
        if (!res.ok) throw new Error(`wa-akg: getQr rejeitado (${errorText(body, res.status)})`);
        const parsed = qrSuccessSchema.safeParse(body);
        if (!parsed.success) {
          throw new ProviderUnavailableError('wa-akg: resposta inesperada em getQr');
        }
        return { qr: parsed.data.qr }; // sem expiresAt: o fork não tem TTL de QR (A4)
      });
    },

    async logout(sessionId) {
      await guard(async () => {
        const res = await queryTimeout('logout', () =>
          waFetch(o, {
            path: `/api/sessions/${encodeURIComponent(sessionId)}/logout`,
            init: { method: 'POST' },
            timeoutMs: o.sendTimeoutMs,
          }),
        );
        throwIfUnavailable(res, 'logout');
        const body = await readJson(res);
        if (!res.ok) throw new Error(`wa-akg: logout rejeitado (${errorText(body, res.status)})`);
        const parsed = okOnlySchema.safeParse(body);
        if (!parsed.success) {
          throw new ProviderUnavailableError('wa-akg: resposta inesperada em logout');
        }
      });
    },

    async sendText(input) {
      const e164 = normalizePhoneE164(input.to);
      if (e164 === null) {
        return { providerMessageId: null, outcome: 'rejected', error: 'to não é E.164 válido' };
      }
      return sendOp(async () => {
        let res: Response;
        try {
          res = await waFetch(o, {
            path: sendPath(input.sessionId, e164.slice(1), 'send'),
            init: {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ message: input.text }),
            },
            timeoutMs: o.sendTimeoutMs,
          });
        } catch (e) {
          if (isAbortError(e)) {
            // timeout a meio: o envio pode ter saído — NUNCA retry automático (port §5)
            return { providerMessageId: null, outcome: 'unknown' };
          }
          throw e;
        }
        return classifySend(res, 'sendText');
      });
    },

    async sendMedia(input) {
      const e164 = normalizePhoneE164(input.to);
      if (e164 === null) {
        return { providerMessageId: null, outcome: 'rejected', error: 'to não é E.164 válido' };
      }
      // download SEM a nossa chave e SEM tocar no breaker (falha do nosso CDN
      // não é indisponibilidade do WA-AKG)
      const dl = await downloadMedia(o, input.mediaUrl);
      if (!dl.ok) {
        if (dl.transient) throw new ProviderUnavailableError(`wa-akg: ${dl.error}`);
        return { providerMessageId: null, outcome: 'rejected', error: dl.error };
      }
      return sendOp(async () => {
        const form = new FormData();
        form.set('file', new File([dl.bytes], fileNameOf(input.mediaUrl), { type: input.mimeType }));
        form.set('type', waMediaType(input.mimeType));
        form.set('caption', input.caption ?? '');
        let res: Response;
        try {
          res = await waFetch(o, {
            path: sendPath(input.sessionId, e164.slice(1), 'media'),
            init: { method: 'POST', body: form },
            timeoutMs: o.sendTimeoutMs,
          });
        } catch (e) {
          if (isAbortError(e)) return { providerMessageId: null, outcome: 'unknown' };
          throw e;
        }
        return classifySend(res, 'sendMedia');
      });
    },

    verifyAndParseWebhook: (headers, rawBody) =>
      verifyWebhook(o.webhookSecret, headers, rawBody, o.logger),
  };
}
