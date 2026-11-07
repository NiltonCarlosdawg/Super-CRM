import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  accountAgeDays,
  dayStartInTz,
  effectiveDailyCap,
  isQuietHours,
  nextCampaignWindowOpen,
  nextDayStartInTz,
  randomDelayMs,
  rampCapFor,
} from '../../../src/domain/campaigns/rhythm.js';
import type { CampaignConfig } from '../../../src/modules/campaigns/config.js';

const cfg = {
  quietHours: { startMinute: 1200, endMinute: 480 },
  timezone: 'Africa/Luanda',
  ramp: {
    bands: [
      { fromDay: 1, toDay: 3, cap: 30 },
      { fromDay: 4, toDay: 7, cap: 60 },
      { fromDay: 8, toDay: 14, cap: 100 },
    ],
    defaultCap: 150,
  },
  delay: { minMs: 15000, maxMs: 45000 },
} as const satisfies Pick<CampaignConfig, 'quietHours' | 'timezone' | 'ramp' | 'delay'>;

describe('rhythm', () => {
  it('janela silenciosa 20:00-08:00 Africa/Luanda com limites exatos', () => {
    assert.equal(isQuietHours(new Date('2026-10-07T18:59:59Z'), cfg), false); // 19:59:59 local
    assert.equal(isQuietHours(new Date('2026-10-07T19:00:00Z'), cfg), true); // 20:00 local
    assert.equal(isQuietHours(new Date('2026-10-07T19:30:00Z'), cfg), true); // 20:30 local
    assert.equal(isQuietHours(new Date('2026-10-07T06:59:59Z'), cfg), true); // 07:59:59 local
    assert.equal(isQuietHours(new Date('2026-10-07T07:00:00Z'), cfg), false); // 08:00 local
    assert.deepEqual(
      nextCampaignWindowOpen(new Date('2026-10-07T19:30:00Z'), cfg),
      new Date('2026-10-08T07:00:00Z'),
    );
    assert.deepEqual(
      nextCampaignWindowOpen(new Date('2026-10-07T03:00:00Z'), cfg),
      new Date('2026-10-07T07:00:00Z'),
    );
    assert.deepEqual(
      nextCampaignWindowOpen(new Date('2026-10-07T07:00:00Z'), cfg),
      new Date('2026-10-07T07:00:00Z'),
    );
  });

  it('idade da conta em dias (1-based)', () => {
    assert.equal(accountAgeDays(new Date('2026-10-07T10:00:00Z'), new Date('2026-10-07T10:00:00Z')), 1);
    assert.equal(accountAgeDays(new Date('2026-10-04T10:00:00Z'), new Date('2026-10-07T09:59:59Z')), 3);
    assert.equal(accountAgeDays(new Date('2026-10-04T10:00:00Z'), new Date('2026-10-07T10:00:00Z')), 4);
  });

  it('ramp: dias 1-3:30, 4-7:60, 8-14:100, depois default', () => {
    assert.equal(rampCapFor(1, cfg.ramp), 30);
    assert.equal(rampCapFor(3, cfg.ramp), 30);
    assert.equal(rampCapFor(4, cfg.ramp), 60);
    assert.equal(rampCapFor(7, cfg.ramp), 60);
    assert.equal(rampCapFor(8, cfg.ramp), 100);
    assert.equal(rampCapFor(14, cfg.ramp), 100);
    assert.equal(rampCapFor(15, cfg.ramp), 150);
    assert.equal(rampCapFor(90, cfg.ramp), 150);
  });

  it('cap efetivo = min(ramp, dailyLimit da campanha)', () => {
    assert.equal(effectiveDailyCap({ ageDays: 3, ramp: cfg.ramp, campaignDailyLimit: null }), 30);
    assert.equal(effectiveDailyCap({ ageDays: 3, ramp: cfg.ramp, campaignDailyLimit: 10 }), 10);
    assert.equal(effectiveDailyCap({ ageDays: 3, ramp: cfg.ramp, campaignDailyLimit: 500 }), 30);
  });

  it('atraso aleatório dentro de 15000-45000 (inclusivo)', () => {
    assert.equal(randomDelayMs(cfg.delay, () => 0), 15000);
    assert.equal(randomDelayMs(cfg.delay, () => 0.5), 30000);
    assert.equal(randomDelayMs(cfg.delay, () => 0.999999999999), 45000);
  });

  it('meia-noite local em Africa/Luanda (UTC+1, sem DST)', () => {
    assert.deepEqual(
      dayStartInTz(new Date('2026-10-07T19:30:00Z'), 'Africa/Luanda'),
      new Date('2026-10-06T23:00:00Z'),
    );
    assert.deepEqual(
      dayStartInTz(new Date('2026-10-07T00:30:00Z'), 'Africa/Luanda'),
      new Date('2026-10-06T23:00:00Z'),
    );
    assert.deepEqual(
      nextDayStartInTz(new Date('2026-10-07T19:30:00Z'), 'Africa/Luanda'),
      new Date('2026-10-07T23:00:00Z'),
    );
  });
});
