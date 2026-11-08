import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { makeStartDeps } from './fakes.js';

const U1 = '00000000-0000-0000-0000-0000000000f1';
const A1 = '00000000-0000-0000-0000-0000000000a1';
const A2 = '00000000-0000-0000-0000-0000000000a2';
const CT1 = '00000000-0000-0000-0000-0000000000c1';
const CT2 = '00000000-0000-0000-0000-0000000000c2';
const CAMP = '00000000-0000-0000-0000-0000000000d1';

describe('startCampaign', () => {
  it('materializa destinatários e só depois transita draft → running', async () => {
    const { start, recipients } = makeStartDeps({
      campaignId: CAMP,
      allowedAccountIds: [A1, A2],
      eligible: [CT1, CT2],
    });
    const res = await start({
      campaignId: CAMP,
      idempotencyKey: 'S1',
      actorId: U1,
      scheduledAt: null,
      now: new Date('2026-10-07T10:00:00Z'),
    });
    assert.equal(res.recipientsCreated, 2);
    assert.equal(res.replayed, false);
    assert.equal(res.campaign.status, 'running');
    assert.deepEqual(recipients.calls, ['insertBatch', 'compareAndSetStatus']); // crash-safe: materializar antes de transitar
    assert.equal(recipients.lastRows.length, 2);
    const [row1, row2] = recipients.lastRows;
    assert.ok(typeof row1.id === 'string' && typeof row2.id === 'string'); // ids gerados em runtime
    assert.deepEqual(
      { campaignId: row1.campaignId, contactId: row1.contactId, accountId: row1.accountId, step: row1.step },
      { campaignId: CAMP, contactId: CT1, accountId: A1, step: 1 },
    );
    assert.deepEqual(
      { campaignId: row2.campaignId, contactId: row2.contactId, accountId: row2.accountId, step: row2.step },
      { campaignId: CAMP, contactId: CT2, accountId: A2, step: 1 },
    );
  });

  it('scheduledAt futuro deixa a campanha scheduled; replay não recria destinatários', async () => {
    const { start } = makeStartDeps({
      campaignId: CAMP,
      allowedAccountIds: [A1],
      eligible: [CT1],
    });
    const first = await start({
      campaignId: CAMP,
      idempotencyKey: 'S1',
      actorId: U1,
      scheduledAt: new Date('2026-10-08T09:00:00Z'),
      now: new Date('2026-10-07T10:00:00Z'),
    });
    assert.equal(first.campaign.status, 'scheduled');
    const replay = await start({
      campaignId: CAMP,
      idempotencyKey: 'S1',
      actorId: U1,
      scheduledAt: new Date('2026-10-08T09:00:00Z'),
      now: new Date('2026-10-07T10:05:00Z'),
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.recipientsCreated, 0);
    await assert.rejects(
      start({
        campaignId: CAMP,
        idempotencyKey: 'S2',
        actorId: U1,
        scheduledAt: null,
        now: new Date('2026-10-07T10:06:00Z'),
      }),
      { code: 'invalid_status', status: 409 },
    );
  });

  it('re-valida purpose das contas no início (mudou desde a criação)', async () => {
    const { start } = makeStartDeps({
      campaignId: CAMP,
      allowedAccountIds: [A1],
      eligible: [],
      purposeNow: 'support',
    });
    await assert.rejects(
      start({
        campaignId: CAMP,
        idempotencyKey: 'S1',
        actorId: U1,
        scheduledAt: null,
        now: new Date('2026-10-07T10:00:00Z'),
      }),
      { code: 'unsupported_account_purpose', status: 400 },
    );
  });
});
