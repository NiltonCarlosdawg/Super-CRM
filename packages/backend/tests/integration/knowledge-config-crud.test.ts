import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';

import { createSessionStore } from '../../src/adapters/db/auth.js';
import * as base from '../../src/adapters/db/schema/index.js';
import { businessLines, handoffTriggers, knowledgeDocs, knowledgeDraftItems, knowledgeSuggestions } from '../../src/modules/knowledge/knowledge.schema.js';
import { seedHandoffTriggers } from '../../src/modules/knowledge/handoff-triggers.seed.js';
import { resetDb } from '../helpers/db.js';
import { buildTestApp, type TestApp } from '../helpers/http.js';

interface Sess { session: string; csrf: string }

const editor = (app: TestApp): Sess => ({ session: app.sessions.editor, csrf: app.csrf.editor });

async function seedLines(app: TestApp): Promise<void> {
  await app.db.insert(businessLines).values([
    { slug: 'software', name: 'Software', conversionGoal: 'demo_request' },
    { slug: 'cctv', name: 'CCTV', conversionGoal: 'installation_booking' },
    { slug: 'custom', name: 'Personalizado', conversionGoal: 'proposal_request' },
    { slug: 'telecom', name: 'Telecomunicações', conversionGoal: 'purchase' },
  ]).onConflictDoNothing();
}

async function tenantBSession(app: TestApp): Promise<Sess> {
  const [tenant] = await app.db.insert(base.tenants).values({ id: randomUUID(), name: 'Tenant B — config test' }).returning({ id: base.tenants.id });
  assert.ok(tenant !== undefined);
  const [user] = await app.db.insert(base.users).values({ tenantId: tenant.id, name: 'Admin B', email: 'admin-b@config.test.local', passwordHash: 'hash-sintetico-sem-login', role: 'admin', active: true }).returning({ id: base.users.id });
  assert.ok(user !== undefined);
  const store = createSessionStore({ db: app.db });
  const { sessionId } = await store.create({ userId: user.id, role: 'admin', mfaPending: false, now: new Date(), ttlHours: 72, ip: '127.0.0.1' });
  return { session: sessionId, csrf: randomUUID() };
}

const call = (app: TestApp, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, s: Sess, payload?: unknown) =>
  app.inject({ method, url, cookies: { session: s.session, csrf: s.csrf }, headers: { 'x-csrf-token': s.csrf }, ...(payload !== undefined ? { payload } : {}) });

test('knowledge config CRUD', async () => {
  await resetDb();
  const app = await buildTestApp();
  try {
    await seedLines(app);
    const tenantB = await tenantBSession(app);
    const a = editor(app);

    // Task 4 — perguntas
    const created = await call(app, 'POST', '/v1/knowledge/qualification-questions', a, {
      lineSlug: 'cctv', key: 'camera_count', question: 'Quantas câmaras pretende?', answerType: 'number', position: 1,
    });
    assert.equal(created.statusCode, 201);
    const questionId = (created.json() as { id: string }).id;

    const duplicateSameTenant = await call(app, 'POST', '/v1/knowledge/qualification-questions', a, {
      lineSlug: 'cctv', key: 'camera_count', question: 'Quantas câmaras pretende?', answerType: 'number', position: 1,
    });
    assert.equal(duplicateSameTenant.statusCode, 409);
    assert.equal((duplicateSameTenant.json() as { title: string }).title, 'duplicate_key');

    const duplicateOtherTenant = await call(app, 'POST', '/v1/knowledge/qualification-questions', tenantB, {
      lineSlug: 'cctv', key: 'camera_count', question: 'Quantas câmaras pretende?', answerType: 'number', position: 1,
    });
    assert.equal(duplicateOtherTenant.statusCode, 201);

    const updated = await call(app, 'PATCH', `/v1/knowledge/qualification-questions/${questionId}`, a, {
      question: 'Quantas câmaras quer instalar?', expectedVersion: 1,
    });
    assert.equal(updated.statusCode, 200);
    assert.equal((updated.json() as { version: number }).version, 2);

    const stale = await call(app, 'PATCH', `/v1/knowledge/qualification-questions/${questionId}`, a, {
      question: 'Texto desactualizado', expectedVersion: 1,
    });
    assert.equal(stale.statusCode, 409);

    const revisions = await call(app, 'GET', `/v1/knowledge/config-revisions?entityType=qualification_question&entityId=${questionId}`, a);
    assert.equal(revisions.statusCode, 200);
    const revisionItems = (revisions.json() as { items: Array<{ id: string; version: number }> }).items;
    assert.equal(revisionItems[0]?.version, 1);

    const reverted = await call(app, 'POST', `/v1/knowledge/config-revisions/${revisionItems[0]!.id}/revert`, a, { expectedVersion: 2 });
    assert.equal(reverted.statusCode, 200);
    assert.equal((reverted.json() as { version: number; question: string }).version, 3);
    assert.equal((reverted.json() as { version: number; question: string }).question, 'Quantas câmaras pretende?');

    // Task 5 — gatilhos
    await seedHandoffTriggers(app.db);
    const list = await call(app, 'GET', '/v1/knowledge/triggers?lineSlug=software', a);
    assert.equal(list.statusCode, 200);
    const items = list.json() as { items: Array<{ code: string; lineId: string | null; description: string }> };
    assert.ok(items.items.some((item) => item.lineId === null), 'global triggers included');
    assert.ok(items.items.some((item) => item.lineId !== null), 'line triggers included');

    const [trigger] = await app.db.select().from(handoffTriggers).where(eq(handoffTriggers.code, 'human_requested')).limit(1);
    assert.ok(trigger !== undefined);
    const patch = await call(app, 'PATCH', `/v1/knowledge/triggers/${trigger.id}`, a, { description: 'Descrição alterada', expectedVersion: trigger.version });
    assert.equal(patch.statusCode, 200);

    await seedHandoffTriggers(app.db);
    const [afterSeed] = await app.db.select().from(handoffTriggers).where(eq(handoffTriggers.id, trigger.id)).limit(1);
    assert.equal(afterSeed?.description, 'Descrição alterada');

    const triggerRevisions = await call(app, 'GET', `/v1/knowledge/config-revisions?entityType=handoff_trigger&entityId=${trigger.id}`, a);
    assert.equal(triggerRevisions.statusCode, 200);
    const triggerRevisionItems = (triggerRevisions.json() as { items: Array<{ id: string; version: number }> }).items;
    const triggerReverted = await call(app, 'POST', `/v1/knowledge/config-revisions/${triggerRevisionItems[0]!.id}/revert`, a, { expectedVersion: 2 });
    assert.equal(triggerReverted.statusCode, 200);
    assert.equal((triggerReverted.json() as { version: number }).version, 3);

    // Task 6 — sugestões
    const [docLine] = await app.db.select({ id: businessLines.id }).from(businessLines).where(eq(businessLines.slug, 'cctv')).limit(1);
    assert.ok(docLine !== undefined);
    const [doc] = await app.db.insert(knowledgeDocs).values({
      tenantId: base.MILVENDAS_TENANT_ID,
      lineId: docLine.id,
      type: 'faq',
      title: 'Perguntas frequentes',
      slug: 'faq-cctv',
      body: 'Conteúdo sintético.',
      status: 'published',
      ownerId: app.users.editor.id,
    }).returning({ id: knowledgeDocs.id });
    assert.ok(doc !== undefined);

    const createdSuggestion = await call(app, 'POST', '/v1/knowledge/suggestions', a, {
      humanAnswer: 'Responder ao cliente com o FAQ aprovado.',
      proposedTitle: 'FAQ CCTV',
      proposedBody: 'Actualização sintética do FAQ.',
      targetDocId: doc.id,
      proposedDocType: 'faq',
    });
    assert.equal(createdSuggestion.statusCode, 201);
    const suggestionId = (createdSuggestion.json() as { id: string }).id;

    const approved = await call(app, 'POST', `/v1/knowledge/suggestions/${suggestionId}/approve`, a);
    assert.equal(approved.statusCode, 200);
    assert.equal((approved.json() as { status: string; stagedItemId: string | null }).status, 'approved');

    const suggestionRow = await app.db.select().from(knowledgeSuggestions).where(eq(knowledgeSuggestions.id, suggestionId)).limit(1);
    assert.equal(suggestionRow[0]?.stagedItemId !== null, true);

    const draftRow = await app.db.select().from(knowledgeDraftItems).where(eq(knowledgeDraftItems.slug, 'faq-cctv')).limit(1);
    assert.equal(draftRow[0]?.op, 'update');

    const rejected = await call(app, 'POST', '/v1/knowledge/suggestions', a, {
      humanAnswer: 'Não vale a pena.',
      proposedTitle: 'Outra sugestão',
      proposedBody: 'Texto sintético.',
    });
    const rejectedId = (rejected.json() as { id: string }).id;
    const reject = await call(app, 'POST', `/v1/knowledge/suggestions/${rejectedId}/reject`, a);
    assert.equal(reject.statusCode, 200);

    const tenantBList = await call(app, 'GET', '/v1/knowledge/suggestions?status=pending', tenantB);
    assert.equal(tenantBList.statusCode, 200);
    assert.equal((tenantBList.json() as { items: unknown[] }).items.length, 0);
  } finally {
    await app.close();
  }
});
