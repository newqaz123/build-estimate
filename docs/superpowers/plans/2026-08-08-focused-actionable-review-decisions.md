# Focused Actionable Review Decisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace proposal-card sprawl with a focused, source-linked review surface that shows only likely missing BOQ items, preserves dismissed/represented evidence in an audit drawer, supports explicit Add to BOQ / Do not add / restore decisions, focuses Stage 2 on catalog-pending items, and blocks approval transactionally while actionable decisions remain.

**Architecture:** The UI consumes the immutable shadow projection from Plan 1 through a closed response normalizer. New decision routes accept only opaque suggestion IDs, expected fingerprints, bounded reviewer-editable fields, and an optional numeric correction reason; the server preserves extracted evidence, records reviewer-confirmed pricing separately with trusted actor/time, and reuses existing transactional proposal/audit safeguards. Existing catalog creation/linking remains Stage 2 and approval remains status-only.

**Tech Stack:** Current project Next.js App Router version, TypeScript, React, Firestore Admin transactions, existing PDF review viewer, existing source-backed item validation, Open Design project `buildestimate-actionable-ai-review`, Node tests through `npm test`, Graphify.

## Global Constraints

- Plan 1 must be complete and its shadow projection verified before starting this plan.
- Use 2-space indentation in all new or touched TypeScript/TSX; do not reformat unrelated files.
- Follow strict RED → verify RED → minimal GREEN → verify GREEN for every behavior.
- Run `npm run check` after each task and `graphify update .` after every code-changing commit.
- Never run production migrations locally.
- Never inspect, stage, or commit `Quotation example/`; use sanitized fixtures.
- Preserve unrelated unstaged edits and stage only named task paths; never use `git add .`.
- Dirty-tree staging protocol: at each task start, save `git status --short` and `git diff --binary -- <every touched existing file>` under the gitignored task SDD workspace. If a touched file was already dirty, path-wide `git add <file>` is forbidden; use `git add -p -- <file>` and stage only new task hunks. Before every commit, inspect `git diff --cached --name-only` and the complete `git diff --cached`; a fresh task reviewer must confirm no baseline hunk is staged.
- Preserve exact **Exclude** wording and existing exclusion behavior.
- Every likely missing item must receive an explicit human Add to BOQ or Do not add decision.
- Hidden rows remain auditable and restorable; hidden evidence is never deleted.
- Client requests may supply only bounded reviewer-editable BOQ fields through `SourceBackedItemRequest`; they never supply immutable extraction provenance/raw evidence, normalized values, AI advice, or conversion factors.
- Approved BOQs expose history read-only and reject generation, restore, Add, dismiss, catalog, or conversion mutations.
- `Add & match` remains disabled in this plan; it is enabled only by the next plan after conversion-aware persistence is complete.
- Before changing React/page code, read completely:
  - `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`
  - `node_modules/next/dist/docs/01-app/01-getting-started/07-mutating-data.md`
  - `node_modules/next/dist/docs/01-app/01-getting-started/10-error-handling.md`
- Before changing route handlers, read the route-handler/dynamic-route documents listed in Plan 1.
- Before UI implementation, call Open Design MCP `open_design_get_artifact` for project `buildestimate-actionable-ai-review` and treat its latest entry artifact as the UX/UI reference. Do not hand-invent a competing layout.

---

## File Structure

### New focused UI/state

- `src/lib/actionable-review-state.ts` — closed response normalization and selection state.
- `src/lib/actionable-review-client.ts` — fetch/generation/decision client with stale request protection.
- `src/components/actionable-extraction-review.tsx` — responsive focused workspace shell.
- `src/components/actionable-review-detail.tsx` — selected suggestion editor and source/catalog explanation.
- `src/components/actionable-review-audit-drawer.tsx` — dismissed/represented evidence inspection and restore.

### New decisions/readiness

- `src/lib/actionable-review-decision.ts` — closed decision parser.
- `src/lib/catalog-pending-items.ts` — Stage 2 projection.
- `src/lib/boq-approval-readiness.ts` — combined verification/catalog/actionable blockers.
- New decision route under extraction-run actionable review.

### Existing modules changed carefully

- `src/lib/boq-extraction-proposal-store.ts` remains transaction authority; add a narrow actionable-decision entry point rather than projection/UI logic.
- `src/lib/boq-extraction-acceptance.ts` records separate model advice and human decisions.
- `src/app/(authenticated)/boqs/[id]/page.tsx` selects old/new UI by rollout stage and uses combined readiness.
- `src/components/unified-boq-items-table.tsx` receives the Stage 2 pending subset without changing Exclude semantics.

---

### Task 1: Add closed client normalization and request state

**Files:**

- Create: `src/lib/actionable-review-state.ts`
- Test: `src/lib/actionable-review-state.test.ts`
- Create: `src/lib/actionable-review-client.ts`
- Test: `src/lib/actionable-review-client.test.ts`

**Interfaces:**

- Consumes: Plan 1 `ActionableReview`/suggestion contracts and API route.
- Produces:

```ts
export interface ActionableReviewState {
  snapshot: ActionableReview | null
  selectedSuggestionId: string | null
  auditOpen: boolean
  loading: boolean
  submittingSuggestionId: string | null
  error: string | null
}

export function normalizeActionableReviewResponse(value: unknown): ActionableReview | null
```

- [ ] **Step 1: Write failing closed-schema tests**

Test duplicate suggestion/source IDs, missing provenance, unknown role/status, malformed versions, catalog IDs outside the shortlist, and extra numeric AI fields. Test that a stale snapshot remains inspectable but its mutation actions are unavailable.

Test latest-request-wins behavior and that failed decisions do not clear selected suggestion/form state.

- [ ] **Step 2: Verify RED**

```bash
npm test -- src/lib/actionable-review-state.test.ts src/lib/actionable-review-client.test.ts
```

- [ ] **Step 3: Implement the normalizer and dependency-injected client**

The client exposes load, generate, decide, and restore operations. It must use an abort/request-generation guard matching current extraction-review patterns. Approved/read-only context exposes load only.

- [ ] **Step 4: Verify GREEN and checks**

```bash
npm test -- src/lib/actionable-review-state.test.ts src/lib/actionable-review-client.test.ts
npm run check
graphify update .
git diff --check
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/actionable-review-state.ts src/lib/actionable-review-state.test.ts \
  src/lib/actionable-review-client.ts src/lib/actionable-review-client.test.ts
git commit -m "feat: add actionable review client state"
```

---

### Task 2: Build the Open Design focused workspace and audit drawer

**Files:**

- Create: `src/components/actionable-extraction-review.tsx`
- Test: `src/components/actionable-extraction-review.test.ts`
- Create: `src/components/actionable-review-detail.tsx`
- Test: `src/components/actionable-review-detail.test.ts`
- Create: `src/components/actionable-review-audit-drawer.tsx`
- Test: `src/components/actionable-review-audit-drawer.test.ts`
- Modify: `src/app/(authenticated)/boqs/[id]/page.tsx`
- Test: `src/app/(authenticated)/boqs/[id]/page.test.ts`
- Modify: `src/app/globals.css`

**Interfaces:**

- Consumes: Task 1 state/client, Plan 1 projection, `PdfReviewViewer`, BOQ sections, existing source-backed editor validation, historical pricing summaries, latest Open Design artifact.
- Produces a rollout-stage-gated responsive UI; no mutation behavior beyond disabled callbacks yet.

- [ ] **Step 1: Pull and inspect the Open Design artifact**

Use Open Design MCP:

```text
open_design_get_artifact(project="buildestimate-actionable-ai-review", include="all")
```

Record its entry file and preview URL in the task report. Extract layout/state requirements, not generated application code. Verify desktop evidence-first split, mobile drill-down, suggestion list, detail editor, conversion explanation, no-safe-match state, audit drawer, Stage 2, and approval blocking.

- [ ] **Step 2: Write failing component/source assertions**

Tests must prove:

- normal list renders only actionable suggestions,
- counts expose verified/prepared/actionable/dismissed/source-difference summaries,
- selected suggestion drives page/table/row source highlight,
- dismissed and represented evidence appear only inside the audit drawer,
- restore is hidden in approved/read-only mode,
- buttons read **Add & match**, **Add to BOQ**, **Find another**, and **Do not add**,
- **Add & match** is disabled below `add_and_match`,
- old `off`/`shadow` stages keep the current `ExtractionReview`,
- no page-level mobile overflow selectors are introduced,
- exact **Exclude** copy is unchanged elsewhere.

- [ ] **Step 3: Verify RED**

```bash
npm test -- src/components/actionable-extraction-review.test.ts \
  src/components/actionable-review-detail.test.ts \
  src/components/actionable-review-audit-drawer.test.ts \
  'src/app/(authenticated)/boqs/[id]/page.test.ts'
```

- [ ] **Step 4: Implement the minimal Open Design-aligned UI**

Desktop uses persistent source evidence plus actionable queue/detail. Mobile uses queue → evidence → detail drill-down rather than squeezing the split pane. Use existing design tokens, deep navy, Swiss typography, restrained blue-tinted elevation, no gradients, visible focus, and accessible labels.

Do not place projection/business logic in React. Components receive normalized snapshots and callbacks.

- [ ] **Step 5: Verify GREEN and checks**

```bash
npm test -- src/components/actionable-extraction-review.test.ts \
  src/components/actionable-review-detail.test.ts \
  src/components/actionable-review-audit-drawer.test.ts \
  'src/app/(authenticated)/boqs/[id]/page.test.ts'
npm run check
graphify update .
git diff --check
```

- [ ] **Step 6: Commit**

```bash
git add src/components/actionable-extraction-review.tsx \
  src/components/actionable-extraction-review.test.ts \
  src/components/actionable-review-detail.tsx \
  src/components/actionable-review-detail.test.ts \
  src/components/actionable-review-audit-drawer.tsx \
  src/components/actionable-review-audit-drawer.test.ts src/app/globals.css
git add -p -- 'src/app/(authenticated)/boqs/[id]/page.tsx' \
  'src/app/(authenticated)/boqs/[id]/page.test.ts'
git diff --cached --check
git diff --cached
git commit -m "feat: show focused actionable extraction review"
```

---

### Task 3: Add the closed actionable decision API

**Files:**

- Create: `src/lib/actionable-review-decision.ts`
- Test: `src/lib/actionable-review-decision.test.ts`
- Create: `src/app/api/boqs/[id]/extraction-runs/[runId]/actionable-review/[suggestionId]/decision/route.ts`
- Test: `src/app/api/boqs/[id]/extraction-runs/[runId]/actionable-review/actionable-review-decision-api.test.ts`

**Interfaces:**

- Consumes: existing source-backed editable item contract, opaque suggestion ID, Plan 1 snapshot fingerprint.
- Produces:

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
```

- [ ] **Step 1: Write failing parser/API tests**

Prove exact key allowlists, trimmed optional dismiss note limited to 500 characters, optional trimmed `correctionReason` limited to 500 characters for Add to BOQ, valid section/item editable fields, and rejection of client fields such as `sourceRowIds`, `extractedPricing`, `reviewerPricing`, `catalogCandidates`, `aiAdvice`, `normalizedTotal`, and `conversionFactor`.

API tests must prove authentication, opaque ID lookup, approved BOQ `409`, stale fingerprint conflict, and dependency injection.

- [ ] **Step 2: Verify RED**

```bash
npm test -- src/lib/actionable-review-decision.test.ts \
  'src/app/api/boqs/[id]/extraction-runs/[runId]/actionable-review/actionable-review-decision-api.test.ts'
```

- [ ] **Step 3: Implement closed parsing and thin route handler**

The route authenticates, parses only the closed request, and delegates to a store method. It never trusts client provenance/pricing and never calls another API route.

- [ ] **Step 4: Verify GREEN and checks**

```bash
npm test -- src/lib/actionable-review-decision.test.ts \
  'src/app/api/boqs/[id]/extraction-runs/[runId]/actionable-review/actionable-review-decision-api.test.ts'
npm run check
graphify update .
git diff --check
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/actionable-review-decision.ts src/lib/actionable-review-decision.test.ts \
  'src/app/api/boqs/[id]/extraction-runs/[runId]/actionable-review/[suggestionId]/decision/route.ts' \
  'src/app/api/boqs/[id]/extraction-runs/[runId]/actionable-review/actionable-review-decision-api.test.ts'
git commit -m "feat: define actionable review decisions"
```

---

### Task 4: Apply Add to BOQ, Do not add, and restore atomically

**Files:**

- Modify: `src/lib/boq-extraction-proposal-store.ts`
- Test: `src/lib/boq-extraction-proposal-store.test.ts`
- Modify: `src/lib/boq-extraction-acceptance.ts`
- Test: `src/lib/boq-extraction-acceptance.test.ts`
- Modify: `src/lib/actionable-review-storage.ts`
- Test: `src/lib/actionable-review-storage.test.ts`
- Modify: `src/lib/actionable-review-client.ts`
- Test: `src/lib/actionable-review-client.test.ts`
- Modify: `src/components/actionable-extraction-review.tsx`
- Test: `src/components/actionable-extraction-review.test.ts`
- Modify: `src/app/api/boqs/[id]/extraction-runs/[runId]/actionable-review/[suggestionId]/decision/route.ts`
- Test: `src/app/api/boqs/[id]/extraction-runs/[runId]/actionable-review/actionable-review-decision-api.test.ts`

**Interfaces:**

- Consumes: Task 3 request, immutable extraction run/source rows/snapshot, existing proposal audit/lifecycle transactions.
- Produces:

```ts
export async function decideActionableSuggestion(
  boqId: string,
  runId: string,
  suggestionId: string,
  request: ActionableReviewDecisionRequest,
  actorId: string,
): Promise<ProposalStoreResponse>
```

- [ ] **Step 1: Write failing atomicity/idempotency tests**

Cover:

- Add to BOQ reconstructs immutable extraction provenance/raw evidence, preserves extracted pricing unchanged in the actionable audit, validates the reviewer-authored `SourceBackedItemRequest`, captures those values in a distinct `ReviewerPricingSnapshot` with server actor/time in that audit, requires `correctionReason` for numeric divergence, creates one current-schema item with row provenance, leaves catalog pending, writes field-level deltas plus one human decision/audit, and terminally updates the suggestion. This plan does not yet add pricing snapshots to `BoqPricedItem`; Plan 3 adds that backward-compatible schema.
- Do not add writes decision/audit/status and creates no item.
- Restore writes a new audit event and returns a dismissed row to pending; represented rows cannot restore.
- approved, stale, changed source checksum, changed BOQ fingerprint, non-pending suggestion, invalid fields, and simulated final write failures produce no partial writes.
- identical retry returns the same terminal result and never duplicates an item.

- [ ] **Step 2: Verify RED**

```bash
npm test -- src/lib/boq-extraction-acceptance.test.ts \
  src/lib/boq-extraction-proposal-store.test.ts \
  src/lib/actionable-review-storage.test.ts \
  'src/app/api/boqs/[id]/extraction-runs/[runId]/actionable-review/actionable-review-decision-api.test.ts'
```

- [ ] **Step 3: Implement the narrow transaction entry point**

Perform all validation and reconstruction before any transaction write. Reuse existing proposal-order/source-provenance and audit helpers. Do not add projection logic to the store. Keep AI advice and human decision as separate audit fields.

Atomic write sets:

```text
Add to BOQ:
  current-schema BOQ item + immutable source provenance + pending catalog state
  + proposal/actionable audit containing immutable extracted pricing
  + distinct reviewer-confirmed pricing and correction deltas/reason
  + reviewer decision + suggestion status

Do not add:
  proposal/actionable audit + reviewer decision + suggestion status

Restore:
  audit event + pending suggestion status
```

- [ ] **Step 4: Wire UI callbacks and preserve failed form state**

Connect Task 2 callbacks through `actionable-review-client.ts`. Success selects the next pending suggestion; failure leaves current edits, selected row, and decision intact.

- [ ] **Step 5: Verify GREEN and checks**

```bash
npm test -- src/lib/boq-extraction-acceptance.test.ts \
  src/lib/boq-extraction-proposal-store.test.ts \
  src/lib/actionable-review-storage.test.ts \
  'src/app/api/boqs/[id]/extraction-runs/[runId]/actionable-review/actionable-review-decision-api.test.ts' \
  src/components/actionable-extraction-review.test.ts
npm run check
graphify update .
git diff --check
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/boq-extraction-proposal-store.ts \
  src/lib/boq-extraction-proposal-store.test.ts \
  src/lib/boq-extraction-acceptance.ts src/lib/boq-extraction-acceptance.test.ts \
  src/lib/actionable-review-storage.ts src/lib/actionable-review-storage.test.ts \
  src/lib/actionable-review-client.ts src/lib/actionable-review-client.test.ts \
  src/components/actionable-extraction-review.tsx \
  src/components/actionable-extraction-review.test.ts \
  'src/app/api/boqs/[id]/extraction-runs/[runId]/actionable-review/[suggestionId]/decision/route.ts' \
  'src/app/api/boqs/[id]/extraction-runs/[runId]/actionable-review/actionable-review-decision-api.test.ts'
git commit -m "feat: apply actionable review decisions atomically"
```

---

### Task 5: Focus Stage 2 on catalog-pending items

**Files:**

- Create: `src/lib/catalog-pending-items.ts`
- Test: `src/lib/catalog-pending-items.test.ts`
- Modify: `src/components/unified-boq-items-table.tsx`
- Test: `src/components/unified-boq-items-table.test.ts`
- Modify: `src/app/(authenticated)/boqs/[id]/page.tsx`
- Test: `src/app/(authenticated)/boqs/[id]/page.test.ts`

**Interfaces:**

- Consumes: current BOQ unified rows and catalog readiness state; cached proposed catalog metadata from actionable suggestions.
- Produces:

```ts
export function catalogPendingItems(boq: Boq): UnifiedBoqPricedRow[]
```

- [ ] **Step 1: Write failing Stage 2 tests**

Assert Stage 2 contains only positive-rate priced items that remain unmatched/pending. Matched and Excluded items are not shown as pending. Cached proposed name/unit/category/aliases prefill create fields but never create a standard automatically.

Assert actions/copy remain **Create & link**, **Find existing**, and **Exclude**.

- [ ] **Step 2: Verify RED**

```bash
npm test -- src/lib/catalog-pending-items.test.ts \
  src/components/unified-boq-items-table.test.ts \
  'src/app/(authenticated)/boqs/[id]/page.test.ts'
```

- [ ] **Step 3: Implement the pure projection and page wiring**

Keep historical pricing advisory. Do not change `getBoqCatalogReadiness()` semantics. Existing match/create/exclude APIs remain unchanged.

- [ ] **Step 4: Verify GREEN and checks**

```bash
npm test -- src/lib/catalog-pending-items.test.ts \
  src/components/unified-boq-items-table.test.ts \
  'src/app/(authenticated)/boqs/[id]/page.test.ts'
npm run check
graphify update .
git diff --check
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/catalog-pending-items.ts src/lib/catalog-pending-items.test.ts \
  src/components/unified-boq-items-table.tsx \
  src/components/unified-boq-items-table.test.ts
git add -p -- 'src/app/(authenticated)/boqs/[id]/page.tsx' \
  'src/app/(authenticated)/boqs/[id]/page.test.ts'
git diff --cached --check
git diff --cached
git commit -m "feat: focus catalog readiness on pending items"
```

---

### Task 6: Block approval on pending/stale actionable review

**Files:**

- Create: `src/lib/boq-approval-readiness.ts`
- Test: `src/lib/boq-approval-readiness.test.ts`
- Modify: `src/app/api/boqs/[id]/handler.ts`
- Test: `src/app/api/boqs/boq-id-api.test.ts`
- Modify: `src/app/api/boqs/[id]/route.ts`
- Modify: `src/app/(authenticated)/boqs/[id]/page.tsx`
- Test: `src/app/(authenticated)/boqs/[id]/page.test.ts`

**Interfaces:**

- Consumes: deterministic verification, catalog readiness, active actionable/proposal state, rollout stage.
- Produces:

```ts
export interface BoqApprovalReadiness {
  verificationBlocking: number
  catalogBlocking: number
  actionableReviewBlocking: number
  staleReview: boolean
}
```

- [ ] **Step 1: Write failing combined-readiness tests**

Test pending suggestion, stale active snapshot, unresolved current proposal, catalog blocker, verification blocker, fully resolved draft, and approved read-only state.

Add an API concurrency test: approval transaction reads BOQ and active review state; a concurrent restore/new suggestion either conflicts or causes approval failure.

Add a page test replacing misleading success copy “approved and linked to the Standard Catalog” with status-only **BOQ approved**.

- [ ] **Step 2: Verify RED**

```bash
npm test -- src/lib/boq-approval-readiness.test.ts \
  'src/app/api/boqs/[id]/*.test.ts' \
  'src/app/(authenticated)/boqs/[id]/page.test.ts'
```

- [ ] **Step 3: Implement transactional approval readiness**

Approval must read the BOQ plus current actionable/proposal state in the same transaction before setting `status: 'approved'`. Do not bulk-create catalog entries during approval. Return structured blocker counts and exact reconciliation details.

- [ ] **Step 4: Verify focused GREEN and full checks**

```bash
npm test -- src/lib/boq-approval-readiness.test.ts \
  'src/app/api/boqs/[id]/*.test.ts' \
  'src/app/(authenticated)/boqs/[id]/page.test.ts'
npm run check
npx tsc --noEmit
graphify update .
git diff --check
git status --short
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/boq-approval-readiness.ts src/lib/boq-approval-readiness.test.ts \
  'src/app/api/boqs/[id]/handler.ts' 'src/app/api/boqs/[id]/route.ts' \
  src/app/api/boqs/boq-id-api.test.ts
git add -p -- 'src/app/(authenticated)/boqs/[id]/page.tsx' \
  'src/app/(authenticated)/boqs/[id]/page.test.ts'
git diff --cached --check
git diff --cached
git commit -m "fix: block approval on pending extraction review"
```

---

## Plan Completion Gate

- [ ] Open Design project `buildestimate-actionable-ai-review` was used as the UI reference and its preview recorded in the task report.
- [ ] Normal review shows only actionable suggestions.
- [ ] Dismissed/represented rows remain inspectable and restorable where valid.
- [ ] Every likely missing item requires Add to BOQ or Do not add.
- [ ] Add & match remains disabled until the next plan.
- [ ] Add to BOQ creates one source-backed catalog-pending item atomically.
- [ ] Do not add creates no item.
- [ ] Stage 2 contains only catalog-pending priced items and preserves Exclude.
- [ ] Approval transaction blocks pending/stale review and does not create catalog entries.
- [ ] Approved BOQs are read-only.
- [ ] Desktop and mobile browser QA use at least one sanitized text-layer digital PDF fixture and one sanitized image-only scanned PDF fixture.
- [ ] `npm run check`, `npx tsc --noEmit`, `graphify update .`, and `git diff --check` pass.
- [ ] No unrelated working-tree edits were staged.

**Next plan:** `docs/superpowers/plans/2026-08-08-conversion-aware-add-match-rollout.md`
