// Fase 3, Task 7: escolha do transporte por `AIConfig.provider`.

import type { LLMTransport } from '../../../ports/llm-transport.js';
import type { AIConfig } from '../config.js';
import { createAnthropicTransport } from './anthropic.js';
import { createOpenAITransport } from './openai.js';

export function createTransport(
  cfg: AIConfig,
  fetchFn: typeof globalThis.fetch,
): LLMTransport {
  if (cfg.provider === 'openai') {
    return createOpenAITransport({
      baseUrl: cfg.baseUrl ?? 'https://api.openai.com',
      apiKey: cfg.apiKey ?? '',
      fetch: fetchFn,
    });
  }
  return createAnthropicTransport({
    baseUrl: cfg.baseUrl ?? 'https://api.anthropic.com',
    apiKey: cfg.apiKey ?? '',
    fetch: fetchFn,
  });
}
