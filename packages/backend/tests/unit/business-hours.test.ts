// Fase 3, Task 3: domínio de horário de atendimento (Africa/Luanda, UTC+1 sem DST).
// 2026-10-07 = quarta-feira; 2026-10-10 = sábado; 2026-10-12 = segunda-feira.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  businessMinutesBetween,
  isOpenAt,
  nextOpening,
  type BusinessHours,
} from '../../src/domain/business-hours.js';

const b: BusinessHours = { timezone: 'Africa/Luanda', days: [1, 2, 3, 4, 5], open: '08:00', close: '17:00' };

test('aberto no meio da manhã de quarta (10:00 Luanda)', () => {
  assert.equal(isOpenAt(new Date('2026-10-07T09:00:00Z'), b), true);
});

test('aberto na abertura exata (08:00 Luanda)', () => {
  assert.equal(isOpenAt(new Date('2026-10-07T07:00:00Z'), b), true);
});

test('fechado um minuto antes da abertura (07:59)', () => {
  assert.equal(isOpenAt(new Date('2026-10-07T06:59:00Z'), b), false);
});

test('fechado no fecho exato (17:00 Luanda, exclusivo)', () => {
  assert.equal(isOpenAt(new Date('2026-10-07T16:00:00Z'), b), false);
});

test('fechado ao sábado', () => {
  assert.equal(isOpenAt(new Date('2026-10-10T10:00:00Z'), b), false);
});

test('fechado ao domingo', () => {
  assert.equal(isOpenAt(new Date('2026-10-11T10:00:00Z'), b), false);
});

test('nextOpening de sábado devolve segunda 08:00 Luanda', () => {
  // Instante exacto (toISOString inclui ".000"; comparamos o epoch p/ fidelidade ao valor do brief).
  assert.equal(
    nextOpening(new Date('2026-10-10T10:00:00Z'), b)!.getTime(),
    Date.parse('2026-10-12T07:00:00Z'),
  );
});

test('minutos de negócio atravessam o fecho/abertura (10 + 10)', () => {
  assert.equal(
    businessMinutesBetween(new Date('2026-10-07T15:50:00Z'), new Date('2026-10-08T07:10:00Z'), b),
    20,
  );
});

test('minutos de negócio dentro do mesmo dia (60)', () => {
  assert.equal(
    businessMinutesBetween(new Date('2026-10-07T09:00:00Z'), new Date('2026-10-07T10:00:00Z'), b),
    60,
  );
});
