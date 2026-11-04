// CRUD de perguntas/gatilhos da configuração do agente (Fase 2, Tasks 4–5).
// Cada mutação grava o estado anterior em knowledge_revisions; expectedVersion
// torna a reversão optimista e impede que se perca uma edição concorrente.
import { and, asc, eq } from 'drizzle-orm';
import { HttpError } from '../../adapters/http/errors.js';
import { businessLines, handoffTriggers, knowledgeRevisions, qualificationQuestions } from './knowledge.schema.js';
import type { TrainDeps } from './train-service.js';

type Kind = 'qualification_question' | 'handoff_trigger';
type Input = { lineSlug?: string | null; key?: string; question?: string; answerType?: 'text' | 'number' | 'choice'; choices?: unknown; required?: boolean; position?: number; code?: string; description?: string; detectionHint?: string; action?: 'handoff_now' | 'handoff_when_qualified' | 'flag_only'; priority?: 'normal' | 'high' | 'urgent'; active?: boolean };

async function lineId(deps: TrainDeps, slug: string | null | undefined, required: boolean): Promise<string | null> {
  if (slug === null || slug === undefined) {
    if (required) throw new HttpError(422, 'line_required', 'linha obrigatória');
    return null;
  }
  const [line] = await deps.db.select({ id: businessLines.id }).from(businessLines).where(eq(businessLines.slug, slug));
  if (line === undefined) throw new HttpError(404, 'line_not_found', 'linha inexistente');
  return line.id;
}

const table = (kind: Kind) => kind === 'qualification_question' ? qualificationQuestions : handoffTriggers;

export async function listConfig(deps: TrainDeps, kind: Kind): Promise<unknown[]> {
  const rows = await deps.db.select().from(table(kind)).where(eq(table(kind).tenantId, deps.scope.tenantId)).orderBy(asc(table(kind).id));
  return rows;
}

async function revision(deps: TrainDeps, kind: Kind, id: string, version: number, snapshot: Record<string, unknown>, actorId: string, note: string): Promise<void> {
  await deps.db.insert(knowledgeRevisions).values({ tenantId: deps.scope.tenantId, entityType: kind, entityId: id, version, snapshot, changedById: actorId, note });
}

export async function createConfig(deps: TrainDeps, kind: Kind, input: Input, actorId: string): Promise<unknown> {
  const lid = await lineId(deps, input.lineSlug, kind === 'qualification_question');
  try {
    if (kind === 'qualification_question') {
      const [row] = await deps.db.insert(qualificationQuestions).values({ tenantId: deps.scope.tenantId, lineId: lid!, key: input.key!, question: input.question!, answerType: input.answerType ?? 'text', choices: input.choices, required: input.required ?? false, position: input.position ?? 0 }).returning();
      if (row === undefined) throw new Error('question insert');
      await revision(deps, kind, row.id, 0, { absent: true }, actorId, 'create'); return row;
    }
    const [row] = await deps.db.insert(handoffTriggers).values({ tenantId: deps.scope.tenantId, lineId: lid, code: input.code!, description: input.description!, detectionHint: input.detectionHint!, action: input.action ?? 'handoff_now', priority: input.priority ?? 'normal', active: input.active ?? true }).returning();
    if (row === undefined) throw new Error('trigger insert');
    await revision(deps, kind, row.id, 0, { absent: true }, actorId, 'create'); return row;
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw new HttpError(409, 'duplicate_config', 'configuração duplicada');
    throw error;
  }
}

export async function updateConfig(deps: TrainDeps, kind: Kind, id: string, input: Input, expectedVersion: number, actorId: string): Promise<unknown> {
  const lid = await lineId(deps, input.lineSlug, kind === 'qualification_question');
  const t = table(kind);
  const [current] = await deps.db.select().from(t).where(and(eq(t.id, id), eq(t.tenantId, deps.scope.tenantId)));
  if (current === undefined) throw new HttpError(404, 'item_not_found', 'configuração inexistente');
  if (current.version !== expectedVersion) throw new HttpError(409, 'stale_version', 'versão desactualizada');
  await revision(deps, kind, id, current.version, current as unknown as Record<string, unknown>, actorId, 'update');
  const values = kind === 'qualification_question'
    ? { ...(input.key === undefined ? {} : { key: input.key }), ...(input.question === undefined ? {} : { question: input.question }), ...(input.answerType === undefined ? {} : { answerType: input.answerType }), ...(input.choices === undefined ? {} : { choices: input.choices }), ...(input.required === undefined ? {} : { required: input.required }), ...(input.position === undefined ? {} : { position: input.position }), ...(input.lineSlug === undefined ? {} : { lineId: lid }), version: current.version + 1 }
    : { ...(input.code === undefined ? {} : { code: input.code }), ...(input.description === undefined ? {} : { description: input.description }), ...(input.detectionHint === undefined ? {} : { detectionHint: input.detectionHint }), ...(input.action === undefined ? {} : { action: input.action }), ...(input.priority === undefined ? {} : { priority: input.priority }), ...(input.active === undefined ? {} : { active: input.active }), ...(input.lineSlug === undefined ? {} : { lineId: lid }), version: current.version + 1 };
  const [row] = await deps.db.update(t).set(values).where(and(eq(t.id, id), eq(t.tenantId, deps.scope.tenantId), eq(t.version, expectedVersion))).returning();
  if (row === undefined) throw new HttpError(409, 'stale_version', 'versão desactualizada');
  return row;
}

export async function deleteConfig(deps: TrainDeps, kind: Kind, id: string, expectedVersion: number, actorId: string): Promise<void> {
  const t = table(kind); const [current] = await deps.db.select().from(t).where(and(eq(t.id, id), eq(t.tenantId, deps.scope.tenantId)));
  if (current === undefined) throw new HttpError(404, 'item_not_found', 'configuração inexistente');
  if (current.version !== expectedVersion) throw new HttpError(409, 'stale_version', 'versão desactualizada');
  await revision(deps, kind, id, current.version, current as unknown as Record<string, unknown>, actorId, 'delete');
  await deps.db.update(t).set({ active: false, version: current.version + 1 }).where(and(eq(t.id, id), eq(t.tenantId, deps.scope.tenantId), eq(t.version, expectedVersion)));
}
