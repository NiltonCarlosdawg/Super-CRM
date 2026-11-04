// API de lacunas e sugestões explícitas (Fase 2, Task 6). Não captura nem
// copia conversas: a sugestão recebe apenas o texto fornecido pelo editor.
import { and, desc, eq } from 'drizzle-orm';
import { HttpError } from '../../adapters/http/errors.js';
import { knowledgeDraftItems, knowledgeGaps, knowledgeSuggestions } from './knowledge.schema.js';
import type { TrainDeps } from './train-service.js';

export async function listGaps(deps: TrainDeps, status: 'open' | 'resolved' | 'ignored' = 'open', limit = 50): Promise<unknown[]> {
  return deps.db.select().from(knowledgeGaps).where(and(eq(knowledgeGaps.tenantId, deps.scope.tenantId), eq(knowledgeGaps.status, status))).orderBy(desc(knowledgeGaps.occurrences), desc(knowledgeGaps.lastSeenAt)).limit(limit);
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
  return deps.db.select().from(knowledgeSuggestions).where(and(eq(knowledgeSuggestions.tenantId, deps.scope.tenantId), status === undefined ? undefined : eq(knowledgeSuggestions.status, status))).orderBy(desc(knowledgeSuggestions.createdAt)).limit(limit);
}

export async function createSuggestion(deps: TrainDeps, input: { humanAnswer: string; proposedTitle: string; proposedBody: string; proposedLineSlug?: string | null; proposedDocType?: 'faq' | 'policy' | 'process' | 'company_info' | 'objection'; gapId?: string | null }, actorId: string): Promise<unknown> {
  if (input.gapId !== undefined && input.gapId !== null) {
    const [gap] = await deps.db.select({ id: knowledgeGaps.id }).from(knowledgeGaps).where(and(eq(knowledgeGaps.id, input.gapId), eq(knowledgeGaps.tenantId, deps.scope.tenantId)));
    if (gap === undefined) throw new HttpError(404, 'gap_not_found', 'lacuna inexistente');
  }
  const [row] = await deps.db.insert(knowledgeSuggestions).values({ tenantId: deps.scope.tenantId, gapId: input.gapId ?? null, humanAnswer: input.humanAnswer, proposedTitle: input.proposedTitle, proposedBody: input.proposedBody, proposedLineSlug: input.proposedLineSlug ?? null, proposedDocType: input.proposedDocType ?? 'faq', createdById: actorId }).returning();
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
    const [draft] = await deps.db.insert(knowledgeDraftItems).values({ tenantId: deps.scope.tenantId, slug: suggestion.proposedTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), entityType: 'knowledge_doc', op: 'create', lineSlug: suggestion.proposedLineSlug, lineConfirmed: suggestion.proposedLineSlug !== null, payload: { type: suggestion.proposedDocType ?? 'faq', title: suggestion.proposedTitle, body: suggestion.proposedBody }, changedById: actorId }).returning({ id: knowledgeDraftItems.id });
    if (draft !== undefined) await deps.db.update(knowledgeSuggestions).set({ stagedItemId: draft.id }).where(eq(knowledgeSuggestions.id, id));
  }
  await deps.audit.record({ tenantId: deps.scope.tenantId, actorId, action: `knowledge.suggestion_${status}`, entity: 'knowledge_suggestion', entityId: id, detail: {}, at: deps.now() });
  return row;
}
