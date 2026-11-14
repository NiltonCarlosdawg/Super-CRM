// Fronteira HTTP: WA-AKG em baixo é 503 transitório, nunca 500 (docs/04 §6).

import assert from 'node:assert/strict';
import test from 'node:test';

import { toProblem } from '../../src/adapters/http/errors.js';
import { ProviderUnavailableError } from '../../src/ports/messaging-provider.js';

test('ProviderUnavailableError → 503 provider_unavailable', () => {
  const { status, body } = toProblem(new ProviderUnavailableError('wa-akg: fetch falhou'), 'req-1');
  assert.equal(status, 503);
  assert.equal(body.title, 'provider_unavailable');
  assert.equal(body.type, 'about:blank#provider_unavailable');
});

test('erro desconhecido continua 500 sem ecoar a mensagem interna', () => {
  const { status, body } = toProblem(new Error('segredo interno'), 'req-2');
  assert.equal(status, 500);
  assert.equal(body.detail, 'erro interno');
});
