// Fase 3, Task 5: configuração da IA + gate A11 (AI_LLM_DATA_APPROVED=false por omissão).

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAIConfig } from '../../src/adapters/ai/config.js';

test('defaults exatos, incluindo o timeout do docs/05 §6', () => {
  const c = parseAIConfig({ AI_PROVIDER: 'openai', AI_MODEL: 'modelo-x', AI_API_KEY: 'k' });
  assert.equal(c.timeoutMs, 20000);
  assert.equal(c.maxRetries, 2);
  assert.equal(c.historyTurns, 10);
  assert.equal(c.retrievalTopK, 5);
  assert.equal(c.retrievalMinSimilarity, 0.75);
  assert.equal(c.missStreakLimit, 2);
  assert.equal(c.dataApproved, false); // gate A11 fechado por omissão
});

test('sem AI_LLM_DATA_APPROVED não é exigida chave', () => {
  assert.equal(parseAIConfig({ AI_PROVIDER: 'anthropic', AI_MODEL: 'm' }).apiKey, null);
});

test('com gate aberto, chave em falta impede o arranque e não vaza o valor', () => {
  assert.throws(
    () => parseAIConfig({ AI_PROVIDER: 'openai', AI_MODEL: 'm', AI_LLM_DATA_APPROVED: 'true' }),
    (e: Error) => /AI_API_KEY/.test(e.message) && !/sk-/.test(e.message),
  );
});

test('timeout ou retries não positivos são rejeitados', () => {
  assert.throws(() => parseAIConfig({ AI_PROVIDER: 'openai', AI_MODEL: 'm', AI_TIMEOUT_MS: '0' }));
  assert.throws(() => parseAIConfig({ AI_PROVIDER: 'openai', AI_MODEL: 'm', AI_MAX_RETRIES: '-1' }));
});
