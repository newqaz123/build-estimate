# Catalog Historical Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use one auditable approved-matched unit-price history across Catalog, Compare, and Estimator while keeping material and labour as independent items with independent units.

**Architecture:** Add a pure historical-pricing calculator that groups approved matched BOQ lines by catalog ID and returns aggregate plus source records. Enrich Standards API results on read, make Compare reuse the calculator with the selected BOQ excluded, and seed independent Estimator lines from each catalog entry’s own average.

**Tech Stack:** Next.js 16 Route Handlers, React 19 client components, TypeScript, Node test runner, Firestore helpers.

---

### Task 1: Shared historical-pricing calculator

**Files:**
- Create: `src/lib/catalog-historical-pricing.ts`
- Create: `src/lib/catalog-historical-pricing.test.ts`
- Modify: `src/lib/standard-schema.ts`

- [ ] Write failing tests proving that only approved, explicitly matched, positive, unit-compatible rows contribute; legacy `sourceItems` provenance resolves safe links; and `excludeBoqId` removes the selected BOQ.
- [ ] Run `npx tsx src/lib/catalog-historical-pricing.test.ts` and confirm failures occur because the calculator is missing.
- [ ] Implement these interfaces and the calculator:

```ts
export interface HistoricalPriceSource {
  boqId: string
  project: string
  vendor: string
  date: string
  section: string
  itemId?: string
  itemCode?: string
  description: string
  unit: string
  rate: number
}

export interface HistoricalPriceSummary {
  count: number
  min: number
  average: number
  max: number
  sources: HistoricalPriceSource[]
}

export function buildCatalogHistoricalPricing(
  standards: StandardEntry[],
  boqs: Boq[],
  unitMap?: Record<string, string>,
  options?: { excludeBoqId?: string },
): Map<string, HistoricalPriceSummary>
```

- [ ] Add `historicalPricing?: HistoricalPriceSummary` to `StandardEntry`, rerun the focused test, and confirm it passes.

### Task 2: Standards API and Catalog drill-down

**Files:**
- Modify: `src/app/api/standards/route.ts`
- Modify: `src/app/api/standards/standards-api.test.ts`
- Modify: `src/app/(authenticated)/catalog/page.tsx`
- Create: `src/app/(authenticated)/catalog/catalog-pricing-ui.test.ts`

- [ ] Write failing tests for Standards enrichment and the Catalog price-column/detail-dialog UI contract.
- [ ] Update Standards `GET` to load standards, BOQs, and the workspace unit map in parallel, attach computed history to each returned active entry, and preserve search/archive behavior.
- [ ] Add “Average approved unit price” to the Catalog table. Render average, source count, and range as a button; render “No approved matched history” when absent.
- [ ] Add a dialog that lists every source BOQ, vendor/date, description, unit rate, and the displayed arithmetic mean.
- [ ] Run the API and UI tests and confirm they pass.

### Task 3: Compare consistency and explicit empty states

**Files:**
- Modify: `src/lib/boq-catalog-comparison.ts`
- Modify: `src/lib/boq-catalog-comparison.test.ts`
- Modify: `src/app/(authenticated)/compare/page.tsx`

- [ ] Write a failing comparison test proving its benchmark equals the shared pricing summary after excluding the selected BOQ.
- [ ] Replace Compare’s local rate scan with `buildCatalogHistoricalPricing(..., { excludeBoqId: target.id })` and keep unmatched target rows unbenchmarked.
- [ ] Render “No prior approved history” in the average column and “Not enough history to compare” in the comparison column instead of dashes.
- [ ] Run the comparison tests and confirm approved averages and semantic variance labels pass.

### Task 4: Independent Estimator line seeding

**Files:**
- Modify: `src/lib/estimate-ai.ts`
- Modify: `src/lib/estimate-ai.test.ts`
- Modify: `src/app/(authenticated)/estimator/page.tsx`
- Modify: `src/app/(authenticated)/estimator/estimator-page.test.ts`

- [ ] Write failing tests proving one catalog entry maps to one independent estimate line whose default rate is its own historical average, while an entry without history defaults to zero.
- [ ] Add `standardEntryToEstimateAiCatalogEntry(entry)` and set `defaultRate` from `entry.historicalPricing?.average`.
- [ ] Use the mapping for catalog picker additions and AI catalog context. Display the average and source count in each picker row.
- [ ] Keep quantities independent: adding or editing pipe must never add or modify welding, and vice versa.
- [ ] Run estimator and estimate-AI tests and confirm they pass.

### Task 5: Verification

- [ ] Run all focused tests for historical pricing, Standards, Compare, Catalog UI, Estimator, and existing BOQ catalog readiness.
- [ ] Run `npx tsc --noEmit`, `npm run lint`, and `npm run build`.
- [ ] Browser-check Catalog price drill-down, Compare prior-history values/empty states, and Estimator rate seeding.
- [ ] Run `graphify update .` and inspect `git diff --check` plus the scoped diff without altering unrelated working-tree changes.
