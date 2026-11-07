import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadCampaignConfig } from '../../../src/modules/campaigns/config.js';

describe('campaign config', () => {
  it('carrega os defaults de docs/04 §7', () => {
    const cfg = loadCampaignConfig({});
    assert.deepEqual(cfg.delay, { minMs: 15000, maxMs: 45000 });
    assert.deepEqual(cfg.ramp, {
      bands: [
        { fromDay: 1, toDay: 3, cap: 30 },
        { fromDay: 4, toDay: 7, cap: 60 },
        { fromDay: 8, toDay: 14, cap: 100 },
      ],
      defaultCap: 150,
    });
    assert.deepEqual(cfg.quietHours, { startMinute: 1200, endMinute: 480 });
    assert.equal(cfg.timezone, 'Africa/Luanda');
    assert.deepEqual(cfg.optOutKeywords, ['sair']);
    assert.equal(cfg.optOutFooter, 'Responde SAIR para sair desta lista.');
    assert.deepEqual(cfg.pause, { failWindow: 20, failRatio: 0.3, optOutWindow: 50, optOutCount: 5 });
  });

  it('rejeita configuração inválida pelo nome da chave', () => {
    assert.throws(() => loadCampaignConfig({ WA_CAMPAIGN_DELAY_MS: '45000-15000' }), /WA_CAMPAIGN_DELAY_MS/);
    assert.throws(() => loadCampaignConfig({ WA_CAMPAIGN_DELAY_MS: 'abc' }), /WA_CAMPAIGN_DELAY_MS/);
    assert.throws(() => loadCampaignConfig({ WA_CAMPAIGN_RAMP: '1-3:30' }), /default/);
    assert.throws(() => loadCampaignConfig({ WA_CAMPAIGN_RAMP: '1-7:30,4-9:60,default:150' }), /WA_CAMPAIGN_RAMP/);
    assert.throws(() => loadCampaignConfig({ WA_QUIET_HOURS: '20:00-20:00' }), /WA_QUIET_HOURS/);
    assert.throws(() => loadCampaignConfig({ WA_QUIET_HOURS: '25:00-08:00' }), /WA_QUIET_HOURS/);
    assert.throws(() => loadCampaignConfig({ CAMPAIGN_FAIL_RATIO: '30' }), /CAMPAIGN_FAIL_RATIO/);
    assert.throws(() => loadCampaignConfig({ CAMPAIGN_FAIL_WINDOW: '0' }), /CAMPAIGN_FAIL_WINDOW/);
    assert.throws(() => loadCampaignConfig({ CAMPAIGN_OPTOUT_KEYWORDS: ' , ' }), /CAMPAIGN_OPTOUT_KEYWORDS/);
    assert.throws(
      () => loadCampaignConfig({ CAMPAIGN_OPT_OUT_FOOTER: 'Obrigado pela preferência.' }),
      /CAMPAIGN_OPT_OUT_FOOTER/,
    );
  });

  it('normaliza as palavras-chave de opt-out (minúsculas, sem acentos, sem duplicados)', () => {
    assert.deepEqual(
      loadCampaignConfig({ CAMPAIGN_OPTOUT_KEYWORDS: 'SAIR, Saír , unsubscribe' }).optOutKeywords,
      ['sair', 'unsubscribe'],
    );
  });
});
