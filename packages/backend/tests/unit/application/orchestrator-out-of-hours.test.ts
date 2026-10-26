// Fase 3, Task 13: ramo "fora de horário" do orquestrador (ADR-0003 A6).
// Fora de horas: o handoff entra na fila sem mudar o ai_mode da conversa (a IA
// continua a responder) e o cliente recebe a mensagem fixa configurável. Um
// urgente gera ainda um alerta imediato. Em horário útil nada disto muda.

import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AIProvider,
  AIRequest,
  AIResponse,
  ConversationState,
  NewHandoff,
  Ports,
  QualificationQuestion,
  TriggerDef,
} from '../../../src/ports/ai-provider.js';
import { triggerSeeds } from '../../../src/modules/knowledge/handoff-triggers.seed.js';
import { DEFAULT_CONFIG, handleInbound, type OrchestratorConfig } from '../../../src/application/orchestrator.js';

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

type Notice = {
  type: string;
  reason?: string;
  outsideHours?: boolean;
  opensAt?: string;
};

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
    notifications: [] as Notice[],
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
    lookupCatalog: async () => [],
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
    recordGap: async () => {},
    saveTrace: async () => {},
    notify: async (e) => void w.notifications.push(e),
  };

  let n = 0;
  const send = (
    text: string,
    provider: AIProvider,
    opts: { id?: string; cfg?: Partial<OrchestratorConfig> } = {},
  ) => {
    w.state.turns.push({ from: 'customer', text });
    return handleInbound(
      ports,
      provider,
      { id: opts.id ?? `m${++n}`, conversationId: w.state.id, text },
      opts.cfg,
    );
  };
  return { w, send };
}

function fakeProvider(make: Partial<AIResponse> | ((req: AIRequest) => Partial<AIResponse>) = {}) {
  const provider: AIProvider = {
    async respond(req) {
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
    async extractKnowledge() {
      return { items: [] };
    },
  };
  return provider;
}

const CLOSED_CFG: Partial<OrchestratorConfig> = {
  isOpen: () => false,
  now: () => new Date('2026-10-07T22:00:00Z'),
  nextOpening: () => new Date('2026-10-08T07:00:00Z'),
};

test('fora de horas: handoff na fila, conversa NÃO muda de ai_mode, mensagem fixa configurável', async () => {
  const { w, send } = harness();
  const out = await send('Isto é uma vergonha', fakeProvider({ firedTriggers: ['complaint'] }), {
    cfg: CLOSED_CFG,
  });
  assert.equal(out.lockedAi, false);
  assert.equal(w.state.aiMode, 'ai_active');
  assert.equal(
    out.reply,
    'Registei o teu pedido — a equipa responde no próximo dia útil. Entretanto posso ajudar com outras perguntas.',
  );
  assert.equal(w.handoffs.length, 1);
  assert.equal(w.notifications[0]!.outsideHours, true);
  assert.equal(w.notifications[0]!.opensAt, '2026-10-08T07:00:00.000Z');
});

test('fora de horas, urgente: alerta imediato extra', async () => {
  const { w, send } = harness();
  await send('Isto é uma vergonha', fakeProvider({ firedTriggers: ['complaint'] }), {
    cfg: CLOSED_CFG,
  });
  assert.deepEqual(
    w.notifications.map((n) => n.type),
    ['handoff', 'alert'],
  );
  assert.equal(w.notifications[1]!.reason, 'urgent_out_of_hours');
});

test('fora de horas, gatilho não urgente: só o handoff, sem alerta', async () => {
  const { w, send } = harness();
  await send('Prefiro falar com uma pessoa, não com robô', fakeProvider({ firedTriggers: ['human_requested'] }), {
    cfg: CLOSED_CFG,
  });
  assert.equal(w.handoffs.length, 1);
  // 'human_requested' é 'high', não 'urgent' → sem alerta
  assert.deepEqual(
    w.notifications.map((n) => n.type),
    ['handoff'],
  );
});

test('fora de horas, 2.ª mensagem com gatilho: não duplica e sobe a prioridade', async () => {
  const { w, send } = harness();
  await send('Prefiro falar com uma pessoa', fakeProvider({ firedTriggers: ['human_requested'] }), {
    cfg: CLOSED_CFG,
  });
  await send('Isto é uma vergonha', fakeProvider({ firedTriggers: ['complaint'] }), { cfg: CLOSED_CFG });
  // Continua a ser o MESMO handoff, agora urgent (bump)
  assert.equal(w.handoffs.length, 1);
  assert.equal(w.handoffs[0]!.priority, 'urgent');
  // criação (high) + atualização (urgent) + alerta de urgente fora de horas
  assert.deepEqual(
    w.notifications.map((n) => n.type),
    ['handoff', 'handoff', 'alert'],
  );
  assert.ok(w.notifications.every((n) => n.outsideHours === true));
});

test('fora de horas em ai_suggest: sem handoff (efeitos desligados)', async () => {
  const { w, send } = harness({ aiMode: 'ai_suggest' });
  const out = await send('Isto é uma vergonha', fakeProvider({ firedTriggers: ['complaint'] }), {
    cfg: CLOSED_CFG,
  });
  assert.equal(out.mode, 'draft');
  assert.equal(out.handoffId, null);
  assert.equal(w.handoffs.length, 0);
  assert.equal(w.notifications.length, 0);
  assert.equal(w.state.aiMode, 'ai_suggest');
});

test('em horário útil: comportamento de docs/05 §3 inalterado', async () => {
  const { w, send } = harness();
  const out = await send('Isto é uma vergonha', fakeProvider({ firedTriggers: ['complaint'] }), {
    cfg: { isOpen: () => true, now: () => new Date('2026-10-07T09:00:00Z') },
  });
  assert.equal(out.lockedAi, true);
  assert.equal(w.state.aiMode, 'human_only');
  assert.equal(
    out.reply,
    DEFAULT_CONFIG.handoffMessage(ALL_TRIGGERS.find((t) => t.code === 'complaint')!),
  );
  assert.equal(w.notifications[0]!.outsideHours, undefined);
});
