// Testes do orquestrador. Correr com: npm test
// Usam portas em memória e os gatilhos REAIS de handoff-triggers.seed.ts.
// O fornecedor de IA é simulado: aqui testa-se a lógica de decisão, não o modelo.

import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AIProvider,
  AIRequest,
  AIResponse,
  ConversationState,
  NewHandoff,
  Ports,
  Priority,
  QualificationQuestion,
  TraceInput,
  TriggerDef,
} from '../../src/ports/ai-provider.js';
import { triggerSeeds } from '../../src/modules/knowledge/handoff-triggers.seed.js';
import { DEFAULT_CONFIG, handleInbound, type OrchestratorConfig } from '../../src/application/orchestrator.js';

const ALL_TRIGGERS: TriggerDef[] = triggerSeeds.map((s) => ({
  id: `${s.lineSlug ?? 'global'}:${s.code}`,
  code: s.code,
  lineSlug: s.lineSlug,
  description: s.description,
  detectionHint: s.detectionHint,
  action: s.action ?? 'handoff_now',
  priority: s.priority ?? 'normal',
}));

interface HandoffRow extends NewHandoff {
  id: string;
  open: boolean;
}

function harness(init: Partial<ConversationState> = {}, questions: QualificationQuestion[] = []) {
  const w = {
    state: {
      id: 'conv-1',
      line: 'telecom',
      aiMode: 'ai_active',
      turns: [],
      answers: {},
      missStreak: 0,
      ...init,
    } as ConversationState,
    seen: new Set<string>(),
    handoffs: [] as HandoffRow[],
    gaps: [] as string[],
    traces: [] as TraceInput[],
    notifications: [] as { type: string; priority: Priority; handoffId: string }[],
    lookups: 0,
  };

  const ports: Ports = {
    claimMessage: async (id) => (w.seen.has(id) ? false : (w.seen.add(id), true)),
    loadState: async () => structuredClone(w.state),
    saveState: async (_id, patch) => {
      if (patch.aiMode) w.state.aiMode = patch.aiMode;
      if (patch.answers) w.state.answers = patch.answers;
      if (patch.missStreak !== undefined) w.state.missStreak = patch.missStreak;
    },
    retrieve: async () => [],
    lookupCatalog: async () => (w.lookups++, []),
    rules: async () => [],
    questions: async () => questions,
    triggers: async (line) => ALL_TRIGGERS.filter((t) => t.lineSlug === null || t.lineSlug === line),
    findOpenHandoff: async (cid) => {
      const h = w.handoffs.find((x) => x.conversationId === cid && x.open);
      return h ? { id: h.id, priority: h.priority } : null;
    },
    createHandoff: async (h) => {
      const id = `h${w.handoffs.length + 1}`;
      w.handoffs.push({ ...h, id, open: true });
      return id;
    },
    bumpHandoffPriority: async (id, priority) => {
      const h = w.handoffs.find((x) => x.id === id);
      if (h) h.priority = priority;
    },
    recordGap: async (g) => void w.gaps.push(g.question),
    saveTrace: async (t) => void w.traces.push(t),
    notify: async (e) => void w.notifications.push(e),
  };

  let n = 0;
  const send = (
    text: string,
    provider: AIProvider,
    opts: { id?: string; isTest?: boolean; cfg?: Partial<OrchestratorConfig> } = {},
  ) => {
    w.state.turns.push({ from: 'customer', text });
    return handleInbound(
      ports,
      provider,
      { id: opts.id ?? `m${++n}`, conversationId: w.state.id, text, isTest: opts.isTest },
      opts.cfg,
    );
  };
  return { w, send };
}

function fakeProvider(make: Partial<AIResponse> | ((req: AIRequest) => Partial<AIResponse>) = {}) {
  const calls: AIRequest[] = [];
  const provider: AIProvider & { calls: AIRequest[] } = {
    calls,
    async respond(req) {
      calls.push(req);
      const extra = typeof make === 'function' ? make(req) : make;
      return {
        reply: 'resposta da IA',
        answered: true,
        firedTriggers: [],
        qualificationUpdates: {},
        sources: [],
        model: 'fake',
        ...extra,
      };
    },
    async summarizeForHandoff() {
      return 'resumo da IA';
    },
  };
  return provider;
}

const cctvQuestions: QualificationQuestion[] = [
  { key: 'camera_count', question: 'Quantas câmaras?', required: true, position: 1 },
  { key: 'location', question: 'Qual a localização?', required: true, position: 2 },
];

test('mensagem repetida (retry de webhook) não é processada duas vezes', async () => {
  const { send } = harness();
  const provider = fakeProvider();
  const first = await send('olá', provider, { id: 'x' });
  const second = await send('olá', provider, { id: 'x' });
  assert.equal(first.status, 'ok');
  assert.equal(second.status, 'duplicate');
  assert.equal(provider.calls.length, 1);
});

test('conversa em human_only: a IA não responde nem é chamada', async () => {
  const { w, send } = harness({ aiMode: 'human_only' });
  const provider = fakeProvider();
  const out = await send('olá', provider);
  assert.equal(out.status, 'human_only');
  assert.equal(out.reply, null);
  assert.equal(provider.calls.length, 0);
  assert.equal(w.traces.length, 0);
});

test('handoff_now (complaint): cria handoff urgente, bloqueia a IA e usa a mensagem fixa', async () => {
  const { w, send } = harness();
  const provider = fakeProvider({ firedTriggers: ['complaint'], reply: 'Peço desculpa por tudo!' });
  const out = await send('Isto é uma vergonha!', provider);
  assert.equal(out.lockedAi, true);
  assert.equal(w.state.aiMode, 'human_only');
  assert.equal(out.reply, DEFAULT_CONFIG.handoffMessage(ALL_TRIGGERS[1]!));
  assert.equal(w.handoffs.length, 1);
  assert.equal(w.handoffs[0]!.priority, 'urgent');
  assert.equal(w.handoffs[0]!.summary, 'resumo da IA');
  assert.deepEqual(w.notifications.map((n) => n.type), ['handoff']);
  assert.equal(w.traces[0]!.handoffId, 'h1');
});

test('flag_only: avisa o painel mas a IA continua e a resposta é a do modelo', async () => {
  const { w, send } = harness({ line: 'software' });
  const provider = fakeProvider({ firedTriggers: ['scope_exceeds_product'], reply: 'O produto faz X hoje.' });
  const out = await send('Preciso de ligação ao nosso ERP', provider);
  assert.equal(out.lockedAi, false);
  assert.equal(w.state.aiMode, 'ai_active');
  assert.equal(out.reply, 'O produto faz X hoje.');
  assert.equal(w.handoffs.length, 1);
  assert.deepEqual(w.notifications.map((n) => n.type), ['flag']);
});

test('handoff_when_qualified: só passa quando a qualificação fica completa', async () => {
  const { w, send } = harness({ line: 'cctv' }, cctvQuestions);
  const first = await send('Quero câmaras', fakeProvider({ qualificationUpdates: { camera_count: '6' } }));
  assert.equal(first.handoffId, null);
  assert.equal(w.handoffs.length, 0);

  const second = await send('Benfica', fakeProvider({ qualificationUpdates: { location: 'Benfica, Luanda' } }));
  assert.equal(second.lockedAi, true);
  assert.equal(w.handoffs.length, 1);
  assert.equal(w.handoffs[0]!.triggerId, 'cctv:quote_visit');
  const snapshot = w.handoffs[0]!.leadSnapshot as { missing: string[]; answers: Record<string, string> };
  assert.deepEqual(snapshot.missing, []);
  assert.equal(snapshot.answers.camera_count, '6');
});

test('handoff_when_qualified: cliente que insiste passa antes, com os campos em falta no resumo', async () => {
  const { w, send } = harness({ line: 'cctv' }, cctvQuestions);
  const out = await send('Quero que alguém venha ver', fakeProvider({ firedTriggers: ['quote_visit'] }));
  assert.equal(out.lockedAi, true);
  const snapshot = w.handoffs[0]!.leadSnapshot as { missing: string[] };
  assert.deepEqual(snapshot.missing, ['camera_count', 'location']);
});

test('low_confidence: 1.ª falha só regista lacuna; 2.ª seguida passa a humano', async () => {
  const { w, send } = harness();
  const unanswered = fakeProvider({ answered: false, reply: null });
  const first = await send('Têm cobertura em Cacuaco?', unanswered);
  assert.equal(first.gapRecorded, true);
  assert.equal(first.handoffId, null);
  assert.equal(first.reply, DEFAULT_CONFIG.noSourceMessage);
  assert.equal(w.state.missStreak, 1);

  const second = await send('E fibra, chega aí?', unanswered);
  assert.ok(second.fired.includes('low_confidence'));
  assert.equal(second.lockedAi, true);
  assert.equal(w.gaps.length, 2);
});

test('uma resposta com fonte zera a contagem de falhas seguidas', async () => {
  const { w, send } = harness({ missStreak: 1 });
  await send('qual o horário?', fakeProvider({ answered: true }));
  assert.equal(w.state.missStreak, 0);
});

test('rede de segurança: pedido explícito de humano passa mesmo que o modelo não o detete', async () => {
  const { w, send } = harness();
  const out = await send('quero falar com um atendente', fakeProvider());
  assert.ok(out.fired.includes('human_requested'));
  assert.equal(out.lockedAi, true);
  assert.equal(w.handoffs.length, 1);
});

test('falha do fornecedor de IA: passa a humano com mensagem fixa e sem gatilho', async () => {
  const { w, send } = harness();
  const broken: AIProvider = {
    respond: async () => {
      throw new Error('503');
    },
    summarizeForHandoff: async () => '',
  };
  const out = await send('olá', broken);
  assert.equal(out.status, 'provider_error');
  assert.equal(out.reply, DEFAULT_CONFIG.errorHandoffMessage);
  assert.equal(out.lockedAi, true);
  assert.equal(w.handoffs[0]!.triggerId, null);
  assert.equal(w.handoffs[0]!.priority, 'high');
  assert.ok(w.handoffs[0]!.reason.includes('503'));
});

test('tempo excedido: aborta o pedido ao fornecedor e passa a humano', async () => {
  const { send } = harness();
  let aborted = false;
  const hanging: AIProvider = {
    respond: (_req, signal) =>
      new Promise<AIResponse>(() => {
        signal?.addEventListener('abort', () => {
          aborted = true;
        });
      }),
    summarizeForHandoff: async () => '',
  };
  const out = await send('olá', hanging, { cfg: { providerTimeoutMs: 30 } });
  assert.equal(out.status, 'provider_error');
  assert.equal(aborted, true);
});

test('já existe handoff aberto: não duplica e sobe a prioridade', async () => {
  const { w, send } = harness({ line: 'software' });
  await send('preciso de integração com o ERP', fakeProvider({ firedTriggers: ['scope_exceeds_product'] }));
  assert.equal(w.handoffs[0]!.priority, 'normal');

  const out = await send('isto é uma vergonha', fakeProvider({ firedTriggers: ['complaint'] }));
  assert.equal(w.handoffs.length, 1);
  assert.equal(out.handoffId, 'h1');
  assert.equal(w.handoffs[0]!.priority, 'urgent');
  assert.equal(w.notifications.length, 2);
  assert.equal(out.lockedAi, true);
});

test('vários gatilhos: o motivo principal é o de maior prioridade', async () => {
  const { w, send } = harness();
  await send('quero um humano, isto é uma vergonha', fakeProvider({ firedTriggers: ['complaint', 'human_requested'] }));
  assert.equal(w.handoffs.length, 1);
  assert.equal(w.handoffs[0]!.triggerId, 'global:complaint');
  assert.equal(w.handoffs[0]!.priority, 'urgent');
});

test('modo ai_suggest (rascunho): anota os gatilhos mas não cria handoff nem bloqueia', async () => {
  const { w, send } = harness({ aiMode: 'ai_suggest' });
  const out = await send('Isto é uma vergonha', fakeProvider({ firedTriggers: ['complaint'] }));
  assert.equal(out.mode, 'draft');
  assert.ok(out.fired.includes('complaint'));
  assert.equal(out.handoffId, null);
  assert.equal(out.lockedAi, false);
  assert.equal(w.handoffs.length, 0);
  assert.equal(w.state.aiMode, 'ai_suggest');
});

test('chat de teste: sem handoff, lacunas nem notificações, mas com registo marcado como teste', async () => {
  const { w, send } = harness();
  const out = await send(
    'Isto é uma vergonha',
    fakeProvider({ firedTriggers: ['complaint'], answered: false }),
    { isTest: true },
  );
  assert.ok(out.fired.includes('complaint'));
  assert.equal(w.handoffs.length, 0);
  assert.equal(w.gaps.length, 0);
  assert.equal(w.notifications.length, 0);
  assert.equal(out.lockedAi, false);
  assert.equal(w.traces[0]!.isTest, true);
});

test('códigos de gatilho desconhecidos ou de outra linha são ignorados', async () => {
  const { w, send } = harness({ line: 'telecom' });
  const out = await send('olá', fakeProvider({ firedTriggers: ['nao_existe', 'quote_visit'] }));
  assert.deepEqual(out.fired, []);
  assert.equal(w.handoffs.length, 0);
});

test('se o resumo da IA falhar, o handoff usa um resumo local', async () => {
  const { w, send } = harness();
  const provider = fakeProvider({ firedTriggers: ['complaint'] });
  provider.summarizeForHandoff = async () => {
    throw new Error('sem resumo');
  };
  await send('Isto é uma vergonha', provider);
  assert.ok(w.handoffs[0]!.summary.startsWith('Resumo automático indisponível'));
});
