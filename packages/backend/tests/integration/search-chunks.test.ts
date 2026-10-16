// Fase 1, Task 2: pesquisa vetorial contra pgvector real (plano A, docs/06 A5) —
// a extensão `vector` e o índice HNSW funcionam de zero.

import assert from 'node:assert/strict';
import test from 'node:test';
import { MILVENDAS_TENANT_ID } from '../../src/adapters/db/schema/tenants.schema.js';
import { knowledgeChunks, searchChunks } from '../../src/modules/knowledge/knowledge.schema.js';
import { migratedDb, resetDb } from '../helpers/db.js';

test('searchChunks: vetor igual devolve o próprio chunk; base vazia devolve []', async () => {
  await resetDb();
  const db = await migratedDb();
  assert.deepEqual(await searchChunks(db, [0.1, 0.2, 0.3]), []);
  // inserir um chunk sintético com embedding normalizado e consultar com o mesmo vetor
  // dimensão real do schema: vector(1536) (docs/schema-base.md §4 Q8 — 384 é
  // ADR-0002/Fase 2); vetor one-hot = normalizado
  const v = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));
  await db
    .insert(knowledgeChunks)
    .values({
      tenantId: MILVENDAS_TENANT_ID,
      source: 'doc',
      position: 0,
      content: 'Chunk sintético para o teste de similaridade vetorial.',
      embedding: v,
    })
    .onConflictDoNothing();
  const hits = await searchChunks(db, v, { limit: 1 });
  assert.equal(hits.length, 1);
  const top = hits[0];
  assert.ok(top, 'há um hit');
  assert.ok(top.similarity >= 0.99);
});
