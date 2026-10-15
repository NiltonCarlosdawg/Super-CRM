// Estados de mensagem (Task 20; docs/04 §8): só AVANÇAM; failed é terminal a
// partir de queued/sent/delivered; read nunca recua e failed não o sobrepõe.

import assert from 'node:assert/strict';
import test from 'node:test';
import { nextStatus } from '../../src/application/message-status.js';

test('matriz: só avança; failed é terminal a partir de queued/sent/delivered; read nunca recua', () => {
  assert.equal(nextStatus('queued', 'sent'), 'sent');
  assert.equal(nextStatus('sent', 'delivered'), 'delivered');
  assert.equal(nextStatus('delivered', 'read'), 'read');
  assert.equal(nextStatus('delivered', 'sent'), 'delivered', 'evento atrasado não recua');
  assert.equal(nextStatus('read', 'delivered'), 'read');
  assert.equal(nextStatus('queued', 'failed'), 'failed');
  assert.equal(nextStatus('delivered', 'failed'), 'failed');
  assert.equal(nextStatus('failed', 'delivered'), 'failed', 'failed é terminal');
  assert.equal(nextStatus('read', 'failed'), 'read', 'failed não sobrepõe read');
});
