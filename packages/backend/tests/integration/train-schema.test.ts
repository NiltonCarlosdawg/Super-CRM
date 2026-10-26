// Plano "Treinar agente", Task 1: schema da área de rascunho, das publicações e
// do slug de catálogo por tenant. Prova as constraints na BD real (Postgres),
// não no ORM: o teste insere linhas e espera as violações 23505/23503.
// Fixtures 100% sintéticas (AGENTS.md §13).

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { eq, sql } from 'drizzle-orm';
import type { DbClient } from '../../src/adapters/db/index.js';
import * as base from '../../src/adapters/db/schema/index.js';
import {
  businessLines,
  catalogItems,
  knowledgeDraftItems,
  knowledgePublications,
  knowledgeRevisions,
  knowledgeTrainUploads,
  type DraftEntityType,
  type DraftOp,
  type PublicationRow,
  type StagedItemRow,
  type UploadRow,
} from '../../src/modules/knowledge/knowledge.schema.js';
import { migratedDb } from '../helpers/db.js';

/** UUID sintético de autor (sem FK, como `knowledge_revisions.changed_by_id`). */
const ACTOR_ID = '00000000-0000-4000-8000-000000000001';

/** Código SQLSTATE de um erro (o Drizzle embrulha o erro do `pg` em `cause`). */
function sqlState(err: unknown): unknown {
  const code = (e: unknown): unknown => (e as { code?: unknown } | null)?.code;
  return code(err) ?? code((err as { cause?: unknown } | null)?.cause);
}

/** Violação de UNIQUE (23505). */
const isUniqueViolation = (err: unknown): boolean => sqlState(err) === '23505';

/** Violação de FOREIGN KEY (23503). */
const isForeignKeyViolation = (err: unknown): boolean => sqlState(err) === '23503';

/** Segundo tenant sintético (o "MilVendas" já existe após o reset). */
async function createTenant(db: DbClient, name: string): Promise<string> {
  const [row] = await db
    .insert(base.tenants)
    .values({ id: randomUUID(), name })
    .returning({ id: base.tenants.id });
  assert.ok(row !== undefined, 'fixture: tenant sintético');
  return row.id;
}

/** Uma linha de negócio para as FKs de `catalog_items.line_id`. */
async function createLine(db: DbClient): Promise<string> {
  const [row] = await db
    .insert(businessLines)
    .values({ slug: 'software', name: 'Software', conversionGoal: 'demo_request' })
    .returning({ id: businessLines.id });
  assert.ok(row !== undefined, 'fixture: linha de negócio');
  return row.id;
}

/** Insert de um item de catálogo mínimo (campos obrigatórios apenas). */
function insertCatalogItem(db: DbClient, tenantId: string, lineId: string, slug: string) {
  return db
    .insert(catalogItems)
    .values({
      tenantId,
      lineId,
      kind: 'service',
      name: `CRM ${slug}`,
      slug,
      summary: 'Serviço sintético de teste',
      pricingMode: 'quote_only',
      status: 'draft',
      ownerId: ACTOR_ID,
    })
    .returning({ id: catalogItems.id });
}

/** Insert de uma staged row mínima do rascunho. */
function insertDraftItem(
  db: DbClient,
  input: {
    tenantId: string;
    slug: string;
    entityType?: DraftEntityType;
    op?: DraftOp;
    payload?: Record<string, unknown>;
    chunks?: string[];
    baseVersion?: number | null;
    lineConfirmed?: boolean;
  },
) {
  return db
    .insert(knowledgeDraftItems)
    .values({
      tenantId: input.tenantId,
      slug: input.slug,
      entityType: input.entityType ?? 'catalog_item',
      op: input.op ?? 'create',
      lineSlug: 'software',
      lineConfirmed: input.lineConfirmed ?? true,
      payload: input.payload ?? { name: 'CRM sintético', pricingMode: 'quote_only' },
      chunks: input.chunks ?? null,
      baseVersion: input.baseVersion ?? null,
      changedById: ACTOR_ID,
    })
    .returning({ id: knowledgeDraftItems.id });
}

/** Insert de uma publicação mínima. */
function insertPublication(db: DbClient, tenantId: string, idempotencyKey: string) {
  return db
    .insert(knowledgePublications)
    .values({
      tenantId,
      kind: 'train',
      idempotencyKey,
      createdById: ACTOR_ID,
      applied: { added: 1, updated: 0, archived: 0 },
    })
    .returning({ id: knowledgePublications.id });
}

test('catalog_items: mesmo slug em tenants distintos coexiste; duplicado no mesmo tenant é rejeitado', async () => {
  const db = await migratedDb();
  const tenantB = await createTenant(db, 'Empresa B (train-schema sintética)');
  const lineId = await createLine(db);

  // Mesmo slug nos dois tenants → OK (a identidade do catálogo é por tenant).
  await insertCatalogItem(db, base.MILVENDAS_TENANT_ID, lineId, 'crm-sintetico');
  await insertCatalogItem(db, tenantB, lineId, 'crm-sintetico');

  // Mesmo slug repetido dentro do mesmo tenant → unique violation.
  await assert.rejects(
    () => insertCatalogItem(db, base.MILVENDAS_TENANT_ID, lineId, 'crm-sintetico'),
    isUniqueViolation,
    'slug repetido no mesmo tenant tem de violar o unique composto',
  );

  const rows = await db
    .select({ tenantId: catalogItems.tenantId, slug: catalogItems.slug })
    .from(catalogItems)
    .where(eq(catalogItems.slug, 'crm-sintetico'));
  assert.equal(rows.length, 2, 'exactamente uma linha por tenant');
  assert.deepEqual(
    rows.map((r) => r.tenantId).sort(),
    [base.MILVENDAS_TENANT_ID, tenantB].sort(),
    'as duas linhas pertencem a tenants distintos',
  );
});

test('knowledge_draft_items: unique (tenant_id, slug) e roundtrip do payload jsonb', async () => {
  const db = await migratedDb();
  const tenantB = await createTenant(db, 'Empresa B (train-schema sintética)');
  const payload = {
    kind: 'service',
    name: 'CRM sintético',
    pricingMode: 'quote_only',
    priceNote: 'Preço sob orçamento',
  };
  const chunks = ['CRM sintético — gestão de leads', 'Preço sob orçamento'];
  const op: DraftOp = 'update';

  const [inserted] = await insertDraftItem(db, {
    tenantId: base.MILVENDAS_TENANT_ID,
    slug: 'crm-sintetico',
    entityType: 'catalog_item',
    op,
    payload,
    chunks,
    baseVersion: 3,
    lineConfirmed: true,
  });
  assert.ok(inserted !== undefined, 'staged row criada');

  const [stored] = await db
    .select()
    .from(knowledgeDraftItems)
    .where(eq(knowledgeDraftItems.id, inserted.id));
  assert.ok(stored !== undefined, 'staged row relida');
  assert.equal(stored.entityType, 'catalog_item');
  assert.equal(stored.op, op);
  assert.equal(stored.baseVersion, 3);
  assert.equal(stored.lineConfirmed, true);
  assert.equal(stored.lineSlug, 'software');
  assert.deepEqual(stored.payload, payload, 'payload jsonb faz roundtrip intacto');
  assert.deepEqual(stored.chunks, chunks, 'chunks jsonb faz roundtrip intacto');

  // O mesmo slug noutro tenant coexiste; repetido no mesmo tenant falha.
  await insertDraftItem(db, { tenantId: tenantB, slug: 'crm-sintetico' });
  await assert.rejects(
    () => insertDraftItem(db, { tenantId: base.MILVENDAS_TENANT_ID, slug: 'crm-sintetico' }),
    isUniqueViolation,
    'duas staged rows com o mesmo (tenant_id, slug) têm de falhar',
  );
});

test('knowledge_publications: unique (tenant_id, idempotency_key)', async () => {
  const db = await migratedDb();
  const tenantB = await createTenant(db, 'Empresa B (train-schema sintética)');

  await insertPublication(db, base.MILVENDAS_TENANT_ID, 'validacao-sintetica-1');
  // A mesma chave noutro tenant é uma publicação diferente → OK.
  await insertPublication(db, tenantB, 'validacao-sintetica-1');

  await assert.rejects(
    () => insertPublication(db, base.MILVENDAS_TENANT_ID, 'validacao-sintetica-1'),
    isUniqueViolation,
    'a mesma idempotency_key repetida no tenant tem de falhar',
  );

  const rows = await db
    .select({ id: knowledgePublications.id })
    .from(knowledgePublications)
    .where(eq(knowledgePublications.idempotencyKey, 'validacao-sintetica-1'));
  assert.equal(rows.length, 2, 'uma publicação por tenant');
});

test('knowledge_revisions: publication_id aceita nulo e FK para publicação existente', async () => {
  const db = await migratedDb();
  const [publication] = await insertPublication(db, base.MILVENDAS_TENANT_ID, 'validacao-sintetica-2');
  assert.ok(publication !== undefined, 'fixture: publicação');

  // Revisão antiga (antes desta entrega): publication_id nulo.
  const [legacy] = await db
    .insert(knowledgeRevisions)
    .values({
      tenantId: base.MILVENDAS_TENANT_ID,
      entityType: 'catalog_item',
      entityId: randomUUID(),
      version: 1,
      snapshot: { name: 'CRM sintético' },
      changedById: ACTOR_ID,
    })
    .returning({ id: knowledgeRevisions.id, publicationId: knowledgeRevisions.publicationId });
  assert.ok(legacy !== undefined, 'revisão antiga criada');
  assert.equal(legacy.publicationId, null, 'revisões antigas ficam sem publicação');

  // Revisão nova: FK para a publicação que a aplicou.
  const [current] = await db
    .insert(knowledgeRevisions)
    .values({
      tenantId: base.MILVENDAS_TENANT_ID,
      entityType: 'catalog_item',
      entityId: randomUUID(),
      version: 1,
      snapshot: { name: 'CRM sintético v2' },
      changedById: ACTOR_ID,
      publicationId: publication.id,
    })
    .returning({ id: knowledgeRevisions.id, publicationId: knowledgeRevisions.publicationId });
  assert.ok(current !== undefined, 'revisão nova criada');
  assert.equal(current.publicationId, publication.id);

  // A FK é real: uma publicação inexistente é rejeitada (23503).
  await assert.rejects(
    () =>
      db.insert(knowledgeRevisions).values({
        tenantId: base.MILVENDAS_TENANT_ID,
        entityType: 'catalog_item',
        entityId: randomUUID(),
        version: 1,
        snapshot: {},
        changedById: ACTOR_ID,
        publicationId: randomUUID(),
      }),
    isForeignKeyViolation,
    'publication_id inexistente tem de violar a FK',
  );
});

test('conversations.is_test existe, é NOT NULL e default false (information_schema)', async () => {
  const db = await migratedDb();
  const res = await db.execute(sql`
    SELECT is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'conversations' AND column_name = 'is_test'
  `);
  const row = (res.rows as Array<{ is_nullable: string; column_default: string | null }>)[0];
  assert.ok(row !== undefined, 'coluna conversations.is_test existe');
  assert.equal(row.is_nullable, 'NO', 'is_test é NOT NULL');
  assert.match(row.column_default ?? '', /false/i, 'is_test arranca a false');
});

// As tabelas/tipos novos ficam usados no ficheiro mesmo que o teste falhe cedo:
// garante que os exports prometidos às T4–T8 (StagedItemRow/UploadRow/PublicationRow)
// continuam a compilar contra o schema.
test('tipos exportados do schema mapeiam as linhas novas', async () => {
  const db = await migratedDb();
  await db.insert(knowledgeTrainUploads).values({
    tenantId: base.MILVENDAS_TENANT_ID,
    filename: 'folheto-sintetico.txt',
    mediaType: 'text/plain',
    text: 'Conteúdo sintético de teste.',
    changedById: ACTOR_ID,
  });
  const uploads: UploadRow[] = await db.select().from(knowledgeTrainUploads);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0]?.status, 'pending', 'upload arranca em pending');

  await insertDraftItem(db, { tenantId: base.MILVENDAS_TENANT_ID, slug: 'tipo-sintetico' });
  const staged: StagedItemRow[] = await db.select().from(knowledgeDraftItems);
  assert.equal(staged.length, 1);
  assert.equal(staged[0]?.slug, 'tipo-sintetico');

  await insertPublication(db, base.MILVENDAS_TENANT_ID, 'validacao-tipos');
  const publications: PublicationRow[] = await db.select().from(knowledgePublications);
  assert.equal(publications.length, 1);
  assert.equal(publications[0]?.kind, 'train');
});
