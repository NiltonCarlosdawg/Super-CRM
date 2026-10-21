// Casos de uso da fila de handoffs (Fase 3, Task 14; ADR-0003 A6.1, A10).
// O `claim` é O comutador (quem aceita primeiro fica); aceitar assume a
// conversa (human_only); resolver — ou o botão manual de devolução — retorna à
// IA pelo modo por defeito (A10: o da linha, senão o global). Toda a ação
// humana é auditada (docs/01 §6).

import { businessMinutesBetween } from '../domain/business-hours.js';
import type { Settings } from '../modules/settings/settings.js';
import type { AiMode, LineSlug, Ports } from '../ports/ai-provider.js';
import type { Audit } from '../ports/audit.js';
import type { HandoffQueueRepository } from '../ports/handoff-queue.js';
import type { TenantScope } from '../ports/tenancy.js';

/** Superfície mínima de conversas de que os casos de uso precisam (sob scope). */
export interface HandoffConversations {
  getLine(scope: TenantScope, conversationId: string): Promise<LineSlug | null>;
  setAiMode(scope: TenantScope, conversationId: string, mode: AiMode): Promise<void>;
}

export interface HandoffDeps {
  scope: TenantScope;
  queue: HandoffQueueRepository;
  conversations: HandoffConversations;
  settings: Settings;
  audit: Audit;
  notify: Ports['notify'];
  now: () => Date;
}

/** A10: o modo por defeito ao devolver à IA — o da linha se definido, senão o global. */
export function aiModeFor(s: Settings, line: LineSlug | null): AiMode {
  if (line !== null) {
    const byLine = s.aiModeDefault.byLine[line];
    if (byLine !== undefined) return byLine;
  }
  return s.aiModeDefault.global;
}

/** Aceita o handoff: claim; se venceu, assume a conversa e audita. SLA excedido → alerta. */
export async function acceptHandoff(
  d: HandoffDeps,
  handoffId: string,
  userId: string,
): Promise<'claimed' | 'taken' | 'not_found'> {
  const now = d.now();
  const row = await d.queue.get(d.scope, handoffId);
  if (row === null) return 'not_found';
  const result = await d.queue.claim(d.scope, handoffId, userId, now);
  if (result !== 'claimed') return result;

  // O humano assume → a conversa sai do modo automático.
  await d.conversations.setAiMode(d.scope, row.conversationId, 'human_only');
  await d.notify({
    type: 'handoff',
    phase: 'updated',
    handoffId,
    conversationId: row.conversationId,
    priority: row.priority,
    reason: row.reason,
  });
  await d.audit.record({
    tenantId: d.scope.tenantId,
    actorId: userId,
    action: 'handoff.accepted',
    entity: 'handoff',
    entityId: handoffId,
    at: now,
  });

  // SLA de primeira resposta excedido (minutos úteis desde a criação) → alerta + audit.
  if (businessMinutesBetween(row.createdAt, now, d.settings.businessHours) > d.settings.sla.firstResponseMinutes) {
    await d.notify({
      type: 'alert',
      handoffId,
      conversationId: row.conversationId,
      priority: row.priority,
      reason: 'sla_first_response_2h',
    });
    await d.audit.record({
      tenantId: d.scope.tenantId,
      actorId: userId,
      action: 'handoff.sla_breach',
      entity: 'handoff',
      entityId: handoffId,
      at: now,
    });
  }
  return 'claimed';
}

/** Resolve o handoff e devolve a conversa à IA pelo modo por defeito (A10). */
export async function resolveHandoff(
  d: HandoffDeps,
  handoffId: string,
  userId: string,
): Promise<'resolved' | 'not_found'> {
  const now = d.now();
  const row = await d.queue.get(d.scope, handoffId);
  if (row === null) return 'not_found';
  const result = await d.queue.resolve(d.scope, handoffId, userId, now);
  if (result !== 'resolved') return 'not_found';

  await d.audit.record({
    tenantId: d.scope.tenantId,
    actorId: userId,
    action: 'handoff.resolved',
    entity: 'handoff',
    entityId: handoffId,
    at: now,
  });
  const line = await d.conversations.getLine(d.scope, row.conversationId);
  const mode = aiModeFor(d.settings, line);
  await d.conversations.setAiMode(d.scope, row.conversationId, mode);
  await d.audit.record({
    tenantId: d.scope.tenantId,
    actorId: userId,
    action: 'conversation.returned_to_ai',
    entity: 'conversation',
    entityId: row.conversationId,
    at: now,
    detail: { aiMode: mode },
  });
  return 'resolved';
}

/** Botão manual: devolve a conversa à IA a qualquer momento (audita o regresso). */
export async function returnConversationToAi(
  d: HandoffDeps,
  conversationId: string,
  userId: string,
): Promise<{ aiMode: AiMode }> {
  const now = d.now();
  const line = await d.conversations.getLine(d.scope, conversationId);
  const mode = aiModeFor(d.settings, line);
  await d.conversations.setAiMode(d.scope, conversationId, mode);
  await d.audit.record({
    tenantId: d.scope.tenantId,
    actorId: userId,
    action: 'conversation.returned_to_ai',
    entity: 'conversation',
    entityId: conversationId,
    at: now,
    detail: { aiMode: mode },
  });
  return { aiMode: mode };
}
