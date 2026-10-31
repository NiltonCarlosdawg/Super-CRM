// Fase 2, Task 2: retrieve publicado (§7.4) contra Postgres real — caminho
// semântico pgvector com filtros de tenant/publicação/validade/linha e fallback
// FTS em português (plano B de docs/06) quando não há embedder nem vector.
// Fixtures 100% sintéticas (AGENTS.md §13).

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';

import { createAuditAdapter } from '../../src/adapters/db/audit-adapter.js';
import * as base from '../../src/adapters/db/schema/index.js';
import {
  businessLines,
  catalogItems,
  knowledgeChunks,
  knowledgeDocs,
} from '../../src/modules/knowledge/knowledge.schema.js';
import { retrievePublished } from '../../src/modules/knowledge/published-retrieval.js';
import type { TrainDeps } from '../../src/modules/knowledge/train-service.js';
import { TrainServiceError } from '../../src/modules/knowledge/train-service.js';
import type { EmbeddingsProvider } from '../../src/ports/embeddings.js';
import { fakeEmbeddings } from '../helpers/fake-embeddings.js';
import { migratedDb, resetDb } from '../helpers/db.js';

const NOW = new Date('2026-10-29T12:00:00Z');
const CONTENT = 'Quanto custa a instalação de câmaras de segurança?';

function mkDeps(db: Awaited<ReturnType<typeof migratedDb>>, tenantId: string, embedder?: EmbeddingsProvider): TrainDeps {
  return {
    db,
    scope: { tenantId },
    audit: createAuditAdapter({ db }),
    now: () => NOW,
    ...(embedder === undefined ? {} : { embedder }),
  };
}

async function seedLines(db: Awaited<ReturnType<typeof migratedDb>>): Promise<{ software: string; cctv: string }> {
  await db
    .insert(businessLines)
    .values([
      { slug: 'software', name: 'Software', conversionGoal: 'demo_request' },
      { slug: 'cctv', name: 'CCTV', conversionGoal: 'installation_booking' },
    ])
    .onConflictDoNothing();
  const software = await lineId(db, 'software');
  const cctv = await lineId(db, 'cctv');
  return { software, cctv };
}

async function lineId(db: Awaited<ReturnType<typeof migratedDb>>, slug: string): Promise<string> {
  const [row] = await db.select({ id: businessLines.id }).from(businessLines).where(eq(businessLines.slug, slug));
  assert.ok(row !== undefined, `fixture: linha ${slug}`);
  return row.id;
}

async function tenantBId(db: Awaited<ReturnType<typeof migratedDb>>): Promise<string> {
  const [tenant] = await db
    .insert(base.tenants)
    .values({ id: randomUUID(), name: 'Empresa B (retrieve sintético)' })
    .returning({ id: base.tenants.id });
  assert.ok(tenant !== undefined, 'fixture tenant B');
  return tenant.id;
}

interface DocInput {
  tenantId?: string;
  lineId?: string | null;
  status?: 'draft' | 'published' | 'archived';
  validFrom?: Date | null;
  validUntil?: Date | null;
  version?: number;
}

async function insertDoc(
  db: Awaited<ReturnType<typeof migratedDb>>,
  input: DocInput,
): Promise<{ id: string; version: number }> {
  const [row] = await db
    .insert(knowledgeDocs)
    .values({
      tenantId: input.tenantId ?? base.MILVENDAS_TENANT_ID,
      lineId: input.lineId ?? null,
      type: 'faq',
      title: 'Documento sintético de retrieve',
      slug: `doc-${randomUUID().slice(0, 8)}`,
      body: CONTENT,
      status: input.status ?? 'published',
      validFrom: input.validFrom ?? null,
      validUntil: input.validUntil ?? null,
      ownerId: randomUUID(),
      version: input.version ?? 1,
    })
    .returning({ id: knowledgeDocs.id, version: knowledgeDocs.version });
  assert.ok(row !== undefined, 'fixture: doc');
  return row;
}

async function insertDocChunk(
  db: Awaited<ReturnType<typeof migratedDb>>,
  input: {
    tenantId?: string;
    docId: string;
    content?: string;
    embedding?: number[] | null;
    model?: string | null;
    active?: boolean;
  },
): Promise<string> {
  const [row] = await db
    .insert(knowledgeChunks)
    .values({
      tenantId: input.tenantId ?? base.MILVENDAS_TENANT_ID,
      source: 'doc',
      docId: input.docId,
      catalogItemId: null,
      position: 0,
      content: input.content ?? CONTENT,
      embedding: input.embedding ?? undefined,
      embeddingModel: input.model ?? null,
      active: input.active ?? true,
    })
    .returning({ id: knowledgeChunks.id });
  assert.ok(row !== undefined, 'fixture: chunk');
  return row.id;
}

async function insertCatalogChunk(
  db: Awaited<ReturnType<typeof migratedDb>>,
  input: { lineId: string; content?: string; embedding?: number[] | null; model?: string | null },
): Promise<string> {
  const [item] = await db
    .insert(catalogItems)
    .values({
      tenantId: base.MILVENDAS_TENANT_ID,
      lineId: input.lineId,
      kind: 'service',
      name: 'Instalação de câmaras',
      slug: `cat-${randomUUID().slice(0, 8)}`,
      summary: 'Serviço de instalação de câmaras de segurança.',
      pricingMode: 'quote_only',
      status: 'published',
      ownerId: randomUUID(),
      version: 1,
    })
    .returning({ id: catalogItems.id });
  assert.ok(item !== undefined, 'fixture: catálogo');
  const [chunk] = await db
    .insert(knowledgeChunks)
    .values({
      tenantId: base.MILVENDAS_TENANT_ID,
      source: 'catalog',
      docId: null,
      catalogItemId: item.id,
      position: 0,
      content: input.content ?? CONTENT,
      embedding: input.embedding ?? undefined,
      embeddingModel: input.model ?? null,
      active: true,
    })
    .returning({ id: knowledgeChunks.id });
  assert.ok(chunk !== undefined, 'fixture: chunk de catálogo');
  return chunk.id;
}

test('retrievePublished semântico: devolve só do tenant, publicado, válido e da linha pedida', async () => {
  await resetDb();
  const db = await migratedDb();
  const embedder = fakeEmbeddings();
  const [vector] = await embedder.embedTexts([CONTENT]);
  assert.ok(vector !== undefined);
  const lines = await seedLines(db);
  const otherTenant = await tenantBId(db);

  const okDoc = await insertDoc(db, { lineId: null, version: 3 });
  const cctvDoc = await insertDoc(db, { lineId: lines.cctv });
  const softwareDoc = await insertDoc(db, { lineId: lines.software });
  const draftDoc = await insertDoc(db, { lineId: null, status: 'draft' });
  const archivedDoc = await insertDoc(db, { lineId: null, status: 'archived' });
  const expiredDoc = await insertDoc(db, { lineId: null, validUntil: new Date(NOW.getTime() - 1000) });
  const futureDoc = await insertDoc(db, { lineId: null, validFrom: new Date(NOW.getTime() + 10_000) });
  const otherTenantDoc = await insertDoc(db, { tenantId: otherTenant, lineId: null });

  const okChunkId = await insertDocChunk(db, { docId: okDoc.id });
  const cctvChunkId = await insertDocChunk(db, { docId: cctvDoc.id });
  await insertDocChunk(db, { docId: okDoc.id, active: false });
  await insertDocChunk(db, { docId: softwareDoc.id });
  await insertDocChunk(db, { docId: draftDoc.id });
  await insertDocChunk(db, { docId: archivedDoc.id });
  await insertDocChunk(db, { docId: expiredDoc.id });
  await insertDocChunk(db, { docId: futureDoc.id });
  await insertDocChunk(db, { docId: otherTenantDoc.id, tenantId: otherTenant });

  // Mesmo vector em todos: os filtros é que decidem o que entra.
  await db.update(knowledgeChunks).set({ embedding: vector, embeddingModel: embedder.model });

  const deps = mkDeps(db, base.MILVENDAS_TENANT_ID, embedder);
  const hits = await retrievePublished(deps, CONTENT, 'cctv');

  const expected = [okChunkId, cctvChunkId];
  assert.deepEqual(hits.map((hit) => hit.id).sort(), expected.sort(), 'só docs publicados+válidos do tenant, global ou da linha cctv');
  for (const hit of hits) {
    assert.ok(hit.similarity >= 0.75, `similaridade ≥ limiar: ${hit.similarity}`);
    assert.equal(hit.source, 'doc');
  }
  assert.equal(hits.find((hit) => hit.id === okChunkId)?.version, okDoc.version);

  // linha null: catálogo excluído (line_id NOT NULL), docs só os globais
  const globalHits = await retrievePublished(deps, CONTENT, null);
  assert.deepEqual(globalHits.map((hit) => hit.id), [okChunkId]);

  // linha não existente no dicionário → 404 line_not_found (nunca se adivinha)
  await assert.rejects(
    () => retrievePublished(deps, CONTENT, 'telecom'),
    (error: unknown) => error instanceof TrainServiceError && error.code === 'line_not_found',
  );
});

test('retrievePublished semântico: catálogo só entra com linha correspondente', async () => {
  await resetDb();
  const db = await migratedDb();
  const lines = await seedLines(db);
  const embedder = fakeEmbeddings();
  const [vector] = await embedder.embedTexts([CONTENT]);
  assert.ok(vector !== undefined);
  const catalogChunkId = await insertCatalogChunk(db, {
    lineId: lines.cctv,
    embedding: vector,
    model: embedder.model,
  });

  const deps = mkDeps(db, base.MILVENDAS_TENANT_ID, embedder);
  const withLine = await retrievePublished(deps, CONTENT, 'cctv');
  assert.deepEqual(withLine.map((hit) => hit.id), [catalogChunkId]);
  assert.equal(withLine[0]?.source, 'catalog');

  const withoutLine = await retrievePublished(deps, CONTENT, null);
  assert.deepEqual(withoutLine, [], 'catálogo exige linha: sem linha não entra');
});

test('retrievePublished: sem embedder usa FTS português com os mesmos filtros', async () => {
  await resetDb();
  const db = await migratedDb();
  const lines = await seedLines(db);
  const otherTenant = await tenantBId(db);

  const okDoc = await insertDoc(db, { lineId: lines.cctv });
  const expiredDoc = await insertDoc(db, { lineId: lines.cctv, validUntil: new Date(NOW.getTime() - 1000) });
  const otherTenantDoc = await insertDoc(db, { tenantId: otherTenant, lineId: null });
  const okChunkId = await insertDocChunk(db, { docId: okDoc.id, embedding: null });
  await insertDocChunk(db, { docId: expiredDoc.id, embedding: null });
  await insertDocChunk(db, { docId: otherTenantDoc.id, tenantId: otherTenant, embedding: null });

  const deps = mkDeps(db, base.MILVENDAS_TENANT_ID);
  const hits = await retrievePublished(deps, 'câmaras de segurança', 'cctv');

  assert.deepEqual(hits.map((hit) => hit.id), [okChunkId], 'FTS devolve só o chunk publicado+válido do tenant');
  assert.ok((hits[0]?.similarity ?? 0) > 0, 'ts_rank > 0');

  const noOverlap = await retrievePublished(deps, 'xyzzy plugh', 'cctv');
  assert.deepEqual(noOverlap, [], 'sem correspondência léxica o retrieve nunca inventa fontes');
});

test('retrievePublished: com embedder, chunks sem vector servem por FTS; query vazia devolve []', async () => {
  await resetDb();
  const db = await migratedDb();
  const embedder = fakeEmbeddings();
  const lines = await seedLines(db);
  const doc = await insertDoc(db, { lineId: lines.cctv });
  const chunkId = await insertDocChunk(db, { docId: doc.id, embedding: null, model: null });

  const deps = mkDeps(db, base.MILVENDAS_TENANT_ID, embedder);
  const hits = await retrievePublished(deps, 'câmaras de segurança', 'cctv');
  assert.deepEqual(hits.map((hit) => hit.id), [chunkId], 'chunks sem vector são servidos via FTS até reembed');

  assert.deepEqual(await retrievePublished(deps, '   ', 'cctv'), [], 'query vazia não consulta');
});

test('retrievePublished semântico: modelo de embedding diferente fica fora do ranking (conta para backfill)', async () => {
  await resetDb();
  const db = await migratedDb();
  const embedder = fakeEmbeddings();
  const [vector] = await embedder.embedTexts([CONTENT]);
  assert.ok(vector !== undefined);
  await seedLines(db);

  const currentDoc = await insertDoc(db, { lineId: null });
  const staleDoc = await insertDoc(db, { lineId: null });
  const currentId = await insertDocChunk(db, { docId: currentDoc.id, embedding: vector, model: embedder.model });
  await insertDocChunk(db, { docId: staleDoc.id, embedding: vector, model: 'modelo-anterior' });

  const deps = mkDeps(db, base.MILVENDAS_TENANT_ID, embedder);
  const hits = await retrievePublished(deps, CONTENT, null);

  assert.deepEqual(hits.map((hit) => hit.id), [currentId], 'chunks de modelo antigo são incomparáveis no cosseno');
});
