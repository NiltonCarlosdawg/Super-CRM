// Fase 3, Task 18: serviço de rascunhos — aprovar/rejeitar (docs/05 §2).
// Aprovar move o rascunho para a outbox (a ÚNICA saída, `idempotencyKey:
// 'draft:'+draftId`); rejeitar nunca enfileira. Ambas as ações auditam.
// Onda 1: toda a operação sob scope da sessão (cross-tenant = 404, nunca 403).

import { and, desc, eq } from 'drizzle-orm';

import type { DbClient } from '../../adapters/db/index.js';
import { DomainError } from '../../domain/error.js';
import type { Audit } from '../../ports/audit.js';
import type { Outbox } from '../../ports/outbox.js';
import type { TenantScope } from '../../ports/tenancy.js';
import { aiDrafts } from './drafts.schema.js';
import { conversations } from '../../adapters/db/schema/conversations.schema.js';

export interface DraftDeps {
  db: DbClient;
  scope: TenantScope;
  outbox: Outbox;
  audit: Audit;
  now(): Date;
}

async function loadDraft(d: DraftDeps, draftId: string) {
  const [row] = await d.db
    .select({
      id: aiDrafts.id,
      conversationId: aiDrafts.conversationId,
      text: aiDrafts.text,
      status: aiDrafts.status,
      outboxId: aiDrafts.outboxId,
    })
    .from(aiDrafts)
    .where(and(eq(aiDrafts.id, draftId), eq(aiDrafts.tenantId, d.scope.tenantId)))
    .limit(1);
  if (row === undefined) throw new DomainError('not_found');
  return row;
}

/** accountId/contactId da conversa (o enqueue da outbox exige-os) — sob scope. */
async function loadConversation(d: DraftDeps, conversationId: string) {
  const [conv] = await d.db
    .select({ accountId: conversations.accountId, contactId: conversations.contactId })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, d.scope.tenantId)))
    .limit(1);
  if (conv === undefined) throw new DomainError('not_found');
  return conv;
}

export async function listDrafts(d: DraftDeps, conversationId: string) {
  return d.db
    .select({
      id: aiDrafts.id,
      conversationId: aiDrafts.conversationId,
      text: aiDrafts.text,
      status: aiDrafts.status,
      firedTriggers: aiDrafts.firedTriggers,
      outboxId: aiDrafts.outboxId,
      approvedBy: aiDrafts.approvedBy,
      approvedAt: aiDrafts.approvedAt,
      rejectedReason: aiDrafts.rejectedReason,
      createdAt: aiDrafts.createdAt,
    })
    .from(aiDrafts)
    .where(and(eq(aiDrafts.conversationId, conversationId), eq(aiDrafts.tenantId, d.scope.tenantId)))
    .orderBy(desc(aiDrafts.createdAt));
}

/**
 * Aprova um rascunho `pending` e enfileira-o na outbox (`draft:<draftId>`).
 * Já aprovado → devolve o MESMO outboxId (idempotente, sem novo audit).
 * Rejeitado → `DomainError('draft_rejected')`; outro estado → `draft_not_pending`.
 */
export async function approveDraft(
  d: DraftDeps,
  draftId: string,
  userId: string,
): Promise<{ status: 'approved'; outboxId: string }> {
  const draft = await loadDraft(d, draftId);
  if (draft.status === 'approved') return { status: 'approved', outboxId: draft.outboxId ?? '' };
  if (draft.status === 'rejected') throw new DomainError('draft_rejected');
  if (draft.status !== 'pending') throw new DomainError('draft_not_pending');

  const conv = await loadConversation(d, draft.conversationId);
  const { outboxId } = await d.outbox.enqueue({
    accountId: conv.accountId,
    contactId: conv.contactId,
    conversationId: draft.conversationId,
    sender: 'ai',
    text: draft.text,
    idempotencyKey: `draft:${draftId}`,
  });
  await d.db
    .update(aiDrafts)
    .set({ status: 'approved', approvedBy: userId, approvedAt: d.now(), outboxId })
    .where(
      and(eq(aiDrafts.id, draftId), eq(aiDrafts.tenantId, d.scope.tenantId), eq(aiDrafts.status, 'pending')),
    );
  await d.audit.record({
    tenantId: d.scope.tenantId,
    actorId: userId,
    action: 'draft.approved',
    entity: 'ai_draft',
    entityId: draftId,
    detail: { outboxId },
    at: d.now(),
  });
  return { status: 'approved', outboxId };
}

/** Rejeita um rascunho `pending` (nunca enfileira). Já rejeitado → idempotente. */
export async function rejectDraft(
  d: DraftDeps,
  draftId: string,
  userId: string,
  reason: string,
): Promise<{ status: 'rejected' }> {
  const draft = await loadDraft(d, draftId);
  if (draft.status === 'rejected') return { status: 'rejected' };
  if (draft.status !== 'pending') throw new DomainError('draft_not_pending'); // inclui 'approved'

  await d.db
    .update(aiDrafts)
    .set({ status: 'rejected', rejectedReason: reason })
    .where(
      and(eq(aiDrafts.id, draftId), eq(aiDrafts.tenantId, d.scope.tenantId), eq(aiDrafts.status, 'pending')),
    );
  await d.audit.record({
    tenantId: d.scope.tenantId,
    actorId: userId,
    action: 'draft.rejected',
    entity: 'ai_draft',
    entityId: draftId,
    detail: { reason },
    at: d.now(),
  });
  return { status: 'rejected' };
}
