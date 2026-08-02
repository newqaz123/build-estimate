# BOQ ↔ Catalog Component (Material / Labour) Comparison — Design

**Date:** 2026-08-02
**Status:** Approved (brainstormed) → ready for implementation plan
**Scope:** Extend the `/compare` page to compare each BOQ line's **material** and **labour** costs against the Standard Catalog, where each component is benchmarked on its **own unit**.

---

## 1. Goal

A user uploads a BOQ and wants to see, for every line, whether the **material rate** and the **labour rate** are competitive against historical approved data in the catalog — not just a single blended rate.

The existing `/compare` page compares one `rate` per line vs the catalog. This design adds per-component (material/labour) comparison while preserving the existing rate comparison as a fallback.

## 2. Current state (verified)

| Layer | Today | File |
| --- | --- | --- |
| BOQ item cost | `BoqPricedItem.sourceCosts.{material,labour}` each carry `{present, qty, unit, rate, total}` — **native component unit already captured** | `src/lib/boq-schema.ts:14` |
| Cost allocation | `costAllocation: {basis, material, labour, origin}` — ฿ amounts only, line-unit basis | `boq-schema.ts:26`, `boq-cost-allocation.ts` |
| Comparison | `compareBoqToCatalog()` compares `item.rate` (single) to a single historical average | `src/lib/boq-catalog-comparison.ts:31` |
| Catalog benchmark | `buildCatalogHistoricalPricing()` aggregates `item.rate` only → `{count,min,avg,max}` | `src/lib/catalog-historical-pricing.ts` |
| Catalog schema | `StandardEntry.historicalPricing` — single rate summary, one unit | `src/lib/standard-schema.ts` |
| Match step | Line-level: a BOQ line links to one `StandardEntry` by description + line unit (no material/labour matching) | `catalog-match-modal.tsx`, `use-inline-catalog-matching.ts` |
| Parse step | Docling parser resolves material/labour columns when present (`boq_column_resolvers.py`) | `py-sidecar/` |

**Data audit (dev):** `sourceCosts` present on only 13/101 items, 0 in approved BOQs. The user's real ETG quotations, however, **do** carry separate MATERIAL COST / LABOUR COST columns with different units (e.g. `Pcs` vs `Db`), and the parser supports resolving them — so per-component data will populate as those quotations are imported and approved.

## 3. Design decisions (locked during brainstorm)

1. **Layout — Option A (split sub-rows).** Each priced BOQ line renders one sub-row per component (Material / Labour). Rejected: paired columns (can't show two different units per row) and expandable detail (buries the primary signal behind a click).
2. **Primary signal — per-component rate variance.** Each component's rate is compared to its own catalog benchmark on the component's own unit. Line total + cost-share % shown secondary.
3. **Never blend incompatible units.** Material and labour keep their own unit & quantity; they are benchmarked independently and reconciled only at the ฿ total level.
4. **Hybrid rate basis with graceful fallback** (see §6 matrix): native component unit first; line-unit derived second; total-only last.
5. **Match step unchanged.** Per-component benchmarks are aggregated from history under each standard; no new material/labour matching is introduced in v1.
6. **Placement — `/compare` page** (extended). BOQ detail view remains unchanged in v1.

## 4. Data model changes

### 4.1 Catalog component pricing (new)

Extend historical pricing to be per-component. New type in `src/lib/catalog-historical-pricing.ts`:

```ts
export interface ComponentPriceSummary {
  unit: string                 // canonical component unit (after unitMap)
  count: number
  min: number
  average: number
  max: number
}
```

`StandardEntry.historicalPricing` (in `standard-schema.ts`) is **not** mutated on the document; instead the comparison computes component summaries on the fly from approved BOQs (see §5). The persisted `historicalPricing` field stays as the rate/total fallback.

### 4.2 Comparison row (extended)

`BoqCatalogComparisonRow` in `src/lib/boq-catalog-comparison.ts` gains a `components` map:

```ts
export type ComponentKey = "material" | "labour"

export interface ComponentComparison {
  present: boolean
  unit: string                 // the unit this component is priced in
  qty: number | null
  rate: number | null          // per `unit`
  total: number | null         // ฿
  basis: "native" | "line-unit" | "none"   // how the rate was derived
  benchmark: ComponentPriceSummary | null
  variancePct: number | null   // (rate - avg) / avg * 100, or null if no benchmark
}
```

The existing single-rate `benchmark` / `variancePct` fields are retained for the lump-sum / total fallback row and backward compatibility.

## 5. Architecture & data flow

```
/api/boqs/[id]/comparison  (GET)
   └─ compareBoqToCatalog(target, standards, allBoqs, unitMap)   [extended]
        ├─ createHistoricalStandardResolver(standards)          [existing]
        ├─ buildCatalogComponentPricing(active, allBoqs, unitMap, {excludeBoqId})  [NEW]
        │     groups approved items by standard → component → unit
        ├─ for each priced line:
        │     resolve standard (linked stdId, else fuzzy ≥1100, unit-compatible)
        │     derive components from sourceCosts / costAllocation  (§6)
        │     attach component benchmark + variancePct
        └─ return { boqId, rows: BoqCatalogComparisonRow[] }

/compare page  (extended render)
   └─ Option A sub-row table from row.components
```

### 5.1 `buildCatalogComponentPricing` (new function)

Input: active standards, all BOQs, unitMap. For each approved BOQ (excluding the target), for each priced item resolved to a standard:

- **Native path:** if `item.sourceCosts.material.present`, emit a material sample `{standardId, component:"material", unit: canonical(material.unit), rate: material.rate}`. Same for labour. Use each component's own `qty`/`unit`/`rate`.
- **Derived path:** if no `sourceCosts` but `item.costAllocation` exists, emit material `{unit: canonical(item.unit), rate: costAllocation.material / item.qty}` and labour similarly. Mark basis `line-unit`.
- Group by `standardId | component | unit`. A standard may have multiple component-unit buckets (e.g. labour in `Db` for some BOQs, `Lot` for others) — keep them separate; the comparison matches the target line's component unit to the right bucket.
- Output: `Map<standardId, { material: Map<unit, ComponentPriceSummary>, labour: Map<unit, ComponentPriceSummary> }>`.

Unit canonicalization reuses the existing `unitMap` (fuzzy settings) and `unitsCompatible`/`canonicalUnit` helpers so `Pcs`/`Pc.`/`pcs` and `Db`/`db` reconcile.

## 6. Per-component derivation & fallback matrix

For each target line, derive `material` and `labour` components in priority order:

| Source data available | Material basis | Labour basis | Rendered as |
| --- | --- | --- | --- |
| `sourceCosts` both present, different units | native unit/rate | native unit/rate | 2 sub-rows, each own unit |
| `sourceCosts` both present, same unit | native | native | 2 sub-rows |
| `sourceCosts.material` only | native | — | Material sub-row; Labour "not in source" |
| `sourceCosts.labour` only | — | native | Labour sub-row; Material "not in source" |
| no `sourceCosts`, `costAllocation` present | line-unit derived rate | line-unit derived rate | 2 sub-rows (basis `line-unit`) |
| neither (lump_sum / single-component) | — | — | single total-only row, tagged `Lump sum` |

**Variance:** `variancePct = (rate - benchmark.average) / benchmark.average * 100`. When no benchmark bucket matches the component unit (e.g. first-time item, or unit never seen), `benchmark = null` → show "no prior approved rates".

## 7. UI — `/compare` page (Option A)

Header/toolbar unchanged (BOQ selector + Upload). The table is rebuilt:

- **Summary band:** Material rate vs catalog (weighted avg Δ%), Labour rate vs catalog, Lines with component split, BOQ total.
- **Table columns:** BOQ item · Component · Qty · Unit · BOQ rate · Catalog avg (min–max · n) · Variance.
- **Row grouping:** one `<tr>` group per BOQ line. Component sub-rows carry the Material/Labour tag; the line total + composition % sit in a dimmed footer row under the group.
- **Component tags:** `Material` (blue), `Labour` (green), `Lump sum` (amber), absent-component placeholder (grey "— not in source").
- **Variance colour:** red = above catalog, green = below, amber = total-only, grey = no history.
- **"Match" action** per line remains (opens `CatalogMatchModal`), unchanged.
- **Responsive (≤390px):** collapse to the card layout already used by `.unified-boq-items-table` mobile rules; component sub-rows stack under the item label.

Real-data reference states (from ETG.2026/AYT074) are captured in the brainstorm mockup at `.superpowers/brainstorm/95770-1785630952/content/compare-real-data-all-cases.html`.

## 8. Edge cases & error handling

- **Component unit has no history:** `benchmark = null`; show "no prior approved rates". Approving the BOQ seeds that bucket.
- **Unit mismatch that the unitMap cannot resolve:** the component is benchmarked only against its exact unit bucket; if empty, treated as no-history (not silently blended into another unit).
- **`qty = 0` or non-finite rate:** skip the component (no benchmark contribution, no variance).
- **Target BOQ excluded from its own benchmark** (`excludeBoqId`, already the case for the rate benchmark — preserved).
- **Lump-sum lines:** total-only comparison against the existing rate/total catalog summary; never invent a split.
- **Read-only / approved BOQ:** comparison is read-only (no inline edits on `/compare`); matching still allowed via the Match action.

## 9. Testing strategy

- `src/lib/catalog-historical-pricing.test.ts` — `buildCatalogComponentPricing`: native-unit grouping, derived line-unit fallback, multi-unit buckets per component, exclusion of target BOQ, unitMap canonicalization.
- `src/lib/boq-catalog-comparison.test.ts` — `compareBoqToCatalog` extended: the six derivation cases in §6, variance math, null-benchmark handling, backward-compatible `benchmark`/`variancePct` for lump-sum rows.
- `src/app/api/boqs/[id]/comparison` route test — response shape includes `components`.
- `src/app/(authenticated)/compare/page.test.tsx` — render: sub-row layout, component tags, variance colours, no-history state, lump-sum total-only row, mobile collapse.
- Fixtures built from the real ETG quotation shapes (Pcs/Db/Lot) in `Quotation example/`.

## 10. Scope

**v1 (this spec):**

- Per-component comparison on `/compare` (Option A layout).
- `buildCatalogComponentPricing` + extended `compareBoqToCatalog` + comparison API.
- Cases: different-units, material-only, labour-only, lump-sum, no-history.

**Out of scope (explicit):**

- Surface material/labour comparison on the BOQ detail page.
- Separate material/labour *matching* (linking a line's material to one standard and labour to another).
- Editing/confirming component splits during the parse review step.
- Persisting `historicalPricing` per-component onto the `StandardEntry` document (computed on the fly in v1; can be persisted later if performance demands).

## 11. Risks & dependencies

1. **Per-component data availability** (primary risk): benchmarks depend on approved BOQs carrying `sourceCosts`. The user's real ETG quotations and the parser support it, but the dev dataset currently has none approved. **Mitigation:** the derived line-unit path (from `costAllocation`, ~72% coverage) keeps the comparison useful even before `sourceCosts` is widespread; native-unit fidelity improves as more structured quotations are approved.
2. **Unit canonicalization coverage:** uncommon units (`Db`, `Lot`, `Pcs`) must be mapped via `unitMap`. Gaps surface as "no history" rather than wrong comparisons. **Mitigation:** seed `unitMap` from the ETG quotations; surface unmapped units to the user.
3. **Multiple component-unit buckets per standard** could fragment small benchmark pools. **Mitigation:** show `n` so thin benchmarks are visible; do not pool across incompatible units.

## 12. Open questions for implementation

None blocking. (Placement confirmed as `/compare`; match step confirmed unchanged; hybrid basis confirmed.)
