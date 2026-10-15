import assert from 'node:assert/strict';
import test from 'node:test';
import { createArgon2Hasher } from '../../src/infra/security/argon2.js';
import { assertPasswordPolicy } from '../../src/domain/password.js';

test('argon2id: hash idempotente por chamada, verify correto/errado', async () => {
  const h = createArgon2Hasher();
  const hash = await h.hash('senha-muito-forte-123');
  assert.ok(hash.startsWith('$argon2id$'));
  assert.equal(await h.verify(hash, 'senha-muito-forte-123'), true);
  assert.equal(await h.verify(hash, 'senha-muito-forte-124'), false);
  assert.notEqual(await h.hash('senha-muito-forte-123'), hash, 'sal novo a cada hash');
});
test('assertPasswordPolicy: 11 chars lança weak_password; 12 passa', () => {
  assert.throws(() => assertPasswordPolicy('curta123456'), /weak_password/);
  assert.doesNotThrow(() => assertPasswordPolicy('senha-muito-forte-123'));
});
