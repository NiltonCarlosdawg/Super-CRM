import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_SETTINGS, parseSettings } from '../../src/modules/settings/settings.js';

test('defaults exatos do A6/D13', () => {
  assert.deepEqual(parseSettings({}), DEFAULT_SETTINGS);
  assert.equal(DEFAULT_SETTINGS.businessHours.timezone, 'Africa/Luanda');
  assert.deepEqual(DEFAULT_SETTINGS.businessHours.days, [1, 2, 3, 4, 5]);
  assert.equal(DEFAULT_SETTINGS.sla.acceptAlertMinutes, 15);
  assert.equal(DEFAULT_SETTINGS.aiModeDefault.global, 'ai_suggest');
});

test('horário inválido (fecho antes do abertura) lança, não corrige', () => {
  assert.throws(
    () =>
      parseSettings({ businessHours: { timezone: 'Africa/Luanda', days: [1], open: '17:00', close: '08:00' } }),
    /businessHours/,
  );
});

test('ai_mode fora do conjunto é rejeitado', () => {
  assert.throws(() => parseSettings({ aiModeDefault: { global: 'auto' } }), /aiModeDefault/);
});
