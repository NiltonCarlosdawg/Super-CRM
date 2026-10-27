// Treinar agente, Task 7: edição rápida de um item publicado e reversão de
// publicações. Cobre os 5 cenários do brief (edição de preço + listagem,
// patch inválido, reversão, reversão desactualizada e isolamento de tenant).
// Fixtures 100% sintéticas (AGENTS.md §13).

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { and, eq } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';

import { createSessionStore } from '../../src/adapters/db/auth.js';
import * as base from '../../src/adapters/db/schema/index.js';
import {
  businessLines,
  catalogItems,
  knowledgeDraftItems,
  knowledgePublications,
  knowledgeRevisions,
} from '../../src/modules/knowledge/knowledge.schema.js';
import { buildTestApp, type TestApp } from '../helpers/http.js';

interface Sess {
  session: string;
  csrf: string;
}

const editor = (app: TestApp): Sess => ({ session: app.sessions.editor, csrf: app.csrf.editor });
const admin = (app: TestApp): Sess => ({ session: app.sessions.admin, csrf: app.csrf.admin });

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

/** Dicionário global `business_lines` (não pertence a tenants). */
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

interface PublishedCatalogInput {
  slug: string;
  version?: number;
  priceAmount?: string;
  name?: string;
}

/** Item publicado por insert directo (não passa pelo staging da T6). */
async function insertPublishedCatalog(app: TestApp, input: PublishedCatalogInput) {
  const line = await lineId(app, 'cctv');
  const [row] = await app.db
    .insert(catalogItems)
    .values({
      tenantId: base.MILVENDAS_TENANT_ID,
      lineId: line,
      kind: 'service',
      name: input.name ?? 'Pacote CFTV 4 câmaras',
      slug: input.slug,
      summary: 'Quatro câmaras com instalação incluída.',
      details: { cameras: 4, indoor: true },
      pricingMode: 'fixed',
      priceAmount: input.priceAmount ?? '150000.00',
      currency: 'AOA',
      priceNote: null,
      availability: 'available',
      status: 'published',
      ownerId: app.users.editor.id,
      version: input.version ?? 1,
    })
    .returning();
  assert.ok(row !== undefined, 'fixture: catálogo publicado');
  return row;
}

async function tenantBSession(app: TestApp): Promise<Sess> {
  const [tenant] = await app.db
    .insert(base.tenants)
    .values({ id: randomUUID(), name: 'Empresa B (edição sintética)' })
    .returning({ id: base.tenants.id });
  assert.ok(tenant !== undefined, 'fixture tenant B');
  const [user] = await app.db
    .insert(base.users)
    .values({
      tenantId: tenant.id,
      name: 'Admin B',
      email: 'admin-b@quickedit.test.local',
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

const quickEditPrice = (app: TestApp, id: string, priceAmount: string, s = editor(app)) =>
  call(app, 'PATCH', `/v1/knowledge/items/${id}`, s, {
    entityType: 'catalog_item',
    patch: { priceAmount },
  });

const CATALOG_PAYLOAD = (priceAmount = '150000.00', name = 'Pacote CFTV 4 câmaras') => ({
  kind: 'catalog_item',
  name,
  summary: 'Quatro câmaras com instalação incluída.',
  details: { cameras: 4, indoor: true },
  pricingMode: 'fixed',
  priceAmount,
  currency: 'AOA',
  priceNote: null,
  availability: 'available',
});

/** Staging directo (o mesmo que o job de extracção faria) para a T6 publicar. */
async function stageCatalog(app: TestApp, input: { slug: string; priceAmount?: string }) {
  await app.db.insert(knowledgeDraftItems).values({
    tenantId: base.MILVENDAS_TENANT_ID,
    slug: input.slug,
    entityType: 'catalog_item',
    op: 'create',
    lineSlug: 'cctv',
    lineConfirmed: true,
    payload: CATALOG_PAYLOAD(input.priceAmount),
    chunks: null,
    baseVersion: null,
    changedById: app.users.editor.id,
  });
}

/** Publica o staging pela rota da T6 e devolve o id da publicação. */
async function trainPublish(app: TestApp): Promise<string> {
  const res = await call(app, 'POST', '/v1/knowledge/train/validate', editor(app), {});
  assert.equal(res.statusCode, 200, 'publicação de treino');
  return (res.json() as { publicationId: string }).publicationId;
}

test('edição rápida do preço: 200, activo actualizado, listagem e revisão quick_edit', async () => {
  const app = await buildTestApp();
  try {
    await seedLines(app);
    const item = await insertPublishedCatalog(app, { slug: 'pacote-cctv', version: 1 });

    const res = await quickEditPrice(app, item.id, '180000.00');
    assert.equal(res.statusCode, 200);
    const body = res.json() as { publicationId: string };
    assert.match(body.publicationId, /^[0-9a-f-]{36}$/, 'devolve o id da publicação');

    const [after] = await app.db
      .select()
      .from(catalogItems)
      .where(eq(catalogItems.id, item.id));
    assert.ok(after !== undefined);
    assert.equal(after.priceAmount, '180000.00', 'activo reflecte o preço novo');
    assert.equal(after.version, 2, 'bump de versão');
    assert.equal(after.status, 'published');

    const listed = await call(app, 'GET', '/v1/knowledge/published', editor(app));
    assert.equal(listed.statusCode, 200);
    const listBody = listed.json() as {
      items: Array<{
        id: string;
        entityType: string;
        slug: string;
        name: string | null;
        title: string | null;
        version: number;
      }>;
    };
    const entry = listBody.items.find((i) => i.id === item.id);
    assert.ok(entry !== undefined, 'item activo listado');
    assert.equal(entry.entityType, 'catalog_item');
    assert.equal(entry.slug, 'pacote-cctv');
    assert.equal(entry.name, 'Pacote CFTV 4 câmaras');
    assert.equal(entry.version, 2);

    const [publication] = await app.db
      .select()
      .from(knowledgePublications)
      .where(eq(knowledgePublications.id, body.publicationId));
    assert.ok(publication !== undefined, 'publicação criada');
    assert.equal(publication.kind, 'quick_edit');
    assert.equal(publication.createdById, app.users.editor.id);
    assert.match(publication.idempotencyKey, /^[0-9a-f-]{36}$/, 'chave uuid');

    const [revision] = await app.db
      .select()
      .from(knowledgeRevisions)
      .where(
        and(
          eq(knowledgeRevisions.entityId, item.id),
          eq(knowledgeRevisions.entityType, 'catalog_item'),
        ),
      );
    assert.ok(revision !== undefined, 'revisão do estado anterior');
    assert.equal(revision.version, 1, 'versão ANTERIOR ao bump');
    assert.equal(revision.note, 'quick_edit');
    assert.equal(revision.publicationId, body.publicationId);
    assert.equal((revision.snapshot as Record<string, unknown>).priceAmount, '150000.00');
    assert.equal((revision.snapshot as Record<string, unknown>).lineSlug, 'cctv');

    const audits = await app.db
      .select({ actorId: base.auditLog.actorId })
      .from(base.auditLog)
      .where(eq(base.auditLog.action, 'knowledge.item_edited'));
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.actorId, app.users.editor.id);
  } finally {
    await app.close();
  }
});

test('patch inválido (preço não numérico em fixed) → 400 e activo intacto', async () => {
  const app = await buildTestApp();
  try {
    await seedLines(app);
    const item = await insertPublishedCatalog(app, { slug: 'pacote-cctv', version: 1 });

    const res = await quickEditPrice(app, item.id, 'muito caro');
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().title, 'invalid_patch');

    const [after] = await app.db
      .select({ priceAmount: catalogItems.priceAmount, version: catalogItems.version })
      .from(catalogItems)
      .where(eq(catalogItems.id, item.id));
    assert.deepEqual(after, { priceAmount: '150000.00', version: 1 }, 'activo intacto');
    assert.equal((await app.db.select().from(knowledgePublications)).length, 0);
    assert.equal((await app.db.select().from(knowledgeRevisions)).length, 0);
  } finally {
    await app.close();
  }
});

test('reversão de uma edição rápida: preço volta ao anterior e kind revert registado', async () => {
  const app = await buildTestApp();
  try {
    await seedLines(app);
    const item = await insertPublishedCatalog(app, { slug: 'pacote-cctv', version: 1 });

    const edited = await quickEditPrice(app, item.id, '180000.00');
    assert.equal(edited.statusCode, 200);
    const publicationId = (edited.json() as { publicationId: string }).publicationId;

    const res = await call(app, 'POST', '/v1/knowledge/published/revert', admin(app), {
      publicationId,
    });
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as { reverted: number }).reverted, 1);

    const [after] = await app.db
      .select({ priceAmount: catalogItems.priceAmount, version: catalogItems.version, status: catalogItems.status })
      .from(catalogItems)
      .where(eq(catalogItems.id, item.id));
    assert.deepEqual(
      after,
      { priceAmount: '150000.00', version: 3, status: 'published' },
      'restaura o snapshot e incrementa a versão',
    );

    const revertPublica = await app.db
      .select()
      .from(knowledgePublications)
      .where(eq(knowledgePublications.kind, 'revert'));
    assert.equal(revertPublica.length, 1, 'publicação revert registada');
    assert.equal(revertPublica[0]?.createdById, app.users.admin.id);

    // Desfazer uma reversão não é suportado (o estado a repor seria ambíguo).
    const again = await call(app, 'POST', '/v1/knowledge/published/revert', editor(app), {
      publicationId: revertPublica[0]?.id,
    });
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().title, 'not_revertible');

    const audits = await app.db
      .select({ actorId: base.auditLog.actorId })
      .from(base.auditLog)
      .where(eq(base.auditLog.action, 'knowledge.reverted'));
    assert.equal(audits.length, 1);
  } finally {
    await app.close();
  }
});

test('reversão velha: editar depois de uma publicação → 409 stale_revert com slugs', async () => {
  const app = await buildTestApp();
  try {
    await seedLines(app);
    const item = await insertPublishedCatalog(app, { slug: 'pacote-cctv', version: 1 });

    const first = await quickEditPrice(app, item.id, '180000.00');
    assert.equal(first.statusCode, 200);
    const firstPublication = (first.json() as { publicationId: string }).publicationId;

    const second = await quickEditPrice(app, item.id, '190000.00');
    assert.equal(second.statusCode, 200);

    const res = await call(app, 'POST', '/v1/knowledge/published/revert', editor(app), {
      publicationId: firstPublication,
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().title, 'stale_revert');
    assert.deepEqual(res.json().slugs, ['pacote-cctv']);

    const [after] = await app.db
      .select({ priceAmount: catalogItems.priceAmount, version: catalogItems.version })
      .from(catalogItems)
      .where(eq(catalogItems.id, item.id));
    assert.deepEqual(after, { priceAmount: '190000.00', version: 3 }, 'tudo ou nada: nada mudou');
    assert.equal(
      (await app.db.select().from(knowledgePublications).where(eq(knowledgePublications.kind, 'revert')))
        .length,
      0,
    );
  } finally {
    await app.close();
  }
});

test('isolamento: item e publicação de outro tenant → 404', async () => {
  const app = await buildTestApp();
  try {
    await seedLines(app);
    const item = await insertPublishedCatalog(app, { slug: 'pacote-do-tenant-a', version: 1 });
    const edited = await quickEditPrice(app, item.id, '180000.00');
    assert.equal(edited.statusCode, 200);
    const publicationId = (edited.json() as { publicationId: string }).publicationId;

    const b = await tenantBSession(app);

    const patchB = await quickEditPrice(app, item.id, '1.00', b);
    assert.equal(patchB.statusCode, 404);
    assert.equal(patchB.json().title, 'item_not_found');

    const revertB = await call(app, 'POST', '/v1/knowledge/published/revert', b, { publicationId });
    assert.equal(revertB.statusCode, 404);
    assert.equal(revertB.json().title, 'publication_not_found');

    const listB = await call(app, 'GET', '/v1/knowledge/published', b);
    assert.equal(listB.statusCode, 200);
    assert.deepEqual((listB.json() as { items: unknown[] }).items, [], 'B não vê itens de A');

    const [after] = await app.db
      .select({ priceAmount: catalogItems.priceAmount })
      .from(catalogItems)
      .where(eq(catalogItems.id, item.id));
    assert.equal(after?.priceAmount, '180000.00', 'item de A intacto');
  } finally {
    await app.close();
  }
});

test('item criado pela T6 → edição rápida e reversão restauram o valor treinado', async () => {
  const app = await buildTestApp();
  try {
    await seedLines(app);
    await stageCatalog(app, { slug: 'pacote-treinado', priceAmount: '150000.00' });
    const trainPublication = await trainPublish(app);

    const [trained] = await app.db
      .select()
      .from(catalogItems)
      .where(eq(catalogItems.slug, 'pacote-treinado'));
    assert.ok(trained !== undefined, 'item publicado pela T6');
    assert.equal(trained.version, 1);

    const edited = await quickEditPrice(app, trained.id, '180000.00');
    assert.equal(edited.statusCode, 200, 'editar um item acabado de treinar não colide');

    const afterEdit = await app.db
      .select({ priceAmount: catalogItems.priceAmount, version: catalogItems.version })
      .from(catalogItems)
      .where(eq(catalogItems.id, trained.id));
    assert.deepEqual(afterEdit[0], { priceAmount: '180000.00', version: 2 });

    // A revisão `create` fica na versão 0 (estado ausente); a edição rápida
    // grava o pré-estado na versão 1 sem colidir.
    const revisions = await app.db
      .select()
      .from(knowledgeRevisions)
      .where(eq(knowledgeRevisions.entityId, trained.id))
      .orderBy(knowledgeRevisions.version);
    assert.deepEqual(
      revisions.map((revision) => ({ version: revision.version, note: revision.note })),
      [
        { version: 0, note: 'create' },
        { version: 1, note: 'quick_edit' },
      ],
    );

    const quickPublicationId = (edited.json() as { publicationId: string }).publicationId;
    const [quickPublication] = await app.db
      .select({ applied: knowledgePublications.applied })
      .from(knowledgePublications)
      .where(eq(knowledgePublications.id, quickPublicationId));
    const changes = (quickPublication?.applied as { changes?: unknown[] } | null)?.changes;
    assert.equal(changes?.length, 1, 'a publicação regista a alteração para a reversão');

    const reverted = await call(app, 'POST', '/v1/knowledge/published/revert', editor(app), {
      publicationId: quickPublicationId,
    });
    assert.equal(reverted.statusCode, 200);
    assert.equal((reverted.json() as { reverted: number }).reverted, 1);

    const afterRevert = await app.db
      .select({
        priceAmount: catalogItems.priceAmount,
        version: catalogItems.version,
        status: catalogItems.status,
      })
      .from(catalogItems)
      .where(eq(catalogItems.id, trained.id));
    assert.deepEqual(afterRevert[0], {
      priceAmount: '150000.00',
      version: 3,
      status: 'published',
    });
    assert.equal((await call(app, 'GET', '/v1/knowledge/published', editor(app))).statusCode, 200);
    assert.ok(trainPublication.length > 0);
  } finally {
    await app.close();
  }
});

test('reverter a publicação de treino que criou o item → arquiva-o', async () => {
  const app = await buildTestApp();
  try {
    await seedLines(app);
    await stageCatalog(app, { slug: 'pacote-treinado', priceAmount: '150000.00' });
    const trainPublication = await trainPublish(app);

    const res = await call(app, 'POST', '/v1/knowledge/published/revert', admin(app), {
      publicationId: trainPublication,
    });
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as { reverted: number }).reverted, 1);

    const [after] = await app.db
      .select({ status: catalogItems.status, version: catalogItems.version })
      .from(catalogItems)
      .where(eq(catalogItems.slug, 'pacote-treinado'));
    assert.deepEqual(after, { status: 'archived', version: 2 }, 'criação revertida = arquivado');

    const list = await call(app, 'GET', '/v1/knowledge/published', editor(app));
    assert.deepEqual((list.json() as { items: unknown[] }).items, [], 'sai da listagem do activo');
  } finally {
    await app.close();
  }
});

