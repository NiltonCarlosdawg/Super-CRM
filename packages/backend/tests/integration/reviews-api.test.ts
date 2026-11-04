// Fase 2 Task 3 (design §5): revisão periódica do conhecimento publicado —
// vencimento por COALESCE(reviewed_at, updated_at) + review_every_days, API de
// alertas e de marcação manual, campos de validade/cadência na edição rápida e
// carimbo automático em publicar/editar/reverter. Fixtures sintéticas (AGENTS.md §13).

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { eq, sql } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';

import { createSessionStore } from '../../src/adapters/db/auth.js';
import * as base from '../../src/adapters/db/schema/index.js';
import {
  businessLines,
  catalogItems,
  knowledgeDocs,
  knowledgeDraftItems,
  rules,
} from '../../src/modules/knowledge/knowledge.schema.js';
import { buildTestApp, type TestApp } from '../helpers/http.js';

const DAY = 86_400_000;
const daysAgo = (days: number): Date => new Date(Date.now() - days * DAY);
const isRecent = (value: Date | null): boolean =>
  value !== null && Math.abs(value.getTime() - Date.now()) < 5_000;

interface Sess {
  session: string;
  csrf: string;
}

const editor = (app: TestApp): Sess => ({ session: app.sessions.editor, csrf: app.csrf.editor });
const agent = (app: TestApp): Sess => ({ session: app.sessions.agent, csrf: app.csrf.agent });

const call = (
  app: TestApp,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  s: Sess,
  payload?: unknown,
) =>
  app.inject({
    method,
    url,
    cookies: { session: s.session, csrf: s.csrf },
    headers: { 'x-csrf-token': s.csrf },
    ...(payload !== undefined ? { payload: payload as InjectOptions['payload'] } : {}),
  });

interface ReviewItem {
  entityType: string;
  id: string;
  slug: string;
  title: string;
  lineSlug: string | null;
  reviewedAt: string | null;
  reviewEveryDays: number;
  daysOverdue: number;
  validUntil: string | null;
}

const listReviews = async (app: TestApp, s: Sess, query = '') =>
  call(app, 'GET', `/v1/knowledge/reviews${query}`, s);

async function seedLines(app: TestApp): Promise<void> {
  await app.db
    .insert(businessLines)
    .values([
      { slug: 'software', name: 'Software', conversionGoal: 'demo_request' },
      { slug: 'cctv', name: 'CCTV', conversionGoal: 'installation_booking' },
    ])
    .onConflictDoNothing();
}

async function lineId(app: TestApp, slug: string): Promise<string> {
  const [row] = await app.db
    .select({ id: businessLines.id })
    .from(businessLines)
    .where(eq(businessLines.slug, slug));
  assert.ok(row !== undefined, `fixture: linha ${slug}`);
  return row.id;
}

async function tenantBSession(app: TestApp): Promise<Sess> {
  const [tenant] = await app.db
    .insert(base.tenants)
    .values({ id: randomUUID(), name: 'Empresa B (revisões sintética)' })
    .returning({ id: base.tenants.id });
  assert.ok(tenant !== undefined, 'fixture tenant B');
  const [user] = await app.db
    .insert(base.users)
    .values({
      tenantId: tenant.id,
      name: 'Admin B',
      email: 'admin-b@reviews.test.local',
      passwordHash: 'hash-sintetico-sem-login',
      role: 'admin',
      active: true,
    })
    .returning({ id: base.users.id });
  assert.ok(user !== undefined, 'fixture admin B');
  const store = createSessionStore({ db: app.db });
  const { sessionId } = await store.create({
    userId: user.id,
    role: 'admin',
    mfaPending: false,
    now: new Date(),
    ttlHours: 72,
    ip: '127.0.0.1',
  });
  return { session: sessionId, csrf: randomUUID() };
}

interface RowInput {
  slug: string;
  updatedAt: Date;
  reviewedAt?: Date | null;
  reviewEveryDays?: number;
  validUntil?: Date | null;
  status?: 'draft' | 'published' | 'archived';
}

async function insertCatalog(app: TestApp, input: RowInput): Promise<string> {
  const [row] = await app.db
    .insert(catalogItems)
    .values({
      tenantId: base.MILVENDAS_TENANT_ID,
      lineId: await lineId(app, 'cctv'),
      kind: 'service',
      name: `Item ${input.slug}`,
      slug: input.slug,
      summary: 'Pacote sintético para testes de revisão.',
      pricingMode: 'fixed',
      priceAmount: '150000.00',
      status: input.status ?? 'published',
      validUntil: input.validUntil ?? null,
      reviewedAt: input.reviewedAt ?? null,
      reviewEveryDays: input.reviewEveryDays ?? 90,
      ownerId: app.users.editor.id,
      updatedAt: input.updatedAt,
      version: 1,
    })
    .returning({ id: catalogItems.id });
  assert.ok(row !== undefined, 'fixture: catálogo');
  return row.id;
}

async function insertDoc(app: TestApp, input: RowInput): Promise<string> {
  const [row] = await app.db
    .insert(knowledgeDocs)
    .values({
      tenantId: base.MILVENDAS_TENANT_ID,
      lineId: null,
      type: 'policy',
      title: `Doc ${input.slug}`,
      slug: input.slug,
      body: 'Conteúdo sintético de política interna.',
      status: input.status ?? 'published',
      validUntil: input.validUntil ?? null,
      reviewedAt: input.reviewedAt ?? null,
      reviewEveryDays: input.reviewEveryDays ?? 90,
      ownerId: app.users.editor.id,
      updatedAt: input.updatedAt,
      version: 1,
    })
    .returning({ id: knowledgeDocs.id });
  assert.ok(row !== undefined, 'fixture: doc');
  return row.id;
}

async function insertRule(app: TestApp, input: RowInput): Promise<string> {
  const [row] = await app.db
    .insert(rules)
    .values({
      tenantId: base.MILVENDAS_TENANT_ID,
      lineId: await lineId(app, 'software'),
      kind: 'tone',
      title: `Regra ${input.slug}`,
      slug: input.slug,
      instruction: 'Tratar por Você.',
      status: input.status ?? 'published',
      validUntil: input.validUntil ?? null,
      reviewedAt: input.reviewedAt ?? null,
      reviewEveryDays: input.reviewEveryDays ?? 90,
      ownerId: app.users.editor.id,
      updatedAt: input.updatedAt,
      version: 1,
    })
    .returning({ id: rules.id });
  assert.ok(row !== undefined, 'fixture: regra');
  return row.id;
}

const stageCatalog = async (app: TestApp, slug: string): Promise<void> => {
  await app.db.insert(knowledgeDraftItems).values({
    tenantId: base.MILVENDAS_TENANT_ID,
    slug,
    entityType: 'catalog_item',
    op: 'create',
    lineSlug: 'cctv',
    lineConfirmed: true,
    payload: {
      kind: 'catalog_item',
      name: 'Pacote CFTV 4 câmaras',
      summary: 'Quatro câmaras com instalação incluída.',
      details: { cameras: 4 },
      pricingMode: 'fixed',
      priceAmount: '150000.00',
      currency: 'AOA',
      priceNote: null,
      availability: 'available',
    },
    chunks: null,
    baseVersion: null,
    changedById: app.users.editor.id,
  });
};

const trainPublish = async (app: TestApp): Promise<string> => {
  const res = await call(app, 'POST', '/v1/knowledge/train/validate', editor(app), {});
  assert.equal(res.statusCode, 200, 'publicação de treino');
  return (res.json() as { publicationId: string }).publicationId;
};

test('GET /v1/knowledge/reviews: só vencidos por COALESCE, ordenados por dias em atraso, com limite', async () => {
  const app = await buildTestApp();
  try {
    await seedLines(app);
    // Nunca revisto: a base é o updated_at antigo (não "nasce" vencido no dia 1).
    const worst = await insertCatalog(app, { slug: 'pacote-velho', updatedAt: daysAgo(120) });
    // Revisto há 100 dias com cadência de 90 → 10 dias em atraso.
    const rule = await insertRule(app, {
      slug: 'tom-formal',
      updatedAt: daysAgo(2),
      reviewedAt: daysAgo(100),
    });
    // Ainda dentro da cadência.
    const fresh = await insertDoc(app, { slug: 'garantia', updatedAt: daysAgo(10) });
    // Draft e archived nunca entram.
    await insertCatalog(app, { slug: 'rascunho', updatedAt: daysAgo(300), status: 'draft' });
    await insertDoc(app, { slug: 'antigo-arquivado', updatedAt: daysAgo(300), status: 'archived' });

    const res = await listReviews(app, editor(app), '?limit=10');
    assert.equal(res.statusCode, 200);
    const items = (res.json() as { items: ReviewItem[] }).items;
    assert.deepEqual(
      items.map((item) => item.id),
      [worst, rule],
      'vencidos primeiro por dias em atraso; não vencidos/draft/archived de fora',
    );
    assert.equal(items[0]?.entityType, 'catalog_item');
    assert.equal(items[0]?.slug, 'pacote-velho');
    assert.equal(items[0]?.lineSlug, 'cctv');
    assert.equal(items[0]?.reviewedAt, null);
    assert.equal(items[0]?.reviewEveryDays, 90);
    assert.equal(items[0]?.daysOverdue, 30);
    assert.equal(items[0]?.validUntil, null);
    assert.equal(items[1]?.entityType, 'rule');
    assert.equal(items[1]?.lineSlug, 'software');
    assert.equal(items[1]?.daysOverdue, 10);
    assert.ok(items.every((item) => item.id !== fresh), 'item dentro da cadência fora');

    const limited = await listReviews(app, editor(app), '?limit=1');
    assert.deepEqual(
      ((limited.json() as { items: ReviewItem[] }).items ?? []).map((item) => item.id),
      [worst],
      'limit corta pelos mais vencidos',
    );
  } finally {
    await app.close();
  }
});

test('item expirado (valid_until no passado) continua na lista de revisões', async () => {
  const app = await buildTestApp();
  try {
    await seedLines(app);
    const expired = await insertCatalog(app, {
      slug: 'campanha-verao',
      updatedAt: daysAgo(200),
      validUntil: daysAgo(5),
    });

    const res = await listReviews(app, editor(app));
    const items = (res.json() as { items: ReviewItem[] }).items;
    const entry = items.find((item) => item.id === expired);
    assert.ok(entry !== undefined, 'expirado continua visível para revisão');
    assert.ok(entry.validUntil !== null && new Date(entry.validUntil).getTime() < Date.now());
    assert.equal(entry.daysOverdue, 110);
  } finally {
    await app.close();
  }
});

test('marcação manual: 200, sai da lista, carimbo reviewed_at e audit knowledge.reviewed', async () => {
  const app = await buildTestApp();
  try {
    await seedLines(app);
    const overdue = await insertCatalog(app, { slug: 'pacote-velho', updatedAt: daysAgo(120) });

    const res = await call(app, 'POST', `/v1/knowledge/reviews/catalog_item/${overdue}`, editor(app), {});
    assert.equal(res.statusCode, 200);
    const body = res.json() as ReviewItem;
    assert.equal(body.entityType, 'catalog_item');
    assert.equal(body.id, overdue);
    assert.equal(body.slug, 'pacote-velho');
    assert.ok(isRecent(new Date(body.reviewedAt ?? 0)), 'reviewed_at = agora');
    assert.equal(body.daysOverdue, 0, 'depois de revisto não há atraso');

    const after = await listReviews(app, editor(app));
    assert.deepEqual((after.json() as { items: unknown[] }).items, [], 'sai da lista');

    const [row] = await app.db
      .select({ reviewedAt: catalogItems.reviewedAt })
      .from(catalogItems)
      .where(eq(catalogItems.id, overdue));
    assert.ok(isRecent(row?.reviewedAt ?? null), 'carimbo persistido');

    const audits = await app.db
      .select({ actorId: base.auditLog.actorId, details: base.auditLog.details })
      .from(base.auditLog)
      .where(eq(base.auditLog.action, 'knowledge.reviewed'));
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.actorId, app.users.editor.id);
    // O adaptador de audit acrescenta `entity`; os campos do domínio mandam.
    const details = audits[0]?.details as { entityType: string; id: string; daysOverdue: number };
    assert.equal(details.entityType, 'catalog_item');
    assert.equal(details.id, overdue);
    assert.equal(details.daysOverdue, 30);
  } finally {
    await app.close();
  }
});

test('revisões: 404 inexistente/cross-tenant, 409 não publicado, 403 agent', async () => {
  const app = await buildTestApp();
  try {
    await seedLines(app);
    const published = await insertCatalog(app, { slug: 'pacote-velho', updatedAt: daysAgo(120) });
    const draft = await insertRule(app, { slug: 'regra-rascunho', updatedAt: daysAgo(300), status: 'draft' });

    const missing = await call(app, 'POST', `/v1/knowledge/reviews/catalog_item/${randomUUID()}`, editor(app), {});
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().title, 'item_not_found');

    const notPublished = await call(app, 'POST', `/v1/knowledge/reviews/rule/${draft}`, editor(app), {});
    assert.equal(notPublished.statusCode, 409);
    assert.equal(notPublished.json().title, 'not_published');

    const b = await tenantBSession(app);
    const crossTenant = await call(app, 'POST', `/v1/knowledge/reviews/catalog_item/${published}`, b, {});
    assert.equal(crossTenant.statusCode, 404, 'B não marca revisões de A');
    const listB = await listReviews(app, b);
    assert.deepEqual((listB.json() as { items: unknown[] }).items, [], 'B não vê revisões de A');

    const agentGet = await listReviews(app, agent(app));
    assert.equal(agentGet.statusCode, 403);
    const agentPost = await call(app, 'POST', `/v1/knowledge/reviews/catalog_item/${published}`, agent(app), {});
    assert.equal(agentPost.statusCode, 403);
  } finally {
    await app.close();
  }
});

test('edição rápida aceita reviewEveryDays/validFrom/validUntil nos três tipos e carimba reviewed_at', async () => {
  const app = await buildTestApp();
  try {
    await seedLines(app);
    const cat = await insertCatalog(app, { slug: 'pacote-velho', updatedAt: daysAgo(120) });
    const doc = await insertDoc(app, {
      slug: 'garantia',
      updatedAt: daysAgo(1),
      validUntil: daysAgo(-30),
    });
    const rule = await insertRule(app, { slug: 'tom-formal', updatedAt: daysAgo(1) });

    const catRes = await call(app, 'PATCH', `/v1/knowledge/items/${cat}`, editor(app), {
      entityType: 'catalog_item',
      patch: {
        reviewEveryDays: 30,
        validFrom: '2026-11-01T00:00:00.000Z',
        validUntil: '2027-01-01T00:00:00.000Z',
      },
    });
    assert.equal(catRes.statusCode, 200);
    const [catAfter] = await app.db.select().from(catalogItems).where(eq(catalogItems.id, cat));
    assert.equal(catAfter?.reviewEveryDays, 30);
    assert.equal(catAfter?.validFrom?.toISOString(), '2026-11-01T00:00:00.000Z');
    assert.equal(catAfter?.validUntil?.toISOString(), '2027-01-01T00:00:00.000Z');
    assert.ok(isRecent(catAfter?.reviewedAt ?? null), 'edição rápida carimba reviewed_at');

    const docRes = await call(app, 'PATCH', `/v1/knowledge/items/${doc}`, editor(app), {
      entityType: 'knowledge_doc',
      patch: { reviewEveryDays: 45, validUntil: null },
    });
    assert.equal(docRes.statusCode, 200);
    const [docAfter] = await app.db.select().from(knowledgeDocs).where(eq(knowledgeDocs.id, doc));
    assert.equal(docAfter?.reviewEveryDays, 45);
    assert.equal(docAfter?.validUntil, null, 'null limpa a validade');
    assert.ok(isRecent(docAfter?.reviewedAt ?? null));

    const ruleRes = await call(app, 'PATCH', `/v1/knowledge/items/${rule}`, editor(app), {
      entityType: 'rule',
      patch: { reviewEveryDays: 60, validFrom: '2026-11-04T00:00:00.000Z' },
    });
    assert.equal(ruleRes.statusCode, 200);
    const [ruleAfter] = await app.db.select().from(rules).where(eq(rules.id, rule));
    assert.equal(ruleAfter?.reviewEveryDays, 60);
    assert.equal(ruleAfter?.validFrom?.toISOString(), '2026-11-04T00:00:00.000Z');
    assert.ok(isRecent(ruleAfter?.reviewedAt ?? null));

    const tooSmall = await call(app, 'PATCH', `/v1/knowledge/items/${cat}`, editor(app), {
      entityType: 'catalog_item',
      patch: { reviewEveryDays: 0 },
    });
    assert.equal(tooSmall.statusCode, 400);
    assert.equal(tooSmall.json().title, 'invalid_patch');

    const notADate = await call(app, 'PATCH', `/v1/knowledge/items/${cat}`, editor(app), {
      entityType: 'catalog_item',
      patch: { validUntil: 'amanhã' },
    });
    assert.equal(notADate.statusCode, 400);
    assert.equal(notADate.json().title, 'invalid_patch');
  } finally {
    await app.close();
  }
});

test('carimbo automático: publicar (treino) e reverter marcam reviewed_at = agora', async () => {
  const app = await buildTestApp();
  try {
    await seedLines(app);

    await stageCatalog(app, 'pacote-treinado');
    await trainPublish(app);
    const [published] = await app.db
      .select({ reviewedAt: catalogItems.reviewedAt })
      .from(catalogItems)
      .where(eq(catalogItems.slug, 'pacote-treinado'));
    assert.ok(isRecent(published?.reviewedAt ?? null), 'publicar é validação humana → carimbo');

    const item = await insertCatalog(app, { slug: 'pacote-velho', updatedAt: daysAgo(1) });
    const edited = await call(app, 'PATCH', `/v1/knowledge/items/${item}`, editor(app), {
      entityType: 'catalog_item',
      patch: { priceAmount: '180000.00' },
    });
    assert.equal(edited.statusCode, 200);
    const publicationId = (edited.json() as { publicationId: string }).publicationId;

    // Isola a reversão: repõe um reviewed_at antigo por fora.
    await app.db
      .update(catalogItems)
      .set({ reviewedAt: daysAgo(60) })
      .where(eq(catalogItems.id, item));

    const reverted = await call(app, 'POST', '/v1/knowledge/published/revert', editor(app), { publicationId });
    assert.equal(reverted.statusCode, 200);
    const [after] = await app.db
      .select({ reviewedAt: catalogItems.reviewedAt, priceAmount: catalogItems.priceAmount })
      .from(catalogItems)
      .where(eq(catalogItems.id, item));
    assert.ok(isRecent(after?.reviewedAt ?? null), 'reverter volta a validar → carimbo');
    assert.equal(after?.priceAmount, '150000.00', 'reversão restaurou o preço');
  } finally {
    await app.close();
  }
});

test('migração 0012: rules ganha validade/revisão e o índice de status+validade', async () => {
  const app = await buildTestApp();
  try {
    const columns = await app.db.execute(sql`
      SELECT column_name, column_default
      FROM information_schema.columns
      WHERE table_name = 'rules'
        AND column_name IN ('valid_from', 'valid_until', 'reviewed_at', 'review_every_days')`);
    const found = (columns.rows as Array<{ column_name: string; column_default: string | null }>)
      .reduce<Record<string, string | null>>((acc, row) => ({ ...acc, [row.column_name]: row.column_default }), {});
    assert.deepEqual(
      Object.keys(found).sort(),
      ['review_every_days', 'reviewed_at', 'valid_from', 'valid_until'],
      'as quatro colunas existem',
    );
    assert.equal(found.valid_from, null, 'validade opcional');
    assert.equal(found.reviewed_at, null, 'revisão opcional');
    assert.match(String(found.review_every_days), /90/, 'cadência default 90 dias');

    const index = await app.db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'rules' AND indexname = 'rules_status_valid_idx'`);
    assert.equal(index.rows.length, 1, 'índice rules_status_valid_idx');
  } finally {
    await app.close();
  }
});
