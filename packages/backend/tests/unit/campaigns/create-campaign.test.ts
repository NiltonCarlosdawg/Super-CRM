import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CampaignError } from '../../../src/application/campaigns/create-campaign.js';
import { A_CAMP, A_SUP, FAKE_U1, makeCreateDeps } from './fakes.js';

const base = {
  idempotencyKey: 'K1',
  actorId: FAKE_U1,
  name: 'Promo Outubro',
  messageTemplate: 'Olá {{nome}}, temos novidades!',
  allowedAccountIds: [A_CAMP],
  dailyLimit: null,
};

describe('createCampaign', () => {
  it('REJEITA campanha numa conta purpose = support (obrigatório)', async () => {
    const { create } = makeCreateDeps({
      accounts: [
        { id: A_SUP, purpose: 'support', status: 'connected', createdAt: new Date('2026-10-01T00:00:00Z') },
      ],
    });
    const err = await create({ ...base, allowedAccountIds: [A_SUP] }).catch((e: unknown) => e);
    assert.ok(err instanceof CampaignError);
    assert.equal((err as CampaignError).code, 'unsupported_account_purpose');
    assert.equal((err as CampaignError).status, 400);
  });

  it('cria em conta campaigns e regista audit', async () => {
    const { create, audit } = makeCreateDeps();
    const res = await create(base);
    assert.equal(res.replayed, false);
    assert.equal(res.campaign.status, 'draft');
    assert.equal(res.campaign.name, 'Promo Outubro');
    assert.equal(res.campaign.dailyLimit, null);
    assert.equal(audit.calls.length, 1);
    const auditCall = audit.calls[0]!;
    assert.equal(auditCall.actorId, FAKE_U1);
    assert.equal(auditCall.action, 'campaign.created');
    assert.equal(auditCall.entity, 'campaign');
    assert.equal(auditCall.entityId, res.campaign.id);
    assert.ok(auditCall.at instanceof Date);
  });

  it('mesma Idempotency-Key + mesmo corpo = replay; corpo diferente = conflito', async () => {
    const { create } = makeCreateDeps();
    const first = await create(base);
    const replay = await create(base);
    assert.equal(replay.replayed, true);
    assert.equal(replay.campaign.id, first.campaign.id);
    const err = await create({ ...base, name: 'Outro nome' }).catch((e: unknown) => e);
    assert.ok(err instanceof CampaignError);
    assert.equal((err as CampaignError).code, 'idempotency_conflict');
    assert.equal((err as CampaignError).status, 409);
  });

  it('valida lista de contas e template', async () => {
    const { create } = makeCreateDeps({ accountsMissing: ['00000000-0000-0000-0000-0000000000a9'] });
    await assert.rejects(create({ ...base, allowedAccountIds: [] }), { code: 'empty_accounts' });
    await assert.rejects(create({ ...base, allowedAccountIds: [A_CAMP, A_CAMP] }), { code: 'duplicate_account' });
    await assert.rejects(create({ ...base, allowedAccountIds: ['00000000-0000-0000-0000-0000000000a9'] }), {
      code: 'unknown_account',
    });
    await assert.rejects(create({ ...base, messageTemplate: 'Oi {{apelido}}' }), { code: 'invalid_template' });
    await assert.rejects(create({ ...base, dailyLimit: 0 }), CampaignError);
  });
});
