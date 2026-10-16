// Port de leitura de conversas e mensagens (docs/01 §6, docs/02 §5): Views
// exactas do painel + paginação por cursor opaco. A ESCRITA de mensagens não
// vive aqui: sai pela outbox (ports/outbox.ts) via application/messaging.ts.

import type { AiMode } from './ai-provider.js';
import type { TenantScope } from './tenancy.js';

export interface ConversationView {
  id: string;
  accountId: string;
  contactId: string;
  contactPhone: string;
  leadId: string | null;
  line: string | null; // lineId (FK → business_lines); nulo até identificar a linha
  aiMode: AiMode;
  missStreak: number;
  lastMessageAt: Date | null;
  createdAt: Date;
}

export interface MessageView {
  id: string;
  conversationId: string;
  direction: 'inbound' | 'outbound';
  sender: 'customer' | 'ai' | 'human' | 'campaign';
  kind: string;
  body: string; // nulo na BD (mídia sem legenda) → '' na View
  status: 'queued' | 'sent' | 'delivered' | 'read' | 'failed';
  mediaRef: string | null;
  createdAt: Date;
}

export interface ConversationsRepository {
  /** Onda 1 (Task 4): toda a leitura opera SOB um TenantScope (spec §4.3) —
   *  `get`/`listMessages` de recurso alheio devolvem null/vazio (cross-tenant
   *  esconde a existência; nunca 403). */
  list(scope: TenantScope, input: {
    accountId?: string;
    cursor?: string;
    limit: number;
  }): Promise<{ items: ConversationView[]; nextCursor: string | null }>;
  get(scope: TenantScope, id: string): Promise<{ conversation: ConversationView; lastMessage: MessageView | null } | null>;
  listMessages(scope: TenantScope, input: {
    conversationId: string;
    cursor?: string;
    limit: number;
  }): Promise<{ items: MessageView[]; nextCursor: string | null }>;
  getMessageByOutbox(scope: TenantScope, outboxId: string): Promise<MessageView | null>;
}
