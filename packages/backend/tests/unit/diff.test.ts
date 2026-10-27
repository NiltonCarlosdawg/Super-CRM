// Treinar agente, Task 6: regras puras do diff de mesclagem (spec §6).
// Cada teste isola uma regra da interface `computeDraftDiff`; o canónico é
// testado à parte (ordem de chaves, campos extra e preço). Sem BD nem rede.
// Fixtures 100% sintéticas (AGENTS.md §13).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalPayload,
  computeDraftDiff,
  type PublishedSnapshot,
  type StagedDiffItem,
} from '../../src/modules/knowledge/diff.js';

const CATALOG = {
  kind: 'catalog_item',
  name: 'Pacote CFTV 4 câmaras',
  summary: 'Quatro câmaras com instalação incluída.',
  details: { cameras: 4, indoor: true },
  pricingMode: 'fixed',
  priceAmount: '150000.00',
  currency: 'AOA',
  priceNote: null,
  availability: 'available',
};

/** Staged mínimo com os defaults das fixtures. */
function staged(overrides: Partial<StagedDiffItem> & {
  slug: string;
  entityType: StagedDiffItem['entityType'];
  op: StagedDiffItem['op'];
}): StagedDiffItem {
  return {
    payload: CATALOG,
    baseVersion: null,
    lineConfirmed: true,
    lineSlug: 'cctv',
    ...overrides,
  };
}

/** Publicado mínimo: o canónico é derivado do payload, como no loader real. */
function published(
  entityType: PublishedSnapshot['entityType'],
  slug: string,
  version: number,
  payload: Record<string, unknown>,
): PublishedSnapshot {
  return {
    slug,
    entityType,
    version,
    canonical: canonicalPayload(entityType, payload),
    rowId: `row-${entityType}-${slug}`,
  };
}

const publishedCatalog = (slug: string, version: number, payload = CATALOG) =>
  // O loader real junta o slug da linha; a fixture faz o mesmo.
  published('catalog_item', slug, version, { ...payload, lineSlug: 'cctv' });

test('create sem activo → added', () => {
  const { entries, unconfirmedSlugs } = computeDraftDiff(
    [staged({ slug: 'pacote-novo', entityType: 'catalog_item', op: 'create' })],
    [],
  );

  assert.deepEqual(entries, [
    {
      slug: 'pacote-novo',
      entityType: 'catalog_item',
      op: 'create',
      classification: 'added',
      baseVersion: null,
      currentVersion: null,
    },
  ]);
  assert.deepEqual(unconfirmedSlugs, []);
});

test('create sobre item já activo → conflict', () => {
  const { entries } = computeDraftDiff(
    [staged({ slug: 'pacote-existente', entityType: 'catalog_item', op: 'create' })],
    [publishedCatalog('pacote-existente', 2)],
  );

  assert.equal(entries[0]?.classification, 'conflict');
  assert.equal(entries[0]?.currentVersion, 2);
});

test('update com baseVersion actual e canónico diferente → updated', () => {
  const novoPreco = { ...CATALOG, priceAmount: '200000.00' };
  const { entries } = computeDraftDiff(
    [
      staged({
        slug: 'pacote-existente',
        entityType: 'catalog_item',
        op: 'update',
        payload: novoPreco,
        baseVersion: 3,
      }),
    ],
    [publishedCatalog('pacote-existente', 3)],
  );

  assert.deepEqual(entries[0], {
    slug: 'pacote-existente',
    entityType: 'catalog_item',
    op: 'update',
    classification: 'updated',
    baseVersion: 3,
    currentVersion: 3,
  });
});

test('update com baseVersion actual e canónico igual → unchanged', () => {
  const { entries } = computeDraftDiff(
    [
      staged({
        slug: 'pacote-existente',
        entityType: 'catalog_item',
        op: 'update',
        payload: { ...CATALOG },
        baseVersion: 3,
      }),
    ],
    [publishedCatalog('pacote-existente', 3)],
  );

  assert.equal(entries[0]?.classification, 'unchanged');
});

test('update com baseVersion desactualizado → conflict', () => {
  const { entries } = computeDraftDiff(
    [
      staged({
        slug: 'pacote-existente',
        entityType: 'catalog_item',
        op: 'update',
        payload: { ...CATALOG, priceAmount: '200000.00' },
        baseVersion: 2,
      }),
    ],
    [publishedCatalog('pacote-existente', 3)],
  );

  assert.equal(entries[0]?.classification, 'conflict');
  assert.equal(entries[0]?.baseVersion, 2);
  assert.equal(entries[0]?.currentVersion, 3);
});

test('update sem activo → conflict', () => {
  const { entries } = computeDraftDiff(
    [staged({ slug: 'fantasma', entityType: 'catalog_item', op: 'update', baseVersion: 1 })],
    [],
  );

  assert.equal(entries[0]?.classification, 'conflict');
  assert.equal(entries[0]?.currentVersion, null);
});

test('delete com activo e versão coincidente → archived', () => {
  const { entries } = computeDraftDiff(
    [
      staged({
        slug: 'pacote-existente',
        entityType: 'catalog_item',
        op: 'delete',
        payload: { kind: 'catalog_item' },
        baseVersion: 4,
      }),
    ],
    [publishedCatalog('pacote-existente', 4)],
  );

  assert.equal(entries[0]?.classification, 'archived');
  assert.equal(entries[0]?.currentVersion, 4);
});

test('delete sem activo → conflict', () => {
  const { entries } = computeDraftDiff(
    [
      staged({
        slug: 'fantasma',
        entityType: 'catalog_item',
        op: 'delete',
        payload: { kind: 'catalog_item' },
        baseVersion: 1,
      }),
    ],
    [],
  );

  assert.equal(entries[0]?.classification, 'conflict');
});

test('delete com versão divergente → conflict', () => {
  const { entries } = computeDraftDiff(
    [
      staged({
        slug: 'pacote-existente',
        entityType: 'catalog_item',
        op: 'delete',
        payload: { kind: 'catalog_item' },
        baseVersion: 2,
      }),
    ],
    [publishedCatalog('pacote-existente', 5)],
  );

  assert.equal(entries[0]?.classification, 'conflict');
});

test('item com linha por confirmar entra em unconfirmedSlugs (sem esconder o diff)', () => {
  const { entries, unconfirmedSlugs } = computeDraftDiff(
    [
      staged({
        slug: 'pacote-novo',
        entityType: 'catalog_item',
        op: 'create',
        lineConfirmed: false,
      }),
    ],
    [],
  );

  assert.deepEqual(unconfirmedSlugs, ['pacote-novo']);
  assert.equal(entries[0]?.classification, 'added');
});

test('ausência no rascunho não é remoção: o activo não staged fica sem entrada', () => {
  const { entries } = computeDraftDiff(
    [staged({ slug: 'pacote-novo', entityType: 'catalog_item', op: 'create' })],
    [publishedCatalog('permanece-publicado', 7)],
  );

  assert.deepEqual(
    entries.map((e) => e.slug),
    ['pacote-novo'],
    'nenhum archived implícito para o que não foi tocado',
  );
});

test('canonicalPayload: ordem de chaves, campos extra e details aninhados não contam', () => {
  const a = canonicalPayload('catalog_item', {
    ...CATALOG,
    details: { cameras: 4, indoor: true },
    campoExtra: 'ignorado',
  });
  const b = canonicalPayload('catalog_item', {
    availability: 'available',
    priceNote: null,
    currency: 'AOA',
    priceAmount: '150000.00',
    pricingMode: 'fixed',
    details: { indoor: true, cameras: 4 },
    summary: 'Quatro câmaras com instalação incluída.',
    name: 'Pacote CFTV 4 câmaras',
    kind: 'service',
    outroExtra: 42,
  });

  assert.equal(a, b);
});

test('canonicalPayload: preço diferente altera o canónico', () => {
  const a = canonicalPayload('catalog_item', CATALOG);
  const b = canonicalPayload('catalog_item', { ...CATALOG, priceAmount: '150001.00' });

  assert.notEqual(a, b);
});

test('canonicalPayload: doc aceita docType do payload extraído ou type da linha publicada', () => {
  const doPayload = canonicalPayload('knowledge_doc', {
    kind: 'knowledge_doc',
    docType: 'policy',
    title: 'Garantia',
    body: 'Doze meses.',
  });
  const daLinha = canonicalPayload('knowledge_doc', {
    type: 'policy',
    title: 'Garantia',
    body: 'Doze meses.',
    lineSlug: null,
  });

  assert.equal(doPayload, daLinha);
});

test('computeDraftDiff devolve entradas ordenadas por tipo e slug', () => {
  const { entries } = computeDraftDiff(
    [
      staged({ slug: 'z-doc', entityType: 'knowledge_doc', op: 'create', payload: { title: 'Z' } }),
      staged({ slug: 'a-item', entityType: 'catalog_item', op: 'create' }),
      staged({ slug: 'a-doc', entityType: 'knowledge_doc', op: 'create', payload: { title: 'A' } }),
    ],
    [],
  );

  assert.deepEqual(
    entries.map((e) => `${e.entityType}:${e.slug}`),
    ['catalog_item:a-item', 'knowledge_doc:a-doc', 'knowledge_doc:z-doc'],
  );
});
