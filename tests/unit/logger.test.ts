import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';

import { createLogger, maskPhoneE164, withCorrelationId } from '../../src/infra/logger.js';

function memoryStream(sink: string[]): NodeJS.WritableStream {
  return new Writable({
    write(chunk, _encoding, callback) {
      sink.push(String(chunk));
      callback();
    },
  });
}

test('logger emite JSON com nível string, msg, correlationId, evento e time numérico', () => {
  const sink: string[] = [];
  const log = withCorrelationId(
    createLogger({ level: 'info', stream: memoryStream(sink) }),
    'corr-123',
  );

  log.info({ event: 'teste' }, 'mensagem');

  assert.equal(sink.length, 1);
  const firstLine = sink[0];
  assert.ok(firstLine !== undefined);

  const payload = JSON.parse(firstLine) as Record<string, unknown>;
  assert.equal(payload.level, 'info');
  assert.equal(payload.msg, 'mensagem');
  assert.equal(payload.correlationId, 'corr-123');
  assert.equal(payload.event, 'teste');
  assert.equal(typeof payload.time, 'number');
});

test('maskPhoneE164 mantém país, 1.º dígito local e 2 últimos, grupos de 3', () => {
  assert.equal(maskPhoneE164('+244912345612'), '+244 9** *** *12');
  assert.equal(maskPhoneE164('+244912345678'), '+244 9** *** *78');
});

test('maskPhoneE164 com local < 4 dígitos mascara o local inteiro', () => {
  assert.equal(maskPhoneE164('+244912'), '+244 ***');
});

test('maskPhoneE164 sem formato E.164 devolve ***', () => {
  assert.equal(maskPhoneE164('9123456'), '***');
});

test('maskPhoneE164 aplica a regra geral a qualquer código do país', () => {
  // Ruling do coordinator (ledger): o `89` do plano era um desconto errado; a regra
  // "1.º dígito local + 2 últimos" de `91234567890` dá `90`.
  assert.equal(maskPhoneE164('+35191234567890'), '+351 9** *** *** 90');
});
