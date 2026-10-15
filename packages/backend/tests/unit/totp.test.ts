import assert from 'node:assert/strict';
import test from 'node:test';
import { createTotp, encryptSecret, decryptSecret } from '../../src/infra/security/totp.js';

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';  // secret ASCII "12345678901234567890"

test('RFC 6238: T=59s → 287082 (SHA1)', () => {
  const totp = createTotp();
  assert.equal(totp.verify({ secret: RFC_SECRET, code: '287082', at: new Date(59_000) }), true);
  assert.equal(totp.verify({ secret: RFC_SECRET, code: '000000', at: new Date(59_000) }), false);
  assert.equal(totp.verify({ secret: RFC_SECRET, code: '287082', at: new Date(89_000) }), true,  'janela -1 (30s)');
  assert.equal(totp.verify({ secret: RFC_SECRET, code: '287082', at: new Date(119_000) }), false, 'fora da janela');
});
test('otpauthUrl com issuer codificado', () => {
  const url = createTotp().otpauthUrl({ secret: RFC_SECRET, accountEmail: 'admin@test.local', issuer: 'MilVendas' });
  assert.equal(url, 'otpauth://totp/MilVendas:admin@test.local?secret=' + RFC_SECRET + '&issuer=MilVendas&algorithm=SHA1&digits=6&period=30');
});
test('encryptSecret/decryptSecret: roundtrip, IV distinto e chave errada falha', () => {
  const a = encryptSecret(RFC_SECRET, 'x'.repeat(32));
  const b = encryptSecret(RFC_SECRET, 'x'.repeat(32));
  assert.notEqual(a, b);
  assert.equal(decryptSecret(a, 'x'.repeat(32)), RFC_SECRET);
  assert.throws(() => decryptSecret(a, 'y'.repeat(32)));
});
