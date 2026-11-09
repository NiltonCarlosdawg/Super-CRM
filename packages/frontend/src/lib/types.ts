// Tipos do contrato API do backend — escritos à mão a partir do código real
// (packages/backend/src/ports/* e adapters/http/routes/*). Datas vêm como
// string ISO no JSON.

export type Role = "admin" | "editor" | "agent" | "platform_admin";

// Onda 1 (Tasks 3/10): o /me devolve scope — a plataforma (platform_admin)
// administra tenants; o backend distingue por `role === 'platform_admin'`
// (guards.ts:60 do backend — a linha users é a autoridade por pedido).
export type Scope = "tenant" | "platform";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  scope: Scope;
}

// POST /v1/auth/register (Onda 1, Task 6, spec §5.1): sem `role` no corpo — o
// servidor fixa 'admin' (o registo cria a primeira conta da empresa).
export interface RegisterInput {
  tenantName: string;
  name: string;
  email: string;
  password: string;
}

// Resumo de utilizador devolvido por GET/POST/PATCH /v1/users (backend:
// adapters/db/users.ts:11-17 — nunca inclui passwordHash).
export interface UserSummary {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
}

/** Docs/04 §6 — estados guardados em whatsapp_accounts.status. */
export type AccountStatus = "connecting" | "connected" | "disconnected" | "suspected_ban";

export type AccountPurpose = "support" | "sales" | "campaigns";

export interface AccountRow {
  id: string;
  label: string;
  phoneE164: string | null;
  providerSessionId: string;
  status: AccountStatus;
  purpose: AccountPurpose;
}

export type AiMode = "ai_active" | "ai_suggest" | "human_only";

export interface ConversationView {
  id: string;
  accountId: string;
  contactId: string;
  contactPhone: string;
  leadId: string | null;
  line: string | null;
  aiMode: AiMode;
  missStreak: number;
  lastMessageAt: string | null;
  createdAt: string;
}

export type MessageStatus = "queued" | "sent" | "delivered" | "read" | "failed";
export type MessageDirection = "inbound" | "outbound";
export type MessageSender = "customer" | "ai" | "human" | "campaign";

export interface MessageView {
  id: string;
  conversationId: string;
  direction: MessageDirection;
  sender: MessageSender;
  kind: string;
  body: string;
  status: MessageStatus;
  mediaRef: string | null;
  createdAt: string;
}

// Envelope real de GET /v1/conversations (rota conversations.ts:36 do backend
// devolve {conversations, nextCursor} — o nome da chave NÃO é genérico).
export interface ConversationsList {
  conversations: ConversationView[];
  nextCursor: string | null;
}

// Envelopes reais das rotas de detalhe/mensagens (conversations.ts:43 e :50).
export interface ConversationDetail {
  conversation: ConversationView;
  lastMessage: MessageView | null;
}

// Mensagens vêm em ordem DESC (mais recente primeiro; conversations.ts:41-50) e
// o nextCursor aponta para as ANTIGORES — inverter para exibir cronológicamente.
export interface MessagesList {
  messages: MessageView[];
  nextCursor: string | null;
}

// POST /v1/conversations/:id/messages (conversations.ts:53-72): 201 com a
// mensagem criada, ou 200 com replayed=true (mesma Idempotency-Key + mesmo
// corpo); 409 idempotency_conflict quando a chave volta com corpo diferente.
export interface SendMessageResponse {
  message: MessageView;
  replayed: boolean;
}

// --- Plataforma (Onda 1, Tasks 7/10) ---

export type TenantStatus = "active" | "suspended";

// GET /v1/platform/tenants devolve um ARRAY directo (routes/platform.ts:81-83,
// ruling R23 — literal do brief, ao contrário das outras listagens envelopadas).
export interface TenantListItem {
  id: string;
  name: string;
  status: TenantStatus;
  usersCount: number;
  accountsCount: number;
  createdAt: string;
}

// --- Campanhas (Fase 4) ---

export type CampaignStatus =
  | "draft"
  | "scheduled"
  | "running"
  | "paused"
  | "completed"
  | "cancelled";

export type CampaignPauseReason = "failure_rate" | "session_down" | "opt_out_spike" | "human";

/** JSON de GET /v1/campaigns/:id (datas ISO; `allowedAccountIds` vem da junção). */
export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  messageTemplate: string;
  allowedAccountIds: string[];
  dailyLimit: number | null;
  scheduledAt: string | null;
  pauseReason: CampaignPauseReason | null;
  pausedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignCounts {
  pending: number;
  sent: number;
  failed: number;
  replied: number;
  optedOut: number;
}

export interface CampaignList {
  items: Campaign[];
  nextCursor: string | null;
}

export interface CampaignDetail {
  campaign: Campaign;
  counts: CampaignCounts;
}

// --- Handoffs (Fase 3) ---

export type HandoffStatus = "pending" | "accepted" | "resolved" | "dismissed";

/** Linha de GET /v1/handoffs (datas ISO; resumo e motivo vêm da IA). */
export interface HandoffRow {
  id: string;
  conversationId: string;
  status: HandoffStatus;
  priority: "urgent" | "high" | "normal";
  createdAt: string;
  openingAlertedAt: string | null;
  slaAlertedAt: string | null;
  summary: string;
  reason: string;
  leadSnapshot: unknown;
}

export interface HandoffList {
  handoffs: HandoffRow[];
}

// --- Rascunhos da IA (Fase 3) ---

export type DraftStatus = "pending" | "approved" | "rejected";

export interface Draft {
  id: string;
  conversationId: string;
  text: string;
  status: DraftStatus;
  firedTriggers: unknown;
  outboxId: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedReason: string | null;
  createdAt: string;
}

export interface DraftsList {
  drafts: Draft[];
}

// --- Conhecimento e treino (Fases 2–4) ---

export type BusinessLineSlug = "software" | "custom" | "telecom" | "cctv";
export type DraftEntityType = "catalog_item" | "knowledge_doc" | "rule";
export type DraftOp = "create" | "update" | "delete";
export type DocType = "faq" | "policy" | "process" | "company_info" | "objection";

/** Linha de GET /v1/knowledge/train/draft (payload é validado no servidor). */
export interface DraftItem {
  id: string;
  slug: string;
  entityType: DraftEntityType;
  op: DraftOp;
  lineSlug: string | null;
  lineConfirmed: boolean;
  payload: Record<string, unknown>;
  chunks: unknown;
  baseVersion: number | null;
  changedById: string;
  createdAt: string;
  updatedAt: string;
}

export type DiffClassification = "added" | "updated" | "unchanged" | "conflict" | "archived";

export interface DiffEntry {
  slug: string;
  entityType: DraftEntityType;
  op: DraftOp;
  classification: DiffClassification;
  baseVersion: number | null;
  currentVersion: number | null;
}

export interface DraftDiff {
  entries: DiffEntry[];
  unconfirmedSlugs: string[];
  digest: string;
}

export interface ValidateResult {
  publicationId: string;
  applied: { added: number; updated: number; archived: number };
  idempotent: boolean;
}

export interface PublishedItem {
  id: string;
  entityType: DraftEntityType;
  slug: string;
  name: string | null;
  title: string | null;
  version: number;
  updatedAt: string;
}

export interface Publication {
  id: string;
  kind: string;
  createdAt: string;
  createdById: string;
  applied: unknown;
}

export interface ReviewItem {
  entityType: DraftEntityType;
  id: string;
  slug: string;
  title: string;
  lineSlug: string | null;
  reviewedAt: string | null;
  reviewEveryDays: number;
  daysOverdue: number;
  validUntil: string | null;
}

export interface KnowledgeGap {
  id: string;
  question: string;
  occurrences: number;
  conversationId: string | null;
  status: "open" | "resolved" | "ignored";
  createdAt: string;
  lastSeenAt: string;
}

export interface KnowledgeSuggestion {
  id: string;
  gapId: string | null;
  aiAnswer: string | null;
  humanAnswer: string;
  proposedTitle: string;
  proposedBody: string;
  proposedLineSlug: string | null;
  proposedDocType: DocType | null;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
}

export type AnswerType = "text" | "number" | "choice";

export interface QualificationQuestion {
  id: string;
  lineId: string;
  key: string;
  question: string;
  answerType: AnswerType;
  choices: unknown;
  required: boolean;
  position: number;
  active: boolean;
  version: number;
}

export type HandoffAction = "handoff_now" | "handoff_when_qualified" | "flag_only";

export interface HandoffTrigger {
  id: string;
  lineId: string | null;
  code: string;
  description: string;
  detectionHint: string;
  action: HandoffAction;
  priority: "normal" | "high" | "urgent";
  active: boolean;
  version: number;
}

export type ConfigEntityType = "qualification_question" | "handoff_trigger";

export interface ConfigRevision {
  id: string;
  entityType: ConfigEntityType;
  entityId: string;
  version: number;
  snapshot: Record<string, unknown>;
  changedById: string;
  note: string | null;
  createdAt: string;
}

export interface ChatSource {
  type: "chunk" | "catalog" | "rule";
  id: string;
  version?: number;
  score?: number;
}

export interface ChatTestResult {
  reply: string | null;
  sources: ChatSource[];
}
