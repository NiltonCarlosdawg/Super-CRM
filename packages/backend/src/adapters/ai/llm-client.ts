// Fase 3, Task 6: política de timeout/retry sobre um LLMTransport (docs/05 §6).
// Retry SÓ em `rate_limit` (429) e `server` (5xx); `client`, `invalid_response`
// e `timeout` nunca repetem. Atraso = min(base * 2^attempt, max) + random() * jitter.
// O sinal externo aborta antes de cada retry e DURANTE o backoff (nunca no meio
// de uma chamada sem o transporte respeitar o `signal`).

import type {
  LLMCallRequest,
  LLMCallResult,
  LLMTransport,
} from '../../ports/llm-transport.js';

export class LLMError extends Error {
  constructor(
    message: string,
    readonly kind: 'rate_limit' | 'server' | 'client' | 'invalid_response' | 'timeout',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

export interface RetryPolicy {
  timeoutMs: number;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterMs: number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

export const DEFAULT_RETRY_POLICY: Omit<RetryPolicy, 'sleep' | 'random'> = {
  timeoutMs: 20_000,
  maxRetries: 2,
  baseDelayMs: 1_000,
  maxDelayMs: 8_000,
  jitterMs: 500,
};

function abortError(): LLMError {
  return new LLMError('abortado pelo chamador', 'client');
}

function toClientError(err: unknown): LLMError {
  if (err instanceof LLMError) return err;
  return new LLMError(err instanceof Error ? err.message : String(err), 'client');
}

/** Uma tentativa: AbortController próprio ligado ao sinal externo + timeout. */
async function attemptCall(
  t: LLMTransport,
  req: LLMCallRequest,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<LLMCallResult> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<LLMCallResult>((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new LLMError('timeout na chamada ao LLM', 'timeout'));
      }, timeoutMs);
      t.call(req, controller.signal).then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Sleep que se aborta se o sinal externo disparar durante a espera. */
async function sleepUnlessAborted(
  ms: number,
  sleep: (ms: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });
    void sleep(ms).then(() => {
      cleanup();
      resolve();
    });
  });
}

export async function callWithPolicy(
  t: LLMTransport,
  req: LLMCallRequest,
  p: RetryPolicy,
  signal?: AbortSignal,
): Promise<LLMCallResult> {
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw abortError();
    try {
      return await attemptCall(t, req, p.timeoutMs, signal);
    } catch (err) {
      const e = toClientError(err);
      if (e.kind !== 'rate_limit' && e.kind !== 'server') throw e;
      if (attempt >= p.maxRetries) throw e;
      const delay =
        Math.min(p.baseDelayMs * 2 ** attempt, p.maxDelayMs) + p.random() * p.jitterMs;
      await sleepUnlessAborted(delay, p.sleep, signal);
    }
  }
}
