import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { processCampaignTick } from '../../../src/application/campaigns/process-campaign-tick.js';
import { makeTickDeps } from './fakes.js';

const CAMP = '00000000-0000-0000-0000-0000000000d1';
const ACC = '00000000-0000-0000-0000-0000000000a1';
const REC = '00000000-0000-0000-0000-0000000000e1';

describe('processCampaignTick', () => {
  it('caminho feliz: envia UMA mensagem e agenda o próximo passo', async () => {
    const d = makeTickDeps({
      now: '2026-10-07T10:00:00Z',
      rng: 0.5,
      campaignStatus: 'running',
      accountCreatedAt: '2026-10-04T10:00:00Z',
      contactName: 'Ana Souza',
      template: 'Olá {{nome}}!',
    });
    const r = await processCampaignTick({ campaignId: CAMP, accountId: ACC }, d);
    assert.deepEqual(r, {
      outcome: 'sent',
      recipientId: REC,
      outboxKey: `campaign:${CAMP}:recipient:${REC}:step:1`,
      retryAt: new Date('2026-10-07T10:00:30Z'),
    });
    assert.equal(d.outbox.calls.length, 1); // serialização: um envio por tick/conta
    const enqueueArgs = d.outbox.calls[0]!;
    assert.equal(enqueueArgs.accountId, ACC);
    assert.equal(enqueueArgs.sender, 'campaign');
    assert.equal(enqueueArgs.idempotencyKey, `campaign:${CAMP}:recipient:${REC}:step:1`);
    assert.equal(enqueueArgs.text, 'Olá Ana Souza!\n\nResponde SAIR para sair desta lista.');
    assert.deepEqual(enqueueArgs.scheduledAt, new Date('2026-10-07T10:00:00Z'));
  });

  it('nunca retoma uma campanha em pausa', async () => {
    const d = makeTickDeps({ now: '2026-10-07T10:00:00Z', campaignStatus: 'paused' });
    assert.deepEqual(await processCampaignTick({ campaignId: CAMP, accountId: ACC }, d), {
      outcome: 'idle',
      reason: 'paused',
    });
    assert.equal(d.outbox.calls.length, 0);
    assert.equal(d.applyPause.calls.length, 0);
  });

  it('agendamento: espera até scheduledAt e depois envia', async () => {
    const future = makeTickDeps({
      now: '2026-10-07T10:00:00Z',
      campaignStatus: 'scheduled',
      scheduledAt: '2026-10-08T09:00:00Z',
    });
    assert.deepEqual(await processCampaignTick({ campaignId: CAMP, accountId: ACC }, future), {
      outcome: 'waiting',
      reason: 'scheduled_not_due',
      retryAt: new Date('2026-10-08T09:00:00Z'),
    });
    const due = makeTickDeps({
      now: '2026-10-07T10:00:00Z',
      campaignStatus: 'scheduled',
      scheduledAt: '2026-10-07T09:00:00Z',
    });
    assert.equal((await processCampaignTick({ campaignId: CAMP, accountId: ACC }, due)).outcome, 'sent');
    const setStatusArgs = due.campaigns.casCalls[0]!;
    assert.equal(setStatusArgs[0], CAMP);
    assert.deepEqual(setStatusArgs[1], ['scheduled']);
    assert.equal(setStatusArgs[2].status, 'running');
  });

  it('janela silenciosa: espera até 08:00 Africa/Luanda', async () => {
    const d = makeTickDeps({ now: '2026-10-07T19:30:00Z', campaignStatus: 'running' });
    assert.deepEqual(await processCampaignTick({ campaignId: CAMP, accountId: ACC }, d), {
      outcome: 'waiting',
      reason: 'quiet_hours',
      retryAt: new Date('2026-10-08T07:00:00Z'),
    });
    assert.equal(d.outbox.calls.length, 0);
  });

  it('cap diário (ramp da idade da conta): às 30 mensagens espera até à meia-noite local', async () => {
    // conta criada em 2026-10-05T10:00Z → dia 3 → ramp 30
    const d = makeTickDeps({
      now: '2026-10-07T10:00:00Z',
      campaignStatus: 'running',
      accountCreatedAt: '2026-10-05T10:00:00Z',
      enqueuedToday: 30,
    });
    assert.deepEqual(await processCampaignTick({ campaignId: CAMP, accountId: ACC }, d), {
      outcome: 'waiting',
      reason: 'daily_cap',
      retryAt: new Date('2026-10-07T23:00:00Z'),
    });
  });

  it('cap da campanha (dailyLimit) é o mínimo entre ele e o ramp', async () => {
    const d = makeTickDeps({
      now: '2026-10-07T10:00:00Z',
      campaignStatus: 'running',
      accountCreatedAt: '2026-10-04T10:00:00Z',
      campaignDailyLimit: 10,
      enqueuedToday: 10,
    });
    const r = await processCampaignTick({ campaignId: CAMP, accountId: ACC }, d);
    assert.equal(r.outcome, 'waiting');
    assert.equal(r.outcome === 'waiting' ? r.reason : null, 'daily_cap');
  });

  it('prioridade das respostas de conversa sobre campanhas', async () => {
    const d = makeTickDeps({
      now: '2026-10-07T10:00:00Z',
      campaignStatus: 'running',
      pendingConversationCount: 2,
    });
    assert.deepEqual(await processCampaignTick({ campaignId: CAMP, accountId: ACC }, d), {
      outcome: 'waiting',
      reason: 'conversation_backlog',
      retryAt: new Date('2026-10-07T10:00:30Z'),
    });
    assert.equal(d.outbox.calls.length, 0);
  });

  it('conta support / desconectada não envia (sem rotação para outra conta)', async () => {
    const support = makeTickDeps({
      now: '2026-10-07T10:00:00Z',
      campaignStatus: 'running',
      accountPurpose: 'support',
    });
    assert.deepEqual(await processCampaignTick({ campaignId: CAMP, accountId: ACC }, support), {
      outcome: 'waiting',
      reason: 'account_unavailable',
      retryAt: new Date('2026-10-07T10:00:30Z'),
    });
    assert.equal(support.outbox.calls.length, 0);
    const down = makeTickDeps({
      now: '2026-10-07T10:00:00Z',
      campaignStatus: 'running',
      accountStatus: 'disconnected',
    });
    const downResult = await processCampaignTick({ campaignId: CAMP, accountId: ACC }, down);
    assert.equal(downResult.outcome === 'waiting' ? downResult.reason : null, 'account_unavailable');
  });

  it('contacto sem consentimento ou com opt-out depois da materialização nunca recebe', async () => {
    const d = makeTickDeps({
      now: '2026-10-07T10:00:00Z',
      campaignStatus: 'running',
      nextPending: null,
      pendingCount: 0,
    });
    assert.deepEqual(await processCampaignTick({ campaignId: CAMP, accountId: ACC }, d), {
      outcome: 'completed',
    });
    assert.deepEqual(d.dispatch.skipCalls[0], [CAMP, new Date('2026-10-07T10:00:00Z')]);
    assert.equal(d.outbox.calls.length, 0);
  });

  it('sem destinatários pendentes: conclui a campanha', async () => {
    const d = makeTickDeps({
      now: '2026-10-07T10:00:00Z',
      campaignStatus: 'running',
      nextPending: null,
      pendingCount: 0,
    });
    assert.deepEqual(await processCampaignTick({ campaignId: CAMP, accountId: ACC }, d), {
      outcome: 'completed',
    });
    assert.deepEqual(d.campaigns.casCalls[0], [CAMP, ['running', 'scheduled'], { status: 'completed' }]);
  });

  it('guardas de pausa correm antes dos gates e pausam com o motivo devolvido', async () => {
    const d = makeTickDeps({
      now: '2026-10-07T10:00:00Z',
      campaignStatus: 'running',
      guardReason: 'session_down',
    });
    assert.deepEqual(await processCampaignTick({ campaignId: CAMP, accountId: ACC }, d), {
      outcome: 'idle',
      reason: 'paused',
    });
    assert.deepEqual(d.applyPause.calls[0], {
      campaignId: CAMP,
      reason: 'session_down',
      actorId: null,
      now: new Date('2026-10-07T10:00:00Z'),
    });
    assert.equal(d.outbox.calls.length, 0);
  });

  it('logs do tick sem telefones E.164 completos (só uuids)', async () => {
    const lines: string[] = [];
    const d = makeTickDeps({
      now: '2026-10-07T10:00:00Z',
      campaignStatus: 'running',
      logger: (msg: string) => lines.push(msg),
    });
    await processCampaignTick({ campaignId: CAMP, accountId: ACC }, d);
    assert.doesNotMatch(lines.join('\n'), /\+244\d{9}/);
    assert.ok(lines.join('\n').includes(CAMP));
  });
});
