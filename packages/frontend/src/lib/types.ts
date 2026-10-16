// Tipos do contrato API do backend — escritos à mão a partir do código real
// (packages/backend/src/ports/* e adapters/http/routes/*). Datas vêm como
// string ISO no JSON.

export type Role = "admin" | "editor" | "agent";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
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
