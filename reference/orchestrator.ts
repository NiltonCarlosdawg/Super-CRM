// Orquestrador — CRM MilVendas
// Decide o que acontece a cada mensagem de entrada. A IA só classifica e responde:
// quem decide handoff, bloqueio, lacunas e registo é este código, de forma determinística.

import { keywordSafetyNet } from './keyword-safety-net';
import type {
  AIProvider,
  AIRequest,
  AIResponse,
  ConversationState,
  LineSlug,
  Ports,
  Priority,
  TriggerCode,
  TriggerDef,
  Turn,
} from './ai-provider';

export interface InboundMessage {
  id: string;
  conversationId: string;
  text: string;
  /** Chat de teste da aba de conhecimento: sem handoff, bloqueio, lacunas nem notificações. */
  isTest?: boolean;
}

export interface Outcome {
  status: 'duplicate' | 'human_only' | 'ok' | 'provider_error';
  /** Texto a enviar (mode 'send') ou a propor a um humano (mode 'draft'). */
  reply: string | null;
  mode: 'send' | 'draft';
  fired: TriggerCode[];
  handoffId: string | null;
  lockedAi: boolean;
  gapRecorded: boolean;
}

export interface OrchestratorConfig {
  /** Respostas seguidas sem fonte que disparam low_confidence. */
  missStreakLimit: number;
  providerTimeoutMs: number;
  /** Rede de segurança determinística; corre antes do modelo. */
  safetyNet: (turns: readonly Turn[]) => TriggerCode[];
  /** Mensagem fixa ao passar a um humano (não promete prazos). */
  handoffMessage: (primary: TriggerDef) => string;
  errorHandoffMessage: string;
  noSourceMessage: string;
}

export const DEFAULT_CONFIG: OrchestratorConfig = {
  missStreakLimit: 2,
  providerTimeoutMs: 20_000,
  safetyNet: keywordSafetyNet,
  handoffMessage: () =>
    'Vou passar esta conversa a um colega da equipa, que continua consigo. Sou um assistente virtual.',
  errorHandoffMessage:
    'Neste momento não consigo continuar a ajudá-lo. Vou passar a conversa a um colega da equipa.',
  noSourceMessage: 'Não tenho essa informação neste momento. Vou pedir à equipa que a confirme.',
};

const RANK: Record<Priority, number> = { urgent: 3, high: 2, normal: 1 };

function pickPrimary(ts: readonly TriggerDef[]): TriggerDef {
  const weight = (t: TriggerDef) => (t.action === 'flag_only' ? 0 : 1);
  return [...ts].sort(
    (a, b) =>
      RANK[b.priority] - RANK[a.priority] ||
      Number(b.lineSlug !== null) - Number(a.lineSlug !== null) ||
      weight(b) - weight(a),
  )[0];
}

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new Error(`timeout após ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([fn(ac.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const fallbackSummary = (turns: readonly Turn[]): string =>
  'Resumo automático indisponível. Últimas mensagens:\n' +
  turns
    .slice(-4)
    .map((t) => `${t.from === 'customer' ? 'Cliente' : 'IA'}: ${t.text}`)
    .join('\n');

const isComplete = (
  questions: readonly { key: string; required: boolean }[],
  answers: Readonly<Record<string, string>>,
): boolean => {
  const required = questions.filter((q) => q.required);
  return required.length > 0 && required.every((q) => (answers[q.key] ?? '').trim() !== '');
};

const empty = (status: Outcome['status'], mode: Outcome['mode'] = 'send'): Outcome => ({
  status,
  reply: null,
  mode,
  fired: [],
  handoffId: null,
  lockedAi: false,
  gapRecorded: false,
});

export async function handleInbound(
  p: Ports,
  provider: AIProvider,
  msg: InboundMessage,
  cfg: Partial<OrchestratorConfig> = {},
): Promise<Outcome> {
  const c: OrchestratorConfig = { ...DEFAULT_CONFIG, ...cfg };

  if (!(await p.claimMessage(msg.id))) return empty('duplicate');

  const state: ConversationState = await p.loadState(msg.conversationId);
  if (state.aiMode === 'human_only') return empty('human_only');

  const mode: Outcome['mode'] = state.aiMode === 'ai_suggest' ? 'draft' : 'send';
  const canAct = mode === 'send' && !msg.isTest; // handoff, bloqueio e notificações
  const line: LineSlug | null = state.line;

  const [triggers, rules, questions, chunks] = await Promise.all([
    p.triggers(line),
    p.rules(line),
    p.questions(line),
    p.retrieve(msg.text, line),
  ]);

  // Por código: o gatilho da linha prevalece sobre o global.
  const byCode = new Map<TriggerCode, TriggerDef>();
  for (const t of triggers.filter((x) => x.lineSlug === null)) byCode.set(t.code, t);
  for (const t of triggers.filter((x) => x.lineSlug !== null)) byCode.set(t.code, t);

  const request: AIRequest = {
    conversationId: msg.conversationId,
    line,
    turns: state.turns,
    chunks,
    rules,
    qualification: { questions, answers: state.answers },
    triggers: [...byCode.values()],
    lookupCatalog: (query) => p.lookupCatalog(query, line),
    mode,
  };

  let response: AIResponse;
  try {
    response = await withTimeout((signal) => provider.respond(request, signal), c.providerTimeoutMs);
  } catch (err) {
    return failSafe(p, msg, state, mode, canAct, c, err);
  }

  // Qualificação
  const answers = { ...state.answers, ...response.qualificationUpdates };
  const wasComplete = isComplete(questions, state.answers);
  const nowComplete = isComplete(questions, answers);

  // Lacunas e falhas seguidas
  const missStreak = response.answered ? 0 : state.missStreak + 1;
  let gapRecorded = false;
  if (!response.answered && !msg.isTest) {
    await p.recordGap({ question: msg.text, conversationId: msg.conversationId, line });
    gapRecorded = true;
  }

  // Gatilhos: rede de segurança + modelo + regras determinísticas do sistema
  const fired = new Set<TriggerCode>(c.safetyNet(state.turns));
  for (const code of response.firedTriggers) fired.add(code);
  if (missStreak >= c.missStreakLimit) fired.add('low_confidence');
  if (nowComplete && !wasComplete) {
    for (const t of byCode.values()) {
      if (t.action === 'handoff_when_qualified' && t.lineSlug === line) fired.add(t.code);
    }
  }
  const active = [...fired].map((code) => byCode.get(code)).filter((t): t is TriggerDef => !!t);

  let handoffId: string | null = null;
  let lockedAi = false;
  let reply = response.reply?.trim() || null;

  if (active.length > 0 && canAct) {
    const primary = pickPrimary(active);
    const mustLock = active.some((t) => t.action !== 'flag_only');
    const open = await p.findOpenHandoff(msg.conversationId);
    let notify = false;

    if (open) {
      handoffId = open.id;
      if (RANK[primary.priority] > RANK[open.priority]) {
        await p.bumpHandoffPriority(open.id, primary.priority);
        notify = true;
      }
    } else {
      let summary: string;
      try {
        summary = await withTimeout(
          (signal) =>
            provider.summarizeForHandoff(
              { turns: state.turns, qualification: answers, reason: primary.description },
              signal,
            ),
          c.providerTimeoutMs,
        );
      } catch {
        summary = fallbackSummary(state.turns);
      }
      handoffId = await p.createHandoff({
        conversationId: msg.conversationId,
        triggerId: primary.id,
        reason: primary.description,
        summary,
        leadSnapshot: {
          line,
          answers,
          fired: active.map((t) => t.code),
          missing: questions.filter((q) => q.required && !(answers[q.key] ?? '').trim()).map((q) => q.key),
        },
        priority: primary.priority,
      });
      notify = true;
    }

    if (notify && handoffId) {
      await p.notify({
        type: mustLock ? 'handoff' : 'flag',
        handoffId,
        conversationId: msg.conversationId,
        priority: primary.priority,
        reason: primary.description,
      });
    }
    if (mustLock) {
      lockedAi = true;
      reply = c.handoffMessage(primary); // mensagem fixa: a IA não promete nada ao passar
    }
  }

  if (!response.answered && !lockedAi && !reply) reply = c.noSourceMessage;

  await p.saveState(msg.conversationId, {
    answers,
    missStreak: lockedAi ? 0 : missStreak,
    ...(lockedAi ? { aiMode: 'human_only' as const } : {}),
  });

  await p.saveTrace({
    conversationId: msg.conversationId,
    question: msg.text,
    answer: reply ?? '',
    sources: response.sources,
    model: response.model,
    handoffId,
    latencyMs: response.latencyMs ?? null,
    isTest: !!msg.isTest,
  });

  return {
    status: 'ok',
    reply,
    mode,
    fired: active.map((t) => t.code),
    handoffId,
    lockedAi,
    gapRecorded,
  };
}

// Se o fornecedor de IA falha ou excede o tempo, o cliente não fica sem resposta:
// passa a um humano com uma mensagem fixa.
async function failSafe(
  p: Ports,
  msg: InboundMessage,
  state: ConversationState,
  mode: Outcome['mode'],
  canAct: boolean,
  c: OrchestratorConfig,
  err: unknown,
): Promise<Outcome> {
  const reason = `Falha do fornecedor de IA: ${err instanceof Error ? err.message : String(err)}`;
  let handoffId: string | null = null;
  let lockedAi = false;

  if (canAct) {
    const open = await p.findOpenHandoff(msg.conversationId);
    if (open) {
      handoffId = open.id;
    } else {
      handoffId = await p.createHandoff({
        conversationId: msg.conversationId,
        triggerId: null,
        reason,
        summary: fallbackSummary(state.turns),
        leadSnapshot: { line: state.line, answers: state.answers, fired: [], missing: [] },
        priority: 'high',
      });
      await p.notify({
        type: 'handoff',
        handoffId,
        conversationId: msg.conversationId,
        priority: 'high',
        reason,
      });
    }
    await p.saveState(msg.conversationId, { aiMode: 'human_only' });
    lockedAi = true;
  }

  await p.saveTrace({
    conversationId: msg.conversationId,
    question: msg.text,
    answer: canAct ? c.errorHandoffMessage : '',
    sources: [],
    model: 'unavailable',
    handoffId,
    latencyMs: null,
    isTest: !!msg.isTest,
  });

  return {
    status: 'provider_error',
    reply: canAct ? c.errorHandoffMessage : null,
    mode,
    fired: [],
    handoffId,
    lockedAi,
    gapRecorded: false,
  };
}
