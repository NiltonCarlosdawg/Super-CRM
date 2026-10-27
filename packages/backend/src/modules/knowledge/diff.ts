// Treinar agente, Task 6: diff puro entre o rascunho e o activo (spec §6).
// Sem BD: recebe as linhas staged e um snapshot dos publicados e classifica
// cada slug em added/updated/unchanged/conflict/archived. A regra de ouro é
// "novo prevalece, não tocado permanece": ausência no rascunho NUNCA produz
// archived; só um `op: 'delete'` explícito o faz.
//
// `canonicalPayload` compara apenas os campos editáveis por tipo. É a mesma
// função usada pela T7 para a edição rápida e pela reversão.

import type { DraftEntityType, DraftOp, StagedItemRow } from './knowledge.schema.js';

/** Item publicado reduzido ao que o diff precisa (carregado por tenant). */
export interface PublishedSnapshot {
  slug: string;
  entityType: DraftEntityType;
  version: number;
  canonical: string;
  rowId: string;
}

/** Entrada do diff mostrada ao utilizador antes de confirmar. */
export interface DiffEntry {
  slug: string;
  entityType: DraftEntityType;
  op: DraftOp;
  classification: 'added' | 'updated' | 'unchanged' | 'conflict' | 'archived';
  baseVersion: number | null;
  currentVersion: number | null;
}

/**
 * Entrada staged vista pelo diff. O `lineSlug` é opcional para aceitar tanto
 * a linha completa da BD como o `Pick` mínimo do contrato; quando presente,
 * entra no canónico (a linha faz parte do estado editável).
 */
export type StagedDiffItem = Pick<
  StagedItemRow,
  'slug' | 'entityType' | 'op' | 'payload' | 'baseVersion' | 'lineConfirmed'
> & { lineSlug?: string | null };

export interface DraftDiff {
  entries: DiffEntry[];
  unconfirmedSlugs: string[];
}

const ENTITY_TYPES: readonly DraftEntityType[] = ['catalog_item', 'knowledge_doc', 'rule'];
const DRAFT_OPS: readonly DraftOp[] = ['create', 'update', 'delete'];

/** Campos editáveis por tipo (ordem irrelevante: a serialização ordena). */
const EDITABLE_FIELDS: Record<DraftEntityType, readonly string[]> = {
  catalog_item: [
    'name',
    'summary',
    'details',
    'pricingMode',
    'priceAmount',
    'currency',
    'priceNote',
    'availability',
    'lineSlug',
  ],
  knowledge_doc: ['title', 'body', 'type', 'lineSlug'],
  rule: ['title', 'instruction', 'params', 'lineSlug'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asEntityType(value: string): DraftEntityType {
  if ((ENTITY_TYPES as readonly string[]).includes(value)) return value as DraftEntityType;
  throw new Error(`tipo de entidade desconhecido no rascunho: ${value}`);
}

export function asDraftOp(value: string): DraftOp {
  if ((DRAFT_OPS as readonly string[]).includes(value)) return value as DraftOp;
  throw new Error(`operação desconhecida no rascunho: ${value}`);
}

/** Normaliza recursivamente para que a ordem das chaves não conte. */
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
    return out;
  }
  return value === undefined ? null : value;
}

function nestedJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(stableValue(value));
}

function normalizePrice(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return typeof value === 'string' ? value : String(value);
}

/**
 * `docType` é o nome do campo no payload extraído (T3); `type` é a coluna
 * publicada. O canónico lê os dois para que rascunho e activo comparem.
 */
function withDocTypeAlias(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload.type !== undefined || typeof payload.docType !== 'string') return payload;
  return { ...payload, type: payload.docType };
}

/** Serializa SÓ os campos editáveis do tipo, com chaves ordenadas. */
export function canonicalPayload(entityType: DraftEntityType, payload: unknown): string {
  const source = isRecord(payload)
    ? entityType === 'knowledge_doc'
      ? withDocTypeAlias(payload)
      : payload
    : {};

  const normalized: Record<string, unknown> = {};
  for (const field of [...EDITABLE_FIELDS[entityType]].sort()) {
    const raw = source[field];
    if (field === 'lineSlug') {
      normalized[field] = typeof raw === 'string' && raw.length > 0 ? raw : null;
    } else if (field === 'priceAmount') {
      normalized[field] = normalizePrice(raw);
    } else if (field === 'details' || field === 'params') {
      normalized[field] = nestedJson(raw);
    } else {
      normalized[field] = raw === undefined ? null : raw;
    }
  }
  return JSON.stringify(normalized);
}

/** Canónico de uma linha staged, incluindo a linha de negócio da própria row. */
export function stagedCanonical(item: StagedDiffItem): string {
  const payload = isRecord(item.payload) ? item.payload : {};
  const lineSlug =
    item.lineSlug !== undefined ? item.lineSlug : isRecord(item.payload) ? item.payload.lineSlug : null;
  return canonicalPayload(asEntityType(item.entityType), {
    ...payload,
    lineSlug: lineSlug ?? null,
  });
}

const keyOf = (entityType: string, slug: string): string => `${entityType}:${slug}`;

/**
 * Compara o rascunho com o activo. Regras (spec §6):
 * - create sem activo → added; com activo → conflict.
 * - update sem activo → conflict; versão de origem diferente da actual → conflict;
 *   versão igual e canónico diferente → updated; igual → unchanged.
 * - delete com activo e versão igual → archived; sem activo ou versão
 *   divergente → conflict.
 * - linha por confirmar → `unconfirmedSlugs` (o diff continua a ser devolvido).
 * - ausência no rascunho nunca vira archived.
 */
export function computeDraftDiff(
  staged: readonly StagedDiffItem[],
  published: readonly PublishedSnapshot[],
): DraftDiff {
  const publishedByKey = new Map(
    published.map((item) => [keyOf(item.entityType, item.slug), item]),
  );

  const entries: DiffEntry[] = staged.map((item) => {
    const entityType = asEntityType(item.entityType);
    const op = asDraftOp(item.op);
    const current = publishedByKey.get(keyOf(entityType, item.slug));
    const baseVersion = item.baseVersion;
    const currentVersion = current?.version ?? null;

    let classification: DiffEntry['classification'];
    if (op === 'create') {
      classification = current === undefined ? 'added' : 'conflict';
    } else if (op === 'update') {
      if (current === undefined || baseVersion !== currentVersion) {
        classification = 'conflict';
      } else {
        classification = stagedCanonical(item) === current.canonical ? 'unchanged' : 'updated';
      }
    } else if (current === undefined || baseVersion !== currentVersion) {
      classification = 'conflict';
    } else {
      classification = 'archived';
    }

    return {
      slug: item.slug,
      entityType,
      op,
      classification,
      baseVersion,
      currentVersion,
    };
  });

  entries.sort(
    (a, b) => a.entityType.localeCompare(b.entityType) || a.slug.localeCompare(b.slug),
  );

  const unconfirmedSlugs = [
    ...new Set(staged.filter((item) => !item.lineConfirmed).map((item) => item.slug)),
  ].sort();

  return { entries, unconfirmedSlugs };
}
