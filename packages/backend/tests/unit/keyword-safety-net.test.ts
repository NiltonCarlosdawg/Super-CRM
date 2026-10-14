// Testes da rede de segurança por palavras-chave (função pura). Correr com: npm test
// Fixam o comportamento de src/domain/keyword-safety-net.ts: normalização, gatilhos
// explícitos e a regra de só contar o ÚLTIMO turno do cliente.

import assert from 'node:assert/strict';
import test from 'node:test';
import type { Turn } from '../../src/ports/ai-provider.js';
import { keywordSafetyNet } from '../../src/domain/keyword-safety-net.js';

const customer = (text: string): Turn => ({ from: 'customer', text });
const ai = (text: string): Turn => ({ from: 'ai', text });

test('human_requested: pedido explícito de atendente', () => {
  assert.deepEqual(keywordSafetyNet([customer('quero falar com um atendente')]), ['human_requested']);
});

test('human_requested: normalização de caixa e acentos', () => {
  assert.deepEqual(keywordSafetyNet([customer('QUERO FALAR COM UM HUMANO!!!')]), ['human_requested']);
});

test('purchase_intent: como pago', () => {
  assert.deepEqual(keywordSafetyNet([customer('como é que eu pago?')]), ['purchase_intent']);
});

test('purchase_intent: aceita a proposta e pode avançar', () => {
  const hits = keywordSafetyNet([customer('aceito a proposta, pode avançar')]);
  assert.ok(hits.includes('purchase_intent'));
});

test('negativo: pergunta de cobertura não dispara gatilho', () => {
  assert.deepEqual(keywordSafetyNet([customer('Têm cobertura em Cacuaco?')]), []);
});

test('usa o texto do cliente, mesmo com turno de IA depois', () => {
  assert.deepEqual(keywordSafetyNet([customer('falar com uma pessoa'), ai('ok')]), ['human_requested']);
});

test('turno só de IA: sem turno de cliente não há gatilho', () => {
  assert.deepEqual(keywordSafetyNet([{ from: 'ai', text: 'atendente' }]), []);
});
