import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { eq } from 'drizzle-orm';

import {
  buildContactNameSource,
  buildConversationFinder,
  buildDispatchStore,
  buildRecipientStore,
  createCampaignRepositories,
} from '../../../src/adapters/db/campaigns.js';
import { campaignRecipients } from '../../../src/adapters/db/schema/campaigns.schema.js';
import { contacts } from '../../../src/adapters/db/schema/index.js';
import { MILVENDAS_TENANT_ID } from '../../../src/adapters/db/schema/tenants.schema.js';
import { users } from '../../../src/adapters/db/schema/users.schema.js';
import { whatsappAccounts } from '../../../src/adapters/db/schema/whatsapp-accounts.schema.js';
import { createJobQueue } from '../../../src/adapters/queue/index.js';
import {
  CAMPAIGN_TICK_QUEUE,
  createCampaignTickScheduler,
  registerCampaignTickWorker,
} from '../../../src/adapters/queue/campaign-tick.js';
import { processCampaignTick, type TickDeps } from '../../../src/application/campaigns/process-campaign-tick.js';
import { loadCampaignConfig } from '../../../src/modules/campaigns/config.js';
import { migratedDb } from '../../helpers/db.js';

const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6380';
const NOW = new Date('2026-10-07T10:00:00Z');

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error('timeout à espera de condição');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('campaign tick queue', () => {
  it('ensureTick com o mesmo runAt executa o handler uma só vez', async () => {
    const jobs = createJobQueue({ redisUrl: TEST_REDIS_URL });
    const tenantId = randomUUID();
    const campaignId = randomUUID();
    const accountId = randomUUID();
    let runs = 0;
    await jobs.register(CAMPAIGN_TICK_QUEUE, async () => {
      runs += 1;
    });
    const scheduler = createCampaignTickScheduler({ jobs, now: () => NOW });

    await scheduler.ensureTick({ tenantId, campaignId, accountId, runAt: NOW });
    await scheduler.ensureTick({ tenantId, campaignId, accountId, runAt: NOW });
    await waitFor(() => runs >= 1);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(runs, 1);

    // Um runAt diferente agenda o tick seguinte (o jobId anterior fica retido).
    await scheduler.ensureTick({ tenantId, campaignId, accountId, runAt: new Date(NOW.getTime() + 1_000) });
    await waitFor(() => runs >= 2, 8_000);
    await jobs.close();
  });

  it('tick repetido com stores reais produz um único envio e conclui a campanha', async () => {
    const db = await migratedDb();
    const scope = { tenantId: MILVENDAS_TENANT_ID };
    const campaignId = randomUUID();
    const accountId = randomUUID();
    const contactId = randomUUID();
    const userId = randomUUID();

    await db.insert(users).values({
      id: userId,
      tenantId: MILVENDAS_TENANT_ID,
      name: 'Admin',
      email: 'admin-tick-queue@example.test',
      passwordHash: 'x',
      role: 'admin',
    });
    const createdAt = new Date('2026-10-04T10:00:00Z');
    await db.insert(whatsappAccounts).values({
      id: accountId,
      tenantId: MILVENDAS_TENANT_ID,
      label: 'Campanhas',
      providerSessionId: `sess-${accountId}`,
      purpose: 'campaigns',
      status: 'connected',
      createdAt,
    });
    await db.insert(contacts).values({
      id: contactId,
      tenantId: MILVENDAS_TENANT_ID,
      phoneE164: '+244900000031',
      name: 'Ana',
      marketingConsent: true,
    });

    const repos = createCampaignRepositories({ db });
    const campaign = await repos.campaigns.insert(scope, {
      id: campaignId,
      tenantId: MILVENDAS_TENANT_ID,
      name: 'Campanha',
      messageTemplate: 'Olá {{nome}}!',
      allowedAccountIds: [accountId],
      dailyLimit: null,
      createdBy: userId,
      createIdempotencyKey: `create-${campaignId}`,
      createRequestHash: `hash-${campaignId}`,
    });
    await repos.campaigns.compareAndSetStatus(scope, campaign.id, ['draft'], { status: 'running' });

    const recipients = buildRecipientStore(db);
    const recipientId = randomUUID();
    await recipients.insertBatch(scope, [
      { id: recipientId, campaignId, contactId, accountId, step: 1 },
    ]);

    const outboxCalls: Array<Parameters<TickDeps['outbox']['enqueue']>[0]> = [];
    const deps: TickDeps = {
      scope,
      campaigns: repos.campaigns,
      dispatch: buildDispatchStore(db),
      recipients,
      contacts: buildContactNameSource(db),
      accounts: repos.accounts,
      outbox: {
        async enqueue(input) {
          outboxCalls.push(input);
          return { outboxId: 'out-1', duplicate: false };
        },
        async pendingConversationCount() {
          return 0;
        },
      },
      conversations: buildConversationFinder(db, () => NOW),
      pauseGuards: [],
      applyPause: {
        async apply() {
          return true;
        },
      },
      now: () => NOW,
      rng: () => 0.5,
      cfg: loadCampaignConfig({}),
    };

    assert.equal((await processCampaignTick({ campaignId, accountId }, deps)).outcome, 'sent');
    assert.equal((await processCampaignTick({ campaignId, accountId }, deps)).outcome, 'completed');
    assert.equal(outboxCalls.length, 1);

    const [row] = await db
      .select({ status: campaignRecipients.status, outboxKey: campaignRecipients.outboxKey })
      .from(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, campaignId));
    assert.equal(row?.status, 'sent');
    assert.equal(row?.outboxKey, `campaign:${campaignId}:recipient:${recipientId}:step:1`);
  });

  it('registar o worker duas vezes não duplica o ensure recorrente', async () => {
    const jobs = createJobQueue({ redisUrl: TEST_REDIS_URL });
    let ensureRuns = 0;
    const tickInputs: Array<{ tenantId: string; campaignId: string; accountId: string }> = [];
    const worker = {
      jobs,
      async runTick(input: { tenantId: string; campaignId: string; accountId: string }) {
        tickInputs.push(input);
        return { outcome: 'idle' as const, reason: 'campaign_not_running' as const };
      },
      async ensure() {
        ensureRuns += 1;
        return { scheduled: 0, completed: 0 };
      },
      ensureEveryMs: 100,
    };
    await registerCampaignTickWorker(worker);
    await registerCampaignTickWorker(worker); // 2.ª chamada = no-op

    // O payload do tick leva o tenant (scope) até ao worker.
    const tenantId = randomUUID();
    const campaignId = randomUUID();
    const accountId = randomUUID();
    await createCampaignTickScheduler({ jobs, now: () => NOW }).ensureTick({
      tenantId,
      campaignId,
      accountId,
      runAt: NOW,
    });
    await waitFor(() => tickInputs.length >= 1);
    assert.deepEqual(tickInputs[0], { tenantId, campaignId, accountId });

    ensureRuns = 0; // conta só a janela seguinte (o tick acima pode ter demorado)
    await new Promise((r) => setTimeout(r, 550));
    await jobs.close();
    assert.ok(ensureRuns >= 3 && ensureRuns <= 7, `ensureRuns=${ensureRuns} (3–7 em 550ms; >7 houve duplicação)`);
  });
});
