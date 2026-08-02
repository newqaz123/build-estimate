import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canonicalUnit,
  normalizeCatalogText,
  rankCatalogMatches,
  unitsCompatible,
} from './standard-matching'

const catalog = [
  {
    id: 'std-conc',
    description: 'Structural concrete C32/40 columns',
    unit: 'm³',
    aliases: ['conc C32/40 col', '  CONC. C32/40 — columns  '],
  },
  {
    id: 'std-rebar',
    description: 'Reinforcement bar SD40 16mm',
    unit: 'ton',
    aliases: ['rebar SD40 16 mm', 'steel rebar 16mm'],
  },
  {
    id: 'std-formwork',
    description: 'Formwork slab',
    unit: 'm²',
    aliases: ['slab formwork'],
  },
]

test('normalizes punctuation, dashes, case, and whitespace', () => {
  assert.equal(normalizeCatalogText('  Conc. C32/40 — COL  '), 'conc c32/40 col')
  assert.equal(normalizeCatalogText('Steel—beam\tMain\nFrame'), 'steel beam main frame')
})

test('treats configured unit equivalents as compatible and mismatched units as incompatible', () => {
  assert.equal(unitsCompatible('m2', 'm²', { m2: 'm²' }), true)
  assert.equal(unitsCompatible('m²', 'm2', { m2: 'm²' }), true)
  assert.equal(unitsCompatible('ton', 'm³', {}), false)
})

test('ranks exact canonical matches above alias and fuzzy matches', () => {
  const result = rankCatalogMatches('Reinforcement bar SD40 16mm', 'tonne', catalog, { tonne: 'ton' })

  assert.equal(result[0].id, 'std-rebar')
  assert.equal(result[0].matchReason, 'exact')
  assert.equal(result[0].unitCompatible, true)
  assert.ok(result[0].score > result[1].score)
})

test('treats normalized aliases as alias matches', () => {
  const result = rankCatalogMatches('Rebar SD40 16 mm', 'tonne', catalog, { tonne: 'ton' })

  assert.equal(result[0].id, 'std-rebar')
  assert.equal(result[0].matchReason, 'alias')
  assert.equal(result[0].unitCompatible, true)
  assert.ok(result[0].score > result[1].score)
})

test('keeps compatible results ahead of incompatible ones when both exist', () => {
  const result = rankCatalogMatches('Slab formwork', 'm2', catalog, { m2: 'm²' })

  const compatible = result.filter((entry) => entry.unitCompatible)
  const incompatible = result.filter((entry) => !entry.unitCompatible)

  assert.ok(compatible.length > 0)
  assert.ok(incompatible.length > 0)
  assert.ok(result.indexOf(incompatible[0]) > result.indexOf(compatible[compatible.length - 1]))
})

test('keeps meaningful fuzzy matches ahead of unrelated same-unit candidates', () => {
  const result = rankCatalogMatches(
    'Slab formwork',
    'm2',
    [
      { id: 'std-related', description: 'Slab formwork installation', unit: 'ton', aliases: [] },
      { id: 'std-unrelated', description: 'Office cleaning', unit: 'm²', aliases: [] },
    ],
    { m2: 'm²' },
  )

  assert.equal(result[0].id, 'std-related')
  assert.equal(result[0].unitCompatible, false)
  assert.ok(result[0].score > result[1].score)
  assert.equal(result[1].id, 'std-unrelated')
})

test('sorts deterministically by score then description when scores tie', () => {
  const tieCatalog = [
    { id: 'std-b', description: 'Beta item', unit: 'ton', aliases: ['beta variant'] },
    { id: 'std-a', description: 'Alpha item', unit: 'ton', aliases: ['alpha variant'] },
  ]

  const result = rankCatalogMatches('item', 'ton', tieCatalog, {})

  assert.equal(result[0].description, 'Alpha item')
  assert.equal(result[1].description, 'Beta item')
})

test('returns an empty list when there are no catalog entries', () => {
  assert.deepEqual(rankCatalogMatches('Anything', 'ton', [], {}), [])
})

test('canonicalizes component units through the same unitMap used by matching', () => {
  const unitMap = {
    pcs: 'piece',
    'pc': 'piece',
    db: 'joint',
  }

  assert.equal(canonicalUnit(' Pcs. ', unitMap), 'piece')
  assert.equal(canonicalUnit('PC', unitMap), 'piece')
  assert.equal(canonicalUnit('Db', unitMap), 'joint')
  assert.equal(canonicalUnit('Lot', unitMap), 'lot')
})
