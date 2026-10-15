import assert from 'node:assert/strict';
import test from 'node:test';
import { createLoginLimiter } from '../../src/application/auth/login-limiter.js';

test('bloqueio progressivo: 5 falhas bloqueiam; 2.º bloqueio dobra; sucesso limpa', () => {
  let t = Date.parse('2026-10-07T10:00:00.000Z');
  const l = createLoginLimiter({ max: 5, windowMs: 900000, lockMaxMs: 3600000 }, () => new Date(t));
  for (let i = 0; i < 5; i++) { assert.equal(l.check('a@b.c|1.2.3.4').allowed, true); l.fail('a@b.c|1.2.3.4'); }
  const r = l.check('a@b.c|1.2.3.4');
  assert.equal(r.allowed, false);
  assert.equal((r as { retryAfterSeconds: number }).retryAfterSeconds, 30);   // 2^(5-5) * 30s
  l.fail('a@b.c|1.2.3.4');                                                    // 6.ª falha → dobra
  const r2 = l.check('a@b.c|1.2.3.4');
  assert.equal((r2 as { retryAfterSeconds: number }).retryAfterSeconds, 60);
  t += 61_000;
  assert.equal(l.check('a@b.c|1.2.3.4').allowed, true);                       // expirou o 2.º bloqueio
  l.reset('a@b.c|1.2.3.4');
  assert.equal(l.check('a@b.c|1.2.3.4').allowed, true);
});
