// Treinar agente, Task 6: diff e validação atómica aditiva contra o activo.
// Staging directo em `knowledge_draft_items` e activos via inserts publicados;
// cobre os 9 cenários do brief (added, update «novo prevalece», conflito +
// aceitação, linha por confirmar, idempotência, concorrência, isolamento,
// arquivo explícito e papéis). Fixtures 100% sintéticas (AGENTS.md §13).

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { and, eq } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';

import { createAuditAdapter } from '../../src/adapters/db/audit-adapter.js';
import { createSessionStore } from '../../src/adapters/db/auth.js';
import * as base from '../../src/adapters/db/schema/index.js';
import {
  businessLines,
  catalogItems,
  knowledgeDocs,
  knowledgeDraftItems,
  knowledgePublications,
  knowledgeRevisions,
  rules,
  type DraftEntityType,
  type DraftOp,
} from '../../src/modules/knowledge/knowledge.schema.js';
import { validateDraft } from '../../src/modules/knowledge/publish-service.js';
import { buildTestApp, type TestApp } from '../helpers/http.js';

interface Sess {
  session: string;
  csrf: string;
}

const editor = (app: TestApp): Sess => ({ session: app.sessions.editor, csrf: app.csrf.editor });
const admin = (app: TestApp): Sess => ({ session: app.sessions.admin, csrf: app.csrf.admin });

const call = (
  app: TestApp,
  method: 'GET' | 'POST',
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

const DOC_PAYLOAD = {
  kind: 'knowledge_doc',
  docType: 'policy',
  title: 'Garantia da instalação',
  body: 'A instalação tem garantia de 12 meses.',
};

const RULE_PAYLOAD = {
  kind: 'rule',
  ruleKind: 'discount_limit',
  title: 'Desconto máximo',
  instruction: 'Nunca dar mais de 10% de desconto.',
  params: { maxDiscountPct: 10 },
};

interface StagedInput {
  slug: string;
  entityType: DraftEntityType;
  op: DraftOp;
  payload: Record<string, unknown>;
  lineSlug?: string | null;
  lineConfirmed?: boolean;
  baseVersion?: number | null;
}

/** Insert directo no staging (o mesmo que o job faria). */
async function insertStaged(app: TestApp, input: StagedInput): Promise<string> {
  const [row] = await app.db
    .insert(knowledgeDraftItems)
    .values({
      tenantId: base.MILVENDAS_TENANT_ID,
      slug: input.slug,
      entityType: input.entityType,
      op: input.op,
      lineSlug: input.lineSlug === undefined ? 'cctv' : input.lineSlug,
      lineConfirmed: input.lineConfirmed ?? true,
      payload: input.payload,
      chunks: null,
      baseVersion: input.baseVersion ?? null,
      changedById: app.users.editor.id,
    })
    .returning({ id: knowledgeDraftItems.id });
  assert.ok(row !== undefined, 'fixture: item staged');
  return row.id;
}

interface PublishedCatalogInput {
  slug: string;
  version: number;
  priceAmount?: string;
  name?: string;
  summary?: string;
}

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
      summary: input.summary ?? 'Quatro câmaras com instalação incluída.',
      details: { cameras: 4, indoor: true },
      pricingMode: 'fixed',
      priceAmount: input.priceAmount ?? '150000.00',
      currency: 'AOA',
      priceNote: null,
      availability: 'available',
      status: 'published',
      ownerId: app.users.editor.id,
      version: input.version,
    })
    .returning();
  assert.ok(row !== undefined, 'fixture: catálogo publicado');
  return row;
}

async function tenantBSession(app: TestApp): Promise<Sess> {
  const [tenant] = await app.db
    .insert(base.tenants)
    .values({ id: randomUUID(), name: 'Empresa B (validação sintética)' })
    .returning({ id: base.tenants.id });
  assert.ok(tenant !== undefined, 'fixture tenant B');
  const [user] = await app.db
    .insert(base.users)
    .values({
      tenantId: tenant.id,
      name: 'Admin B',
      email: 'admin-b@validate.test.local',
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

const stagedRows = (app: TestApp) =>
  app.db
    .select({ id: knowledgeDraftItems.id })
    .from(knowledgeDraftItems)
    .where(eq(knowledgeDraftItems.tenantId, base.MILVENDAS_TENANT_ID));

/** Dependências directas de `validateDraft` (caso de concorrência). */
function trainDeps(app: TestApp) {
  return {
    db: app.db,
    scope: { tenantId: base.MILVENDAS_TENANT_ID },
    audit: createAuditAdapter({ db: app.db }),
    now: () => new Date(),
  };
}

test('carga nova válida → diff added e publicação atómica dos três tipos', async () => {
  const app = await buildTestApp();
  try {
    await seedLines(app);
    const s = editor(app);

    await insertStaged(app, {
      slug: 'pacote-novo-cctv',
      entityType: 'catalog_item',
      op: 'create',
      payload: CATALOG_PAYLOAD(),
    });
    await insertStaged(app, {
      slug: 'garantia-cctv',
      entityType: 'knowledge_doc',
      op: 'create',
      payload: DOC_PAYLOAD,
    });
    await insertStaged(app, {
      slug: 'desconto-cctv',
      entityType: 'rule',
      op: 'create',
      payload: RULE_PAYLOAD,
    });

    const diffRes = await call(app, 'GET', '/v1/knowledge/train/diff', s);
    assert.equal(diffRes.statusCode, 200);
    const diff = diffRes.json() as {
      entries: Array<{ slug: string; classification: string }>;
      unconfirmedSlugs: string[];
      digest: string;
    };
    assert.deepEqual(
      diff.entries.map((e) => `${e.slug}:${e.classification}`).sort(),
      ['desconto-cctv:added', 'garantia-cctv:added', 'pacote-novo-cctv:added'],
    );
    assert.deepEqual(diff.unconfirmedSlugs, []);
    assert.match(diff.digest, /^[0-9a-f]{64}$/, 'digest sha256');

    const validateRes = await call(app, 'POST', '/v1/knowledge/train/validate', s, {});
    assert.equal(validateRes.statusCode, 200);
    const result = validateRes.json() as {
      publicationId: string;
      applied: { added: number; updated: number; archived: number };
      idempotent: boolean;
    };
    assert.equal(result.idempotent, false);
    assert.deepEqual(result.applied, { added: 3, updated: 0, archived: 0 });

    assert.deepEqual(await stagedRows(app), [], 'staging limpo na mesma transacção');

    const [catalog] = await app.db
      .select()
      .from(catalogItems)
      .where(eq(catalogItems.slug, 'pacote-novo-cctv'));
    assert.ok(catalog !== undefined, 'catálogo publicado');
    assert.equal(catalog.status, 'published');
    assert.equal(catalog.version, 1);
    assert.equal(catalog.ownerId, app.users.editor.id);
    assert.equal(catalog.priceAmount, '150000.00');
    assert.equal(catalog.lineId, await lineId(app, 'cctv'));

    const [doc] = await app.db
      .select()
      .from(knowledgeDocs)
      .where(eq(knowledgeDocs.slug, 'garantia-cctv'));
    assert.ok(doc !== undefined, 'documento publicado');
    assert.equal(doc.status, 'published');
    assert.equal(doc.version, 1);
    assert.equal(doc.type, 'policy');

    const [rule] = await app.db.select().from(rules).where(eq(rules.slug, 'desconto-cctv'));
    assert.ok(rule !== undefined, 'regra publicada');
    assert.equal(rule.status, 'published');
    assert.equal(rule.version, 1);
    assert.equal(rule.kind, 'discount_limit');

    const [publication] = await app.db
      .select()
      .from(knowledgePublications)
      .where(eq(knowledgePublications.id, result.publicationId));
    assert.ok(publication !== undefined, 'publicação criada');
    assert.equal(publication.kind, 'train');
    assert.equal(publication.idempotencyKey, diff.digest);
    assert.equal(publication.createdById, app.users.editor.id);
    assert.deepEqual(publication.applied, { added: 3, updated: 0, archived: 0 });

    const revisions = await app.db
      .select()
      .from(knowledgeRevisions)
      .where(eq(knowledgeRevisions.publicationId, result.publicationId));
    assert.equal(revisions.length, 3);
    for (const revision of revisions) assert.equal(revision.version, 1);
    const catalogRevision = revisions.find((r) => r.entityType === 'catalog_item');
    const catalogSnapshot = catalogRevision?.snapshot as Record<string, unknown> | undefined;
    assert.equal(catalogSnapshot?.name, 'Pacote CFTV 4 câmaras');
    assert.equal(catalogSnapshot?.lineSlug, 'cctv');

    const audits = await app.db
      .select({ actorId: base.auditLog.actorId, details: base.auditLog.details })
      .from(base.auditLog)
      .where(eq(base.auditLog.action, 'knowledge.validated'));
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.actorId, app.users.editor.id);
    assert.equal((audits[0]?.details as Record<string, unknown>).added, 3);
  } finally {
    await app.close();
  }
});

test('update com baseVersion actual → «novo prevalece» e revisão do estado prévio', async () => {
  const app = await buildTestApp();
  try {
    await seedLines(app);
    const s = editor(app);
    const active = await insertPublishedCatalog(app, {
      slug: 'pacote-cctv',
      version: 3,
      priceAmount: '1000.00',
      name: 'Nome antigo',
    });

    await insertStaged(app, {
      slug: 'pacote-cctv',
      entityType: 'catalog_item',
      op: 'update',
      payload: CATALOG_PAYLOAD('2000.00', 'Nome novo'),
      baseVersion: 3,
    });

    const diff = (await call(app, 'GET', '/v1/knowledge/train/diff', s)).json() as {
      entries: Array<{ classification: string; baseVersion: number; currentVersion: number }>;
    };
    assert.equal(diff.entries[0]?.classification, 'updated');
    assert.equal(diff.entries[0]?.baseVersion, 3);
    assert.equal(diff.entries[0]?.currentVersion, 3);

    const validateRes = await call(app, 'POST', '/v1/knowledge/train/validate', s, {});
    assert.equal(validateRes.statusCode, 200);
    const result = validateRes.json() as { applied: { updated: number } };
    assert.equal(result.applied.updated, 1);

    const [after] = await app.db
      .select()
      .from(catalogItems)
      .where(eq(catalogItems.id, active.id));
    assert.ok(after !== undefined);
    assert.equal(after.priceAmount, '2000.00', 'novo preço prevalece');
    assert.equal(after.name, 'Nome novo');
    assert.equal(after.version, 4);
    assert.equal(after.status, 'published');

    const [revision] = await app.db
      .select()
      .from(knowledgeRevisions)
      .where(
        and(
          eq(knowledgeRevisions.entityId, active.id),
          eq(knowledgeRevisions.entityType, 'catalog_item'),
        ),
      );
    assert.ok(revision !== undefined, 'revisão do estado prévio');
    assert.equal(revision.version, 3, 'versão ACTUAL antes do bump');
    const snapshot = revision.snapshot as Record<string, unknown>;
    assert.equal(snapshot.priceAmount, '1000.00');
    assert.equal(snapshot.name, 'Nome antigo');
    assert.ok(revision.publicationId !== null);
  } finally {
    await app.close();
  }
});

test('baseVersion desactualizado → 409 draft_conflicts; aceitar aplica a versão do rascunho', async () => {
  const app = await buildTestApp();
  try {
    await seedLines(app);
    const s = editor(app);
    const active = await insertPublishedCatalog(app, {
      slug: 'pacote-cctv',
      version: 5,
      priceAmount: '1000.00',
    });

    await insertStaged(app, {
      slug: 'pacote-cctv',
      entityType: 'catalog_item',
      op: 'update',
      payload: CATALOG_PAYLOAD('2000.00'),
      baseVersion: 4,
    });

    const diff = (await call(app, 'GET', '/v1/knowledge/train/diff', s)).json() as {
      entries: Array<{ slug: string; classification: string }>;
    };
    assert.equal(diff.entries[0]?.classification, 'conflict');

    const blocked = await call(app, 'POST', '/v1/knowledge/train/validate', s, {});
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().title, 'draft_conflicts');
    const conflictEntries = blocked.json().entries as Array<{ slug: string; classification: string }>;
    assert.deepEqual(
      conflictEntries.map((e) => `${e.slug}:${e.classification}`),
      ['pacote-cctv:conflict'],
      'o payload do 409 traz as entradas em conflito',
    );

    const [untouched] = await app.db
      .select({ priceAmount: catalogItems.priceAmount, version: catalogItems.version })
      .from(catalogItems)
      .where(eq(catalogItems.id, active.id));
    assert.deepEqual(untouched, { priceAmount: '1000.00', version: 5 }, 'activo intacto');
    assert.equal((await app.db.select().from(knowledgePublications)).length, 0);

    const accepted = await call(app, 'POST', '/v1/knowledge/train/validate', s, {
      acceptConflicts: ['pacote-cctv'],
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal((accepted.json() as { applied: { updated: number } }).applied.updated, 1);

    const [after] = await app.db
      .select({ priceAmount: catalogItems.priceAmount, version: catalogItems.version })
      .from(catalogItems)
      .where(eq(catalogItems.id, active.id));
    assert.deepEqual(after, { priceAmount: '2000.00', version: 6 }, 'rascunho prevalece após aceitar');
  } finally {
    await app.close();
  }
});

test('item sem linha confirmada → 422 lines_unconfirmed, sem efeitos', async () => {
  const app = await buildTestApp();
  try {
    await seedLines(app);
    const s = editor(app);
    await insertStaged(app, {
      slug: 'pacote-por-confirmar',
      entityType: 'catalog_item',
      op: 'create',
      payload: CATALOG_PAYLOAD(),
      lineConfirmed: false,
    });

    const diff = (await call(app, 'GET', '/v1/knowledge/train/diff', s)).json() as {
      unconfirmedSlugs: string[];
    };
    assert.deepEqual(diff.unconfirmedSlugs, ['pacote-por-confirmar']);

    const res = await call(app, 'POST', '/v1/knowledge/train/validate', s, {});
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().title, 'lines_unconfirmed');
    assert.deepEqual(res.json().unconfirmedSlugs, ['pacote-por-confirmar']);

    assert.equal((await app.db.select().from(knowledgePublications)).length, 0);
    assert.equal((await stagedRows(app)).length, 1, 'staging preservado no erro');
    assert.equal(
      (await app.db.select().from(catalogItems)).length,
      0,
      'nada publicado',
    );
  } finally {
    await app.close();
  }
});

test('idempotência: validar o mesmo conteúdo duas vezes devolve a mesma publicação', async () => {
  const app = await buildTestApp();
  try {
    await seedLines(app);
    const s = editor(app);
    const staged = {
      slug: 'pacote-idempotente',
      entityType: 'catalog_item' as const,
      op: 'create' as const,
      payload: CATALOG_PAYLOAD(),
    };
    await insertStaged(app, staged);

    const first = await call(app, 'POST', '/v1/knowledge/train/validate', s, {});
    assert.equal(first.statusCode, 200);
    const firstResult = first.json() as { publicationId: string; idempotent: boolean };
    assert.equal(firstResult.idempotent, false);

    // Re-staging igual (retry do cliente): mesmo slug + mesmo canónico.
    await insertStaged(app, staged);
    const second = await call(app, 'POST', '/v1/knowledge/train/validate', s, {});
    assert.equal(second.statusCode, 200);
    const secondResult = second.json() as {
      publicationId: string;
      idempotent: boolean;
      applied: { added: number };
    };
    assert.equal(secondResult.idempotent, true);
    assert.equal(secondResult.publicationId, firstResult.publicationId);
    assert.equal(secondResult.applied.added, 1);

    assert.equal((await app.db.select().from(knowledgePublications)).length, 1);
    assert.equal((await app.db.select().from(catalogItems)).length, 1, 'sem duplicados');
    assert.equal((await app.db.select().from(knowledgeRevisions)).length, 1);
  } finally {
    await app.close();
  }
});

test('concorrência: duas validações em paralelo → exactamente uma publicação nova', async () => {
  const app = await buildTestApp();
  try {
    await seedLines(app);
    await insertStaged(app, {
      slug: 'doc-concorrente',
      entityType: 'knowledge_doc',
      op: 'create',
      payload: DOC_PAYLOAD,
    });

    const deps = trainDeps(app);
    const [a, b] = await Promise.all([
      validateDraft(deps, { changedById: app.users.editor.id }),
      validateDraft(deps, { changedById: app.users.editor.id }),
    ]);

    assert.equal(a.publicationId, b.publicationId, 'ambas apontam para a publicação vencedora');
    assert.deepEqual(
      [a.idempotent, b.idempotent].sort(),
      [false, true],
      'a segunda cai na rede do unique (23505) e relê a publicação',
    );
    assert.equal((await app.db.select().from(knowledgePublications)).length, 1);
    assert.equal((await app.db.select().from(knowledgeDocs)).length, 1);
    assert.equal((await app.db.select().from(knowledgeRevisions)).length, 1);
    assert.deepEqual(await stagedRows(app), []);
  } finally {
    await app.close();
  }
});

test('isolamento: o tenant B não vê o staging do tenant A', async () => {
  const app = await buildTestApp();
  try {
    await seedLines(app);
    const b = await tenantBSession(app);
    await insertStaged(app, {
      slug: 'pacote-do-tenant-a',
      entityType: 'catalog_item',
      op: 'create',
      payload: CATALOG_PAYLOAD(),
    });

    const diffA = (await call(app, 'GET', '/v1/knowledge/train/diff', editor(app))).json() as {
      entries: unknown[];
    };
    assert.equal(diffA.entries.length, 1);

    const diffB = await call(app, 'GET', '/v1/knowledge/train/diff', b);
    assert.equal(diffB.statusCode, 200);
    const bodyB = diffB.json() as { entries: unknown[]; unconfirmedSlugs: unknown[]; digest: string };
    assert.deepEqual(bodyB.entries, [], 'B não enxerga o staging de A');
    assert.deepEqual(bodyB.unconfirmedSlugs, []);
    assert.match(bodyB.digest, /^[0-9a-f]{64}$/);

    assert.equal((await stagedRows(app)).length, 1, 'staging de A intacto');
  } finally {
    await app.close();
  }
});

test('delete explícito → archived; ausência no rascunho não remove o activo', async () => {
  const app = await buildTestApp();
  try {
    await seedLines(app);
    const s = editor(app);
    const toArchive = await insertPublishedCatalog(app, {
      slug: 'pacote-a-arquivar',
      version: 2,
      priceAmount: '1000.00',
    });
    const stays = await insertPublishedCatalog(app, {
      slug: 'pacote-permanece',
      version: 1,
      priceAmount: '3000.00',
    });

    await insertStaged(app, {
      slug: 'pacote-a-arquivar',
      entityType: 'catalog_item',
      op: 'delete',
      payload: { kind: 'catalog_item' },
      baseVersion: 2,
    });

    const diff = (await call(app, 'GET', '/v1/knowledge/train/diff', s)).json() as {
      entries: Array<{ classification: string }>;
    };
    assert.deepEqual(
      diff.entries.map((e) => e.classification),
      ['archived'],
    );

    const res = await call(app, 'POST', '/v1/knowledge/train/validate', s, {});
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as { applied: { archived: number } }).applied.archived, 1);

    const [archived] = await app.db
      .select({ status: catalogItems.status, version: catalogItems.version })
      .from(catalogItems)
      .where(eq(catalogItems.id, toArchive.id));
    assert.deepEqual(archived, { status: 'archived', version: 3 });

    const [untouched] = await app.db
      .select({ status: catalogItems.status, version: catalogItems.version })
      .from(catalogItems)
      .where(eq(catalogItems.id, stays.id));
    assert.deepEqual(untouched, { status: 'published', version: 1 }, 'não tocado permanece');

    const [revision] = await app.db
      .select()
      .from(knowledgeRevisions)
      .where(eq(knowledgeRevisions.entityId, toArchive.id));
    assert.ok(revision !== undefined);
    assert.equal(revision.version, 2);
    assert.equal((revision.snapshot as Record<string, unknown>).priceAmount, '1000.00');
  } finally {
    await app.close();
  }
});

test('papéis: agent recusado (403); sem sessão 401; admin lê o diff', async () => {
  const app = await buildTestApp();
  try {
    const agentSess: Sess = { session: app.sessions.agent, csrf: app.csrf.agent };

    const diffAgent = await call(app, 'GET', '/v1/knowledge/train/diff', agentSess);
    assert.equal(diffAgent.statusCode, 403);

    const validateAgent = await call(app, 'POST', '/v1/knowledge/train/validate', agentSess, {});
    assert.equal(validateAgent.statusCode, 403);

    const noSession = await app.inject({ method: 'GET', url: '/v1/knowledge/train/diff' });
    assert.equal(noSession.statusCode, 401);

    const diffAdmin = await call(app, 'GET', '/v1/knowledge/train/diff', admin(app));
    assert.equal(diffAdmin.statusCode, 200);
    assert.deepEqual(diffAdmin.json().entries, []);
  } finally {
    await app.close();
  }
});
