import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ensureCampaignTicks } from '../../../src/application/campaigns/ensure-campaign-ticks.js';
import { makeEnsureDeps } from './fakes.js';

describe('ensureCampaignTicks', () => {
  it('agenda um tick por conta com pendentes e não toca em campanhas pausadas', async () => {
    const d = makeEnsureDeps({
      campaigns: [
        { id: 'c1', status: 'running', allowedAccountIds: ['a1', 'a2'], pending: { a1: 3, a2: 0 } },
        { id: 'c2', status: 'paused', allowedAccountIds: ['a1'], pending: { a1: 9 } },
        { id: 'c3', status: 'running', allowedAccountIds: ['a1'], pending: { a1: 0 } },
      ],
    });
    assert.deepEqual(await ensureCampaignTicks(d), { scheduled: 1, completed: 1 });
    assert.equal(d.scheduler.calls.length, 1);
    const ensureArgs = d.scheduler.calls[0]!;
    assert.equal(ensureArgs.campaignId, 'c1');
    assert.equal(ensureArgs.accountId, 'a1');
    assert.ok(ensureArgs.runAt instanceof Date);
    assert.deepEqual(d.campaigns.casCalls[0], ['c3', ['running', 'scheduled'], { status: 'completed' }]);
  });
});
