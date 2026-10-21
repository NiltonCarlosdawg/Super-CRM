// Fase 3, Task 17/18: repositório de rascunhos (`ai_drafts`, schema da Task 2).
// Cria um rascunho PENDENTE associado à conversa; o tenant vem da própria
// conversa (`ai_drafts.tenant_id` é NOT NULL — Onda 1).

import { eq } from 'drizzle-orm';

import type { TriggerCode } from '../../ports/ai-provider.js';
import { aiDrafts } from '../../modules/drafts/drafts.schema.js';
import type { DbClient } from './index.js';
import { conversations } from './schema/conversations.schema.js';

export interface DraftRow {
  id: string;
  text: string;
  status: 'pending' | 'approved' | 'edited' | 'rejected' | 'expired';
  firedTriggers: unknown;
}

export interface DraftsRepository {
  create(input: {
    conversationId: string;
    text: string;
    firedTriggers: TriggerCode[];
  }): Promise<string>;
  listByConversation(conversationId: string): Promise<DraftRow[]>;
}

export function createDraftsRepository(db: DbClient): DraftsRepository {
  return {
    async create({ conversationId, text, firedTriggers }) {
      const [conv] = await db
        .select({ tenantId: conversations.tenantId })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);
      if (conv === undefined) throw new Error('conversa inexistente ao criar rascunho');

      const [row] = await db
        .insert(aiDrafts)
        .values({
          tenantId: conv.tenantId,
          conversationId,
          text,
          firedTriggers,
          status: 'pending',
        })
        .returning({ id: aiDrafts.id });
      return row!.id;
    },

    async listByConversation(conversationId) {
      return db
        .select({
          id: aiDrafts.id,
          text: aiDrafts.text,
          status: aiDrafts.status,
          firedTriggers: aiDrafts.firedTriggers,
        })
        .from(aiDrafts)
        .where(eq(aiDrafts.conversationId, conversationId));
    },
  };
}
