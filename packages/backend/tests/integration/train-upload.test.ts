// Treinar agente, Task 4: upload de documento → job de extração → rascunho.
// Cobre o caminho completo (POST documents → knowledge.extract → GET draft),
// os limites da fronteira (415/400/413), a falha de extração visível sem efeitos
// no activo, os papéis (editor/admin; agent recusado), o isolamento cross-tenant
// e a correção/cancelamento de itens staged (PATCH/DELETE).
// Fixtures 100% sintéticas (AGENTS.md §13); transporte LLM falso, sem rede.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';

import { createSessionStore } from '../../src/adapters/db/auth.js';
import * as base from '../../src/adapters/db/schema/index.js';
import {
  businessLines,
  catalogItems,
  knowledgeDraftItems,
  knowledgeTrainUploads,
} from '../../src/modules/knowledge/knowledge.schema.js';
import { buildTestApp, type TestApp } from '../helpers/http.js';
import { ok, textResult, toolCallResult } from '../helpers/fake-llm.js';

interface Sess {
  session: string;
  csrf: string;
}

const editor = (app: TestApp): Sess => ({ session: app.sessions.editor, csrf: app.csrf.editor });

/** Envio autenticado com CSRF (padrão de isolation.test.ts). */
const call = (
  app: TestApp,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

const txt = (filename: string, text: string) => ({
  filename,
  mediaType: 'text/plain',
  contentBase64: b64(text),
});

/** Dicionário global `business_lines` (não pertence a tenants). */
async function seedLines(app: TestApp): Promise<void> {
  await app.db
    .insert(businessLines)
    .values([
      { slug: 'software', name: 'Software', conversionGoal: 'demo_request' },
      { slug: 'custom', name: 'Soluções personalizadas', conversionGoal: 'proposal_request' },
      { slug: 'telecom', name: 'Telecomunicações', conversionGoal: 'purchase' },
      { slug: 'cctv', name: 'CCTV', conversionGoal: 'installation_booking' },
    ])
    .onConflictDoNothing();
}

/** Tenant B + admin por inserts directos e sessão criada no SessionStore. */
async function tenantBSession(app: TestApp): Promise<Sess> {
  const [tenant] = await app.db
    .insert(base.tenants)
    .values({ id: randomUUID(), name: 'Empresa B (treino sintético)' })
    .returning({ id: base.tenants.id });
  assert.ok(tenant !== undefined, 'fixture tenant B');
  const [user] = await app.db
    .insert(base.users)
    .values({
      tenantId: tenant.id,
      name: 'Admin B',
      email: 'admin-b@train.test.local',
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

const DOC_ITEM = {
  slug: 'garantia-instalacao',
  lineSlug: 'cctv',
  op: 'create',
  payload: {
    kind: 'knowledge_doc',
    docType: 'policy',
    title: 'Garantia da instalação',
    body: 'A instalação tem garantia de 12 meses.',
  },
};

const CATALOG_ITEM = {
  slug: 'pacote-cftv-4-camaras',
  lineSlug: 'cctv',
  op: 'create',
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
};

const DOCUMENTO =
  'A instalação tem garantia de 12 meses.\n\n' +
  'O pacote CFTV 4 câmaras custa 150000.00 AOA e inclui instalação.';

test('upload TXT → 202; o job extrai e o rascunho tem chunks com embedding + audit', async () => {
  const app = await buildTestApp({
    llmSteps: [ok(toolCallResult('submit_knowledge', { items: [DOC_ITEM, CATALOG_ITEM] }))],
  });
  try {
    await seedLines(app);
    const s = editor(app);

    const res = await call(app, 'POST', '/v1/knowledge/train/documents', s, {
      documents: [txt('empresa.txt', DOCUMENTO)],
    });
    assert.equal(res.statusCode, 202);
    const uploadIds = res.json().uploadIds as string[];
    assert.equal(uploadIds.length, 1);
    assert.equal(typeof uploadIds[0], 'string');

    // O payload do job leva SÓ ids (docs/02 §6).
    const job = app.enqueuedJobs.find((j) => j.name === 'knowledge.extract');
    assert.ok(job !== undefined, 'knowledge.extract enfileirado');
    assert.deepEqual(Object.keys(job.payload), ['uploadId']);
    assert.equal(job.payload.uploadId, uploadIds[0]);

    // Antes de correr o job não há rascunho.
    const before = await call(app, 'GET', '/v1/knowledge/train/draft', s);
    assert.equal(before.statusCode, 200);
    assert.deepEqual(before.json().items, []);

    await app.runPendingJobs();

    const draft = await call(app, 'GET', '/v1/knowledge/train/draft', s);
    assert.equal(draft.statusCode, 200);
    const items = draft.json().items as Array<{
      slug: string;
      entityType: string;
      chunks: Array<{ position: number; content: string; embedding: number[] | null }>;
    }>;
    assert.equal(items.length, 2);

    const doc = items.find((i) => i.slug === 'garantia-instalacao');
    assert.ok(doc !== undefined, 'documento staged');
    assert.equal(doc.entityType, 'knowledge_doc');
    assert.ok(doc.chunks.length >= 1, 'documento tem chunks');
    for (const chunk of doc.chunks) {
      assert.equal(typeof chunk.content, 'string');
      assert.equal(typeof chunk.position, 'number');
      assert.ok(Array.isArray(chunk.embedding), 'embedding calculado na extração');
      assert.equal(chunk.embedding.length, 384, 'dimensão do embedder falso');
    }

    const catalog = items.find((i) => i.slug === 'pacote-cftv-4-camaras');
    assert.ok(catalog !== undefined, 'item de catálogo staged');
    assert.equal(catalog.entityType, 'catalog_item');
    assert.equal(catalog.chunks.length, 1);
    assert.match(catalog.chunks[0]?.content ?? '', /Pacote CFTV 4 câmaras/);
    assert.equal(catalog.chunks[0]?.embedding?.length, 384);

    const [uploadRow] = await app.db
      .select()
      .from(knowledgeTrainUploads)
      .where(eq(knowledgeTrainUploads.id, uploadIds[0]!));
    assert.equal(uploadRow?.status, 'done');
    assert.equal(uploadRow?.error, null);

    const audits = await app.db
      .select({ action: base.auditLog.action, actorId: base.auditLog.actorId })
      .from(base.auditLog)
      .where(eq(base.auditLog.action, 'knowledge.staged'));
    assert.equal(audits.length, 1, 'exatamente 1 audit knowledge.staged');
    assert.equal(audits[0]?.actorId, app.users.editor.id);

    // Idempotência: repetir os jobs não duplica staging nem audit (CAS pending).
    await app.runPendingJobs();
    const again = await call(app, 'GET', '/v1/knowledge/train/draft', s);
    assert.equal((again.json().items as unknown[]).length, 2);
    const auditsAgain = await app.db
      .select({ id: base.auditLog.id })
      .from(base.auditLog)
      .where(eq(base.auditLog.action, 'knowledge.staged'));
    assert.equal(auditsAgain.length, 1);
  } finally {
    await app.close();
  }
});

test('upload com lineSlug pré-selecionado → itens lineConfirmed true (linha herdada)', async () => {
  const itemWithoutLine = { ...DOC_ITEM, lineSlug: null };
  const app = await buildTestApp({
    llmSteps: [ok(toolCallResult('submit_knowledge', { items: [itemWithoutLine] }))],
  });
  try {
    await seedLines(app);
    const s = editor(app);

    const res = await call(app, 'POST', '/v1/knowledge/train/documents', s, {
      documents: [txt('politicas.txt', 'Política de garantia sintética.')],
      lineSlug: 'cctv',
    });
    assert.equal(res.statusCode, 202);
    const uploadId = (res.json().uploadIds as string[])[0]!;

    const [upload] = await app.db
      .select()
      .from(knowledgeTrainUploads)
      .where(eq(knowledgeTrainUploads.id, uploadId));
    assert.equal(upload?.lineSlug, 'cctv');
    assert.equal(upload?.lineConfirmed, true);

    await app.runPendingJobs();

    const draft = await call(app, 'GET', '/v1/knowledge/train/draft', s);
    const items = draft.json().items as Array<{ lineSlug: string | null; lineConfirmed: boolean }>;
    assert.equal(items.length, 1);
    assert.equal(items[0]?.lineSlug, 'cctv', 'linha pré-selecionada herdada pelo item');
    assert.equal(items[0]?.lineConfirmed, true);
  } finally {
    await app.close();
  }
});

test('fronteira do upload: PDF → 415 (ADR pendente), base64 inválido → 400, >8 MiB → 413', async () => {
  const app = await buildTestApp();
  try {
    const s = editor(app);

    const pdf = await call(app, 'POST', '/v1/knowledge/train/documents', s, {
      documents: [
        { filename: 'manual.pdf', mediaType: 'application/pdf', contentBase64: b64('%PDF-1.7 sintetico') },
      ],
    });
    assert.equal(pdf.statusCode, 415);
    assert.equal(pdf.json().title, 'unsupported_media_type');
    assert.match(String(pdf.json().detail), /ADR/, 'mensagem aponta o ADR pendente');

    const badBase64 = await call(app, 'POST', '/v1/knowledge/train/documents', s, {
      documents: [{ filename: 'x.txt', mediaType: 'text/plain', contentBase64: '!!!' }],
    });
    assert.equal(badBase64.statusCode, 400);
    assert.equal(badBase64.json().title, 'invalid_content_base64');

    const tooBig = await call(app, 'POST', '/v1/knowledge/train/documents', s, {
      documents: [
        { filename: 'grande.txt', mediaType: 'text/plain', contentBase64: 'A'.repeat(8 * 1024 * 1024 + 1024) },
      ],
    });
    assert.equal(tooBig.statusCode, 413, 'body limit da rota é 8 MiB');

    // Nada foi criado em nenhuma das tentativas.
    const uploads = await app.db.select({ id: knowledgeTrainUploads.id }).from(knowledgeTrainUploads);
    assert.equal(uploads.length, 0);
  } finally {
    await app.close();
  }
});

test('falha de extração → upload error (mensagem sem conteúdo), rascunho vazio, activo intacto', async () => {
  const app = await buildTestApp({ llmSteps: [ok(textResult('resposta sem ferramenta'))] });
  try {
    await seedLines(app);
    const s = editor(app);
    const [line] = await app.db
      .select({ id: businessLines.id })
      .from(businessLines)
      .where(eq(businessLines.slug, 'cctv'));
    assert.ok(line !== undefined, 'linha cctv semeada');

    // Activo publicado com o mesmo slug que o extractor devolveria.
    await app.db.insert(catalogItems).values({
      tenantId: base.MILVENDAS_TENANT_ID,
      lineId: line.id,
      kind: 'product',
      name: 'Activo',
      slug: 'garantia-instalacao',
      summary: 'item activo sintético',
      pricingMode: 'fixed',
      priceAmount: '1000.00',
      status: 'published',
      ownerId: app.users.editor.id,
      version: 1,
    });

    const segredo = 'SEGREDO-DO-DOCUMENTO-QUE-NAO-PODE-IR-PARA-O-ERRO';
    const res = await call(app, 'POST', '/v1/knowledge/train/documents', s, {
      documents: [txt('segredo.txt', `${segredo}\n\ntexto sintético`)],
    });
    assert.equal(res.statusCode, 202);
    const uploadId = (res.json().uploadIds as string[])[0]!;

    await app.runPendingJobs();

    const [upload] = await app.db
      .select()
      .from(knowledgeTrainUploads)
      .where(eq(knowledgeTrainUploads.id, uploadId));
    assert.equal(upload?.status, 'error');
    assert.ok((upload?.error ?? '').length > 0, 'falha visível ao utilizador');
    assert.ok(!(upload?.error ?? '').includes(segredo), 'erro nunca ecoa o conteúdo do documento');

    const staged = await app.db.select({ id: knowledgeDraftItems.id }).from(knowledgeDraftItems);
    assert.equal(staged.length, 0, 'rascunho vazio');

    const [active] = await app.db
      .select({ name: catalogItems.name, priceAmount: catalogItems.priceAmount, version: catalogItems.version })
      .from(catalogItems)
      .where(eq(catalogItems.slug, 'garantia-instalacao'));
    assert.deepEqual(active, { name: 'Activo', priceAmount: '1000.00', version: 1 }, 'activo intacto');
  } finally {
    await app.close();
  }
});

test('papéis: agent → 403 (upload e leitura); sem sessão → 401', async () => {
  const app = await buildTestApp();
  try {
    const body = { documents: [txt('x.txt', 'texto sintético')] };
    const agentSess: Sess = { session: app.sessions.agent, csrf: app.csrf.agent };

    const uploadAgent = await call(app, 'POST', '/v1/knowledge/train/documents', agentSess, body);
    assert.equal(uploadAgent.statusCode, 403);

    const draftAgent = await call(app, 'GET', '/v1/knowledge/train/draft', agentSess);
    assert.equal(draftAgent.statusCode, 403);

    const noSession = await app.inject({
      method: 'POST',
      url: '/v1/knowledge/train/documents',
      payload: body,
    });
    assert.equal(noSession.statusCode, 401);
  } finally {
    await app.close();
  }
});

test('isolamento: admin do tenant B não vê nem altera o rascunho de A', async () => {
  const app = await buildTestApp({
    llmSteps: [ok(toolCallResult('submit_knowledge', { items: [DOC_ITEM] }))],
  });
  try {
    await seedLines(app);
    const a = editor(app);
    const b = await tenantBSession(app);

    const res = await call(app, 'POST', '/v1/knowledge/train/documents', a, {
      documents: [txt('empresa.txt', DOCUMENTO)],
    });
    assert.equal(res.statusCode, 202);
    await app.runPendingJobs();

    const draftA = await call(app, 'GET', '/v1/knowledge/train/draft', a);
    assert.equal((draftA.json().items as unknown[]).length, 1);
    const itemId = (draftA.json().items as Array<{ id: string }>)[0]!.id;

    const draftB = await call(app, 'GET', '/v1/knowledge/train/draft', b);
    assert.equal(draftB.statusCode, 200);
    assert.deepEqual(draftB.json().items, [], 'B não vê o rascunho de A');

    const patchB = await call(app, 'PATCH', `/v1/knowledge/train/draft/${itemId}`, b, {
      confirmLine: true,
    });
    assert.equal(patchB.statusCode, 404, 'mutação por id alheio esconde a existência');

    const deleteB = await call(app, 'DELETE', `/v1/knowledge/train/draft/${itemId}`, b);
    assert.equal(deleteB.statusCode, 404);

    // O rascunho de A não mudou.
    const afterA = await call(app, 'GET', '/v1/knowledge/train/draft', a);
    const itemsA = afterA.json().items as Array<{ id: string; lineConfirmed: boolean }>;
    assert.equal(itemsA.length, 1);
    assert.equal(itemsA[0]?.id, itemId);
    assert.equal(itemsA[0]?.lineConfirmed, false);
  } finally {
    await app.close();
  }
});

test('PATCH corrige payload/confirma linha e DELETE remove o item staged', async () => {
  const app = await buildTestApp({
    llmSteps: [ok(toolCallResult('submit_knowledge', { items: [CATALOG_ITEM] }))],
  });
  try {
    await seedLines(app);
    const s = editor(app);

    const res = await call(app, 'POST', '/v1/knowledge/train/documents', s, {
      documents: [txt('catalogo.txt', 'Pacote CFTV 4 câmaras por 150000.00 AOA.')],
    });
    assert.equal(res.statusCode, 202);
    await app.runPendingJobs();

    const draft = await call(app, 'GET', '/v1/knowledge/train/draft', s);
    const item = (draft.json().items as Array<{ id: string; lineConfirmed: boolean }>)[0]!;
    assert.equal(item.lineConfirmed, false, 'linha proposta pelo extractor ainda não confirmada');

    const confirmed = await call(app, 'PATCH', `/v1/knowledge/train/draft/${item.id}`, s, {
      confirmLine: true,
    });
    assert.equal(confirmed.statusCode, 200);
    assert.equal(confirmed.json().item.lineConfirmed, true);

    const edited = await call(app, 'PATCH', `/v1/knowledge/train/draft/${item.id}`, s, {
      payload: { summary: 'Resumo corrigido pelo editor.' },
      lineSlug: 'telecom',
      confirmLine: true,
    });
    assert.equal(edited.statusCode, 200);
    const editedItem = edited.json().item as {
      lineSlug: string;
      lineConfirmed: boolean;
      payload: Record<string, unknown>;
      chunks: Array<{ content: string }>;
    };
    assert.equal(editedItem.lineSlug, 'telecom');
    assert.equal(editedItem.lineConfirmed, true);
    assert.equal(editedItem.payload.summary, 'Resumo corrigido pelo editor.');
    assert.match(editedItem.chunks[0]?.content ?? '', /Resumo corrigido pelo editor/, 'chunks recalculados');

    const removed = await call(app, 'DELETE', `/v1/knowledge/train/draft/${item.id}`, s);
    assert.equal(removed.statusCode, 204);

    const empty = await call(app, 'GET', '/v1/knowledge/train/draft', s);
    assert.deepEqual(empty.json().items, []);

    const missing = await call(app, 'DELETE', `/v1/knowledge/train/draft/${item.id}`, s);
    assert.equal(missing.statusCode, 404);
  } finally {
    await app.close();
  }
});
