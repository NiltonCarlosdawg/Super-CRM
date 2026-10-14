// Contrato do AIProvider — CRM MilVendas
// Só tipos, sem lógica. Duas fronteiras:
//   1. AIProvider: o modelo (Anthropic, vLLM, modelo afinado...). Troca-se sem tocar no CRM.
//   2. Ports: o acesso a dados e notificações. Implementam-se com Drizzle, Redis, Socket.IO.
// Os códigos de gatilho são dados (handoff_triggers.code), por isso são `string`.

export type LineSlug = 'software' | 'custom' | 'telecom' | 'cctv';
export type TriggerCode = string;
export type Priority = 'urgent' | 'high' | 'normal';
export type TriggerAction = 'handoff_now' | 'handoff_when_qualified' | 'flag_only';
export type AiMode = 'ai_active' | 'ai_suggest' | 'human_only';
export type Turn = { from: 'customer' | 'ai'; text: string };

// ───────────── Dados que a IA recebe ─────────────

export interface TriggerDef {
  id: string;
  code: TriggerCode;
  lineSlug: LineSlug | null; // null = global
  description: string;
  detectionHint: string;
  action: TriggerAction;
  priority: Priority;
}

export interface RetrievedChunk {
  id: string;
  source: 'doc' | 'catalog';
  sourceId: string;
  content: string;
  similarity: number;
  version: number;
}

export interface CatalogFact {
  id: string;
  name: string;
  summary: string;
  pricingMode: 'fixed' | 'from' | 'quote_only';
  priceAmount: string | null;
  currency: string;
  availability: 'available' | 'limited' | 'unavailable';
  version: number;
}

export interface RuleDef {
  id: string;
  kind: string;
  title: string;
  instruction: string;
  params: Record<string, unknown> | null;
}

export interface QualificationQuestion {
  key: string;
  question: string;
  required: boolean;
  position: number;
}

export interface SourceRef {
  type: 'chunk' | 'catalog' | 'rule';
  id: string;
  version?: number;
  score?: number;
}

// ───────────── AIProvider ─────────────

export interface AIRequest {
  conversationId: string;
  line: LineSlug | null;
  /** Histórico recente. O último turno é sempre do cliente. */
  turns: readonly Turn[];
  /** Pedaços já filtrados: só itens publicados e válidos. */
  chunks: readonly RetrievedChunk[];
  rules: readonly RuleDef[];
  qualification: {
    questions: readonly QualificationQuestion[];
    answers: Readonly<Record<string, string>>;
  };
  /** Gatilhos ativos desta linha, já com os globais. */
  triggers: readonly TriggerDef[];
  /** Ferramenta: preços e disponibilidade vêm daqui, nunca de texto solto. */
  lookupCatalog(query: string): Promise<CatalogFact[]>;
  /** 'draft': um humano aprova antes de enviar. */
  mode: 'send' | 'draft';
}

export interface AIResponse {
  /** Texto para o cliente. Pode ser null se não houver nada a dizer. */
  reply: string | null;
  /** false = não havia fonte fiável (gera uma lacuna de conhecimento). */
  answered: boolean;
  /** Gatilhos reconhecidos nesta mensagem, pelos códigos de `triggers`. */
  firedTriggers: TriggerCode[];
  /** Respostas de qualificação extraídas da conversa (key -> valor). */
  qualificationUpdates: Record<string, string>;
  /** Fontes realmente usadas na resposta. */
  sources: SourceRef[];
  model: string;
  latencyMs?: number;
}

/**
 * Regras que toda a implementação deve cumprir (verificáveis com os cenários de teste):
 *  - Nunca inventar preço, prazo, cobertura ou disponibilidade: usar `lookupCatalog` e `chunks`.
 *    Sem fonte: `answered = false`.
 *  - Nunca dar preço ou prazo de trabalho personalizado, nem conceder desconto acima da regra.
 *  - Nunca fingir ser humano.
 *  - Gatilhos `handoff_when_qualified` só se disparam se o cliente insistir antes de a
 *    qualificação estar completa. A conclusão da qualificação é detetada pelo orquestrador.
 */
export interface AIProvider {
  respond(req: AIRequest, signal?: AbortSignal): Promise<AIResponse>;
  summarizeForHandoff(
    input: {
      turns: readonly Turn[];
      qualification: Readonly<Record<string, string>>;
      reason: string;
    },
    signal?: AbortSignal,
  ): Promise<string>;
}

// ───────────── Ports (dados e notificações) ─────────────

export interface ConversationState {
  id: string;
  line: LineSlug | null;
  aiMode: AiMode;
  /** Mensagens guardadas até esta, INCLUINDO a mensagem de entrada atual. */
  turns: Turn[];
  answers: Record<string, string>;
  /** Respostas seguidas sem fonte (zera quando a IA responde com fonte). */
  missStreak: number;
}

export interface NewHandoff {
  conversationId: string;
  triggerId: string | null;
  reason: string;
  summary: string;
  leadSnapshot: unknown;
  priority: Priority;
}

export interface TraceInput {
  conversationId: string;
  question: string;
  answer: string;
  sources: SourceRef[];
  model: string;
  handoffId: string | null;
  latencyMs: number | null;
  isTest: boolean;
}

export interface Ports {
  /** Idempotência: false se esta mensagem já foi processada (retry de webhook). */
  claimMessage(messageId: string): Promise<boolean>;
  loadState(conversationId: string): Promise<ConversationState>;
  saveState(
    conversationId: string,
    patch: { aiMode?: AiMode; answers?: Record<string, string>; missStreak?: number },
  ): Promise<void>;

  // Conhecimento (knowledge_chunks, catalog_items, rules, qualification_questions, handoff_triggers)
  retrieve(query: string, line: LineSlug | null): Promise<RetrievedChunk[]>;
  lookupCatalog(query: string, line: LineSlug | null): Promise<CatalogFact[]>;
  rules(line: LineSlug | null): Promise<RuleDef[]>;
  questions(line: LineSlug | null): Promise<QualificationQuestion[]>;
  /** Globais + da linha, só ativos. */
  triggers(line: LineSlug | null): Promise<TriggerDef[]>;

  // Handoff (handoffs)
  findOpenHandoff(conversationId: string): Promise<{ id: string; priority: Priority } | null>;
  createHandoff(h: NewHandoff): Promise<string>;
  bumpHandoffPriority(handoffId: string, priority: Priority): Promise<void>;

  // Melhoria contínua (knowledge_gaps, answer_traces)
  recordGap(g: { question: string; conversationId: string; line: LineSlug | null }): Promise<void>;
  saveTrace(t: TraceInput): Promise<void>;

  /** Notificação ao painel (ex.: Socket.IO). */
  notify(e: {
    type: 'handoff' | 'flag';
    handoffId: string;
    conversationId: string;
    priority: Priority;
    reason: string;
  }): Promise<void>;
}
