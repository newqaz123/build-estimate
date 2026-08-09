# Conversion-Aware Add & Match and Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable safe one-action Add & match with separate extracted, reviewer-confirmed, and normalized pricing evidence, deterministic identity/global/item-specific conversions, one Firestore transaction, Open Design-aligned UI, and metric-gated replacement of proposal-card routing.

**Architecture:** Converted items gain additive extracted-source, reviewer-confirmed, and deterministic-normalization snapshots while existing numeric BOQ fields remain backward compatible. The client may choose only server-allowlisted catalog/conversion IDs and bounded `SourceBackedItemRequest` fields; the server reconstructs raw evidence, validates reviewer values, calculates normalization exactly, and atomically creates the BOQ item, catalog link/history, audit, and terminal suggestion state. Feature stages progress from focused to add-and-match to default only after shadow metrics pass.

**Tech Stack:** Current project Next.js App Router version, TypeScript, React, Firestore Admin transactions, exact decimal-string helpers from Plan 1, existing catalog/BOQ schemas, Open Design project `buildestimate-actionable-ai-review`, Node tests through `npm test`, Graphify.

## Global Constraints

- Plans 1 and 2 must be complete and green before starting this plan.
- Use 2-space indentation in all new/touched TypeScript/TSX; avoid broad reformatting.
- Strict TDD: observe focused RED before production changes, then minimal GREEN.
- Run `npm run check` after each task and `graphify update .` after every code-changing commit.
- Never run production migrations locally; new fields are additive and optional for legacy items.
- Never inspect, stage, or commit `Quotation example/`; use sanitized fixtures.
- Preserve unrelated unstaged edits; stage only named task files and never use `git add .`.
- Dirty-tree staging protocol: at each task start, save `git status --short` and `git diff --binary -- <every touched existing file>` under the gitignored task SDD workspace. If a touched file was already dirty, path-wide `git add <file>` is forbidden; use `git add -p -- <file>` and stage only new task hunks. Before every commit, inspect `git diff --cached --name-only` and the complete `git diff --cached`; a fresh task reviewer must confirm no baseline hunk is staged.
- Preserve exact **Exclude** wording and semantics.
- AI never authors quantity, rate, total, conversion factor, or normalized price.
- Client may submit only bounded reviewer-editable BOQ fields through `SourceBackedItemRequest`; it never submits immutable extraction provenance/raw evidence, normalized values, conversion factors, AI confidence, or arbitrary catalog IDs.
- Quoted source total remains authoritative; historical catalog pricing is comparison-only.
- Unknown/archived conversion rules, mismatched totals, stale fingerprints, non-shortlisted catalog IDs, approved BOQs, and duplicate/conflicting decisions fail closed.
- Approval remains status-only and never creates catalog entries.
- Before changing route/page code, read the complete Next.js documents listed in the prior plans.
- Before UI work, retrieve the latest Open Design artifact for project `buildestimate-actionable-ai-review` through Open Design MCP.

---

## File Structure

- `src/lib/actionable-review-match.ts` — reconstruct and validate Add & match without persistence.
- `src/lib/catalog-linking.ts` — pure catalog-link/source-history helpers extracted from route modules.
- `src/lib/boq-schema.ts` — optional source and normalization snapshots.
- `src/lib/actionable-review-decision.ts` — closed `add_and_match` request variant.
- Existing proposal store — single transaction authority.
- Existing actionable review components — enable conversion-aware display/action only at `add_and_match` stage.
- Existing metrics/page routing — enforce rollout gates and preserve old history.

---

### Task 1: Preserve extracted, reviewer-confirmed, and normalized pricing on BOQ items

**Files:**

- Modify: `src/lib/boq-schema.ts`
- Modify: `src/lib/boq-canonical.ts`
- Test: `src/lib/boq-canonical.test.ts`
- Modify: `src/lib/boq-public.ts`
- Test: `src/lib/boq-public.test.ts`
- Modify: `src/lib/boq-ingestion.ts`
- Test: `src/lib/boq-ingestion.test.ts`

**Interfaces:**

- Consumes: Plan 1 `ExtractedPricingSnapshot`, `ReviewerPricingSnapshot`, `PricingNormalization`, and decimal helpers.
- Produces optional additive snapshots on `BoqPricedItem`.

```ts
export interface BoqPricedItem extends BoqItemCommon {
  // existing fields remain unchanged
  extractedPricing?: ExtractedPricingSnapshot
  reviewerPricing?: ReviewerPricingSnapshot
  pricingNormalization?: PricingNormalization
}
```

- [ ] **Step 1: Write failing compatibility and invariant tests**

Test:

- legacy items without snapshots still decode/canonicalize,
- a new converted item requires immutable `extractedPricing`, separate human-confirmed `reviewerPricing`, and `pricingNormalization`,
- reviewer edits never overwrite extracted pricing,
- normalization catalog ID/unit/rule matches the linked BOQ item,
- normalized total equals persisted line total at currency minor-unit precision,
- reviewer-confirmed total equals normalized total while raw extraction evidence remains separately auditable,
- numeric divergence requires a non-empty correction reason and preserves field-level deltas,
- extracted line totals may differ only through that audited correction; final BOQ-to-document total reconciliation remains an approval gate,
- public serialization preserves audit-safe snapshots without exposing internal fingerprints.

- [ ] **Step 2: Verify RED**

```bash
npm test -- src/lib/boq-canonical.test.ts src/lib/boq-public.test.ts src/lib/boq-ingestion.test.ts
```

- [ ] **Step 3: Implement additive schema/canonical support**

Do not bulk backfill. Legacy items remain valid. New conversion-aware items must carry both snapshots; same-unit matches may use factor `1` so their normalization is explicit.

Existing number fields remain operational compatibility fields. `extractedPricing` preserves parser interpretation, `reviewerPricing` preserves the accepted human revision and optional correction reason, and `pricingNormalization` is derived from the reviewer snapshot. Raw source rows/cells remain immutable in the extraction run.

- [ ] **Step 4: Verify GREEN and checks**

```bash
npm test -- src/lib/boq-canonical.test.ts src/lib/boq-public.test.ts src/lib/boq-ingestion.test.ts
npm run check
graphify update .
git diff --check
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/boq-schema.ts src/lib/boq-canonical.ts \
  src/lib/boq-canonical.test.ts src/lib/boq-public.ts src/lib/boq-public.test.ts \
  src/lib/boq-ingestion.ts src/lib/boq-ingestion.test.ts
git commit -m "feat: preserve reviewed and normalized BOQ pricing"
```

---

### Task 2: Define and validate Add & match reconstruction

**Files:**

- Modify: `src/lib/actionable-review-decision.ts`
- Test: `src/lib/actionable-review-decision.test.ts`
- Create: `src/lib/actionable-review-match.ts`
- Test: `src/lib/actionable-review-match.test.ts`

**Interfaces:**

- Consumes: pending actionable suggestion, immutable source evidence, active shortlisted catalog entry, active conversion rule, reviewer section/description.
- Produces a fully reconstructed `PreparedActionableMatch` suitable for one transaction.

```ts
export type ActionableReviewDecisionRequest =
  | {
      action: 'add_pending_catalog'
      expectedFingerprint: string
      item: SourceBackedItemRequest
      correctionReason?: string
    }
  | {
      action: 'dismiss'
      expectedFingerprint: string
      note?: string
    }
  | {
      action: 'restore'
      expectedFingerprint: string
    }
  | {
      action: 'add_and_match'
      expectedFingerprint: string
      catalogId: string
      conversionRuleId?: string
      item: SourceBackedItemRequest
      correctionReason?: string
    }

export interface ResolvedActionableSource {
  sourceMapping: ValidatedSourceMapping
  extractedPricing: ExtractedPricingSnapshot
}

export interface PreparedActionableMatch {
  item: BoqPricedItem
  extractedPricing: ExtractedPricingSnapshot
  reviewerPricing: ReviewerPricingSnapshot
  pricingNormalization: PricingNormalization
  catalogSourceItem: StandardSourceItem
  catalog: StandardEntry
  decision: {
    action: 'add_and_match'
    catalogId: string
    conversionRuleId?: string
  }
}

export function prepareActionableAddAndMatch(input: {
  suggestion: ActionableItemSuggestion
  immutableSource: ResolvedActionableSource
  catalog: StandardEntry
  conversion?: HumanApprovedCatalogConversionRule
  userValues: SourceBackedItemRequest
  correctionReason?: string
  actorId: string
  confirmedAt: string
  currencyScale: number
}): PreparedActionableMatch
```

- [ ] **Step 1: Write failing closed-request tests**

Reject immutable source/provenance/normalization/AI fields. Accept only the expected fingerprint, allowlisted catalog ID, optional allowlisted conversion rule ID, optional trimmed `correctionReason` limited to 500 characters, and the existing bounded `SourceBackedItemRequest` fields: `sectionIndex`, `desc`, `unit`, `qty`, `materialCost`, and `labourCost`. `materialCost` and `labourCost` are per-unit component rates, not line totals. `actorId` and `confirmedAt` are trusted server inputs and never accepted from the client.

- [ ] **Step 2: Write failing reconstruction tests**

Cover:

- same-unit match with factor `1` and persisted identity rule ID `identity:<canonical-unit>:v1` when `conversionRuleId` is omitted,
- global conversion,
- catalog-item conversion,
- material and labour rates normalized independently,
- reviewer-confirmed/normalized total preservation,
- unchanged extracted/reviewer values require no correction reason,
- any numeric divergence from extracted pricing requires a correction reason and field-level audit delta,
- unknown conversion,
- missing conversion for incompatible units,
- non-shortlisted/archived catalog,
- archived/wrong-scope rule,
- stale fingerprints,
- exact arithmetic failure.

- [ ] **Step 3: Verify RED**

```bash
npm test -- src/lib/actionable-review-decision.test.ts src/lib/actionable-review-match.test.ts
```

- [ ] **Step 4: Implement server reconstruction only**

The function obtains immutable raw extraction evidence/provenance from `immutableSource`, keeps `immutableSource.extractedPricing` unchanged as `extractedPricing`, validates the bounded reviewer-authored item fields, captures those values separately as `reviewerPricing` with trusted `actorId`/`confirmedAt`, requires a correction reason for numeric divergence, and applies either the supplied human-approved rule or `identityConversionRule()` for canonically equal units. Raw OCR cells remain unchanged in the extraction run. Reviewer-confirmed and normalized totals must match exactly; final document-total reconciliation remains the approval gate. The function returns the exact `PreparedActionableMatch` above without performing writes.

- [ ] **Step 5: Verify GREEN and checks**

```bash
npm test -- src/lib/actionable-review-decision.test.ts src/lib/actionable-review-match.test.ts
npm run check
graphify update .
git diff --check
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/actionable-review-decision.ts src/lib/actionable-review-decision.test.ts \
  src/lib/actionable-review-match.ts src/lib/actionable-review-match.test.ts
git commit -m "feat: validate conversion-aware add and match"
```

---

### Task 3: Persist Add & match in one Firestore transaction

**Files:**

- Create: `src/lib/catalog-linking.ts`
- Test: `src/lib/catalog-linking.test.ts`
- Modify: `src/lib/boq-extraction-proposal-store.ts`
- Test: `src/lib/boq-extraction-proposal-store.test.ts`
- Modify: `src/app/api/boqs/[id]/extraction-runs/[runId]/actionable-review/[suggestionId]/decision/route.ts`
- Test: `src/app/api/boqs/[id]/extraction-runs/[runId]/actionable-review/actionable-review-decision-api.test.ts`
- Modify: `src/app/api/standards/route.ts`
- Modify: `src/app/api/standards/match/route.ts`
- Test: `src/app/api/standards/match/match-route.test.ts`

**Interfaces:**

- Consumes: Task 2 prepared match and existing Firestore transaction dependencies.
- Produces atomic `added_matched` terminal result.

- [ ] **Step 1: Extract failing tests for pure catalog-link helpers**

Move/replace route-owned behavior behind pure helpers without changing existing same-unit match results:

```ts
export function buildCatalogLinkUpdate(input: {
  item: BoqPricedItem
  standard: StandardEntry
  confidence: NonNullable<BoqItem['stdConfidence']>
  sourceItem: StandardSourceItem
  matchedAt: string
  normalization?: PricingNormalization
}): {
  item: BoqPricedItem
  standard: StandardEntry
}
```

Prove current matches preserve source description/unit, update source history once, reject archived standards, and require normalization when changing real units.

- [ ] **Step 2: Write failing transaction tests**

The single transaction must:

1. create one source-backed BOQ item,
2. persist immutable `extractedPricing`,
3. persist separate human-confirmed `reviewerPricing` plus correction deltas/reason when applicable,
4. persist deterministic `pricingNormalization`,
5. set catalog match metadata,
6. update catalog source history/count/last-matched,
7. persist separate AI advice and human decision/audit with trusted actor/time,
8. mark suggestion `added_matched`,
9. update BOQ totals/readiness,
10. preserve the final document-total reconciliation gate.

Also update the existing `add_pending_catalog` branch to copy its already-audited extracted and reviewer-confirmed snapshots onto new `BoqPricedItem` fields now that Task 1 makes them available. Legacy items created before this rollout remain valid without backfill.

Simulate failure before each write boundary and assert no partial state. Test approved, stale, archived, non-shortlisted, changed conversion version, conflicting retry, and identical idempotent retry.

- [ ] **Step 3: Verify RED**

```bash
npm test -- src/lib/catalog-linking.test.ts \
  src/lib/boq-extraction-proposal-store.test.ts \
  'src/app/api/boqs/[id]/extraction-runs/[runId]/actionable-review/actionable-review-decision-api.test.ts' \
  src/app/api/standards/match/match-route.test.ts
```

- [ ] **Step 4: Implement pure helpers and one transaction**

Do not call API routes from other routes. Route modules become adapters over pure catalog-link helpers. `boq-extraction-proposal-store.ts` remains transaction authority but receives no React/projection logic. The authenticated route supplies `actorId`; one injected server clock supplies `confirmedAt`. Neither value is client-controlled.

Do not reuse current `applyStandardToBoqItem()` to change a real unit without explicit validated normalization.

- [ ] **Step 5: Verify GREEN and checks**

```bash
npm test -- src/lib/catalog-linking.test.ts \
  src/lib/boq-extraction-proposal-store.test.ts \
  'src/app/api/boqs/[id]/extraction-runs/[runId]/actionable-review/actionable-review-decision-api.test.ts' \
  src/app/api/standards/match/match-route.test.ts
npm run check
graphify update .
git diff --check
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/catalog-linking.ts src/lib/catalog-linking.test.ts \
  src/lib/boq-extraction-proposal-store.ts \
  src/lib/boq-extraction-proposal-store.test.ts \
  'src/app/api/boqs/[id]/extraction-runs/[runId]/actionable-review/[suggestionId]/decision/route.ts' \
  'src/app/api/boqs/[id]/extraction-runs/[runId]/actionable-review/actionable-review-decision-api.test.ts' \
  src/app/api/standards/route.ts
git add -p -- src/app/api/standards/match/route.ts \
  src/app/api/standards/match/match-route.test.ts
git diff --cached --check
git diff --cached
git commit -m "feat: add and match actionable items atomically"
```

---

### Task 4: Enable conversion-aware Open Design UI actions

**Files:**

- Modify: `src/components/actionable-review-detail.tsx`
- Test: `src/components/actionable-review-detail.test.ts`
- Modify: `src/components/actionable-extraction-review.tsx`
- Test: `src/components/actionable-extraction-review.test.ts`
- Modify: `src/components/catalog-match-modal.tsx`
- Test: `src/components/catalog-match-modal.test.ts`
- Modify: `src/app/globals.css`

**Interfaces:**

- Consumes: Task 3 decision response, Open Design artifact, extracted/reviewer-confirmed/normalized snapshots, and historical pricing.
- Produces enabled Add & match only at `add_and_match` or `default` stage.

- [ ] **Step 1: Refresh the Open Design artifact**

Call:

```text
open_design_get_artifact(project="buildestimate-actionable-ai-review", include="all")
```

Verify the latest artifact still matches the approved evidence-first split and copy requirements. Record preview URL and any deliberate implementation deviations in the task report.

- [ ] **Step 2: Write failing action-state tests**

Assert:

- conversion rule ID/scope/factor are visible,
- extracted, reviewer-confirmed, and normalized quantity/rates/totals are labeled distinctly,
- historical median is marked advisory,
- Add & match is disabled for unknown conversion, mismatched totals, stale candidate/snapshot, archived rule/catalog, and lower feature stage,
- Find another uses server candidates/manual refresh rather than client-invented IDs,
- no-safe-match state offers Add to BOQ, not catalog creation,
- transaction errors preserve edits/selected candidate.

- [ ] **Step 3: Verify RED**

```bash
npm test -- src/components/actionable-review-detail.test.ts \
  src/components/actionable-extraction-review.test.ts \
  src/components/catalog-match-modal.test.ts
```

- [ ] **Step 4: Implement minimal enabled behavior**

Keep arithmetic in server/library modules. UI renders returned values and submits only the closed request. Preserve focus management, keyboard access, mobile drill-down, no gradients, and exact Exclude copy.

- [ ] **Step 5: Verify GREEN, project checks, and browser QA**

```bash
npm test -- src/components/actionable-review-detail.test.ts \
  src/components/actionable-extraction-review.test.ts \
  src/components/catalog-match-modal.test.ts
npm run check
graphify update .
git diff --check
```

Browser QA with sanitized fixtures at `1280×800` and `390×844`:

- same-unit Add & match,
- item-specific conversion with preserved total,
- no-safe-match Add to BOQ,
- failed submit preserving edits,
- audit drawer restore,
- no page-level horizontal overflow.

- [ ] **Step 6: Commit**

```bash
git add src/components/actionable-review-detail.tsx \
  src/components/actionable-review-detail.test.ts \
  src/components/actionable-extraction-review.tsx \
  src/components/actionable-extraction-review.test.ts src/app/globals.css
git add -p -- src/components/catalog-match-modal.tsx \
  src/components/catalog-match-modal.test.ts
git diff --cached --check
git diff --cached
git commit -m "feat: enable safe add and match review"
```

---

### Task 5: Gate default rollout and retire old routing safely

**Files:**

- Modify: `src/lib/actionable-review-metrics.ts`
- Test: `src/lib/actionable-review-metrics.test.ts`
- Modify: `src/app/(authenticated)/boqs/[id]/page.tsx`
- Test: `src/app/(authenticated)/boqs/[id]/page.test.ts`
- Modify: `src/components/extraction-review.tsx`
- Test: `src/components/extraction-review.test.ts`
- Create: `docs/superpowers/validation/actionable-review-rollout-checklist.md`

**Interfaces:**

- Consumes: shadow/focused production metrics and rollout setting.
- Produces stage guards for `focused`, `add_and_match`, and `default`; preserves old history.

- [ ] **Step 1: Write failing metric-gate tests**

The gate requires:

```text
local catalog preparation >= 70%
normal AI calls per BOQ <= 1
accepted AI-authored numeric values/factors = 0
projected reviewer-action reduction >= 50%
source-total mismatch escapes do not increase
false-dismissal/restoration rate reviewed
approved/read-only mutation tests green
```

A missing metric, insufficient sample, or failed threshold must keep the prior stage.

- [ ] **Step 2: Write failing routing/history tests**

Assert:

- `focused` uses the new UI but disables Add & match,
- `add_and_match` enables one-action matching,
- `default` makes focused review the default,
- old proposal/audit history remains readable,
- old proposal-card routing is not deleted before default gate evidence,
- approval/catalog/extraction history remains read-only when approved.

- [ ] **Step 3: Verify RED**

```bash
npm test -- src/lib/actionable-review-metrics.test.ts \
  src/components/extraction-review.test.ts \
  'src/app/(authenticated)/boqs/[id]/page.test.ts'
```

- [ ] **Step 4: Implement gated routing and validation checklist**

Create the rollout checklist with metric definitions, sample-size evidence, owner/date, sanitized fixture/browser results, rollback steps, and explicit sign-off. Do not automatically advance a workspace based solely on client-computed metrics.

Retire only old UI routing after default approval; keep proposal/audit persistence and history readers.

- [ ] **Step 5: Run final automated verification**

```bash
npm test -- src/lib/actionable-review-metrics.test.ts \
  src/components/extraction-review.test.ts \
  'src/app/(authenticated)/boqs/[id]/page.test.ts'
npm run check
npx tsc --noEmit
graphify update .
git diff --check
git status --short
```

- [ ] **Step 6: Run final browser QA**

Using at least one sanitized text-layer digital PDF BOQ and one sanitized image-only scanned PDF BOQ, verify desktop/mobile:

- actionable list smaller than raw evidence,
- hidden evidence inspectable/restorable,
- every suggestion requires Add or Do not add,
- source highlight provenance correct,
- reviewer-confirmed total preserved across conversion and final BOQ total reconciles to the source document total,
- Add & match idempotent and atomic,
- Stage 2 catalog-pending flow unchanged,
- catalog/actionable/verification blockers prevent approval,
- approved BOQ fully read-only,
- Exclude wording unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/lib/actionable-review-metrics.ts src/lib/actionable-review-metrics.test.ts \
  docs/superpowers/validation/actionable-review-rollout-checklist.md
git add -p -- 'src/app/(authenticated)/boqs/[id]/page.tsx' \
  'src/app/(authenticated)/boqs/[id]/page.test.ts' \
  src/components/extraction-review.tsx src/components/extraction-review.test.ts
git diff --cached --check
git diff --cached
git commit -m "feat: make actionable review the gated default"
```

---

## Program Completion Gate

- [ ] Open Design MCP artifact was used for UX/UI implementation and final visual QA.
- [ ] Local-first resolution meets the approved threshold before default rollout.
- [ ] Normal operation uses at most one initial AI call per BOQ; optional escalation is measured separately.
- [ ] AI supplied zero accepted monetary values or conversion factors.
- [ ] Source and normalized pricing snapshots preserve the quoted total.
- [ ] Add & match is one idempotent Firestore transaction.
- [ ] Add to BOQ without a safe match stays catalog-pending for Stage 2.
- [ ] Approval remains status-only and requires verification, catalog, and actionable readiness.
- [ ] Old proposal/audit history remains readable.
- [ ] Approved BOQs reject every mutation.
- [ ] Exact Exclude wording/semantics remain unchanged.
- [ ] `npm run check`, `npx tsc --noEmit`, `graphify update .`, `git diff --check`, and browser QA pass.
- [ ] No production migration ran locally and no unrelated edit was staged.
