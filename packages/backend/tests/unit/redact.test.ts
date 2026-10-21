// Fase 3, Task 4: redacção de PII antes de qualquer chamada ao LLM (docs/03, A11).

import assert from 'node:assert/strict';
import test from 'node:test';

import { redactForLLM } from '../../src/domain/redact.js';

test('telefones com país e locais são mascarados', () => {
  assert.equal(
    redactForLLM('Liga para +244 923 456 789 ou 912345678'),
    'Liga para [TELEFONE] ou [TELEFONE]',
  );
});

test('morada com número é mascarada', () => {
  assert.equal(redactForLLM('Moro na Rua da Escola, nº 14, Viana'), 'Moro na [MORADA], Viana');
});

test('email e IBAN são mascarados', () => {
  assert.equal(
    redactForLLM('Contacto: joao.silva@mail.example e IBAN AO06 0040 0000 1234 5678 9012 3'),
    'Contacto: [EMAIL] e IBAN [IDENTIFICADOR]',
  );
});

test('preços não são tocados', () => {
  assert.equal(redactForLLM('O plano custa 1.500.000,00 Kz'), 'O plano custa 1.500.000,00 Kz');
});

test('morada sem número é mascarada por inteiro', () => {
  assert.equal(redactForLLM('Rua 12 de Fevereiro'), '[MORADA]');
});
