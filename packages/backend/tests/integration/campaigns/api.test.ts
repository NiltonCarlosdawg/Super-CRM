import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { and, eq } from 'drizzle-orm';

import { auditLog } from '../../../src/adapters/db/schema/audit.schema.js';
import { campaignRecipients } from '../../../src/adapters/db/schema/campaigns.schema.js';
import { contacts } from '../../../src/adapters/db/schema/index.js';
import { MILVENDAS_TENANT_ID } from '../../../src/adapters/db/schema/tenants.schema.js';
import { whatsappAccounts } from '../../../src/adapters/db/schema/whatsapp-accounts.schema.js';
import { buildTestApp, type TestApp } from '../../helpers/http.js';

const A_SUP = '00000000-0000-0000-0000-0000000000a1';
const A_CAMP = '00000000-0000-0000-0000-0000000000a2';
const CT = [1, 2, 3, 4, 5, 6].map(
  (n) => `00000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`,
);
const body = {
  name: 'Promo Outubro',
  messageTemplate: 'Olá {{nome}}, temos novidades!',
  allowedAccountIds: [A_CAMP],
  dailyLimit: null,
};

/** Contas com os dois purposes + contactos: 4 elegíveis, 1 com opt-out, 1 sem consentimento. */
async function seed(app: TestApp): Promise<void> {
  await app.db.insert(whatsappAccounts).values([
    {
      id: A_SUP,
      tenantId: MILVENDAS_TENANT_ID,
      label: 'Apoio',
      providerSessionId: 'sess-api-support',
      purpose: 'support',
    },
    {
      id: A_CAMP,
      tenantId: MILVENDAS_TENANT_ID,
      label: 'Campanhas',
      providerSessionId: 'sess-api-campaigns',
      purpose: 'campaigns',
      status: 'connected',
      createdAt: new Date('2026-10-04T10:00:00Z'),
    },
  ]);
  await app.db.insert(contacts).values(
    CT.map((id, i) => ({
      id,
      tenantId: MILVENDAS_TENANT_ID,
      phoneE164: `+2449000010${i}${i}`,
      name: `Contacto ${i}`,
      marketingConsent: i !== 5,
      optedOutAt: i === 4 ? new Date('2026-10-01T00:00:00Z') : null,
    })),
  );
}

const admin = (app: TestApp) => ({
  cookies: { session: app.sessions.admin, csrf: app.csrf.admin },
  headers: { 'x-csrf-token': app.csrf.admin },
});

describe('POST /v1/campaigns', () => {
  it('exige sessão e papel admin', async () => {
    const app = await buildTestApp();
    try {
      const noSession = await app.inject({ method: 'POST', url: '/v1/campaigns', payload: body });
      assert.equal(noSession.statusCode, 401);
      const asAgent = await app.inject({
        method: 'POST',
        url: '/v1/campaigns',
        payload: body,
        cookies: { session: app.sessions.agent },
        headers: { 'x-csrf-token': app.csrf.agent },
      });
      assert.equal(asAgent.statusCode, 403);
      const asEditor = await app.inject({
        method: 'POST',
        url: '/v1/campaigns',
        payload: body,
        cookies: { session: app.sessions.editor },
        headers: { 'x-csrf-token': app.csrf.editor },
      });
      assert.equal(asEditor.statusCode, 403);
    } finally {
      await app.close();
    }
  });

  it('recusa conta purpose = support no boundary HTTP (obrigatório)', async () => {
    const app = await buildTestApp();
    try {
      await seed(app);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/campaigns',
        ...admin(app),
        headers: { ...admin(app).headers, 'idempotency-key': 'K1' },
        payload: { ...body, allowedAccountIds: [A_SUP] },
      });
      assert.equal(res.statusCode, 400);
      assert.match(String(res.json().detail), /purpose/i);
    } finally {
      await app.close();
    }
  });

  it('Idempotency-Key obrigatória: em falta 400, replay 200, corpo diferente 409', async () => {
    const app = await buildTestApp();
    try {
      await seed(app);
      const auth = admin(app);
      const missing = await app.inject({ method: 'POST', url: '/v1/campaigns', ...auth, payload: body });
      assert.equal(missing.statusCode, 400);
      assert.match(String(missing.json().detail), /Idempotency-Key/);

      const first = await app.inject({
        method: 'POST',
        url: '/v1/campaigns',
        ...auth,
        headers: { ...auth.headers, 'idempotency-key': 'K1' },
        payload: body,
      });
      assert.equal(first.statusCode, 201);
      assert.equal(first.json().replayed, false);

      const replay = await app.inject({
        method: 'POST',
        url: '/v1/campaigns',
        ...auth,
        headers: { ...auth.headers, 'idempotency-key': 'K1' },
        payload: body,
      });
      assert.equal(replay.statusCode, 200);
      assert.equal(replay.json().replayed, true);
      assert.equal(replay.json().campaign.id, first.json().campaign.id);

      const conflict = await app.inject({
        method: 'POST',
        url: '/v1/campaigns',
        ...auth,
        headers: { ...auth.headers, 'idempotency-key': 'K1' },
        payload: { ...body, name: 'Outro' },
      });
      assert.equal(conflict.statusCode, 409);
      assert.match(String(conflict.headers['content-type']), /application\/problem\+json/);
    } finally {
      await app.close();
    }
  });
});

describe('ciclo start/pause/resume/estados', () => {
  it('start materializa; pause/resume mudam estado com 409 no estado errado; GET devolve contagens', async () => {
    const app = await buildTestApp();
    try {
      await seed(app);
      const auth = admin(app);
      const created = await app.inject({
        method: 'POST',
        url: '/v1/campaigns',
        ...auth,
        headers: { ...auth.headers, 'idempotency-key': 'K1' },
        payload: body,
      });
      assert.equal(created.statusCode, 201);
      const id: string = created.json().campaign.id;

      const startHeaders = { ...auth.headers, 'idempotency-key': 'S1' };
      const started = await app.inject({
        method: 'POST',
        url: `/v1/campaigns/${id}/start`,
        ...auth,
        headers: startHeaders,
        payload: { scheduledAt: null },
      });
      assert.equal(started.statusCode, 200);
      assert.equal(started.json().recipientsCreated, 4); // CT5/CT6 fora pela segmentação
      assert.equal(started.json().campaign.status, 'running');

      const replay = await app.inject({
        method: 'POST',
        url: `/v1/campaigns/${id}/start`,
        ...auth,
        headers: startHeaders,
        payload: { scheduledAt: null },
      });
      assert.equal(replay.statusCode, 200);
      assert.equal(replay.json().replayed, true);
      assert.equal(replay.json().recipientsCreated, 0);

      const again = await app.inject({
        method: 'POST',
        url: `/v1/campaigns/${id}/start`,
        ...auth,
        headers: { ...auth.headers, 'idempotency-key': 'S2' },
        payload: { scheduledAt: null },
      });
      assert.equal(again.statusCode, 409);

      const paused = await app.inject({
        method: 'POST',
        url: `/v1/campaigns/${id}/pause`,
        ...auth,
        payload: {},
      });
      assert.equal(paused.statusCode, 200);
      assert.equal(paused.json().campaign.status, 'paused');
      assert.equal(paused.json().campaign.pauseReason, 'human');
      const pauseAgain = await app.inject({
        method: 'POST',
        url: `/v1/campaigns/${id}/pause`,
        ...auth,
        payload: {},
      });
      assert.equal(pauseAgain.statusCode, 409);

      const resumed = await app.inject({
        method: 'POST',
        url: `/v1/campaigns/${id}/resume`,
        ...auth,
        payload: {},
      });
      assert.equal(resumed.statusCode, 200);
      assert.equal(resumed.json().campaign.status, 'running');
      const resumeAgain = await app.inject({
        method: 'POST',
        url: `/v1/campaigns/${id}/resume`,
        ...auth,
        payload: {},
      });
      assert.equal(resumeAgain.statusCode, 409);

      // Estados por destinatário para as contagens pedidas.
      const rows = await app.db
        .select({ id: campaignRecipients.id })
        .from(campaignRecipients)
        .where(eq(campaignRecipients.campaignId, id));
      const ids = rows.map((r) => r.id).sort();
      const setStatus = async (
        recipientId: string,
        patch: Partial<typeof campaignRecipients.$inferInsert>,
      ): Promise<void> => {
        await app.db.update(campaignRecipients).set(patch).where(eq(campaignRecipients.id, recipientId));
      };
      await setStatus(ids[0]!, { status: 'sent' });
      await setStatus(ids[1]!, { status: 'sent' });
      await setStatus(ids[2]!, { status: 'replied' });
      await setStatus(ids[3]!, { status: 'failed', optedOutAt: new Date('2026-10-07T10:00:00Z') });

      const detail = await app.inject({ method: 'GET', url: `/v1/campaigns/${id}`, ...auth });
      assert.equal(detail.statusCode, 200);
      assert.deepEqual(detail.json().counts, { pending: 0, sent: 2, failed: 1, replied: 1, optedOut: 1 });

      // Uma segunda campanha para a paginação ter mesmo duas páginas.
      const second = await app.inject({
        method: 'POST',
        url: '/v1/campaigns',
        ...auth,
        headers: { ...auth.headers, 'idempotency-key': 'K2' },
        payload: { ...body, name: 'Promo Novembro' },
      });
      assert.equal(second.statusCode, 201);

      const page1 = await app.inject({ method: 'GET', url: '/v1/campaigns?limit=1', ...auth });
      assert.equal(page1.statusCode, 200);
      assert.equal(page1.json().items.length, 1);
      assert.ok(page1.json().nextCursor);

      const page2 = await app.inject({
        method: 'GET',
        url: `/v1/campaigns?limit=1&cursor=${encodeURIComponent(page1.json().nextCursor)}`,
        ...auth,
      });
      assert.equal(page2.statusCode, 200);
      assert.equal(page2.json().items.length, 1);

      const actions = await app.db
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, MILVENDAS_TENANT_ID), eq(auditLog.entityId, id)));
      const seen = actions.map((a) => a.action);
      assert.ok(seen.includes('campaign.created'));
      assert.ok(seen.includes('campaign.started'));
      assert.ok(seen.includes('campaign.paused'));
      assert.ok(seen.includes('campaign.resumed'));
    } finally {
      await app.close();
    }
  });
});
