// Fase 4, Task 12: jornada ponta-a-ponta — API → tick → outbox → entrada →
// pausa/retoma → conclusão. Postgres real, outbox real da Fase 1 e o
// MessagingProvider fake (nenhum envio direto: só a outbox é escrita).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { and, asc, eq, inArray } from 'drizzle-orm';

import { auditLog } from '../../../src/adapters/db/schema/audit.schema.js';
import { campaignRecipients, campaigns } from '../../../src/adapters/db/schema/campaigns.schema.js';
import {
  contacts,
  conversations,
  messages,
  outboxMessages,
} from '../../../src/adapters/db/schema/index.js';
import { MILVENDAS_TENANT_ID } from '../../../src/adapters/db/schema/tenants.schema.js';
import { whatsappAccounts } from '../../../src/adapters/db/schema/whatsapp-accounts.schema.js';
import {
  buildAudience,
  buildContactNameSource,
  buildConversationFinder,
  buildDeliveryProbe,
  buildDispatchStore,
  buildRecipientStatsStore,
  buildRecipientStore,
  createCampaignRepositories,
} from '../../../src/adapters/db/campaigns.js';
import { createAuditAdapter } from '../../../src/adapters/db/audit-adapter.js';
import { createOutbox } from '../../../src/adapters/db/outbox.js';
import { createCampaignAlertSink } from '../../../src/adapters/realtime/campaign-alerts.js';
import { makeApplyOptOut } from '../../../src/application/campaigns/apply-opt-out.js';
import { makeInboundEffects } from '../../../src/application/campaigns/inbound-effects.js';
import { makePauseApplier, sessionPauseGuard, volumePauseGuard } from '../../../src/application/campaigns/pause-campaign.js';
import { processCampaignTick, type TickDeps } from '../../../src/application/campaigns/process-campaign-tick.js';
import { reconcileFailures } from '../../../src/application/campaigns/reconcile-failures.js';
import { loadCampaignConfig } from '../../../src/modules/campaigns/config.js';
import { buildTestApp, type TestApp } from '../../helpers/http.js';

const A1 = '00000000-0000-0000-0000-0000000000a1';
const CT1 = '00000000-0000-0000-0000-0000000000c1';
const CT2 = '00000000-0000-0000-0000-0000000000c2';
const CT3 = '00000000-0000-0000-0000-0000000000c3';
const CT4 = '00000000-0000-0000-0000-0000000000c4';
const CT5 = '00000000-0000-0000-0000-0000000000c5';
const AT = new Date('2026-10-07T10:00:00Z');
const cfg = loadCampaignConfig({});

const admin = (app: TestApp) => ({
  cookies: { session: app.sessions.admin, csrf: app.csrf.admin },
  headers: { 'x-csrf-token': app.csrf.admin },
});

/** Conta de campanhas + 5 contactos: 3 elegíveis, 1 com opt-out, 1 sem consentimento. */
async function seed(app: TestApp): Promise<void> {
  await app.db.insert(whatsappAccounts).values({
    id: A1,
    tenantId: MILVENDAS_TENANT_ID,
    label: 'Campanhas',
    providerSessionId: 'sess-journey',
    purpose: 'campaigns',
    status: 'connected',
    createdAt: new Date('2026-10-04T10:00:00Z'),
  });
  await app.db.insert(contacts).values([
    { id: CT1, tenantId: MILVENDAS_TENANT_ID, phoneE164: '+244900000061', name: 'CT1', marketingConsent: true },
    {
      id: CT2,
      tenantId: MILVENDAS_TENANT_ID,
      phoneE164: '+244900000062',
      name: 'CT2',
      marketingConsent: true,
      optedOutAt: new Date('2026-10-01T00:00:00Z'),
    },
    { id: CT3, tenantId: MILVENDAS_TENANT_ID, phoneE164: '+244900000063', name: 'CT3', marketingConsent: false },
    { id: CT4, tenantId: MILVENDAS_TENANT_ID, phoneE164: '+244900000064', name: 'CT4', marketingConsent: true },
    { id: CT5, tenantId: MILVENDAS_TENANT_ID, phoneE164: '+244900000065', name: 'CT5', marketingConsent: true },
  ]);
}

/** `nextPending` ordena por created_at, id: fixa a ordem para CT1 → CT4 → CT5. */
async function orderRecipients(app: TestApp, campaignId: string): Promise<void> {
  const rows = await app.db
    .select({ id: campaignRecipients.id })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, campaignId))
    .orderBy(asc(campaignRecipients.contactId));
  for (const [i, row] of rows.entries()) {
    await app.db
      .update(campaignRecipients)
      .set({ createdAt: new Date(AT.getTime() + i) })
      .where(eq(campaignRecipients.id, row.id));
  }
}

/** Simula o worker: marca o que está em voo como entregue, sem chamar o provider. */
async function drainOutbox(app: TestApp): Promise<void> {
  await app.db
    .update(outboxMessages)
    .set({ status: 'sent' })
    .where(and(eq(outboxMessages.accountId, A1), inArray(outboxMessages.status, ['queued', 'sending'])));
}

const outboxCount = async (app: TestApp): Promise<number> =>
  (
    await app.db
      .select({ id: outboxMessages.id })
      .from(outboxMessages)
      .where(eq(outboxMessages.accountId, A1))
  ).length;

const recipientOf = async (app: TestApp, campaignId: string, contactId: string) => {
  const [row] = await app.db
    .select()
    .from(campaignRecipients)
    .where(and(eq(campaignRecipients.campaignId, campaignId), eq(campaignRecipients.contactId, contactId)));
  return row;
};

describe('jornada de campanhas', () => {
  it('criar → iniciar → enviar → opt-out → responder → pausar → retomar → concluir', async () => {
    const app = await buildTestApp();
    try {
      await seed(app);
      const auth = admin(app);
      const body = {
        name: 'Jornada',
        messageTemplate: 'Olá {{nome}}, novidades!',
        allowedAccountIds: [A1],
        dailyLimit: null,
      };

      // 1. Criar (201) e repetir a chave (200, mesma campanha).
      const created = await app.inject({
        method: 'POST',
        url: '/v1/campaigns',
        ...auth,
        headers: { ...auth.headers, 'idempotency-key': 'K1' },
        payload: body,
      });
      assert.equal(created.statusCode, 201);
      assert.equal(created.json().replayed, false);
      const id: string = created.json().campaign.id;
      const replay = await app.inject({
        method: 'POST',
        url: '/v1/campaigns',
        ...auth,
        headers: { ...auth.headers, 'idempotency-key': 'K1' },
        payload: body,
      });
      assert.equal(replay.statusCode, 200);
      assert.equal(replay.json().campaign.id, id);

      // Relógio do tick coerente com a campanha (o createdAt real é posterior).
      await app.db.update(campaigns).set({ createdAt: AT }).where(eq(campaigns.id, id));

      // 2. Iniciar: só os 3 contactos elegíveis são materializados.
      const started = await app.inject({
        method: 'POST',
        url: `/v1/campaigns/${id}/start`,
        ...auth,
        headers: { ...auth.headers, 'idempotency-key': 'S1' },
        payload: { scheduledAt: null },
      });
      assert.equal(started.statusCode, 200);
      assert.equal(started.json().recipientsCreated, 3);
      assert.equal(started.json().campaign.status, 'running');
      await orderRecipients(app, id);

      // 3. Tick 1: um envio para CT1, pela outbox, com conversa criada.
      const repos = createCampaignRepositories({ db: app.db });
      const recipients = buildRecipientStore(app.db);
      const dispatch = buildDispatchStore(app.db);
      const audit = createAuditAdapter({ db: app.db });
      const outbox = createOutbox({
        db: app.db,
        notifySink: async () => {},
        now: () => AT,
        random: () => 0,
        replyDelay: { min: 0, max: 0 },
      });
      const alerts = createCampaignAlertSink({ notifySink: async () => {} });
      const deps: TickDeps = {
        scope: { tenantId: MILVENDAS_TENANT_ID },
        campaigns: repos.campaigns,
        dispatch,
        recipients,
        contacts: buildContactNameSource(app.db),
        accounts: repos.accounts,
        outbox,
        conversations: buildConversationFinder(app.db, () => AT),
        pauseGuards: [
          sessionPauseGuard({ accounts: repos.accounts }),
          volumePauseGuard({
            stats: buildRecipientStatsStore(app.db),
            probe: buildDeliveryProbe(app.db),
            cfg,
            reconcile: reconcileFailures,
          }),
        ],
        applyPause: makePauseApplier({
          scope: { tenantId: MILVENDAS_TENANT_ID },
          campaigns: repos.campaigns,
          audit,
          alerts,
        }),
        now: () => AT,
        rng: () => 0.5,
        cfg,
      };
      const tick = () => processCampaignTick({ campaignId: id, accountId: A1 }, deps);

      const first = await tick();
      assert.equal(first.outcome, 'sent');
      assert.equal(await outboxCount(app), 1);
      const sentRows = await app.db
        .select({ sender: messages.sender })
        .from(messages)
        .where(and(eq(messages.accountId, A1), eq(messages.sender, 'campaign')));
      assert.equal(sentRows.length, 1);
      assert.equal(sentRows[0]?.sender, 'campaign');
      assert.equal((await recipientOf(app, id, CT1))?.status, 'sent');
      const conv = await app.db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.accountId, A1), eq(conversations.contactId, CT1)));
      assert.equal(conv.length, 1);
      await drainOutbox(app);

      // 4. 'SAIR' de CT1: consentimento retirado + destinatário marcado.
      const effects = makeInboundEffects({
        applyOptOutFor: (tenantId) =>
          makeApplyOptOut({
            scope: { tenantId },
            audience: buildAudience(app.db),
            recipients,
            audit,
          }),
        recipients,
        keywords: cfg.optOutKeywords,
      });
      const optOut = await effects({
        tenantId: MILVENDAS_TENANT_ID,
        contactId: CT1,
        text: 'sair',
        receivedAt: AT,
      });
      assert.equal(optOut.optedOut, true);
      const [ct1] = await app.db.select().from(contacts).where(eq(contacts.id, CT1));
      assert.ok(ct1 !== undefined && ct1.optedOutAt !== null);
      const r1 = await recipientOf(app, id, CT1);
      assert.ok(r1 !== undefined && r1.optedOutAt !== null);

      // 5. Tick 2: envia a CT4, nunca outra vez a CT1.
      assert.equal((await tick()).outcome, 'sent');
      assert.equal((await recipientOf(app, id, CT4))?.status, 'sent');
      assert.equal(
        (
          await app.db
            .select({ id: messages.id })
            .from(messages)
            .where(and(eq(messages.accountId, A1), eq(messages.sender, 'campaign')))
        ).length,
        2,
      );
      await drainOutbox(app);

      // 6. Resposta de CT4 → replied.
      const reply = await effects({
        tenantId: MILVENDAS_TENANT_ID,
        contactId: CT4,
        text: 'Muito obrigado!',
        receivedAt: AT,
      });
      assert.equal(reply.repliesMarked > 0, true);
      assert.equal((await recipientOf(app, id, CT4))?.status, 'replied');

      // 7. Pausa humana a meio (a campanha ainda corre): 3 ticks sem envios.
      const paused = await app.inject({
        method: 'POST',
        url: `/v1/campaigns/${id}/pause`,
        ...auth,
        payload: {},
      });
      assert.equal(paused.statusCode, 200);
      assert.equal(paused.json().campaign.status, 'paused');
      const beforePause = await outboxCount(app);
      for (let i = 0; i < 3; i += 1) {
        const idle = await tick();
        assert.equal(idle.outcome, 'idle');
      }
      assert.equal(await outboxCount(app), beforePause);
      const resumed = await app.inject({
        method: 'POST',
        url: `/v1/campaigns/${id}/resume`,
        ...auth,
        payload: {},
      });
      assert.equal(resumed.statusCode, 200);
      assert.equal(resumed.json().campaign.status, 'running');

      // 8. Tick final envia a CT5; o seguinte conclui.
      assert.equal((await tick()).outcome, 'sent');
      assert.equal((await recipientOf(app, id, CT5))?.status, 'sent');
      assert.equal(await outboxCount(app), 3);
      assert.deepEqual(await tick(), { outcome: 'completed' });
      const [finished] = await app.db.select().from(campaigns).where(eq(campaigns.id, id));
      assert.equal(finished?.status, 'completed');

      // 9. Contagens por estado.
      const detail = await app.inject({ method: 'GET', url: `/v1/campaigns/${id}`, ...auth });
      assert.equal(detail.statusCode, 200);
      assert.deepEqual(detail.json().counts, {
        pending: 0,
        sent: 2,
        failed: 0,
        replied: 1,
        optedOut: 1,
      });

      // 10. Auditoria completa da jornada.
      const actions = (
        await app.db
          .select({ action: auditLog.action })
          .from(auditLog)
          .where(and(eq(auditLog.tenantId, MILVENDAS_TENANT_ID), eq(auditLog.entityId, id)))
      ).map((r) => r.action);
      for (const action of ['campaign.created', 'campaign.started', 'campaign.paused', 'campaign.resumed']) {
        assert.ok(actions.includes(action), `audit sem ${action}`);
      }

      // 11. Nenhum envio direto: o provider fake nunca foi chamado.
      const calls = (app.waProvider as unknown as { sendTextCalls?: unknown[] }).sendTextCalls ?? [];
      assert.equal(calls.length, 0);
    } finally {
      await app.close();
    }
  });
});
