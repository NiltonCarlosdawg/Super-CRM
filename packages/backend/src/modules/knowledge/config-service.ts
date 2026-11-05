// CRUD de perguntas/gatilhos da configuração do agente (Fase 2, Tasks 4–5).
// Cada mutação grava o estado anterior em knowledge_revisions; expectedVersion
// torna a reversão optimista e impede que se perca uma edição concorrente.
import { and, asc, desc, eq, isNull, or } from 'drizzle-orm';
import { HttpError } from '../../adapters/http/errors.js';
import {
  businessLines,
  handoffTriggers,
  knowledgeDocs,
  knowledgeDraftItems,
  knowledgeRevisions,
  qualificationQuestions,
} from './knowledge.schema.js';
import { buildChunks, chunkContentsFor } from './train-service.js';
import type { TrainDeps } from './train-service.js';

export type Kind = 'qualification_question' | 'handoff_trigger';
export type Revision = {
  id: string;
  entityType: Kind;
  entityId: string;
  version: number;
  snapshot: Record<string, unknown>;
  changedById: string;
  note: string | null;
  createdAt: Date;
};

type QuestionInput = {
  lineSlug: string;
  key: string;
  question: string;
  answerType?: 'text' | 'number' | 'choice';
  choices?: unknown;
  required?: boolean;
  position?: number;
};

type TriggerInput = {
  lineSlug?: string | null;
  code: string;
  description: string;
  detectionHint: string;
  action?: 'handoff_now' | 'handoff_when_qualified' | 'flag_only';
  priority?: 'normal' | 'high' | 'urgent';
  active?: boolean;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function lineId(deps: TrainDeps, slug: string | null | undefined, required: boolean): Promise<string | null> {
  if (slug === null || slug === undefined) {
    if (required) throw new HttpError(422, 'line_required', 'linha obrigatória');
    return null;
  }
  const [line] = await deps.db.select({ id: businessLines.id }).from(businessLines).where(eq(businessLines.slug, slug));
  if (line === undefined) throw new HttpError(404, 'line_not_found', 'linha inexistente');
  return line.id;
}

const table = (kind: Kind) => (kind === 'qualification_question' ? qualificationQuestions : handoffTriggers);

function duplicateError(kind: Kind): HttpError {
  return new HttpError(409, kind === 'qualification_question' ? 'duplicate_key' : 'duplicate_trigger', 'configuração duplicada');
}

function isUniqueViolation(error: unknown): boolean {
  const code = (value: unknown): unknown =>
    typeof value === 'object' && value !== null && 'code' in value
      ? (value as { code?: unknown }).code
      : undefined;
  return code(error) === '23505' || code((error as { cause?: unknown }).cause) === '23505';
}

function snap(current: Record<string, unknown>): Record<string, unknown> {
  return current;
}

export async function listConfig(deps: TrainDeps, kind: Kind): Promise<unknown[]> {
  const rows = await deps.db.select().from(table(kind)).where(eq(table(kind).tenantId, deps.scope.tenantId)).orderBy(asc(table(kind).id));
  return rows;
}

async function revision(deps: TrainDeps, kind: Kind, id: string, version: number, snapshot: Record<string, unknown>, actorId: string, note: string): Promise<void> {
  await deps.db.insert(knowledgeRevisions).values({ tenantId: deps.scope.tenantId, entityType: kind, entityId: id, version, snapshot, changedById: actorId, note });
}

async function currentConfig(deps: TrainDeps, kind: Kind, id: string): Promise<Record<string, unknown> | null> {
  const t = table(kind);
  const [row] = await deps.db.select().from(t).where(and(eq(t.id, id), eq(t.tenantId, deps.scope.tenantId)));
  return row === undefined ? null : (row as Record<string, unknown>);
}

function validateChoices(input: QuestionInput): void {
  const choices = input.choices as unknown;
  if (input.answerType === 'choice') {
    if (!Array.isArray(choices) || choices.length < 1 || choices.length > 50 || choices.some((value) => typeof value !== 'string' || value.trim() === '')) {
      throw new HttpError(400, 'invalid_choices', 'choices inválidas');
    }
    return;
  }
  if (choices !== undefined && choices !== null) {
    throw new HttpError(400, 'invalid_choices', 'choices inválidas');
  }
}

function validateCode(code: string): void {
  if (!/^[a-z][a-z0-9_]{2,39}$/.test(code)) {
    throw new HttpError(400, 'invalid_code', 'code inválido');
  }
}

async function createRow(deps: TrainDeps, kind: Kind, values: Record<string, unknown>, actorId: string): Promise<unknown> {
  try {
    const t = table(kind);
    const [row] = await deps.db.insert(t).values(values as never).returning();
    if (row === undefined) throw new Error('insert failed');
    await revision(deps, kind, (row as { id: string }).id, 0, { absent: true }, actorId, 'create');
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) throw duplicateError(kind);
    throw error;
  }
}

export async function listQualificationQuestions(
  deps: TrainDeps,
  input: { lineSlug?: string | null; includeInactive?: boolean } = {},
): Promise<unknown[]> {
  const lineSlug = input.lineSlug ?? null;
  const line = lineSlug === null ? null : await lineId(deps, lineSlug, true);
  const query = deps.db
    .select()
    .from(qualificationQuestions)
    .where(
      line === null
        ? eq(qualificationQuestions.tenantId, deps.scope.tenantId)
        : and(eq(qualificationQuestions.tenantId, deps.scope.tenantId), eq(qualificationQuestions.lineId, line)),
    )
    .orderBy(asc(qualificationQuestions.position), asc(qualificationQuestions.key));
  const rows = await query;
  return input.includeInactive === true ? rows : rows.filter((row) => row.active === true);
}

export async function createQualificationQuestion(deps: TrainDeps, input: QuestionInput, actorId: string): Promise<unknown> {
  validateChoices(input);
  const line = await lineId(deps, input.lineSlug, true);
  return createRow(deps, 'qualification_question', {
    tenantId: deps.scope.tenantId,
    lineId: line,
    key: input.key,
    question: input.question,
    answerType: input.answerType ?? 'text',
    choices: input.choices ?? null,
    required: input.required ?? false,
    position: input.position ?? 0,
  }, actorId);
}

export async function updateQualificationQuestion(
  deps: TrainDeps,
  id: string,
  input: Partial<Omit<QuestionInput, 'lineSlug' | 'key'>> & { active?: boolean; expectedVersion: number },
  actorId: string,
): Promise<unknown> {
  const current = await currentConfig(deps, 'qualification_question', id);
  if (current === null) throw new HttpError(404, 'not_found', 'configuração inexistente');
  if (current.version !== input.expectedVersion) throw new HttpError(409, 'stale_version', 'versão desactualizada');
  if (input.answerType !== undefined || input.choices !== undefined) validateChoices({ lineSlug: 'x', key: 'x', question: 'x', answerType: input.answerType as QuestionInput['answerType'], choices: input.choices });
  await revision(deps, 'qualification_question', id, current.version, snap(current), actorId, 'update');
  const [row] = await deps.db
    .update(qualificationQuestions)
    .set({
      question: input.question ?? (current.question as string),
      answerType: input.answerType ?? (current.answerType as 'text' | 'number' | 'choice'),
      choices: input.choices === undefined ? current.choices ?? null : input.choices,
      required: input.required ?? (current.required as boolean),
      position: input.position ?? (current.position as number),
      active: input.active ?? (current.active as boolean),
      version: current.version + 1,
    })
    .where(and(eq(qualificationQuestions.id, id), eq(qualificationQuestions.tenantId, deps.scope.tenantId), eq(qualificationQuestions.version, input.expectedVersion)))
    .returning();
  if (row === undefined) throw new HttpError(409, 'stale_version', 'versão desactualizada');
  return row;
}

export async function deleteQualificationQuestion(deps: TrainDeps, id: string, expectedVersion: number, actorId: string): Promise<void> {
  const current = await currentConfig(deps, 'qualification_question', id);
  if (current === null) throw new HttpError(404, 'not_found', 'configuração inexistente');
  if (current.version !== expectedVersion) throw new HttpError(409, 'stale_version', 'versão desactualizada');
  if (current.active === false) return;
  await revision(deps, 'qualification_question', id, current.version, snap(current), actorId, 'deactivate');
  await deps.db
    .update(qualificationQuestions)
    .set({ active: false, version: current.version + 1 })
    .where(and(eq(qualificationQuestions.id, id), eq(qualificationQuestions.tenantId, deps.scope.tenantId), eq(qualificationQuestions.version, expectedVersion)));
}

export async function listHandoffTriggers(
  deps: TrainDeps,
  input: { lineSlug?: string | null; includeInactive?: boolean } = {},
): Promise<unknown[]> {
  const lineSlug = input.lineSlug ?? null;
  const line = lineSlug === null ? null : await lineId(deps, lineSlug, true);
  const rows = await deps.db
    .select()
    .from(handoffTriggers)
    .where(
      line === null
        ? and(eq(handoffTriggers.tenantId, deps.scope.tenantId), isNull(handoffTriggers.lineId))
        : and(eq(handoffTriggers.tenantId, deps.scope.tenantId), or(isNull(handoffTriggers.lineId), eq(handoffTriggers.lineId, line))),
    )
    .orderBy(asc(handoffTriggers.priority), asc(handoffTriggers.code));
  return input.includeInactive === true ? rows : rows.filter((row) => row.active === true);
}

export async function createHandoffTrigger(deps: TrainDeps, input: TriggerInput, actorId: string): Promise<unknown> {
  validateCode(input.code);
  const line = await lineId(deps, input.lineSlug, false);
  return createRow(deps, 'handoff_trigger', {
    tenantId: deps.scope.tenantId,
    lineId: line,
    code: input.code,
    description: input.description,
    detectionHint: input.detectionHint,
    action: input.action ?? 'handoff_now',
    priority: input.priority ?? 'normal',
    active: input.active ?? true,
  }, actorId);
}

export async function updateHandoffTrigger(
  deps: TrainDeps,
  id: string,
  input: Partial<Omit<TriggerInput, 'lineSlug' | 'code'>> & { expectedVersion: number },
  actorId: string,
): Promise<unknown> {
  const current = await currentConfig(deps, 'handoff_trigger', id);
  if (current === null) throw new HttpError(404, 'not_found', 'configuração inexistente');
  if (current.version !== input.expectedVersion) throw new HttpError(409, 'stale_version', 'versão desactualizada');
  await revision(deps, 'handoff_trigger', id, current.version, snap(current), actorId, 'update');
  const [row] = await deps.db
    .update(handoffTriggers)
    .set({
      description: input.description ?? (current.description as string),
      detectionHint: input.detectionHint ?? (current.detectionHint as string),
      action: input.action ?? (current.action as 'handoff_now' | 'handoff_when_qualified' | 'flag_only'),
      priority: input.priority ?? (current.priority as 'normal' | 'high' | 'urgent'),
      active: input.active ?? (current.active as boolean),
      version: current.version + 1,
    })
    .where(and(eq(handoffTriggers.id, id), eq(handoffTriggers.tenantId, deps.scope.tenantId), eq(handoffTriggers.version, input.expectedVersion)))
    .returning();
  if (row === undefined) throw new HttpError(409, 'stale_version', 'versão desactualizada');
  return row;
}

export async function deleteHandoffTrigger(deps: TrainDeps, id: string, expectedVersion: number, actorId: string): Promise<void> {
  const current = await currentConfig(deps, 'handoff_trigger', id);
  if (current === null) throw new HttpError(404, 'not_found', 'configuração inexistente');
  if (current.version !== expectedVersion) throw new HttpError(409, 'stale_version', 'versão desactualizada');
  if (current.active === false) return;
  await revision(deps, 'handoff_trigger', id, current.version, snap(current), actorId, 'deactivate');
  await deps.db
    .update(handoffTriggers)
    .set({ active: false, version: current.version + 1 })
    .where(and(eq(handoffTriggers.id, id), eq(handoffTriggers.tenantId, deps.scope.tenantId), eq(handoffTriggers.version, expectedVersion)));
}

export async function listConfigRevisions(deps: TrainDeps, entityType: Kind, entityId: string): Promise<Revision[]> {
  const rows = await deps.db
    .select()
    .from(knowledgeRevisions)
    .where(and(eq(knowledgeRevisions.tenantId, deps.scope.tenantId), eq(knowledgeRevisions.entityType, entityType), eq(knowledgeRevisions.entityId, entityId)))
    .orderBy(desc(knowledgeRevisions.version));
  return rows as Revision[];
}

function targetTable(entityType: Kind) {
  return entityType === 'qualification_question' ? qualificationQuestions : handoffTriggers;
}

function reviveValues(entityType: Kind, snapshot: Record<string, unknown>, version: number): Record<string, unknown> {
  if (snapshot.absent === true) {
    return { active: false, version: version + 1 };
  }
  if (entityType === 'qualification_question') {
    return {
      lineId: snapshot.lineId,
      key: snapshot.key,
      question: snapshot.question,
      answerType: snapshot.answerType ?? 'text',
      choices: snapshot.choices ?? null,
      required: snapshot.required ?? false,
      position: snapshot.position ?? 0,
      active: snapshot.active ?? true,
      version: version + 1,
    };
  }
  return {
    lineId: snapshot.lineId ?? null,
    code: snapshot.code,
    description: snapshot.description,
    detectionHint: snapshot.detectionHint,
    action: snapshot.action ?? 'handoff_now',
    priority: snapshot.priority ?? 'normal',
    active: snapshot.active ?? true,
    version: version + 1,
  };
}

export async function revertConfigRevision(deps: TrainDeps, revisionId: string, expectedVersion: number, actorId: string): Promise<unknown> {
  const [revisionRow] = await deps.db
    .select()
    .from(knowledgeRevisions)
    .where(and(eq(knowledgeRevisions.id, revisionId), eq(knowledgeRevisions.tenantId, deps.scope.tenantId)))
    .limit(1);
  if (revisionRow === undefined) throw new HttpError(404, 'not_found', 'revisão inexistente');
  if (!isObject(revisionRow.snapshot)) throw new HttpError(409, 'revert_snapshot_invalid', 'snapshot inválido');
  const kind = revisionRow.entityType as Kind;
  const t = targetTable(kind);
  const [current] = await deps.db.select().from(t).where(and(eq(t.id, revisionRow.entityId), eq(t.tenantId, deps.scope.tenantId))).limit(1);
  if (current === undefined) throw new HttpError(404, 'not_found', 'configuração inexistente');
  if (current.version !== expectedVersion) throw new HttpError(409, 'stale_version', 'versão desactualizada');
  await revision(deps, kind, revisionRow.entityId, current.version, current as unknown as Record<string, unknown>, actorId, 'revert');
  const [row] = await deps.db
    .update(t)
    .set(reviveValues(kind, revisionRow.snapshot, current.version))
    .where(and(eq(t.id, revisionRow.entityId), eq(t.tenantId, deps.scope.tenantId), eq(t.version, expectedVersion)))
    .returning();
  if (row === undefined) throw new HttpError(409, 'stale_version', 'versão desactualizada');
  return row;
}

type TxClient = Parameters<Parameters<TrainDeps['db']['transaction']>[0]>[0];

export async function createSuggestionDraft(
  deps: TrainDeps,
  input: {
    targetDocId?: string | null;
    proposedTitle: string;
    proposedBody: string;
    proposedLineSlug?: string | null;
    proposedDocType?: 'faq' | 'policy' | 'process' | 'company_info' | 'objection';
  },
  actorId: string,
  /** Transacção do aprovador: falhar o staging não deixa a sugestão aprovada. */
  tx?: TxClient,
): Promise<{ slug: string; draftId: string }> {
  const db = (tx ?? deps.db) as typeof deps.db;
  if (input.targetDocId !== undefined && input.targetDocId !== null) {
    const [doc] = await db
      .select({ doc: knowledgeDocs, lineSlug: businessLines.slug })
      .from(knowledgeDocs)
      .leftJoin(businessLines, eq(knowledgeDocs.lineId, businessLines.id))
      .where(and(eq(knowledgeDocs.id, input.targetDocId), eq(knowledgeDocs.tenantId, deps.scope.tenantId)))
      .limit(1);
    if (doc === undefined) throw new HttpError(404, 'not_found', 'documento inexistente');
    if (doc.doc.status !== 'published') throw new HttpError(409, 'not_published', 'documento ainda não publicado');
    const slug = doc.doc.slug;
    const payload = {
      kind: 'knowledge_doc' as const,
      title: input.proposedTitle,
      body: input.proposedBody,
      type: doc.doc.type,
    };
    const chunks = await buildChunks(chunkContentsFor(payload), deps.embedder);
    const [draft] = await db
      .insert(knowledgeDraftItems)
      .values({
        tenantId: deps.scope.tenantId,
        slug,
        entityType: 'knowledge_doc',
        op: 'update',
        lineSlug: doc.lineSlug,
        lineConfirmed: true,
        payload,
        chunks,
        baseVersion: doc.doc.version,
        changedById: actorId,
      })
      .onConflictDoUpdate({
        target: [knowledgeDraftItems.tenantId, knowledgeDraftItems.slug],
        set: { op: 'update', lineSlug: doc.lineSlug, lineConfirmed: true, payload, chunks, baseVersion: doc.doc.version, changedById: actorId, updatedAt: deps.now() },
      })
      .returning({ id: knowledgeDraftItems.id });
    if (draft === undefined) throw new Error('draft insert failed');
    return { slug, draftId: draft.id };
  }

  const slug = input.proposedTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || `sugestao-${Math.random().toString(16).slice(2, 10)}`;
  const [existingDraft] = await db.select({ id: knowledgeDraftItems.id }).from(knowledgeDraftItems).where(and(eq(knowledgeDraftItems.tenantId, deps.scope.tenantId), eq(knowledgeDraftItems.slug, slug))).limit(1);
  if (existingDraft !== undefined) throw new HttpError(409, 'slug_conflict', 'slug já existe em rascunho');
  const [existingDoc] = await db.select({ id: knowledgeDocs.id }).from(knowledgeDocs).where(and(eq(knowledgeDocs.tenantId, deps.scope.tenantId), eq(knowledgeDocs.slug, slug))).limit(1);
  if (existingDoc !== undefined) throw new HttpError(409, 'slug_conflict', 'slug já existe em publicado');
  const payload = {
    kind: 'knowledge_doc' as const,
    title: input.proposedTitle,
    body: input.proposedBody,
    type: input.proposedDocType ?? 'faq',
  };
  const chunks = await buildChunks(chunkContentsFor(payload), deps.embedder);
  const [draft] = await db
    .insert(knowledgeDraftItems)
    .values({
      tenantId: deps.scope.tenantId,
      slug,
      entityType: 'knowledge_doc',
      op: 'create',
      lineSlug: input.proposedLineSlug ?? null,
      lineConfirmed: true,
      payload,
      chunks,
      baseVersion: null,
      changedById: actorId,
    })
    .returning({ id: knowledgeDraftItems.id });
  if (draft === undefined) throw new Error('draft insert failed');
  return { slug, draftId: draft.id };
}
