// Treinar agente, Task 5: fluxo guiado (passo a passo) → mesmo pipeline da T4.
// As respostas do editor são convertidas numa transcrição de texto simples,
// guardadas como upload (`passo-a-passo`) e seguem o job `knowledge.extract`
// até ao rascunho, com a linha escolhida já confirmada.
// Fixtures 100% sintéticas (AGENTS.md §13); transporte LLM falso, sem rede.

import assert from 'node:assert/strict';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';

import { businessLines, knowledgeTrainUploads } from '../../src/modules/knowledge/knowledge.schema.js';
import { formatGuidedTranscript } from '../../src/modules/knowledge/train-service.js';
import { buildTestApp, type TestApp } from '../helpers/http.js';
import { ok, toolCallResult } from '../helpers/fake-llm.js';

interface Sess {
  session: string;
  csrf: string;
}

const editor = (app: TestApp): Sess => ({ session: app.sessions.editor, csrf: app.csrf.editor });

/** Envio autenticado com CSRF (padrão de train-upload.test.ts). */
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
async function seedCctvLine(app: TestApp): Promise<void> {
  await app.db
    .insert(businessLines)
    .values([{ slug: 'cctv', name: 'CCTV', conversionGoal: 'installation_booking' }])
    .onConflictDoNothing();
}

const ANSWERS = [
  { question: 'Quanto custa instalar 4 câmaras?', answer: 'O pacote de 4 câmaras custa 150000.00 AOA.' },
  { question: 'A instalação tem garantia?', answer: 'Sim, a instalação tem garantia de 12 meses.' },
  { question: 'Quanto tempo demora a instalação?', answer: 'A instalação demora um dia útil.' },
];

const DOC_ITEM = {
  slug: 'garantia-instalacao',
  lineSlug: null,
  op: 'create',
  payload: {
    kind: 'knowledge_doc',
    docType: 'faq',
    title: 'Perguntas frequentes de CCTV',
    body: 'A instalação tem garantia de 12 meses.',
  },
};

test('editor responde ao passo a passo → 202, upload sintético e itens staged na linha confirmada', async () => {
  const app = await buildTestApp({
    llmSteps: [ok(toolCallResult('submit_knowledge', { items: [DOC_ITEM] }))],
  });
  try {
    await seedCctvLine(app);
    const s = editor(app);

    const res = await call(app, 'POST', '/v1/knowledge/train/guided', s, {
      lineSlug: 'cctv',
      answers: ANSWERS,
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

    // O upload é a transcrição do passo a passo, com a linha já confirmada.
    const [upload] = await app.db
      .select()
      .from(knowledgeTrainUploads)
      .where(eq(knowledgeTrainUploads.id, uploadIds[0]!));
    assert.ok(upload !== undefined, 'upload criado');
    assert.equal(upload.filename, 'passo-a-passo');
    assert.equal(upload.mediaType, 'text/plain');
    assert.equal(upload.lineSlug, 'cctv');
    assert.equal(upload.lineConfirmed, true);
    assert.equal(
      upload.text,
      'Pergunta: Quanto custa instalar 4 câmaras?\nResposta: O pacote de 4 câmaras custa 150000.00 AOA.'
        + '\n\nPergunta: A instalação tem garantia?\nResposta: Sim, a instalação tem garantia de 12 meses.'
        + '\n\nPergunta: Quanto tempo demora a instalação?\nResposta: A instalação demora um dia útil.',
      'transcrição na ordem das respostas',
    );
    for (const { answer } of ANSWERS) {
      assert.ok(upload.text.includes(answer), `texto do upload contém a resposta: ${answer}`);
    }

    await app.runPendingJobs();

    const draft = await call(app, 'GET', '/v1/knowledge/train/draft', s);
    assert.equal(draft.statusCode, 200);
    const items = draft.json().items as Array<{
      slug: string;
      lineSlug: string | null;
      lineConfirmed: boolean;
      entityType: string;
    }>;
    assert.equal(items.length, 1);
    const item = items[0]!;
    assert.equal(item.slug, DOC_ITEM.slug);
    assert.equal(item.lineSlug, 'cctv', 'linha do passo a passo herdada pelo item');
    assert.equal(item.lineConfirmed, true, 'linha confirmada no fluxo guiado');

    // O upload do passo a passo foi processado sem erro.
    const [after] = await app.db
      .select({ status: knowledgeTrainUploads.status, error: knowledgeTrainUploads.error })
      .from(knowledgeTrainUploads)
      .where(eq(knowledgeTrainUploads.id, uploadIds[0]!));
    assert.deepEqual(after, { status: 'done', error: null });
  } finally {
    await app.close();
  }
});

test('answers vazio → 400 e nada é criado', async () => {
  const app = await buildTestApp();
  try {
    await seedCctvLine(app);
    const res = await call(app, 'POST', '/v1/knowledge/train/guided', editor(app), {
      lineSlug: 'cctv',
      answers: [],
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().title, 'validation_failed');

    const uploads = await app.db.select({ id: knowledgeTrainUploads.id }).from(knowledgeTrainUploads);
    assert.equal(uploads.length, 0, 'sem upload parcial');
  } finally {
    await app.close();
  }
});

test('linha de negócio inexistente → 404 line_not_found e nada é criado', async () => {
  const app = await buildTestApp();
  try {
    // `business_lines` vazia: o slug é válido no enum mas não existe na BD.
    const res = await call(app, 'POST', '/v1/knowledge/train/guided', editor(app), {
      lineSlug: 'telecom',
      answers: ANSWERS,
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().title, 'line_not_found');
    assert.match(String(res.json().detail), /linha de negócio inexistente: telecom/);

    const uploads = await app.db.select({ id: knowledgeTrainUploads.id }).from(knowledgeTrainUploads);
    assert.equal(uploads.length, 0, 'sem upload parcial');
  } finally {
    await app.close();
  }
});

test('papéis: agent → 403; sem sessão → 401', async () => {
  const app = await buildTestApp();
  try {
    await seedCctvLine(app);
    const body = { lineSlug: 'cctv', answers: ANSWERS };

    const agentRes = await call(app, 'POST', '/v1/knowledge/train/guided', {
      session: app.sessions.agent,
      csrf: app.csrf.agent,
    }, body);
    assert.equal(agentRes.statusCode, 403);

    const noSession = await app.inject({ method: 'POST', url: '/v1/knowledge/train/guided', payload: body });
    assert.equal(noSession.statusCode, 401);
  } finally {
    await app.close();
  }
});

test('formatGuidedTranscript: uma linha de pergunta/resposta por item, ordem preservada', () => {
  assert.equal(formatGuidedTranscript([]), '');
  assert.equal(
    formatGuidedTranscript([
      { question: 'Pergunta A?', answer: 'Resposta A.' },
      { question: 'Pergunta B?', answer: 'Resposta B.' },
    ]),
    'Pergunta: Pergunta A?\nResposta: Resposta A.\n\nPergunta: Pergunta B?\nResposta: Resposta B.',
  );
});
