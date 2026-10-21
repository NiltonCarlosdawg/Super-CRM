// Fase 3, Task 7: helper HTTP partilhado pelos transportes OpenAI/Anthropic.
// Classifica o erro HTTP no vocabulário do `LLMError` (kind) para a política de
// retry da Task 6 decidir se repete.

import { LLMError } from '../llm-client.js';

/** Junta base (origem) + caminho versionado, sem duplicar `\/v\d+` final. */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '').replace(/\/v\d+$/, '');
  return `${base}${path}`;
}

export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  fetchFn: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new LLMError('abortado', 'client');
    }
    throw new LLMError(`erro de rede: ${err instanceof Error ? err.message : String(err)}`, 'server');
  }

  if (res.status === 429) throw new LLMError('rate limit', 'rate_limit', 429);
  if (res.status >= 500) throw new LLMError(`server ${res.status}`, 'server', res.status);
  if (res.status >= 400) throw new LLMError(`client ${res.status}`, 'client', res.status);

  try {
    return await res.json();
  } catch {
    throw new LLMError('corpo de resposta não é JSON', 'invalid_response');
  }
}
