import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePhoneE164, maskPhone } from '../../src/domain/phone.js';

test('normalizePhoneE164', () => {
  assert.equal(normalizePhoneE164('+244 923 111 222'), '+244923111222');
  assert.equal(normalizePhoneE164('00244923111222'), '+244923111222');
  assert.equal(normalizePhoneE164('+244-923.111(222)'), '+244923111222');
  assert.equal(normalizePhoneE164('923111222'), null, 'sem código de país não se infere');
  assert.equal(normalizePhoneE164('+244923111'), null, 'curto demais');
  assert.equal(normalizePhoneE164('+2449231112221234'), null, 'longo demais');
  assert.equal(normalizePhoneE164('abc'), null);
  assert.equal(normalizePhoneE164('+244 923 111 222 x'), null);
});
test('maskPhone', () => {
  // Nota: o par de exemplo do plano copiou o esperado do logger histórico
  // (+244912345612 → '+244 9** *** *12') com outro input; para
  // +244923111222 (local 923111222) a regra "1.º dígito + '*' até n-3 +
  // últimos 2, blocos de 3" dá '*22' — expected corrigido, regra intacta.
  assert.equal(maskPhone('+244923111222'), '+244 9** *** *22');
  assert.equal(maskPhone('923111222'), '***');
});
