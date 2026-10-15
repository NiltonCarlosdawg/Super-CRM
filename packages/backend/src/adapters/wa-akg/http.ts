// Chamadas HTTP do adaptador: auth `x-api-key` exacta (api-auth.ts:15 do fork),
// timeout por AbortSignal e classificação de erros no sentido do port
// (docs/04 §5). Mensagens de erro nunca incluem a chave nem corpo completo.

import { ProviderUnavailableError } from '../../ports/messaging-provider.js';
import { errorTextSchema } from './schemas.js';

export interface WaAkgOptions {
  baseUrl: string;
  apiKey: string;
  /** Task 12 (webhook); guardado no closure. */
  webhookSecret: string;
  sendTimeoutMs: number;
  cbThreshold: number;
  cbCooldownMs: number;
  /** Download de mídia para o multipart (limites do fork: 50MB, A4). */
  downloadTimeoutMs?: number;
  maxMediaBytes?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_MEDIA_BYTES = 50 * 1024 * 1024; // MAX_UPLOAD_SIZE_MB=50 (fork .env.example:12)

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError');
}

/** GET/POST ao WA-AKG com a chave nos headers. Rede ⇒ ProviderUnavailableError;
 *  timeout/abort ⇒ propaga (cada operação decide: consulta vs envio). */
export async function waFetch(
  o: WaAkgOptions,
  opts: { path: string; init?: RequestInit; timeoutMs: number },
): Promise<Response> {
  try {
    return await (o.fetchImpl ?? fetch)(`${o.baseUrl.replace(/\/+$/, '')}${opts.path}`, {
      method: 'GET',
      ...opts.init,
      headers: { 'x-api-key': o.apiKey, ...(opts.init?.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (e) {
    if (isAbortError(e)) throw e;
    throw new ProviderUnavailableError(`wa-akg: fetch falhou (${e instanceof Error ? e.name : 'erro'})`);
  }
}

/** 401 (nossa chave) e 5xx ⇒ transitório; não-parseável nunca chega aqui. */
export function throwIfUnavailable(res: Response, op: string): void {
  if (res.status === 401 || res.status >= 500) {
    throw new ProviderUnavailableError(`wa-akg: ${op} HTTP ${res.status}`);
  }
}

export async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/** Texto de erro de um corpo 4xx: `error` ?? `message` ?? `HTTP <status>`. */
export function errorText(body: unknown, status: number): string {
  const parsed = errorTextSchema.safeParse(body);
  if (parsed.success) {
    const text = parsed.data.error ?? parsed.data.message;
    if (text !== undefined && text.length > 0) return text;
  }
  return `HTTP ${status}`;
}

export type DownloadOutcome =
  | { ok: true; bytes: Uint8Array<ArrayBuffer> }
  | { ok: false; error: string; transient: boolean };

/** Descarrega a mediaUrl para o multipart. SEM a nossa API key (a chave não sai
 *  para hosts de terceiros) — decisão humana 2026-10-15 (README §Mídia). */
export async function downloadMedia(o: WaAkgOptions, mediaUrl: string): Promise<DownloadOutcome> {
  let url: URL;
  try {
    url = new URL(mediaUrl);
  } catch {
    return { ok: false, error: 'mediaUrl inválida (http/https esperado)', transient: false };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `scheme não suportado: ${url.protocol}`, transient: false };
  }
  const timeoutMs = o.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const maxBytes = o.maxMediaBytes ?? DEFAULT_MAX_MEDIA_BYTES;
  let res: Response;
  try {
    res = await (o.fetchImpl ?? fetch)(mediaUrl, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const why = isAbortError(e) ? 'download de mídia expirou' : 'download de mídia falhou';
    return { ok: false, error: why, transient: true };
  }
  if (!res.ok) {
    return res.status >= 500
      ? { ok: false, error: `download de mídia HTTP ${res.status}`, transient: true }
      : { ok: false, error: `download de mídia HTTP ${res.status}`, transient: false };
  }
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, error: `mídia excede ${maxBytes} bytes`, transient: false };
  }
  try {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      return { ok: false, error: `mídia excede ${maxBytes} bytes`, transient: false };
    }
    return { ok: true, bytes };
  } catch {
    return { ok: false, error: 'download de mídia falhou', transient: true };
  }
}
