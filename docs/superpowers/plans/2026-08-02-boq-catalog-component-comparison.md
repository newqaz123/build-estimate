# Implementation Plan

## Goal

Implement per-component material/labour catalog comparison on `/compare`, preserving each component’s unit and quantity, with native-unit benchmarks, line-unit fallback, total-only lump-sum handling, and responsive Open Design–approved UI.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Plan target:** `docs/superpowers/plans/2026-08-02-boq-catalog-component-comparison.md`

**Architecture:** Extend historical pricing with component-and-unit buckets computed from approved matched BOQs. Extend comparison rows with material/labour component data, expose the result through a dependency-injected API handler, and render grouped sub-rows through a focused React component. Preserve the existing line-level catalog match and total-rate benchmark as fallback behavior.

**Tech Stack:** Next.js 16.2, React 19, TypeScript, Node test runner via `tsx --test`, existing Airtable-inspired CSS system, Open Design MCP.

### Global Constraints

- TDD (red-green-commit)
- 2-space indentation
- run `npm run check` after code changes
- never run production migrations locally
- never commit anything under `Quotation example/` (it is gitignored — private quotation PDFs)
- follow existing patterns in the repo
- currency is ฿ (Thai Baht)
- Open Design project **“BuildEstimate Compare Component UI”** is the visual source of truth for the `/compare` rendering task; the approved spec remains authoritative for behavior.

---

## Tasks

### 1. **Canonical units and native component pricing**

Add a public unit canonicalization helper and aggregate native `sourceCosts.material` / `sourceCosts.labour` rates independently by standard, component, and canonical unit.

- **Files:**
  - Modify: `src/lib/standard-matching.ts:24-70`
  - Modify: `src/lib/standard-matching.test.ts:1-81`
  - Modify: `src/lib/catalog-historical-pricing.ts:1-105`
  - Modify: `src/lib/catalog-historical-pricing.test.ts:1-101`

- **Interfaces:**
  - Consumes:
    - `BoqPricedItem.sourceCosts`
    - `createHistoricalStandardResolver(standards)`
    - workspace `unitMap`
  - Produces:

```ts
export function canonicalUnit(
  unit: string,
  unitMap: Record<string, string>,
): string

export type CatalogComponentKey = 'material' | 'labour'

export interface ComponentPriceSummary {
  unit: string
  count: number
  min: number
  average: number
  max: number
}

export interface CatalogComponentPricing {
  material: Map<string, ComponentPriceSummary>
  labour: Map<string, ComponentPriceSummary>
}

export function buildCatalogComponentPricing(
  standards: StandardEntry[],
  boqs: Boq[],
  unitMap?: Record<string, string>,
  options?: { excludeBoqId?: string },
): Map<string, CatalogComponentPricing>
```

- [ ] **Step 1: Write failing canonicalization tests**

Add to `src/lib/standard-matching.test.ts`:

```ts
import {
  canonicalUnit,
  normalizeCatalogText,
  rankCatalogMatches,
  unitsCompatible,
} from './standard-matching'

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
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx tsx --test src/lib/standard-matching.test.ts
```

Expected: FAIL because `canonicalUnit` is not exported.

- [ ] **Step 3: Export canonical unit resolution**

Replace the private `resolveUnit` usage in `src/lib/standard-matching.ts` with:

```ts
export function canonicalUnit(
  unit: string,
  unitMap: Record<string, string>,
): string {
  const normalized = normalizeUnitKey(unit)
  const mapped =
    unitMap[normalized]
    ?? unitMap[unit]
    ?? unitMap[unit.toLowerCase()]

  return mapped ? normalizeUnitKey(mapped) : normalized
}

export function unitsCompatible(
  itemUnit: string,
  catalogUnit: string,
  unitMap: Record<string, string>,
): boolean {
  return (
    canonicalUnit(itemUnit, unitMap)
    === canonicalUnit(catalogUnit, unitMap)
  )
}
```

- [ ] **Step 4: Run the canonicalization test and verify GREEN**

Run:

```bash
npx tsx --test src/lib/standard-matching.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing native component-history tests**

Extend `src/lib/catalog-historical-pricing.test.ts` with a reusable source-cost helper and a test based on the private ETG quotation shape without reading private files:

```ts
function sourceCost(
  present: boolean,
  qty: number,
  unit: string,
  rate: number,
) {
  return {
    present,
    qty,
    unit,
    rate,
    total: qty * rate,
  }
}

test('groups native material and labour rates by independent canonical units', () => {
  const priorOne = boq('prior-1', 'approved', item('stub-end-1', 4608, {
    sourceCosts: {
      material: sourceCost(true, 8, 'Pcs', 2808),
      labour: sourceCost(true, 48, 'Db', 300),
    },
  }))
  const priorTwo = boq('prior-2', 'approved', item('stub-end-2', 4500, {
    sourceCosts: {
      material: sourceCost(true, 8, 'pc', 2700),
      labour: sourceCost(true, 48, 'db', 285),
    },
  }))

  const pricing = buildCatalogComponentPricing(
    [standard],
    [priorOne, priorTwo],
    { pcs: 'piece', pc: 'piece', db: 'joint' },
  )

  assert.deepEqual(pricing.get('std-pipe')?.material.get('piece'), {
    unit: 'piece',
    count: 2,
    min: 2700,
    average: 2754,
    max: 2808,
  })
  assert.deepEqual(pricing.get('std-pipe')?.labour.get('joint'), {
    unit: 'joint',
    count: 2,
    min: 285,
    average: 292.5,
    max: 300,
  })
})

test('keeps incompatible native component units in separate buckets', () => {
  const perJoint = boq('joint', 'approved', item('joint-item', 100, {
    sourceCosts: {
      material: sourceCost(false, 0, '', 0),
      labour: sourceCost(true, 12, 'Db', 260),
    },
  }))
  const perLot = boq('lot', 'approved', item('lot-item', 100, {
    sourceCosts: {
      material: sourceCost(false, 0, '', 0),
      labour: sourceCost(true, 1, 'Lot', 1000),
    },
  }))

  const pricing = buildCatalogComponentPricing(
    [standard],
    [perJoint, perLot],
  ).get('std-pipe')

  assert.equal(pricing?.labour.get('db')?.average, 260)
  assert.equal(pricing?.labour.get('lot')?.average, 1000)
  assert.equal(pricing?.labour.size, 2)
})
```

- [ ] **Step 6: Run historical-pricing tests and verify RED**

Run:

```bash
npx tsx --test src/lib/catalog-historical-pricing.test.ts
```

Expected: FAIL because component pricing types and builder do not exist.

- [ ] **Step 7: Implement native component aggregation**

Add the following focused structures to `src/lib/catalog-historical-pricing.ts`:

```ts
import {
  canonicalUnit,
  unitsCompatible,
} from './standard-matching'

export type CatalogComponentKey = 'material' | 'labour'

export interface ComponentPriceSummary {
  unit: string
  count: number
  min: number
  average: number
  max: number
}

export interface CatalogComponentPricing {
  material: Map<string, ComponentPriceSummary>
  labour: Map<string, ComponentPriceSummary>
}

const COMPONENT_KEYS: CatalogComponentKey[] = ['material', 'labour']

function emptyComponentPricing(): CatalogComponentPricing {
  return {
    material: new Map(),
    labour: new Map(),
  }
}

function summarizeRates(
  unit: string,
  rates: number[],
): ComponentPriceSummary {
  return {
    unit,
    count: rates.length,
    min: Math.min(...rates),
    average: rates.reduce((sum, rate) => sum + rate, 0) / rates.length,
    max: Math.max(...rates),
  }
}
```

Implement `buildCatalogComponentPricing()` with these rules:

```ts
export function buildCatalogComponentPricing(
  standards: StandardEntry[],
  boqs: Boq[],
  unitMap: Record<string, string> = {},
  options: { excludeBoqId?: string } = {},
): Map<string, CatalogComponentPricing> {
  const resolver = createHistoricalStandardResolver(standards)
  const grouped = new Map<
    string,
    Record<CatalogComponentKey, Map<string, number[]>>
  >()

  for (const boq of boqs) {
    if (
      boq.status !== 'approved'
      || boq.id === options.excludeBoqId
    ) {
      continue
    }

    boq.sections.forEach((section, sectionIndex) => {
      section.items.forEach((item) => {
        if (!isPricedBoqItem(item) || item.stdStatus !== 'matched') return

        const standardId = resolver.resolve(boq.id, sectionIndex, item)
        if (!standardId || !item.sourceCosts) return

        const standardGroups = grouped.get(standardId) ?? {
          material: new Map<string, number[]>(),
          labour: new Map<string, number[]>(),
        }

        for (const key of COMPONENT_KEYS) {
          const source = item.sourceCosts[key]
          if (
            !source.present
            || source.qty <= 0
            || !source.unit.trim()
            || !Number.isFinite(source.rate)
            || source.rate <= 0
          ) {
            continue
          }

          const unit = canonicalUnit(source.unit, unitMap)
          const rates = standardGroups[key].get(unit) ?? []
          rates.push(source.rate)
          standardGroups[key].set(unit, rates)
        }

        grouped.set(standardId, standardGroups)
      })
    })
  }

  const result = new Map<string, CatalogComponentPricing>()

  for (const [standardId, groups] of grouped) {
    const pricing = emptyComponentPricing()

    for (const key of COMPONENT_KEYS) {
      for (const [unit, rates] of groups[key]) {
        pricing[key].set(unit, summarizeRates(unit, rates))
      }
    }

    result.set(standardId, pricing)
  }

  return result
}
```

- [ ] **Step 8: Run focused and full checks**

Run:

```bash
npx tsx --test \
  src/lib/standard-matching.test.ts \
  src/lib/catalog-historical-pricing.test.ts
npm run check
```

Expected: all tests pass, zero lint/type errors.

- [ ] **Step 9: Commit**

```bash
git add \
  src/lib/standard-matching.ts \
  src/lib/standard-matching.test.ts \
  src/lib/catalog-historical-pricing.ts \
  src/lib/catalog-historical-pricing.test.ts
git commit -m "feat(compare): aggregate native component pricing"
```

- **Acceptance:**
  - `Pcs`, `pc`, and configured equivalents share one canonical bucket.
  - `Db` and `Lot` remain separate.
  - Material and labour histories cannot contaminate each other.
  - Draft, unmatched, archived-standard, invalid-rate, and excluded target records do not contribute.

---

### 2. **Derived line-unit component fallback**

Extend component history to use rate-basis `costAllocation` when no native `sourceCosts` component is present.

- **Files:**
  - Modify: `src/lib/catalog-historical-pricing.ts:1-170`
  - Modify: `src/lib/catalog-historical-pricing.test.ts:1-end`

- **Interfaces:**
  - Consumes:
    - Task 1 `buildCatalogComponentPricing()`
    - `deriveSourceCostAllocation(item)`
    - `unitsCompatible(item.unit, standard.unit, unitMap)`
  - Produces:
    - Native-first historical sampling
    - Derived `line-unit` samples without double-counting native evidence

- [ ] **Step 1: Write failing fallback tests**

Add:

```ts
test('uses rate-basis allocations as line-unit component history', () => {
  const allocated = boq('allocated', 'approved', item('allocated-item', 100, {
    unit: 'm3',
    qty: 10,
    total: 1000,
    sourceCosts: undefined,
    costAllocation: {
      basis: 'rate',
      material: 70,
      labour: 30,
      origin: 'manual',
    },
  }))

  const pricing = buildCatalogComponentPricing(
    [{ ...standard, unit: 'm³' }],
    [allocated],
    { m3: 'm³' },
  ).get('std-pipe')

  assert.equal(pricing?.material.get('m³')?.average, 70)
  assert.equal(pricing?.labour.get('m³')?.average, 30)
})

test('does not divide rate-basis allocations by item quantity', () => {
  const allocated = boq('allocated', 'approved', item('allocated-item', 100, {
    qty: 10,
    total: 1000,
    costAllocation: {
      basis: 'rate',
      material: 60,
      labour: 40,
      origin: 'manual',
    },
  }))

  const pricing = buildCatalogComponentPricing(
    [standard],
    [allocated],
  ).get('std-pipe')

  assert.equal(pricing?.material.get('pcs')?.average, 60)
  assert.equal(pricing?.labour.get('pcs')?.average, 40)
})

test('native evidence wins and is not duplicated by costAllocation', () => {
  const native = boq('native', 'approved', item('native-item', 100, {
    sourceCosts: {
      material: sourceCost(true, 8, 'Pcs', 2808),
      labour: sourceCost(true, 48, 'Db', 300),
    },
    costAllocation: {
      basis: 'rate',
      material: 50,
      labour: 50,
      origin: 'source',
    },
  }))

  const pricing = buildCatalogComponentPricing(
    [standard],
    [native],
  ).get('std-pipe')

  assert.equal(pricing?.material.get('pcs')?.count, 1)
  assert.equal(pricing?.material.get('pcs')?.average, 2808)
  assert.equal(pricing?.labour.get('db')?.average, 300)
})

test('skips total-basis, zero-quantity, non-finite, and lump-sum fallbacks', () => {
  const invalid = [
    item('zero-qty', 100, {
      qty: 0,
      costAllocation: {
        basis: 'rate',
        material: 60,
        labour: 40,
        origin: 'manual',
      },
    }),
    item('non-finite', 100, {
      costAllocation: {
        basis: 'rate',
        material: Number.NaN,
        labour: 40,
        origin: 'manual',
      },
    }),
    item('lump', 100, {
      type: 'lump_sum',
      costAllocation: {
        basis: 'total',
        material: 60,
        labour: 40,
        origin: 'manual',
      },
    }),
  ]

  const history = invalid.map((entry, index) =>
    boq(`invalid-${index}`, 'approved', entry),
  )

  const pricing = buildCatalogComponentPricing([standard], history)

  assert.equal(pricing.get('std-pipe'), undefined)
})
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
npx tsx --test src/lib/catalog-historical-pricing.test.ts
```

Expected: fallback assertions fail because only native `sourceCosts` are read.

- [ ] **Step 3: Implement native-first sample selection**

Import:

```ts
import { deriveSourceCostAllocation } from './boq-cost-allocation'
```

Add:

```ts
function hasNativeComponentEvidence(item: BoqPricedItem): boolean {
  return Boolean(
    item.sourceCosts?.material.present
    || item.sourceCosts?.labour.present,
  )
}

function derivedComponentRates(
  item: BoqPricedItem,
  standard: StandardEntry,
  unitMap: Record<string, string>,
): Partial<Record<CatalogComponentKey, {
  unit: string
  rate: number
}>> {
  if (
    hasNativeComponentEvidence(item)
    || item.type === 'lump_sum'
    || item.qty <= 0
    || !unitsCompatible(item.unit, standard.unit, unitMap)
  ) {
    return {}
  }

  const allocation = deriveSourceCostAllocation(item)
  if (!allocation || allocation.basis !== 'rate') return {}

  const unit = canonicalUnit(item.unit, unitMap)
  const result: Partial<Record<CatalogComponentKey, {
    unit: string
    rate: number
  }>> = {}

  for (const key of COMPONENT_KEYS) {
    const rate = allocation[key]
    if (Number.isFinite(rate) && rate > 0) {
      result[key] = { unit, rate }
    }
  }

  return result
}
```

In `buildCatalogComponentPricing()`, retain native processing first. When no native component is present, resolve the standard and add returned derived rates.

**Important:** `BoqCostAllocation` with `basis: 'rate'` already stores per-line-unit component rates. Do not divide those values by `item.qty`.

- [ ] **Step 4: Run focused tests and verify GREEN**

```bash
npx tsx --test src/lib/catalog-historical-pricing.test.ts
npm run check
```

Expected: all component pricing and existing historical pricing tests pass.

- [ ] **Step 5: Commit**

```bash
git add \
  src/lib/catalog-historical-pricing.ts \
  src/lib/catalog-historical-pricing.test.ts
git commit -m "feat(compare): derive component history from allocations"
```

- **Acceptance:**
  - Native evidence always wins.
  - Rate-basis allocations use the allocation values directly.
  - Zero-value components do not create misleading benchmark buckets.
  - Total-basis and lump-sum allocations remain total-only.

---

### 3. **Extend BOQ comparison rows with the full component matrix**

Add stable material/labour comparison records to every priced row and attach matching component-unit benchmark buckets.

- **Files:**
  - Modify: `src/lib/boq-catalog-comparison.ts:1-69`
  - Modify: `src/lib/boq-catalog-comparison.test.ts:1-end`

- **Interfaces:**
  - Consumes:
    - `buildCatalogComponentPricing()`
    - `canonicalUnit()`
    - `deriveSourceCostAllocation()`
  - Produces:

```ts
export type ComponentKey = CatalogComponentKey

export interface ComponentComparison {
  present: boolean
  unit: string
  qty: number | null
  rate: number | null
  total: number | null
  basis: 'native' | 'line-unit' | 'none'
  benchmark: ComponentPriceSummary | null
  variancePct: number | null
}

export type ComponentComparisonMap =
  Record<ComponentKey, ComponentComparison>

export interface BoqCatalogComparisonRow {
  // existing properties remain
  components: ComponentComparisonMap
}
```

- [ ] **Step 1: Add failing native and partial-component tests**

Add ETG-shaped fixtures:

```ts
function nativeCost(
  present: boolean,
  qty: number,
  unit: string,
  rate: number,
) {
  return {
    present,
    qty,
    unit,
    rate,
    total: qty * rate,
  }
}

test('compares native material and labour on independent component units', () => {
  const target = boq('target', 36864, 'std-1')
  target.sections[0].items[0] = {
    ...target.sections[0].items[0],
    desc: 'STUB-END 6B BS4',
    unit: 'Lot',
    qty: 1,
    rate: 36864,
    total: 36864,
    sourceCosts: {
      material: nativeCost(true, 8, 'Pcs', 2808),
      labour: nativeCost(true, 48, 'Db', 300),
    },
  }

  const prior = boq('prior', 35000, 'std-1')
  prior.sections[0].items[0] = {
    ...prior.sections[0].items[0],
    sourceCosts: {
      material: nativeCost(true, 8, 'Pcs', 2750),
      labour: nativeCost(true, 48, 'Db', 285),
    },
  }

  const row = compareBoqToCatalog(
    target,
    [standard],
    [target, prior],
  ).rows[0]

  assert.deepEqual(row.components.material, {
    present: true,
    unit: 'Pcs',
    qty: 8,
    rate: 2808,
    total: 22464,
    basis: 'native',
    benchmark: {
      unit: 'pcs',
      count: 1,
      min: 2750,
      average: 2750,
      max: 2750,
    },
    variancePct: ((2808 - 2750) / 2750) * 100,
  })

  assert.equal(row.components.labour.unit, 'Db')
  assert.equal(row.components.labour.benchmark?.unit, 'db')
  assert.equal(row.components.labour.variancePct, ((300 - 285) / 285) * 100)
})

test('preserves a missing component instead of inventing a zero-rate row', () => {
  const target = boq('target', 5368, 'std-1')
  target.sections[0].items[0] = {
    ...target.sections[0].items[0],
    sourceCosts: {
      material: nativeCost(true, 8, 'Pcs', 671),
      labour: nativeCost(false, 0, '', 0),
    },
  }

  const row = compareBoqToCatalog(target, [standard], [target]).rows[0]

  assert.equal(row.components.material.present, true)
  assert.deepEqual(row.components.labour, {
    present: false,
    unit: '',
    qty: null,
    rate: null,
    total: null,
    basis: 'none',
    benchmark: null,
    variancePct: null,
  })
})
```

- [ ] **Step 2: Add failing derived, lump-sum, and no-history tests**

```ts
test('derives target component rates from a rate-basis allocation', () => {
  const target = boq('target', 100, 'std-1')
  target.sections[0].items[0] = {
    ...target.sections[0].items[0],
    qty: 10,
    rate: 100,
    total: 1000,
    sourceCosts: undefined,
    costAllocation: {
      basis: 'rate',
      material: 60,
      labour: 40,
      origin: 'manual',
    },
  }

  const row = compareBoqToCatalog(target, [standard], [target]).rows[0]

  assert.deepEqual(row.components.material, {
    present: true,
    unit: 'm3',
    qty: 10,
    rate: 60,
    total: 600,
    basis: 'line-unit',
    benchmark: null,
    variancePct: null,
  })
  assert.equal(row.components.labour.total, 400)
})

test('keeps lump-sum lines total-only and preserves legacy benchmarking', () => {
  const target = boq('target', 6000, 'std-1')
  target.sections[0].items[0] = {
    ...target.sections[0].items[0],
    type: 'lump_sum',
    unit: 'Lot',
    qty: 1,
    rate: 6000,
    total: 6000,
    costComponent: 'lump_sum',
  }

  const row = compareBoqToCatalog(target, [standard], [
    target,
    boq('prior', 5800, 'std-1'),
  ]).rows[0]

  assert.equal(row.components.material.present, false)
  assert.equal(row.components.labour.present, false)
  assert.equal(row.benchmark?.average, 5800)
})

test('returns a component with null benchmark when its unit has no history', () => {
  const target = boq('target', 275, 'std-1')
  target.sections[0].items[0] = {
    ...target.sections[0].items[0],
    sourceCosts: {
      material: nativeCost(true, 80, 'Pcs', 275),
      labour: nativeCost(false, 0, '', 0),
    },
  }

  const material = compareBoqToCatalog(
    target,
    [standard],
    [target],
  ).rows[0].components.material

  assert.equal(material.present, true)
  assert.equal(material.benchmark, null)
  assert.equal(material.variancePct, null)
})
```

- [ ] **Step 3: Run comparison tests and verify RED**

```bash
npx tsx --test src/lib/boq-catalog-comparison.test.ts
```

Expected: FAIL because `components` does not exist.

- [ ] **Step 4: Add component types and derivation helpers**

Add:

```ts
import { deriveSourceCostAllocation } from './boq-cost-allocation'
import {
  buildCatalogComponentPricing,
  buildCatalogHistoricalPricing,
  createHistoricalStandardResolver,
  type CatalogComponentKey,
  type ComponentPriceSummary,
} from './catalog-historical-pricing'
import { canonicalUnit, rankCatalogMatches } from './standard-matching'

export type ComponentKey = CatalogComponentKey

export interface ComponentComparison {
  present: boolean
  unit: string
  qty: number | null
  rate: number | null
  total: number | null
  basis: 'native' | 'line-unit' | 'none'
  benchmark: ComponentPriceSummary | null
  variancePct: number | null
}

export type ComponentComparisonMap =
  Record<ComponentKey, ComponentComparison>

function absentComponent(): ComponentComparison {
  return {
    present: false,
    unit: '',
    qty: null,
    rate: null,
    total: null,
    basis: 'none',
    benchmark: null,
    variancePct: null,
  }
}
```

Implement native-first target derivation:

```ts
function deriveTargetComponents(
  item: BoqPricedItem,
): ComponentComparisonMap {
  const components: ComponentComparisonMap = {
    material: absentComponent(),
    labour: absentComponent(),
  }

  const hasNativeEvidence = Boolean(
    item.sourceCosts?.material.present
    || item.sourceCosts?.labour.present,
  )

  if (hasNativeEvidence && item.sourceCosts) {
    for (const key of ['material', 'labour'] as const) {
      const source = item.sourceCosts[key]
      if (
        !source.present
        || source.qty <= 0
        || !source.unit.trim()
        || !Number.isFinite(source.rate)
        || source.rate <= 0
      ) {
        continue
      }

      components[key] = {
        present: true,
        unit: source.unit,
        qty: source.qty,
        rate: source.rate,
        total: source.total,
        basis: 'native',
        benchmark: null,
        variancePct: null,
      }
    }

    return components
  }

  if (item.type === 'lump_sum' || item.qty <= 0) return components

  const allocation = deriveSourceCostAllocation(item)
  if (!allocation || allocation.basis !== 'rate') return components

  for (const key of ['material', 'labour'] as const) {
    const rate = allocation[key]
    if (!Number.isFinite(rate) || rate <= 0) continue

    components[key] = {
      present: true,
      unit: item.unit,
      qty: item.qty,
      rate,
      total: rate * item.qty,
      basis: 'line-unit',
      benchmark: null,
      variancePct: null,
    }
  }

  return components
}
```

- [ ] **Step 5: Attach matching benchmark buckets**

Within `compareBoqToCatalog()`:

```ts
const componentPricing = buildCatalogComponentPricing(
  active,
  allBoqs,
  unitMap,
  { excludeBoqId: target.id },
)
```

After resolving `candidate` and `matchedStandardId`:

```ts
const components = deriveTargetComponents(item)
const matchedComponentPricing =
  candidate && matchedStandardId === candidate.standardId
    ? componentPricing.get(candidate.standardId)
    : undefined

for (const key of ['material', 'labour'] as const) {
  const component = components[key]
  if (!component.present || component.rate === null) continue

  const unit = canonicalUnit(component.unit, unitMap)
  const componentBenchmark =
    matchedComponentPricing?.[key].get(unit)
    ?? null

  components[key] = {
    ...component,
    benchmark: componentBenchmark,
    variancePct:
      componentBenchmark && componentBenchmark.average > 0
        ? (
            (component.rate - componentBenchmark.average)
            / componentBenchmark.average
          ) * 100
        : null,
  }
}
```

Add `components` to each returned row without removing `benchmark` or `variancePct`.

- [ ] **Step 6: Run focused and full checks**

```bash
npx tsx --test \
  src/lib/catalog-historical-pricing.test.ts \
  src/lib/boq-catalog-comparison.test.ts
npm run check
```

Expected: all existing and new comparison tests pass.

- [ ] **Step 7: Commit**

```bash
git add \
  src/lib/boq-catalog-comparison.ts \
  src/lib/boq-catalog-comparison.test.ts
git commit -m "feat(compare): compare material and labour rates"
```

- **Acceptance:**
  - All six §6 matrix cases return deterministic component maps.
  - Native different-unit data remains independent.
  - Partial components remain explicitly absent.
  - Unmatched target candidates do not receive historical baselines.
  - Existing total-rate behavior remains backward compatible.

---

### 4. **Testable comparison API response**

Extract a dependency-injected handler and prove the HTTP response exposes component data without weakening authentication or error handling.

- **Files:**
  - Create: `src/app/api/boqs/[id]/comparison/handler.ts`
  - Create: `src/app/api/boqs/[id]/comparison/comparison-api.test.ts`
  - Modify: `src/app/api/boqs/[id]/comparison/route.ts:1-26`

- **Interfaces:**
  - Consumes: `compareBoqToCatalog()`
  - Produces:

```ts
export interface ComparisonHandlerDependencies {
  authenticate: () => Promise<{ user?: unknown } | null>
  loadBoqs: () => Promise<Boq[]>
  loadStandards: () => Promise<StandardEntry[]>
  loadUnitMap: () => Promise<Record<string, string>>
}

export function createComparisonGetHandler(
  dependencies: ComparisonHandlerDependencies,
): (
  request: Request,
  context: { params: Promise<{ id: string }> },
) => Promise<Response>
```

- [ ] **Step 1: Write failing handler tests**

Create `comparison-api.test.ts`:

```ts
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Boq } from '@/lib/boq-schema'
import type { StandardEntry } from '@/lib/standard-schema'
import { createComparisonGetHandler } from './handler'

const now = '2026-08-02T00:00:00.000Z'

const standard: StandardEntry = {
  id: 'std-valve',
  description: 'STUB-END 6B BS4',
  unit: 'Lot',
  aliases: [],
  sourceBoqCount: 1,
  createdAt: now,
  updatedAt: now,
}

function boq(id: string, materialRate: number): Boq {
  return {
    id,
    project: 'Valve installation',
    vendor: 'E.T.G.',
    workType: 'MEP',
    date: '2026-06-04',
    totalItems: 1,
    grandTotal: 36864,
    status: 'approved',
    stdStatus: 'complete',
    sections: [{
      header: 'E&M',
      items: [{
        id: `${id}-item`,
        desc: 'STUB-END 6B BS4',
        unit: 'Lot',
        qty: 1,
        rate: 36864,
        total: 36864,
        type: 'unit',
        stdStatus: 'matched',
        stdId: 'std-valve',
        sourceCosts: {
          material: {
            present: true,
            qty: 8,
            unit: 'Pcs',
            rate: materialRate,
            total: materialRate * 8,
          },
          labour: {
            present: true,
            qty: 48,
            unit: 'Db',
            rate: 300,
            total: 14400,
          },
        },
      }],
    }],
    createdAt: now,
    updatedAt: now,
  }
}

const context = {
  params: Promise.resolve({ id: 'target' }),
}

test('comparison API requires authentication before loading data', async () => {
  let loaded = false
  const GET = createComparisonGetHandler({
    authenticate: async () => null,
    loadBoqs: async () => {
      loaded = true
      return []
    },
    loadStandards: async () => [],
    loadUnitMap: async () => ({}),
  })

  const response = await GET(
    new Request('http://localhost/api/boqs/target/comparison'),
    context,
  )

  assert.equal(response.status, 401)
  assert.equal(loaded, false)
})

test('comparison API returns component comparison records', async () => {
  const GET = createComparisonGetHandler({
    authenticate: async () => ({ user: {} }),
    loadBoqs: async () => [boq('target', 2808), boq('prior', 2750)],
    loadStandards: async () => [standard],
    loadUnitMap: async () => ({}),
  })

  const response = await GET(
    new Request('http://localhost/api/boqs/target/comparison'),
    context,
  )
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.boqId, 'target')
  assert.equal(body.rows[0].components.material.unit, 'Pcs')
  assert.equal(body.rows[0].components.material.benchmark.average, 2750)
  assert.equal(body.rows[0].components.labour.unit, 'Db')
})

test('comparison API returns 404 for a missing BOQ', async () => {
  const GET = createComparisonGetHandler({
    authenticate: async () => ({ user: {} }),
    loadBoqs: async () => [],
    loadStandards: async () => [standard],
    loadUnitMap: async () => ({}),
  })

  const response = await GET(
    new Request('http://localhost/api/boqs/target/comparison'),
    context,
  )

  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'BOQ not found' })
})

test('comparison API returns a non-leaking 500', async (t) => {
  t.mock.method(console, 'error', () => {})

  const GET = createComparisonGetHandler({
    authenticate: async () => ({ user: {} }),
    loadBoqs: async () => {
      throw new Error('FIREBASE_PROJECT_ID=production-secret')
    },
    loadStandards: async () => [],
    loadUnitMap: async () => ({}),
  })

  const response = await GET(
    new Request('http://localhost/api/boqs/target/comparison'),
    context,
  )
  const body = await response.json()

  assert.equal(response.status, 500)
  assert.deepEqual(body, { error: 'Internal server error' })
  assert.doesNotMatch(JSON.stringify(body), /FIREBASE|production-secret/)
})
```

- [ ] **Step 2: Run API test and verify RED**

```bash
npx tsx --test \
  src/app/api/boqs/\[id\]/comparison/comparison-api.test.ts
```

Expected: FAIL because `handler.ts` does not exist.

- [ ] **Step 3: Implement the handler**

Create `handler.ts`:

```ts
import type { Boq } from '@/lib/boq-schema'
import { compareBoqToCatalog } from '@/lib/boq-catalog-comparison'
import type { StandardEntry } from '@/lib/standard-schema'

export interface ComparisonHandlerDependencies {
  authenticate: () => Promise<{ user?: unknown } | null>
  loadBoqs: () => Promise<Boq[]>
  loadStandards: () => Promise<StandardEntry[]>
  loadUnitMap: () => Promise<Record<string, string>>
}

export function createComparisonGetHandler({
  authenticate,
  loadBoqs,
  loadStandards,
  loadUnitMap,
}: ComparisonHandlerDependencies) {
  return async function GET(
    _request: Request,
    { params }: { params: Promise<{ id: string }> },
  ): Promise<Response> {
    try {
      const session = await authenticate()
      if (!session?.user) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }

      const { id } = await params
      const [boqs, standards, unitMap] = await Promise.all([
        loadBoqs(),
        loadStandards(),
        loadUnitMap(),
      ])
      const target = boqs.find((boq) => boq.id === id)

      if (!target) {
        return Response.json({ error: 'BOQ not found' }, { status: 404 })
      }

      return Response.json(
        compareBoqToCatalog(target, standards, boqs, unitMap),
      )
    } catch (error) {
      console.error('Error comparing BOQ to catalog:', error)
      return Response.json(
        { error: 'Internal server error' },
        { status: 500 },
      )
    }
  }
}
```

- [ ] **Step 4: Wire the production route**

Replace route-local logic with:

```ts
import { auth } from '@/lib/auth'
import { getDocument, queryCollection } from '@/lib/db'
import type { Boq } from '@/lib/boq-schema'
import type { StandardEntry } from '@/lib/standard-schema'
import { createComparisonGetHandler } from './handler'

export const GET = createComparisonGetHandler({
  authenticate: auth,
  loadBoqs: async () => (
    await queryCollection<Boq>('boqs')
  ).docs,
  loadStandards: async () => (
    await queryCollection<StandardEntry>('standards')
  ).docs,
  loadUnitMap: async () => {
    const settings = await getDocument<{
      fuzzy?: {
        unitMap?: Record<string, string>
      }
    }>('settings', 'workspace')

    return settings?.fuzzy?.unitMap ?? {}
  },
})
```

- [ ] **Step 5: Run focused and full checks**

```bash
npx tsx --test \
  src/app/api/boqs/\[id\]/comparison/comparison-api.test.ts
npm run check
```

Expected: authentication, 404, success shape, and 500 tests pass.

- [ ] **Step 6: Commit**

```bash
git add \
  src/app/api/boqs/\[id\]/comparison/handler.ts \
  src/app/api/boqs/\[id\]/comparison/comparison-api.test.ts \
  src/app/api/boqs/\[id\]/comparison/route.ts
git commit -m "refactor(compare): expose testable comparison API"
```

- **Acceptance:**
  - Existing endpoint URL and authorization behavior remain unchanged.
  - Component records survive JSON serialization.
  - Infrastructure errors never leak details.

---

### 5. **Desktop comparison UI and summary band**

Create a focused table component for Option A, preserve matching actions, and replace the old summary with component-aware totals.

- **Files:**
  - Create: `src/components/boq-catalog-component-table.tsx`
  - Create: `src/components/boq-catalog-component-table.test.tsx`
  - Modify: `src/app/(authenticated)/compare/page.tsx:1-177`
  - Modify: `src/app/(authenticated)/compare/compare-pricing-ui.test.ts:1-12`

- **Interfaces:**
  - Consumes:
    - Task 3 `BoqCatalogComparisonRow`
    - Open Design project **“BuildEstimate Compare Component UI”**
  - Produces:

```ts
export interface ComponentComparisonSummary {
  materialVariancePct: number | null
  labourVariancePct: number | null
  componentLines: number
  totalLines: number
  boqTotal: number
}

export function summarizeComponentComparison(
  rows: BoqCatalogComparisonRow[],
  boqTotal: number,
): ComponentComparisonSummary

export function BoqCatalogComponentTable(props: {
  rows: BoqCatalogComparisonRow[]
  onMatch: (row: BoqCatalogComparisonRow) => void
}): React.ReactNode
```

- [ ] **Step 1: Review the Open Design output**

Before coding, inspect the latest successful output for **“BuildEstimate Compare Component UI”**. Record the final spacing, class naming, summary-card copy, grouping, and 390px behavior in the task notes.

If visual output conflicts with the approved spec, preserve spec behavior and apply only visual treatments from Open Design.

- [ ] **Step 2: Write failing summary tests**

Create `boq-catalog-component-table.test.tsx` with fixtures that do not import private quotation files:

```tsx
import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type {
  BoqCatalogComparisonRow,
  ComponentComparison,
} from '@/lib/boq-catalog-comparison'
import {
  BoqCatalogComponentTable,
  summarizeComponentComparison,
} from './boq-catalog-component-table'

function component(
  overrides: Partial<ComponentComparison> = {},
): ComponentComparison {
  return {
    present: true,
    unit: 'Pcs',
    qty: 8,
    rate: 2808,
    total: 22464,
    basis: 'native',
    benchmark: {
      unit: 'pcs',
      count: 14,
      min: 2600,
      average: 2750,
      max: 2950,
    },
    variancePct: ((2808 - 2750) / 2750) * 100,
    ...overrides,
  }
}

function row(
  overrides: Partial<BoqCatalogComparisonRow> = {},
): BoqCatalogComparisonRow {
  return {
    key: '0-item',
    sectionIndex: 0,
    section: 'E&M',
    item: {
      id: 'item',
      desc: 'STUB-END 6B BS4',
      unit: 'Lot',
      qty: 1,
      rate: 36864,
      total: 36864,
      type: 'unit',
      stdStatus: 'matched',
      stdId: 'std-1',
    },
    identity: { itemId: 'item' },
    candidate: {
      standardId: 'std-1',
      description: 'STUB-END 6B BS4',
      unit: 'Lot',
      score: 2000,
      matchReason: 'linked',
    },
    benchmark: null,
    variancePct: null,
    components: {
      material: component(),
      labour: component({
        unit: 'Db',
        qty: 48,
        rate: 300,
        total: 14400,
        benchmark: {
          unit: 'db',
          count: 11,
          min: 270,
          average: 285,
          max: 310,
        },
        variancePct: ((300 - 285) / 285) * 100,
      }),
    },
    ...overrides,
  }
}

test('summary weights component variance by benchmark cost exposure', () => {
  const summary = summarizeComponentComparison([row()], 36864)

  assert.equal(
    summary.materialVariancePct,
    ((2808 * 8 - 2750 * 8) / (2750 * 8)) * 100,
  )
  assert.equal(
    summary.labourVariancePct,
    ((300 * 48 - 285 * 48) / (285 * 48)) * 100,
  )
  assert.equal(summary.componentLines, 1)
  assert.equal(summary.totalLines, 1)
  assert.equal(summary.boqTotal, 36864)
})
```

- [ ] **Step 3: Write failing render-state tests**

```tsx
test('renders independent material and labour sub-rows', () => {
  const html = renderToStaticMarkup(createElement(
    BoqCatalogComponentTable,
    {
      rows: [row()],
      onMatch: () => undefined,
    },
  ))

  assert.match(html, /STUB-END 6B BS4/)
  assert.match(html, /Material/)
  assert.match(html, /8/)
  assert.match(html, /Pcs/)
  assert.match(html, /฿2,808/)
  assert.match(html, /Labour/)
  assert.match(html, /48/)
  assert.match(html, /Db/)
  assert.match(html, /฿300/)
  assert.match(html, /14 approved rates/)
  assert.match(html, /Change match/)
})

test('renders absent, no-history, and lump-sum states explicitly', () => {
  const materialOnly = row({
    key: 'material-only',
    components: {
      material: component({ benchmark: null, variancePct: null }),
      labour: component({
        present: false,
        unit: '',
        qty: null,
        rate: null,
        total: null,
        basis: 'none',
        benchmark: null,
        variancePct: null,
      }),
    },
  })

  const lumpSum = row({
    key: 'lump',
    item: {
      ...row().item,
      desc: 'TOOLS AND CONSUMABLE',
      type: 'lump_sum',
      qty: 1,
      unit: 'Lot',
      rate: 6000,
      total: 6000,
    },
    benchmark: {
      count: 9,
      min: 5000,
      average: 5800,
      max: 6500,
    },
    variancePct: ((6000 - 5800) / 5800) * 100,
    components: {
      material: component({
        present: false,
        unit: '',
        qty: null,
        rate: null,
        total: null,
        basis: 'none',
        benchmark: null,
        variancePct: null,
      }),
      labour: component({
        present: false,
        unit: '',
        qty: null,
        rate: null,
        total: null,
        basis: 'none',
        benchmark: null,
        variancePct: null,
      }),
    },
  })

  const html = renderToStaticMarkup(createElement(
    BoqCatalogComponentTable,
    {
      rows: [materialOnly, lumpSum],
      onMatch: () => undefined,
    },
  ))

  assert.match(html, /not in source quotation/)
  assert.match(html, /No prior approved rates/)
  assert.match(html, /Lump sum/)
  assert.match(html, /compared on total only/)
})
```

- [ ] **Step 4: Run tests and verify RED**

```bash
npx tsx --test \
  src/components/boq-catalog-component-table.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 5: Implement weighted summary**

In `boq-catalog-component-table.tsx`:

```tsx
function weightedVariance(
  rows: BoqCatalogComparisonRow[],
  key: 'material' | 'labour',
): number | null {
  let actual = 0
  let baseline = 0

  for (const row of rows) {
    const component = row.components[key]
    if (
      !component.present
      || component.qty === null
      || component.rate === null
      || component.benchmark === null
      || component.qty <= 0
      || component.benchmark.average <= 0
    ) {
      continue
    }

    actual += component.rate * component.qty
    baseline += component.benchmark.average * component.qty
  }

  return baseline > 0
    ? ((actual - baseline) / baseline) * 100
    : null
}

export function summarizeComponentComparison(
  rows: BoqCatalogComparisonRow[],
  boqTotal: number,
): ComponentComparisonSummary {
  return {
    materialVariancePct: weightedVariance(rows, 'material'),
    labourVariancePct: weightedVariance(rows, 'labour'),
    componentLines: rows.filter((row) =>
      row.components.material.present
      || row.components.labour.present,
    ).length,
    totalLines: rows.length,
    boqTotal,
  }
}
```

- [ ] **Step 6: Implement grouped table rendering**

Use one `<tbody className="compare-component-group">` per BOQ line. Required desktop columns:

1. BOQ item and matched catalog description
2. Component
3. Qty
4. Unit
5. BOQ rate
6. Catalog average with min/max/count
7. Variance
8. Match action

Required behaviors:

```tsx
const COMPONENT_KEYS = ['material', 'labour'] as const

function varianceClass(
  value: number | null,
  totalOnly = false,
): string {
  if (totalOnly) return 'compare-component-variance-total'
  if (value === null) return 'compare-component-variance-new'
  if (Math.abs(value) < 0.05) return 'compare-component-variance-at'
  return value > 0
    ? 'compare-component-variance-above'
    : 'compare-component-variance-below'
}

function displayComponents(row: BoqCatalogComparisonRow) {
  const present = COMPONENT_KEYS.filter(
    (key) => row.components[key].present,
  )

  return present.length === 1 ? COMPONENT_KEYS : present
}
```

For a partial component, render:

```tsx
<tr className="compare-component-row compare-component-row-missing">
  <td data-label="Component">
    <span className="compare-component-tag compare-component-tag-missing">
      Labour
    </span>
  </td>
  <td data-label="Component data" colSpan={5}>
    — not in source quotation
  </td>
</tr>
```

For a no-history component, render exactly:

```tsx
<span className="compare-component-no-history">
  No prior approved rates
</span>
```

For lump-sum rows, use existing `row.benchmark` and `row.variancePct`, show the amber `Lump sum` tag, and include “No material/labour split in source — compared on total only.”

Preserve `Match` / `Change match` by calling `onMatch(row)`.

- [ ] **Step 7: Integrate the component into `/compare`**

In `page.tsx`:

- Import `BoqCatalogComponentTable` and `summarizeComponentComparison`.
- Remove the old `matched` / `benchmarked` stat calculations.
- Calculate:

```tsx
const comparisonSummary = summarizeComponentComparison(
  rows,
  selected?.grandTotal ?? 0,
)
```

- Replace the three old stats with four cards:
  - Material rate vs catalog
  - Labour rate vs catalog
  - Lines with component data
  - BOQ total
- Render:

```tsx
<BoqCatalogComponentTable
  rows={rows}
  onMatch={setMatchTarget}
/>
```

Keep upload, preparation, review, retry, empty, and `CatalogMatchModal` flows unchanged.

- [ ] **Step 8: Update the compare page contract test**

Replace old-only copy assertions in `compare-pricing-ui.test.ts` with checks for:

```ts
test('compare renders component summary and delegates grouped rows', () => {
  assert.match(source, /Material rate vs catalog/)
  assert.match(source, /Labour rate vs catalog/)
  assert.match(source, /Lines with component data/)
  assert.match(source, /BOQ total/)
  assert.match(source, /BoqCatalogComponentTable/)
  assert.match(source, /onMatch=\{setMatchTarget\}/)
  assert.match(source, /Review, match & approve/)
})
```

- [ ] **Step 9: Run focused and full checks**

```bash
npx tsx --test \
  src/components/boq-catalog-component-table.test.tsx \
  src/app/\(authenticated\)/compare/compare-pricing-ui.test.ts
npm run check
```

Expected: all render, copy, and legacy-flow assertions pass.

- [ ] **Step 10: Commit**

```bash
git add \
  src/components/boq-catalog-component-table.tsx \
  src/components/boq-catalog-component-table.test.tsx \
  src/app/\(authenticated\)/compare/page.tsx \
  src/app/\(authenticated\)/compare/compare-pricing-ui.test.ts
git commit -m "feat(compare): render material and labour benchmarks"
```

- **Acceptance:**
  - Different units appear as independent sub-rows.
  - Material-only and labour-only items show explicit missing-component states.
  - Lump-sum and no-history states are understandable without ambiguous dashes.
  - Catalog matching remains available.
  - Summary percentages use baseline-cost weighting, avoiding invalid averaging across unlike units.

---

### 6. **Responsive styling, accessibility, and final visual verification**

Apply Open Design visual tokens, collapse grouped rows into cards at mobile widths, and complete regression and browser verification.

- **Files:**
  - Modify: `src/app/globals.css:703-766`
  - Modify: `src/components/boq-catalog-component-table.tsx`
  - Modify: `src/components/boq-catalog-component-table.test.tsx`
  - Modify: `src/app/(authenticated)/compare/compare-pricing-ui.test.ts`

- **Interfaces:**
  - Consumes: Task 5 grouped `<tbody>` and `data-label` structure
  - Produces:
    - 1440px desktop table
    - 390px stacked component cards
    - Keyboard-accessible horizontal desktop region

- [ ] **Step 1: Write failing responsive-contract tests**

Add source assertions:

```ts
import { readFileSync } from 'node:fs'

const tableSource = readFileSync(
  new URL('../../../components/boq-catalog-component-table.tsx', import.meta.url),
  'utf8',
)
const styles = readFileSync(
  new URL('../../globals.css', import.meta.url),
  'utf8',
)

test('component comparison exposes mobile labels and card breakpoints', () => {
  assert.match(tableSource, /className="compare-component-group"/)
  assert.match(tableSource, /data-label="Component"/)
  assert.match(tableSource, /data-label="Quantity"/)
  assert.match(tableSource, /data-label="Catalog average"/)
  assert.match(tableSource, /data-label="Variance"/)
  assert.match(styles, /@media \(max-width: 920px\)[\s\S]*\.compare-component-group/)
  assert.match(styles, /@media \(max-width: 560px\)[\s\S]*\.compare-component-row/)
})
```

Extend the render test:

```tsx
assert.match(html, /aria-label="BOQ material and labour comparison"/)
assert.match(html, /tabindex="0"/)
assert.match(html, /data-label="Catalog average"/)
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npx tsx --test \
  src/components/boq-catalog-component-table.test.tsx \
  src/app/\(authenticated\)/compare/compare-pricing-ui.test.ts
```

Expected: FAIL until the final semantic attributes and CSS selectors exist.

- [ ] **Step 3: Add desktop styling from Open Design**

Add focused selectors inside the existing Compare section:

```css
.compare-component-table-wrap {
  width: 100%;
  max-width: 100%;
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-brand-sm);
  background: var(--surface);
}

.compare-component-table {
  width: 100%;
  min-width: 980px;
  border-collapse: collapse;
}

.compare-component-group + .compare-component-group {
  border-top: 2px solid var(--border);
}

.compare-component-item {
  min-width: 220px;
  vertical-align: top;
}

.compare-component-tag {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: var(--radius-pill);
  font-size: 10px;
  font-weight: 700;
}

.compare-component-tag-material {
  color: var(--accent);
  background: color-mix(in oklab, var(--accent) 12%, transparent);
}

.compare-component-tag-labour {
  color: var(--success);
  background: color-mix(in oklab, var(--success) 12%, transparent);
}

.compare-component-tag-lump {
  color: color-mix(in oklab, var(--warn), black 35%);
  background: color-mix(in oklab, var(--warn) 15%, transparent);
}

.compare-component-variance-above {
  color: var(--danger);
  font-weight: 600;
}

.compare-component-variance-below {
  color: var(--success);
  font-weight: 600;
}

.compare-component-variance-total {
  color: color-mix(in oklab, var(--warn), black 35%);
  font-weight: 600;
}

.compare-component-variance-new,
.compare-component-tag-missing {
  color: var(--muted-text);
}

.compare-component-total-row td {
  padding-block: 4px 10px;
  color: var(--muted-text);
  font-size: 10px;
}
```

Adjust exact spacing, colour mix, shadows, and type scale to the approved Open Design output.

- [ ] **Step 4: Add mobile card collapse**

```css
@media (max-width: 920px) {
  .compare-component-table-wrap {
    overflow: visible;
    border: 0;
    background: transparent;
  }

  .compare-component-table,
  .compare-component-table tbody,
  .compare-component-table tr,
  .compare-component-table td {
    display: block;
    width: 100%;
  }

  .compare-component-table {
    min-width: 0;
  }

  .compare-component-table thead {
    display: none;
  }

  .compare-component-group {
    display: block;
    margin-bottom: var(--space-3);
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-brand-sm);
    background: var(--surface);
    box-shadow: var(--elev-raised);
  }

  .compare-component-row {
    display: grid !important;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .compare-component-row > td {
    display: grid;
    grid-template-columns: 88px minmax(0, 1fr);
    gap: var(--space-2);
    min-width: 0;
    padding: var(--space-3);
    border-bottom: 1px solid var(--border-soft);
    text-align: left;
  }

  .compare-component-row > td::before {
    content: attr(data-label);
    color: var(--muted-text);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .compare-component-item,
  .compare-component-action,
  .compare-component-total-row {
    grid-column: 1 / -1;
  }
}

@media (max-width: 560px) {
  .compare-component-row {
    grid-template-columns: minmax(0, 1fr);
  }

  .compare-summary {
    grid-template-columns: minmax(0, 1fr);
  }
}
```

Ensure item/action cells with `rowSpan` render only in the first component row and do not create duplicate mobile controls.

- [ ] **Step 5: Add semantic table wrapper attributes**

The wrapping region must include:

```tsx
<div
  className="compare-component-table-wrap"
  role="region"
  aria-label="BOQ material and labour comparison — horizontally scrollable"
  tabIndex={0}
>
```

Every data cell used in mobile mode must carry a meaningful `data-label`.

- [ ] **Step 6: Run focused and full automated verification**

```bash
npx tsx --test \
  src/components/boq-catalog-component-table.test.tsx \
  src/app/\(authenticated\)/compare/compare-pricing-ui.test.ts
npm run check
git diff --check
```

Expected: zero failures, zero lint/type errors, no whitespace errors.

- [ ] **Step 7: Run graph update**

```bash
graphify update .
```

Acceptance: graph rebuild succeeds. Review generated graph files separately from feature files before staging.

- [ ] **Step 8: Browser QA against Open Design**

Run the development server and verify:

1. **1440×1000**
   - Summary cards match the approved Open Design hierarchy.
   - `Pcs` and `Db` render on separate rows.
   - Candidate and Match/Change match remain visible.
   - Table can scroll horizontally by keyboard.
2. **390×844**
   - No viewport-level horizontal overflow.
   - Each BOQ line is one card.
   - Material/labour cells stack with labels.
   - Match action appears once per line.
3. **All cases**
   - different units
   - material-only
   - labour-only
   - lump sum
   - no history
4. Use local dev data or the private PDFs locally only. Never copy or stage anything from `Quotation example/`.

Save QA screenshots outside tracked source or in the project’s existing ignored QA location.

- [ ] **Step 9: Commit**

```bash
git add \
  src/app/globals.css \
  src/components/boq-catalog-component-table.tsx \
  src/components/boq-catalog-component-table.test.tsx \
  src/app/\(authenticated\)/compare/compare-pricing-ui.test.ts
git commit -m "ui(compare): polish responsive component comparison"
```

- **Acceptance:**
  - Desktop and 390px layouts match the Open Design source.
  - Every case remains readable without combining unlike units.
  - No regression to upload, review, matching, or approved-BOQ gating.
  - `npm run check` passes.

---

## Files to Modify

- `src/lib/standard-matching.ts` — expose shared canonical unit resolution.
- `src/lib/standard-matching.test.ts` — canonicalization coverage.
- `src/lib/catalog-historical-pricing.ts` — component history types, native aggregation, allocation fallback.
- `src/lib/catalog-historical-pricing.test.ts` — native, derived, unit, exclusion, and invalid-data coverage.
- `src/lib/boq-catalog-comparison.ts` — component comparison map and benchmark attachment.
- `src/lib/boq-catalog-comparison.test.ts` — full derivation matrix and backward compatibility.
- `src/app/api/boqs/[id]/comparison/route.ts` — production dependency wiring.
- `src/app/(authenticated)/compare/page.tsx` — summary cards and component table integration.
- `src/app/(authenticated)/compare/compare-pricing-ui.test.ts` — page and responsive contracts.
- `src/app/globals.css` — desktop and mobile Option A styling.

## New Files

- `src/app/api/boqs/[id]/comparison/handler.ts` — dependency-injected comparison endpoint.
- `src/app/api/boqs/[id]/comparison/comparison-api.test.ts` — endpoint behavior and response-shape tests.
- `src/components/boq-catalog-component-table.tsx` — grouped component comparison and summary.
- `src/components/boq-catalog-component-table.test.tsx` — SSR tests covering every UI case.

## Dependencies

1. Task 2 depends on Task 1’s `canonicalUnit()` and component-pricing structures.
2. Task 3 depends on Tasks 1–2’s historical component builder.
3. Task 4 depends on Task 3’s serialized comparison shape.
4. Task 5 depends on Task 3’s row types and should begin after reviewing the Open Design output.
5. Task 6 depends on Task 5’s grouped markup and semantic `data-label` structure.

## Risks

- **High — allocation semantics conflict:** `docs/superpowers/specs/2026-08-02-boq-catalog-component-comparison-design.md:94` says to divide `costAllocation.material/labour` by quantity. Current `src/lib/boq-cost-allocation.ts:12-37` defines `basis: 'rate'` values as already per-line-unit rates. The plan explicitly uses them directly.
- **Medium — canonical helper is private:** `src/lib/standard-matching.ts:61` has private `resolveUnit`; Task 1 promotes it to `canonicalUnit()` so matching and benchmarking cannot diverge.
- **Medium — summary weighting was underspecified:** the approved spec requests a weighted average but does not define the weight. This plan weights by benchmark cost exposure (`benchmark average × component quantity`), which is valid across unlike units after conversion to ฿.
- **Medium — matching action omitted from column list:** the spec’s table column list omits Action while separately requiring Match to remain. The plan retains one Match/Change match action per BOQ line and shows candidate context in the item cell.
- **Medium — component-count copy ambiguity:** the plan labels the stat “Lines with component data” and counts rows with at least one present component, avoiding the misleading implication that every counted row has both components.
- **Medium — Open Design output pending:** spacing, visual hierarchy, and responsive polish may change when the MCP output completes. Behavior and data semantics must remain aligned with the approved spec.
- **Low — sparse native history:** native-unit benchmarks remain unavailable until approved BOQs carry `sourceCosts`; line-unit allocation fallback and explicit no-history states mitigate this.
- **Low — private fixture prohibition:** tests must recreate ETG-shaped values in TypeScript and must never import, copy, stage, or commit the PDFs in `Quotation example/`.