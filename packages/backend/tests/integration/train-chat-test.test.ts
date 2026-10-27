// Treinar agente, Task 8: chat de teste com substrato sintético e modo rascunho.
// Cobre o alvo `draft` (chunk citado, sem handoff nem lacuna), o alvo `published`
// (o rascunho nunca entra no retrieve de produção), a reutilização da conversa,
// o isolamento por tenant, o catálogo staged (preço + fonte), os papéis e a
// ausência de ports (503). Fixtures 100% sintéticas (AGENTS.md §13); o guião do
// LLM falso responde às duas tools: `submit_knowledge` (extração) e
// `submit_response` (chat).

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { and, eq } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';

import { createAuditAdapter } from '../../src/adapters/db/audit-adapter.js';
import { createSessionStore } from '../../src/adapters/db/auth.js';
import * as base from '../../src/adapters/db/schema/index.js';
import { conversations, contacts, whatsappAccounts } from '../../src/adapters/db/schema/index.js';
import {
  businessLines,
  handoffs,
  knowledgeDraftItems,
  knowledgeGaps,
  type DraftEntityType,
  type DraftOp,
} from '../../src/modules/knowledge/knowledge.schema.js';
import {
  retrieveForTarget,
  stagedCatalogId,
  stagedChunkId,
  tokenize,
} from '../../src/modules/knowledge/draft-retrieval.js';
import type { EmbeddingsProvider } from '../../src/ports/embeddings.js';
import { buildTestApp, type TestApp } from '../helpers/http.js';
import { ok, toolCallResult } from '../helpers/fake-llm.js';

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

/**
 * Embedder lexical determinístico: bolsa-de-palavras normalizada em 384 dims.
 * Ao contrário do `fakeEmbeddings` (hash do texto inteiro), textos que partilham
 * palavras ficam próximos — o necessário para exercitar o caminho do cosseno.
 */
function lexicalEmbeddings(): EmbeddingsProvider {
  const dimensions = 384;
  const embed = (text: string): number[] => {
    const vector = new Array<number>(dimensions).fill(0);
    for (const token of tokenize(text)) {
      let hash = 2166136261;
      for (let i = 0; i < token.length; i++) {
        hash ^= token.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      const index = (hash >>> 0) % dimensions;
      vector[index] = (vector[index] ?? 0) + 1;
    }
    const norm = Math.hypot(...vector);
    return norm === 0 ? vector : vector.map((value) => value / norm);
  };
  return {
    model: 'lexical-384',
    dimensions,
    async embedTexts(texts) {
      return texts.map(embed);
    },
  };
}

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
      { slug: 'cctv', name: 'CCTV', conversionGoal: 'installation_booking' },
    ])
    .onConflictDoNothing();
}

/** Tenant B + admin por inserts directos e sessão criada no SessionStore. */
async function tenantB(app: TestApp): Promise<{ id: string; session: string; csrf: string }> {
  const [tenant] = await app.db
    .insert(base.tenants)
    .values({ id: randomUUID(), name: 'Empresa B (chat sintético)' })
    .returning({ id: base.tenants.id });
  assert.ok(tenant !== undefined, 'fixture tenant B');
  const [user] = await app.db
    .insert(base.users)
    .values({
      tenantId: tenant.id,
      name: 'Admin B',
      email: 'admin-b@chat.test.local',
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
  return { id: tenant.id, session: sessionId, csrf: randomUUID() };
}

const DOC_BODY = 'As nossas câmaras CCTV custam 250.000 AOA.';
const DOC_ITEM = {
  slug: 'camaras-cctv',
  lineSlug: 'cctv',
  op: 'create',
  payload: {
    kind: 'knowledge_doc',
    docType: 'faq',
    title: 'Preços de CCTV',
    body: DOC_BODY,
  },
};

const CATALOG_ITEM = {
  slug: 'pacote-cftv-4-cameras',
  lineSlug: 'cctv',
  op: 'create',
  payload: {
    kind: 'catalog_item',
    name: 'Pacote CFTV 4 câmaras',
    summary: 'Quatro câmaras com instalação incluída.',
    details: { cameras: 4 },
    pricingMode: 'fixed',
    priceAmount: '250000.00',
    currency: 'AOA',
    priceNote: null,
    availability: 'available',
  },
};

const QUESTION = 'Quanto custam as câmaras CCTV?';
const CATALOG_QUESTION = 'Quanto custa o pacote CFTV de 4 câmaras?';

const submitArgs = (
  sources: Array<{ type: 'chunk' | 'catalog' | 'rule'; id: string }>,
  reply = 'Sim, temos câmaras CCTV com instalação incluída.',
) => ({
  reply,
  answered: true,
  firedTriggers: [],
  qualificationUpdates: {},
  sources,
});

const submitStep = (
  sources: Array<{ type: 'chunk' | 'catalog' | 'rule'; id: string }>,
  reply?: string,
) => ok(toolCallResult('submit_response', submitArgs(sources, reply)));

const extractionStep = (items: unknown[]) =>
  ok(toolCallResult('submit_knowledge', { items }));

interface StagedFixture {
  slug: string;
  entityType: DraftEntityType;
  op?: DraftOp;
  payload: Record<string, unknown>;
  body: string;
}

/** Insert directo no staging com o embedding do embedder lexical da app. */
async function insertStaged(
  app: TestApp,
  embedder: EmbeddingsProvider,
  tenantId: string,
  fixture: StagedFixture,
  changedById: string,
): Promise<string> {
  const [vector] = await embedder.embedTexts([fixture.body]);
  assert.ok(vector !== undefined, 'fixture: embedding');
  const [row] = await app.db
    .insert(knowledgeDraftItems)
    .values({
      tenantId,
      slug: fixture.slug,
      entityType: fixture.entityType,
      op: fixture.op ?? 'create',
      lineSlug: 'cctv',
      lineConfirmed: true,
      payload: fixture.payload,
      chunks: [{ position: 0, content: fixture.body, embedding: [...vector] }],
      baseVersion: null,
      changedById,
    })
    .returning({ id: knowledgeDraftItems.id });
  assert.ok(row !== undefined, 'fixture: item staged');
  return row.id;
}

const testConversations = (app: TestApp, tenantId: string) =>
  app.db
    .select({ id: conversations.id, lineId: conversations.lineId, aiMode: conversations.aiMode })
    .from(conversations)
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.isTest, true)));

test('draft: responde com o chunk do rascunho e não cria handoff nem lacuna', async () => {
  const embedder = lexicalEmbeddings();
  const app = await buildTestApp({
    embedder,
    llmSteps: [
      extractionStep([DOC_ITEM]),
      submitStep([{ type: 'chunk', id: stagedChunkId('camaras-cctv', 0) }]),
    ],
  });
  try {
    await seedLines(app);
    const s = editor(app);

    const upload = await call(app, 'POST', '/v1/knowledge/train/documents', s, {
      documents: [txt('precos-cctv.txt', DOC_BODY)],
      lineSlug: 'cctv',
    });
    assert.equal(upload.statusCode, 202);
    await app.runPendingJobs();

    const staged = await app.db.select().from(knowledgeDraftItems);
    assert.equal(staged.length, 1, 'documento staged pela extração');

    const res = await call(app, 'POST', '/v1/knowledge/chat/test', s, {
      text: QUESTION,
      target: 'draft',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      reply: string | null;
      sources: Array<{ type: string; id: string }>;
    };
    assert.ok(body.reply !== null && body.reply.length > 0, 'reply presente');
    assert.deepEqual(
      body.sources.map((source) => source.id),
      [stagedChunkId('camaras-cctv', 0)],
      'a fonte é o chunk staged',
    );
    assert.equal(body.sources[0]?.type, 'chunk');

    assert.equal((await app.db.select().from(handoffs)).length, 0, 'isTest → sem handoff');
    assert.equal((await app.db.select().from(knowledgeGaps)).length, 0, 'isTest → sem lacuna');

    const [conversation] = await testConversations(app, base.MILVENDAS_TENANT_ID);
    assert.ok(conversation !== undefined, 'conversa sintética criada');
    assert.equal(conversation.lineId, null);
    assert.equal(conversation.aiMode, 'ai_active');
  } finally {
    await app.close();
  }
});

test('published (default): o conteúdo do rascunho não entra no retrieve de produção', async () => {
  const embedder = lexicalEmbeddings();
  const app = await buildTestApp({
    embedder,
    llmSteps: [
      extractionStep([DOC_ITEM]),
      submitStep([{ type: 'chunk', id: stagedChunkId('camaras-cctv', 0) }]),
    ],
  });
  try {
    await seedLines(app);
    const s = editor(app);
    await call(app, 'POST', '/v1/knowledge/train/documents', s, {
      documents: [txt('precos-cctv.txt', DOC_BODY)],
      lineSlug: 'cctv',
    });
    await app.runPendingJobs();

    const res = await call(app, 'POST', '/v1/knowledge/chat/test', s, { text: QUESTION });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { reply: string | null; sources: unknown[] };
    assert.deepEqual(body.sources, [], 'sem fontes: o rascunho não é conhecimento publicado');
  } finally {
    await app.close();
  }
});

test('segunda chamada reutiliza a mesma conta, contacto e conversa de teste', async () => {
  const embedder = lexicalEmbeddings();
  const app = await buildTestApp({
    embedder,
    llmSteps: [
      extractionStep([DOC_ITEM]),
      submitStep([{ type: 'chunk', id: stagedChunkId('camaras-cctv', 0) }]),
    ],
  });
  try {
    await seedLines(app);
    const s = editor(app);
    await call(app, 'POST', '/v1/knowledge/train/documents', s, {
      documents: [txt('precos-cctv.txt', DOC_BODY)],
      lineSlug: 'cctv',
    });
    await app.runPendingJobs();

    for (let i = 0; i < 2; i++) {
      const res = await call(app, 'POST', '/v1/knowledge/chat/test', s, {
        text: QUESTION,
        target: 'draft',
      });
      assert.equal(res.statusCode, 200, `chamada ${i + 1}`);
    }

    assert.equal((await testConversations(app, base.MILVENDAS_TENANT_ID)).length, 1);
    const tenantContacts = await app.db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.tenantId, base.MILVENDAS_TENANT_ID));
    assert.equal(tenantContacts.length, 1, 'um contacto sintético');
    const testAccounts = await app.db
      .select({ id: whatsappAccounts.id })
      .from(whatsappAccounts)
      .where(
        and(
          eq(whatsappAccounts.tenantId, base.MILVENDAS_TENANT_ID),
          eq(whatsappAccounts.label, 'chat-de-teste'),
        ),
      );
    assert.equal(testAccounts.length, 1, 'uma conta sintética');
  } finally {
    await app.close();
  }
});

test('isolamento: o chat do tenant B só vê chunks de B', async () => {
  const embedder = lexicalEmbeddings();
  const app = await buildTestApp({
    embedder,
    llmSteps: [submitStep([{ type: 'chunk', id: stagedChunkId('pacote-b', 0) }])],
  });
  try {
    await seedLines(app);
    const b = await tenantB(app);
    await insertStaged(
      app,
      embedder,
      base.MILVENDAS_TENANT_ID,
      { slug: 'pacote-a', entityType: 'knowledge_doc', payload: DOC_ITEM.payload, body: DOC_BODY },
      app.users.editor.id,
    );
    await insertStaged(
      app,
      embedder,
      b.id,
      {
        slug: 'pacote-b',
        entityType: 'knowledge_doc',
        payload: DOC_ITEM.payload,
        body: DOC_BODY,
      },
      app.users.editor.id,
    );

    const res = await call(app, 'POST', '/v1/knowledge/chat/test', { session: b.session, csrf: b.csrf }, {
      text: QUESTION,
      target: 'draft',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { sources: Array<{ id: string }> };
    assert.deepEqual(body.sources.map((source) => source.id), [stagedChunkId('pacote-b', 0)]);

    const retrieved = await retrieveForTarget(
      {
        db: app.db,
        scope: { tenantId: b.id },
        audit: createAuditAdapter({ db: app.db }),
        now: () => new Date(),
        embedder,
      },
      QUESTION,
      'draft',
    );
    assert.deepEqual(
      retrieved.map((chunk) => chunk.id),
      [stagedChunkId('pacote-b', 0)],
      'o staging de A nunca aparece no retrieve de B',
    );
  } finally {
    await app.close();
  }
});

test('draft: catálogo staged responde com preço (tool look up) e fonte de catálogo', async () => {
  const embedder = lexicalEmbeddings();
  const app = await buildTestApp({
    embedder,
    llmSteps: [
      extractionStep([CATALOG_ITEM]),
      ok(toolCallResult('lookup_catalog', { query: 'pacote CFTV 4 câmaras' })),
      submitStep(
        [{ type: 'catalog', id: stagedCatalogId('pacote-cftv-4-cameras') }],
        'O pacote CFTV 4 câmaras custa 250.000 AOA, com instalação incluída.',
      ),
    ],
  });
  try {
    await seedLines(app);
    const s = editor(app);
    await call(app, 'POST', '/v1/knowledge/train/documents', s, {
      documents: [txt('catalogo-cctv.txt', 'Pacote CFTV 4 câmaras por 250000.00 AOA.')],
      lineSlug: 'cctv',
    });
    await app.runPendingJobs();

    const res = await call(app, 'POST', '/v1/knowledge/chat/test', s, {
      text: CATALOG_QUESTION,
      target: 'draft',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      reply: string | null;
      sources: Array<{ type: string; id: string }>;
    };
    assert.match(body.reply ?? '', /250\.000 AOA/);
    assert.deepEqual(
      body.sources.map((source) => `${source.type}:${source.id}`),
      [`catalog:${stagedCatalogId('pacote-cftv-4-cameras')}`],
    );
  } finally {
    await app.close();
  }
});

test('papéis: agent → 403; sem sessão → 401; admin responde 200', async () => {
  const embedder = lexicalEmbeddings();
  const app = await buildTestApp({
    embedder,
    llmSteps: [submitStep([{ type: 'chunk', id: stagedChunkId('camaras-cctv', 0) }])],
  });
  try {
    const agentSess: Sess = { session: app.sessions.agent, csrf: app.csrf.agent };
    const asAgent = await call(app, 'POST', '/v1/knowledge/chat/test', agentSess, {
      text: QUESTION,
      target: 'draft',
    });
    assert.equal(asAgent.statusCode, 403);

    const noSession = await app.inject({
      method: 'POST',
      url: '/v1/knowledge/chat/test',
      payload: { text: QUESTION },
    });
    assert.equal(noSession.statusCode, 401);

    const asAdmin = await call(app, 'POST', '/v1/knowledge/chat/test', admin(app), {
      text: QUESTION,
      target: 'draft',
    });
    assert.equal(asAdmin.statusCode, 200);
  } finally {
    await app.close();
  }
});

test('sem portsFactory no bundle → 503 knowledge_ports_unavailable', async () => {
  const app = await buildTestApp({ omitKnowledgePorts: true });
  try {
    const res = await call(app, 'POST', '/v1/knowledge/chat/test', editor(app), {
      text: QUESTION,
      target: 'draft',
    });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().title, 'knowledge_ports_unavailable');
  } finally {
    await app.close();
  }
});
