// API de lacunas e sugestões explícitas (Fase 2, Task 6).
import { and, desc, eq } from 'drizzle-orm';
import { HttpError } from '../../adapters/http/errors.js';
import {
  knowledgeGaps,
  knowledgeSuggestions,
} from './knowledge.schema.js';
import { conversations } from '../../adapters/db/schema/conversations.schema.js';
import { messages } from '../../adapters/db/schema/messages.schema.js';
import { createSuggestionDraft } from './config-service.js';
import type { TrainDeps } from './train-service.js';

export async function listGaps(deps: TrainDeps, status: 'open' | 'resolved' | 'ignored' = 'open', limit = 50): Promise<unknown[]> {
  return deps.db.select().from(knowledgeGaps).where(and(eq(knowledgeGaps.tenantId, deps.scope.tenantId), eq(knowledgeGaps.status, status))).orderBy(desc(knowledgeGaps.occurrences), desc(knowledgeGaps.lastSeenAt)).limit(limit);
}

export async function createGap(deps: TrainDeps, input: { question: string; lineSlug?: string | null }, actorId: string): Promise<unknown> {
  const [row] = await deps.db.insert(knowledgeGaps).values({ tenantId: deps.scope.tenantId, question: input.question, normalizedQuestion: input.question.trim().toLowerCase(), lineId: null, occurrences: 1, createdAt: deps.now(), lastSeenAt: deps.now(), status: 'open' }).returning();
  if (row === undefined) throw new Error('gap insert');
  await deps.audit.record({ tenantId: deps.scope.tenantId, actorId, action: 'knowledge.gap_created', entity: 'knowledge_gap', entityId: row.id, detail: {}, at: deps.now() });
  return row;
}

export async function decideGap(deps: TrainDeps, id: string, status: 'resolved' | 'ignored', actorId: string): Promise<unknown> {
  const [gap] = await deps.db.select().from(knowledgeGaps).where(and(eq(knowledgeGaps.id, id), eq(knowledgeGaps.tenantId, deps.scope.tenantId)));
  if (gap === undefined) throw new HttpError(404, 'gap_not_found', 'lacuna inexistente');
  if (gap.status === status) return gap;
  const [row] = await deps.db.update(knowledgeGaps).set({ status, resolvedById: actorId, resolvedAt: deps.now() }).where(and(eq(knowledgeGaps.id, id), eq(knowledgeGaps.tenantId, deps.scope.tenantId))).returning();
  if (row === undefined) throw new HttpError(404, 'gap_not_found', 'lacuna inexistente');
  await deps.audit.record({ tenantId: deps.scope.tenantId, actorId, action: `knowledge.gap_${status}`, entity: 'knowledge_gap', entityId: id, detail: {}, at: deps.now() });
  return row;
}

export async function listSuggestions(deps: TrainDeps, status?: 'pending' | 'approved' | 'rejected', limit = 50): Promise<unknown[]> {
  const where = status === undefined
    ? eq(knowledgeSuggestions.tenantId, deps.scope.tenantId)
    : and(eq(knowledgeSuggestions.tenantId, deps.scope.tenantId), eq(knowledgeSuggestions.status, status));
  return deps.db.select().from(knowledgeSuggestions).where(where).orderBy(desc(knowledgeSuggestions.createdAt)).limit(limit);
}

async function validateConversationRefs(
  deps: TrainDeps,
  conversationId: string | null | undefined,
  messageId: string | null | undefined,
): Promise<void> {
  if (conversationId === undefined || conversationId === null) {
    if (messageId !== undefined && messageId !== null) throw new HttpError(404, 'not_found', 'mensagem sem conversa');
    return;
  }
  const [conversation] = await deps.db.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, deps.scope.tenantId))).limit(1);
  if (conversation === undefined) throw new HttpError(404, 'not_found', 'conversa inexistente');
  if (messageId === undefined || messageId === null) return;
  const [message] = await deps.db.select({ id: messages.id }).from(messages).where(and(eq(messages.id, messageId), eq(messages.tenantId, deps.scope.tenantId), eq(messages.conversationId, conversationId))).limit(1);
  if (message === undefined) throw new HttpError(404, 'not_found', 'mensagem inexistente');
}

export async function createSuggestion(deps: TrainDeps, input: { humanAnswer: string; proposedTitle: string; proposedBody: string; aiAnswer?: string; targetDocId?: string | null; proposedLineSlug?: string | null; proposedDocType?: 'faq' | 'policy' | 'process' | 'company_info' | 'objection'; conversationId?: string | null; messageId?: string | null; gapId?: string | null }, actorId: string): Promise<unknown> {
  if (input.gapId !== undefined && input.gapId !== null) {
    const [gap] = await deps.db.select({ id: knowledgeGaps.id }).from(knowledgeGaps).where(and(eq(knowledgeGaps.id, input.gapId), eq(knowledgeGaps.tenantId, deps.scope.tenantId)));
    if (gap === undefined) throw new HttpError(404, 'gap_not_found', 'lacuna inexistente');
  }
  await validateConversationRefs(deps, input.conversationId, input.messageId);
  const [row] = await deps.db.insert(knowledgeSuggestions).values({ tenantId: deps.scope.tenantId, gapId: input.gapId ?? null, aiAnswer: input.aiAnswer ?? null, humanAnswer: input.humanAnswer, proposedTitle: input.proposedTitle, proposedBody: input.proposedBody, targetDocId: input.targetDocId ?? null, createdById: actorId, proposedLineSlug: input.proposedLineSlug ?? null, proposedDocType: input.proposedDocType ?? 'faq', conversationId: input.conversationId ?? null, messageId: input.messageId ?? null }).returning();
  if (row === undefined) throw new Error('suggestion insert');
  return row;
}

export async function decideSuggestion(deps: TrainDeps, id: string, status: 'approved' | 'rejected', actorId: string): Promise<unknown> {
  const [suggestion] = await deps.db.select().from(knowledgeSuggestions).where(and(eq(knowledgeSuggestions.id, id), eq(knowledgeSuggestions.tenantId, deps.scope.tenantId)));
  if (suggestion === undefined) throw new HttpError(404, 'suggestion_not_found', 'sugestão inexistente');
  if (suggestion.status !== 'pending') throw new HttpError(409, 'suggestion_already_decided', 'sugestão já decidida');
  const [row] = await deps.db.update(knowledgeSuggestions).set({ status, reviewedById: actorId, reviewedAt: deps.now() }).where(and(eq(knowledgeSuggestions.id, id), eq(knowledgeSuggestions.tenantId, deps.scope.tenantId), eq(knowledgeSuggestions.status, 'pending'))).returning();
  if (row === undefined) throw new HttpError(409, 'suggestion_already_decided', 'sugestão já decidida');
  if (status === 'approved') {
    const staged = await createSuggestionDraft(deps, { targetDocId: suggestion.targetDocId, proposedTitle: suggestion.proposedTitle, proposedBody: suggestion.proposedBody, proposedLineSlug: suggestion.proposedLineSlug, proposedDocType: suggestion.proposedDocType ?? 'faq' }, actorId);
    await deps.db.update(knowledgeSuggestions).set({ stagedItemId: staged.draftId }).where(eq(knowledgeSuggestions.id, id));
  }
  await deps.audit.record({ tenantId: deps.scope.tenantId, actorId, action: `knowledge.suggestion_${status}`, entity: 'knowledge_suggestion', entityId: id, detail: {}, at: deps.now() });
  return row;
}
