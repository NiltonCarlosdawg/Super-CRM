// Fase 3, Task 9: ferramenta submit_response com saída estruturada validada.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AIValidationError,
  parseSubmitResponse,
} from '../../src/adapters/ai/submit-response.js';

test('args válidos → output exato', () => {
  const out = parseSubmitResponse({
    reply: 'Olá',
    answered: true,
    firedTriggers: ['complaint'],
    qualificationUpdates: { camera_count: '6' },
    sources: [{ type: 'chunk', id: 'c1', version: 2 }],
  });
  assert.deepEqual(out.firedTriggers, ['complaint']);
  assert.equal(out.sources[0]!.version, 2);
});

test('campos desconhecidos são descartados', () => {
  const out = parseSubmitResponse({
    reply: null,
    answered: false,
    firedTriggers: [],
    qualificationUpdates: {},
    sources: [],
    dangerous: true,
  });
  assert.ok(!('dangerous' in out));
});

test('args inválidos lançam AIValidationError com o campo', () => {
  assert.throws(() => parseSubmitResponse({ answered: 'sim' }), AIValidationError);
  assert.throws(
    () =>
      parseSubmitResponse({
        reply: 123,
        answered: true,
        firedTriggers: [],
        qualificationUpdates: {},
        sources: [],
      }),
    AIValidationError,
  );
});

test('source com type fora do conjunto é rejeitada', () => {
  assert.throws(
    () =>
      parseSubmitResponse({
        reply: null,
        answered: false,
        firedTriggers: [],
        qualificationUpdates: {},
        sources: [{ type: 'db', id: 'x' }],
      }),
    AIValidationError,
  );
});
