// Fase 2 Task 3 (design §5.2): o vencimento de revisão é aritmética pura —
// `COALESCE(reviewed_at, updated_at) + review_every_days dias <= now`. O helper
// é partilhado pela API de revisões; nada de SQL aqui.

import assert from 'node:assert/strict';
import test from 'node:test';

import { daysOverdue, dueAt } from '../../src/modules/knowledge/reviews.js';

const DAY = 86_400_000;
const NOW = new Date('2026-11-04T12:00:00.000Z');

test('dueAt: usa reviewed_at quando existe', () => {
  const due = dueAt({
    reviewedAt: new Date(NOW.getTime() - 10 * DAY),
    updatedAt: new Date(NOW.getTime() - 500 * DAY),
    reviewEveryDays: 90,
  });
  assert.equal(due.toISOString(), new Date(NOW.getTime() + 80 * DAY).toISOString());
});

test('dueAt: reviewed_at null cai para updated_at (os itens antigos não nascem vencidos)', () => {
  const due = dueAt({
    reviewedAt: null,
    updatedAt: new Date(NOW.getTime() - 100 * DAY),
    reviewEveryDays: 90,
  });
  assert.equal(due.getTime(), NOW.getTime() - 10 * DAY);
  assert.ok(daysOverdue(due, NOW) > 0, 'vencido há 10 dias');
});

test('daysOverdue: arredonda por baixo e é negativo antes de vencer', () => {
  assert.equal(daysOverdue(new Date(NOW.getTime() - 10 * DAY - 23 * 3_600_000), NOW), 10);
  assert.equal(daysOverdue(NOW, NOW), 0, 'vence agora: 0 dias em atraso');
  assert.equal(daysOverdue(new Date(NOW.getTime() + 1 * DAY), NOW), -1, 'ainda não venceu');
  assert.equal(daysOverdue(new Date(NOW.getTime() + 0.5 * DAY), NOW), -1, 'menos de um dia: floor arredonda para baixo');
});
