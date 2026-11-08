import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createCampaignAlertSink } from '../../../src/adapters/realtime/campaign-alerts.js';
import type { NotifyEvent } from '../../../src/ports/notify.js';

describe('campaign alert sink', () => {
  it('emite o alerta de pausa com o tenant (sem PII)', async () => {
    const events: NotifyEvent[] = [];
    const sink = createCampaignAlertSink({
      notifySink: async (e) => {
        events.push(e);
      },
    });
    const at = new Date('2026-10-07T10:00:00Z');
    await sink.campaignPaused({
      tenantId: '00000000-0000-0000-0000-0000000000f0',
      campaignId: '00000000-0000-0000-0000-0000000000d1',
      accountId: '00000000-0000-0000-0000-0000000000a1',
      reason: 'failure_rate',
      auto: true,
      at,
    });
    assert.deepEqual(events, [
      {
        type: 'alert',
        phase: 'campaign.paused',
        tenantId: '00000000-0000-0000-0000-0000000000f0',
        campaignId: '00000000-0000-0000-0000-0000000000d1',
        accountId: '00000000-0000-0000-0000-0000000000a1',
        reason: 'failure_rate',
        auto: true,
        at: at.toISOString(),
      },
    ]);
  });
});
