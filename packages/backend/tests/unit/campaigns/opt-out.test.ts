import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { detectOptOut } from '../../../src/domain/campaigns/opt-out.js';

describe('detectOptOut', () => {
  it('deteta "SAIR" e variantes configuráveis, palavra inteira', () => {
    const k = ['sair', 'unsubscribe'];
    assert.equal(detectOptOut('SAIR', k), true);
    assert.equal(detectOptOut('sair por favor!!', k), true);
    assert.equal(detectOptOut('SAÍR', k), true);
    assert.equal(detectOptOut('Quero sair desta lista', k), true);
    assert.equal(detectOptOut('unsubscribe now', k), true);
    assert.equal(detectOptOut('sairia amanhã', k), false);
    assert.equal(detectOptOut('vamos sair juntos?', k), true); // contém a palavra inteira "sair"
    assert.equal(detectOptOut('obrigado pela ajuda', k), false);
    assert.equal(detectOptOut('', k), false);
    assert.equal(detectOptOut('SAIR', []), false);
  });
});
