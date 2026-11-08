import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildContactNameSource,
  buildConversationFinder,
  buildDeliveryProbe,
  buildDispatchStore,
  buildRecipientStatsStore,
  buildRecipientStore,
  createCampaignRepositories,
} from '../../../src/adapters/db/campaigns.js';
import { findOrCreateConversation } from '../../../src/adapters/db/inbound.js';
import { campaignRecipients, campaigns } from '../../../src/adapters/db/schema/campaigns.schema.js';
import { contacts, messages, outboxMessages } from '../../../src/adapters/db/schema/index.js';
import { MILVENDAS_TENANT_ID } from '../../../src/adapters/db/schema/tenants.schema.js';
import { users } from '../../../src/adapters/db/schema/users.schema.js';
import { whatsappAccounts } from '../../../src/adapters/db/schema/whatsapp-accounts.schema.js';
import {
  makePauseApplier,
  makePauseCampaign,
  sessionPauseGuard,
  volumePauseGuard,
} from '../../../src/application/campaigns/pause-campaign.js';
import { reconcileFailures } from '../../../src/application/campaigns/reconcile-failures.js';
import { makeResumeCampaign } from '../../../src/application/campaigns/resume-campaign.js';
import { processCampaignTick, type TickDeps } from '../../../src/application/campaigns/process-campaign-tick.js';
import { CampaignError } from '../../../src/application/campaigns/create-campaign.js';
import { loadCampaignConfig } from '../../../src/modules/campaigns/config.js';
import type { Audit } from '../../../src/ports/audit.js';
import type { CampaignAlertSink } from '../../../src/ports/campaign-stats.js';
import { and, eq, gte } from 'drizzle-orm';
import { migratedDb } from '../../helpers/db.js';

const U1 = '00000000-0000-0000-0000-0000000000f1';
const A1 = '00000000-0000-0000-0000-0000000000a1';
const CAMP = '00000000-0000-0000-0000-0000000000d1';
const CT1 = '00000000-0000-0000-0000-0000000000c1';
const AT = new Date('2026-10-07T10:00:00Z');
const cfg = loadCampaignConfig({});

interface SeedOptions {
  count: number;
  outboxFailedFrom?: number; // k<n> em falha a partir daqui
  outboxUnknownFrom?: number; // k<n> com entrega desconhecida a partir daqui
  optedOutFrom?: number; // destinatários com opted_out_at a partir deste passo
  accountStatus?: 'connected' | 'disconnected';
}

async function seed(opts: SeedOptions) {
  const db = await migratedDb();
  const scope = { tenantId: MILVENDAS_TENANT_ID };
  const auditCalls: string[] = [];
  const audit: Audit = {
    async record(input) {
      auditCalls.push(input.action);
    },
  };
  const alertCalls: Array<Parameters<CampaignAlertSink['campaignPaused']>[0]> = [];
  const alerts: CampaignAlertSink = {
    async campaignPaused(input) {
      alertCalls.push(input);
    },
  };

  await db.insert(users).values({
    id: U1,
    tenantId: MILVENDAS_TENANT_ID,
    name: 'Admin',
    email: 'admin-auto-pause@example.test',
    passwordHash: 'x',
    role: 'admin',
  });
  await db.insert(contacts).values({
    id: CT1,
    tenantId: MILVENDAS_TENANT_ID,
    phoneE164: '+244900000041',
    name: 'Ana',
    marketingConsent: true,
  });
  await db.insert(whatsappAccounts).values({
    id: A1,
    tenantId: MILVENDAS_TENANT_ID,
    label: 'Campanhas',
    providerSessionId: 'sess-auto-pause',
    purpose: 'campaigns',
    status: opts.accountStatus ?? 'connected',
    createdAt: new Date('2026-10-04T10:00:00Z'),
  });
  await db.insert(whatsappAccounts).values({
    id: '00000000-0000-0000-0000-0000000000a2',
    tenantId: MILVENDAS_TENANT_ID,
    label: 'Apoio',
    providerSessionId: 'sess-auto-pause-support',
    purpose: 'support',
  }).onConflictDoNothing();
  const repo = createCampaignRepositories({ db });
  await repo.campaigns.insert(scope, {
    id: CAMP,
    tenantId: MILVENDAS_TENANT_ID,
    name: 'Campanha',
    messageTemplate: 'Olá {{nome}}',
    allowedAccountIds: [A1],
    dailyLimit: null,
    createdBy: U1,
    createIdempotencyKey: 'create-auto-pause',
    createRequestHash: 'hash-auto-pause',
  });
  await repo.campaigns.compareAndSetStatus(scope, CAMP, ['draft'], { status: 'running' });
  // O `createdAt` da campanha é o limiar inferior da janela de volume; fixa-se
  // ao relógio do teste para os destinatários enfileirados em AT contarem.
  await db.update(campaigns).set({ createdAt: AT }).where(eq(campaigns.id, CAMP));

  await db.insert(campaignRecipients).values(
    Array.from({ length: opts.count }, (_, i) => ({
      id: recipientId(i + 1),
      tenantId: MILVENDAS_TENANT_ID,
      campaignId: CAMP,
      contactId: CT1,
      accountId: A1,
      step: i + 1,
      status: 'sent' as const,
      outboxKey: `k${i + 1}`,
      enqueuedAt: new Date(AT.getTime() + (i + 1) * 1_000),
    })),
  );
  if (opts.optedOutFrom !== undefined) {
    await db
      .update(campaignRecipients)
      .set({ optedOutAt: AT })
      .where(
        and(
          eq(campaignRecipients.tenantId, MILVENDAS_TENANT_ID),
          gte(campaignRecipients.step, opts.optedOutFrom),
        ),
      );
  }

  // Outbox real: 1 conversa + N mensagens + N linhas de outbox com as chaves k1..kN.
  const conversation = await findOrCreateConversation(db, {
    tenantId: MILVENDAS_TENANT_ID,
    accountId: A1,
    contactId: CT1,
    at: AT,
  });
  const messageId = (i: number): string => `00000000-0000-0000-0000-0000000001${String(i).padStart(2, '0')}`;
  const indexes = Array.from({ length: opts.count }, (_, i) => i + 1);
  await db.insert(messages).values(
    indexes.map((i) => ({
      id: messageId(i),
      tenantId: MILVENDAS_TENANT_ID,
      conversationId: conversation.id,
      accountId: A1,
      direction: 'outbound' as const,
      sender: 'campaign' as const,
      status: 'sent' as const,
    })),
  );
  await db.insert(outboxMessages).values(
    indexes.map((i) => {
      let status: 'sent' | 'failed' | 'unknown_delivery' = 'sent';
      if (opts.outboxFailedFrom !== undefined && i >= opts.outboxFailedFrom) status = 'failed';
      if (opts.outboxUnknownFrom !== undefined && i >= opts.outboxUnknownFrom) status = 'unknown_delivery';
      return {
        tenantId: MILVENDAS_TENANT_ID,
        messageId: messageId(i),
        accountId: A1,
        idempotencyKey: `k${i}`,
        status,
      };
    }),
  );

  const campaign = await repo.campaigns.findById(scope, CAMP);
  assert.ok(campaign !== null);
  const account = (await repo.accounts.find(scope, [A1]))[0];
  assert.ok(account !== undefined);

  return {
    db,
    scope,
    repo,
    campaign,
    account,
    stats: buildRecipientStatsStore(db),
    probe: buildDeliveryProbe(db),
    audit,
    auditCalls,
    alerts,
    alertCalls,
  };
}

const recipientId = (n: number): string => `00000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`;

describe('campaign auto pause', () => {
  it('failure_rate: 6 falhas em 20 → pausa, audita e alerta', async () => {
    const s = await seed({ count: 20, outboxFailedFrom: 15 });
    const guard = volumePauseGuard({
      stats: s.stats,
      probe: s.probe,
      cfg,
      reconcile: reconcileFailures,
    });
    assert.deepEqual(await guard({ campaign: s.campaign, account: s.account, now: AT }), {
      reason: 'failure_rate',
    });

    const pause = makePauseCampaign({ scope: s.scope, campaigns: s.repo.campaigns, audit: s.audit, alerts: s.alerts });
    await pause({ campaignId: CAMP, accountId: A1, reason: 'failure_rate', actorId: null, now: AT });
    const after = await s.repo.campaigns.findById(s.scope, CAMP);
    assert.equal(after?.status, 'paused');
    assert.equal(after?.pauseReason, 'failure_rate');
    assert.equal(after?.pausedBy, null);
    assert.ok(s.auditCalls.includes('campaign.auto_paused'));
    assert.deepEqual(s.alertCalls[0], {
      tenantId: MILVENDAS_TENANT_ID,
      campaignId: CAMP,
      accountId: A1,
      reason: 'failure_rate',
      auto: true,
      at: AT,
    });
  });

  it("'unknown' nunca vira falha: 20 sent → não pausa", async () => {
    const s = await seed({ count: 20, outboxUnknownFrom: 15 });
    const guard = volumePauseGuard({ stats: s.stats, probe: s.probe, cfg, reconcile: reconcileFailures });
    assert.equal(await guard({ campaign: s.campaign, account: s.account, now: AT }), null);
  });

  it('opt_out_spike: 5 opt-outs em 12 enfileiradas → pausa mesmo com janela parcial', async () => {
    const s = await seed({ count: 12, optedOutFrom: 8 });
    const guard = volumePauseGuard({ stats: s.stats, probe: s.probe, cfg, reconcile: reconcileFailures });
    assert.deepEqual(await guard({ campaign: s.campaign, account: s.account, now: AT }), {
      reason: 'opt_out_spike',
    });
  });

  it('sessão em baixo pausa no tick antes de qualquer envio', async () => {
    const s = await seed({ count: 1, accountStatus: 'disconnected' });
    const outboxCalls: string[] = [];
    const deps: TickDeps = {
      scope: s.scope,
      campaigns: s.repo.campaigns,
      dispatch: buildDispatchStore(s.db),
      recipients: buildRecipientStore(s.db),
      contacts: buildContactNameSource(s.db),
      accounts: s.repo.accounts,
      outbox: {
        async enqueue(input) {
          outboxCalls.push(input.idempotencyKey);
          return { outboxId: 'out-1', duplicate: false };
        },
        async pendingConversationCount() {
          return 0;
        },
      },
      conversations: buildConversationFinder(s.db, () => AT),
      pauseGuards: [
        sessionPauseGuard({ accounts: s.repo.accounts }),
        volumePauseGuard({ stats: s.stats, probe: s.probe, cfg, reconcile: reconcileFailures }),
      ],
      applyPause: makePauseApplier({
        scope: s.scope,
        campaigns: s.repo.campaigns,
        audit: s.audit,
        alerts: s.alerts,
      }),
      now: () => AT,
      rng: () => 0.5,
      cfg,
    };
    assert.deepEqual(await processCampaignTick({ campaignId: CAMP, accountId: A1 }, deps), {
      outcome: 'idle',
      reason: 'paused',
    });
    assert.equal(outboxCalls.length, 0);
    const after = await s.repo.campaigns.findById(s.scope, CAMP);
    assert.equal(after?.status, 'paused');
    assert.equal(after?.pauseReason, 'session_down');
  });

  it('a retoma reinicia a janela (nada de re-pausa imediata)', async () => {
    const s = await seed({ count: 20, outboxFailedFrom: 15 });
    const guard = volumePauseGuard({ stats: s.stats, probe: s.probe, cfg, reconcile: reconcileFailures });
    await makePauseCampaign({ scope: s.scope, campaigns: s.repo.campaigns, audit: s.audit, alerts: s.alerts })({
      campaignId: CAMP,
      accountId: A1,
      reason: 'failure_rate',
      actorId: null,
      now: AT,
    });
    const T2 = new Date(AT.getTime() + 60_000);
    const resume = makeResumeCampaign({ scope: s.scope, campaigns: s.repo.campaigns, audit: s.audit });
    const resumed = await resume({ campaignId: CAMP, actorId: U1, now: T2 });
    assert.equal(resumed.campaign.status, 'running');
    assert.deepEqual(resumed.campaign.resumedAt, T2);
    assert.equal(resumed.campaign.pauseReason, null);
    assert.ok(s.auditCalls.includes('campaign.resumed'));

    assert.equal(await guard({ campaign: resumed.campaign, account: s.account, now: T2 }), null);
  });

  it('a retoma é humana: sem actorId → human_required 400', async () => {
    const s = await seed({ count: 1 });
    const resume = makeResumeCampaign({ scope: s.scope, campaigns: s.repo.campaigns, audit: s.audit });
    await makePauseCampaign({ scope: s.scope, campaigns: s.repo.campaigns, audit: s.audit, alerts: s.alerts })({
      campaignId: CAMP,
      accountId: A1,
      reason: 'human',
      actorId: U1,
      now: AT,
    });
    await assert.rejects(
      resume({ campaignId: CAMP, actorId: undefined as unknown as string, now: AT }),
      (err: unknown) => err instanceof CampaignError && err.code === 'human_required' && err.status === 400,
    );
  });
});
