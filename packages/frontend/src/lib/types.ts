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
