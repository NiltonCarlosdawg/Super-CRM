// Fase 2, Task 2: job `knowledge.reembed` (§7.3) e rota
// `POST /v1/knowledge/reembed`. Prova: 202 enfileira com chave por pedido; 503
// `embeddings_unavailable` sem embedder; lotes com teto (continuam naexecução
// seguinte); idempotência por efeito (2.ª execução = no-op); audit
// `knowledge.reembedded` com contagem; payload inválido falha visível.
// Fixtures 100% sintéticas (AGENTS.md §13).

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';

import { createAuditAdapter } from '../../src/adapters/db/audit-adapter.js';
import { auditLog } from '../../src/adapters/db/schema/audit.schema.js';
import { MILVENDAS_TENANT_ID } from '../../src/adapters/db/schema/tenants.schema.js';
import { knowledgeChunks, knowledgeDocs } from '../../src/modules/knowledge/knowledge.schema.js';
import { createReembedHandler } from '../../src/modules/knowledge/reembed-job.js';
import type { EmbeddingsProvider } from '../../src/ports/embeddings.js';
import { fakeEmbeddings } from '../helpers/fake-embeddings.js';
import { migratedDb, resetDb } from '../helpers/db.js';
import { buildTestApp, type TestApp } from '../helpers/http.js';

interface Sess {
  session: string;
  csrf: string;
}

const editor = (app: TestApp): Sess => ({ session: app.sessions.editor, csrf: app.csrf.editor });
const agent = (app: TestApp): Sess => ({ session: app.sessions.agent, csrf: app.csrf.agent });

const call = (app: TestApp, s: Sess, payload?: unknown) =>
  app.inject({
    method: 'POST',
    url: '/v1/knowledge/reembed',
    cookies: { session: s.session, csrf: s.csrf },
    headers: { 'x-csrf-token': s.csrf },
    ...(payload !== undefined ? { payload: payload as InjectOptions['payload'] } : {}),
  });

/** Chunk sintético do tenant MilVendas (doc qualquer — o job não valida o pai). */
async function insertChunk(
  db: Awaited<ReturnType<typeof migratedDb>>,
  input: { content: string; embedding?: number[] | null; model?: string | null },
): Promise<string> {
  const [doc] = await db
    .insert(knowledgeDocs)
    .values({
      tenantId: MILVENDAS_TENANT_ID,
      lineId: null,
      type: 'faq',
      title: 'Doc sintético de reembed',
      slug: `doc-${randomUUID().slice(0, 8)}`,
      body: 'corpo sintético',
      status: 'published',
      ownerId: randomUUID(),
      version: 1,
    })
    .returning({ id: knowledgeDocs.id });
  assert.ok(doc !== undefined, 'fixture: doc');
  const [chunk] = await db
    .insert(knowledgeChunks)
    .values({
      tenantId: MILVENDAS_TENANT_ID,
      source: 'doc',
      docId: doc.id,
      catalogItemId: null,
      position: 0,
      content: input.content,
      ...(input.embedding === null || input.embedding === undefined
        ? {}
        : { embedding: [...input.embedding] }),
      embeddingModel: input.model ?? null,
      active: true,
    })
    .returning({ id: knowledgeChunks.id });
  assert.ok(chunk !== undefined, 'fixture: chunk');
  return chunk.id;
}

const chunksByIds = async (
  db: Awaited<ReturnType<typeof migratedDb>>,
  ids: string[],
): Promise<Array<{ id: string; embedding: unknown; model: string | null }>> =>
  db
    .select({
      id: knowledgeChunks.id,
      embedding: knowledgeChunks.embedding,
      model: knowledgeChunks.embeddingModel,
    })
    .from(knowledgeChunks)
    .where(inArray(knowledgeChunks.id, ids));

/** pgvector guarda float4: a ida-e-volta perde precisão de float64. */
const approxEqual = (actual: unknown, expected: number[]): boolean =>
  Array.isArray(actual) &&
  actual.length === expected.length &&
  actual.every((value, index) => Math.abs(value - (expected[index] ?? 0)) < 1e-6);

test('rota: editor enfileira 202 com chave por pedido e o job preenche os vetores', async () => {
  await resetDb();
  const app = await buildTestApp();
  try {
    const embedder = app.knowledge.embedder;
    assert.ok(embedder !== undefined, 'fixture: app com embedder');
    const [currentVector] = await embedder.embedTexts(['já com vector correcto']);
    assert.ok(currentVector !== undefined);
    const nullId = await insertChunk(app.db, { content: 'câmaras de segurança sem vector' });
    const staleId = await insertChunk(app.db, {
      content: 'câmaras com vector de modelo antigo',
      embedding: currentVector,
      model: 'modelo-anterior',
    });
    const currentId = await insertChunk(app.db, {
      content: 'já com vector correcto',
      embedding: currentVector,
      model: embedder.model,
    });

    const res = await call(app, editor(app));
    assert.equal(res.statusCode, 202);
    assert.deepEqual(res.json(), { queued: true });

    const [job] = app.enqueuedJobs.filter((entry) => entry.name === 'knowledge.reembed');
    assert.ok(job !== undefined, 'knowledge.reembed enfileirado');
    assert.deepEqual(job.payload, { tenantId: MILVENDAS_TENANT_ID });
    assert.ok(
      job.opts.idempotencyKey.startsWith(`knowledge.reembed:${MILVENDAS_TENANT_ID}:`),
      'chave por pedido (chave fixa ficaria deduped para sempre no BullMQ)',
    );

    // agent não gere conhecimento (spec §9) → 403
    assert.equal((await call(app, agent(app))).statusCode, 403);

    await app.runPendingJobs();

    const rows = await chunksByIds(app.db, [nullId, staleId, currentId]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    assert.ok(byId.get(nullId)?.embedding, 'chunk sem vector preenchido');
    assert.equal(byId.get(nullId)?.model, embedder.model);
    assert.ok(byId.get(staleId)?.embedding, 'chunk de modelo antigo re-embeddado');
    assert.equal(byId.get(staleId)?.model, embedder.model, 'modelo carimbado no actual');
    assert.ok(
      approxEqual(byId.get(currentId)?.embedding, currentVector),
      'vector correcto intocado',
    );

    const audits = await app.db
      .select({ action: auditLog.action, details: auditLog.details })
      .from(auditLog)
      .where(eq(auditLog.action, 'knowledge.reembedded'));
    assert.equal(audits.length, 1, 'um audit por execução');
    assert.deepEqual(
      audits[0]?.details,
      { count: 2, model: embedder.model, entity: 'knowledge_chunk' },
      'só os 2 que faltavam (o adaptador junta `entity` aos details)',
    );
  } finally {
    await app.close();
  }
});

test('rota: sem embedder → 503 embeddings_unavailable e nada enfileirado', async () => {
  await resetDb();
  const app = await buildTestApp({ omitEmbedder: true });
  try {
    const res = await call(app, editor(app));
    assert.equal(res.statusCode, 503);
    assert.equal((res.json() as { title: string }).title, 'embeddings_unavailable');
    assert.deepEqual(
      app.enqueuedJobs.filter((entry) => entry.name === 'knowledge.reembed'),
      [],
    );
  } finally {
    await app.close();
  }
});

test('job: lotes com teto por execução e idempotência por efeito (2.ª execução no-op)', async () => {
  await resetDb();
  const db = await migratedDb();
  const embedder: EmbeddingsProvider = fakeEmbeddings();
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    ids.push(await insertChunk(db, { content: `conteúdo sintético ${i}` }));
  }

  const audit = createAuditAdapter({ db });
  const run = createReembedHandler({
    db,
    embedder,
    audit,
    now: () => new Date('2026-10-30T12:00:00Z'),
    batchSize: 2,
    maxBatches: 2,
  });

  const counts: number[] = [];
  for (let i = 0; i < 3; i++) {
    await run({ tenantId: MILVENDAS_TENANT_ID });
    const [last] = await db
      .select({ details: auditLog.details })
      .from(auditLog)
      .where(eq(auditLog.action, 'knowledge.reembedded'))
      .orderBy(auditLog.createdAt)
      .limit(1)
      .offset(i);
    counts.push((last?.details as { count: number }).count);
  }
  assert.deepEqual(counts, [4, 1, 0], '2 lotes de 2; depois o resto; depois no-op');

  const rows = await chunksByIds(db, ids);
  for (const row of rows) {
    assert.ok(row.embedding, 'todos os chunks preenchidos no fim');
    assert.equal(row.model, embedder.model);
  }
});

test('job: payload inválido → falha visível (bug de programação)', async () => {
  await resetDb();
  const db = await migratedDb();
  const run = createReembedHandler({
    db,
    embedder: fakeEmbeddings(),
    audit: createAuditAdapter({ db }),
    now: () => new Date(),
  });
  await assert.rejects(() => run({}), /payload inválido/);
  await assert.rejects(() => run({ tenantId: 'não-uuid' }), /payload inválido/);
});
