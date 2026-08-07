# Mixed-Row Human-Review Decisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace unsafe implicit add-all batches with AI-advised, explicitly human-decided, atomic per-source-row Add/Do not add decisions that reconcile the affected BOQ without duplicates or summary items.

**Architecture:** Extend validated extraction proposals with optional, non-binding per-row AI disposition suggestions from the existing full-document review. Submit a closed human-decision union for every source row, process added and ignored rows atomically, and persist AI advice separately from final reviewer decisions in the accepted audit. Keep mapped and one-row editors unchanged; split pure batch-editor state from rendering so undecided/add/ignore behavior is testable without a browser DOM library.

**Tech Stack:** TypeScript, React 19, Next.js App Router handlers, Firestore transactions, Node test runner, ESLint, pi-lens LSP diagnostics, graphify, agent-browser.

## Global Constraints

- Work directly on `main`; preserve the eleven unrelated unstaged edits and stage only named task files. Never use `git add .`.
- Never read, stage, or commit `Quotation example/`.
- Use 2-space indentation and existing source-backed form helpers; add no dependencies.
- Run `npm run check` after every code task and `graphify update .` after code changes.
- AI suggestions are advisory metadata only: they never preselect a human choice and never contain or populate persisted item values.
- Every row starts **Undecided**; submission requires an explicit **Add to BOQ** or **Do not add** choice for every proposal row.
- **Do not add** notes are optional, reviewer-authored, trimmed, and limited to 500 characters.
- Keep automatic **Accept** disabled for every `needs_human_review` proposal.
- Never infer description, unit, quantity, rate, total, section, or provenance from `rawText`, `rawCells`, classifications, warnings, or provider explanations.
- Keep mapped-draft and one-row source-backed workflows unchanged.
- Keep the endpoint path and single-item wire shape unchanged; reject the obsolete multi-row `{ items }` shape.
- Preserve authentication, opaque IDs, approved/read-only guards, stale-context checks, strict source-total reconciliation, accepted idempotency, undo, and catalog **Exclude** wording.
- A decision batch covers every immutable proposal source row exactly once or commits nothing.
- Added items carry only their own immutable source-row provenance; ignored rows create no item.
- Do not approve the affected BOQ during QA.

---

### Task 1: Carry non-binding AI row suggestions through review

**Files:**

- Modify: `src/lib/boq-extraction-proposals.ts`
- Modify: `src/lib/boq-extraction-proposals.test.ts`
- Modify: `src/lib/boq-extraction-proposal-contract.ts`
- Modify: `src/lib/boq-extraction-proposal-contract.test.ts`
- Modify: `src/lib/boq-extraction-ai-review.ts`
- Modify: `src/lib/boq-extraction-ai-review.test.ts`
- Modify: `src/lib/boq-extraction-review-state.ts`
- Modify: `src/lib/boq-extraction-review-state.test.ts`

**Interfaces:**

- Consumes: existing `ExtractionProposal`, `prepareProviderProposalV2`, `providerContractInstructionsV2`, `executeExtractionReview`, and client response normalization.
- Produces:

```ts
export const SOURCE_ROW_DISPOSITION_REASON_CODES = [
  "missing_priced_item",
  "already_represented",
  "summary_or_tax",
  "unsupported_content",
  "uncertain",
] as const

export type SourceRowDispositionReasonCode = typeof SOURCE_ROW_DISPOSITION_REASON_CODES[number]

export interface SourceRowDispositionSuggestion {
  sourceRowId: string
  suggestedAction: "add" | "ignore"
  reasonCode: SourceRowDispositionReasonCode
  reason: string
  confidence: number
}

export function normalizeSourceRowDispositionSuggestions(
  value: unknown,
  sourceRowIds: readonly string[],
): SourceRowDispositionSuggestion[] | null
```

- `ExtractionProposal` gains `sourceRowSuggestions?: SourceRowDispositionSuggestion[]`.
- `normalizeSourceRowDispositionSuggestions` accepts only a complete, unique, exact row set; validates non-blank reason up to 500 characters and confidence from 0 to 1; and returns proposal order.

- [ ] **Step 1: Write failing proposal and provider-contract tests**

Add tests that prove:

```ts
assert.deepEqual(
  normalizeSourceRowDispositionSuggestions([
    { sourceRowId: "sr-2", suggestedAction: "ignore", reasonCode: "summary_or_tax", reason: "Subtotal", confidence: 0.99 },
    { sourceRowId: "sr-1", suggestedAction: "add", reasonCode: "missing_priced_item", reason: "Missing line", confidence: 0.91 },
  ], ["sr-1", "sr-2"])?.map((entry) => entry.sourceRowId),
  ["sr-1", "sr-2"],
)
```

Cover missing, duplicate, extra, unknown, invalid-action, invalid-reason-code, blank/overlong reason, and out-of-range confidence blocks returning `null`. Extend structural proposal tests so a valid optional suggestion set is accepted, malformed stored metadata is rejected, and a proposal without suggestions remains valid.

In provider-contract tests, require a complete valid `sourceRowSuggestions` block on a `needs_human_review` provider decision to be normalized into proposal order. Require malformed/incomplete advisory blocks to be omitted while the core human-review proposal remains `ok: true`. Require advisory fields on non-human-review operations to fail preparation.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm test -- src/lib/boq-extraction-proposals.test.ts src/lib/boq-extraction-proposal-contract.test.ts
```

Expected: FAIL because the advisory types/normalizer and `sourceRowSuggestions` provider field do not exist.

- [ ] **Step 3: Implement proposal metadata and provider preparation**

In `boq-extraction-proposals.ts`, add the exported advisory types and pure normalizer, add `sourceRowSuggestions` to `ExtractionProposal`, add the key to the exact stored-key allowlist, and validate optional stored metadata against `proposal.sourceRowIds`.

In `boq-extraction-proposal-contract.ts`:

- add `sourceRowSuggestions` to the v2 provider key allowlist;
- allow it only on `needs_human_review`;
- call the pure normalizer after `sourceRowIds` are validated;
- attach normalized suggestions only when the complete block is valid;
- omit malformed/incomplete advisory metadata without rejecting an otherwise valid human-review decision; and
- keep all existing value-authoring prohibitions.

Update `providerContractInstructionsV2()` so `needs_human_review` requests exactly one advisory entry per source row, lists the five reason codes, and explicitly forbids descriptions, units, quantities, rates, totals, section choices, mappings, or preselected human decisions in the advisory block.

- [ ] **Step 4: Write failing AI-review and client-normalization tests**

Add an AI review test with a provider response containing a reversed complete suggestion set and assert the returned proposal contains proposal-ordered suggestions. Add a malformed advisory response and assert the human-review proposal remains available with `sourceRowSuggestions === undefined`.

Add client normalization tests asserting:

```ts
const normalized = normalizeExtractionReviewResponse(responseWithSuggestions)
assert.equal(normalized?.proposals[0]?.sourceRowSuggestions?.[0]?.sourceRowId, "sr-1")
assert.equal(normalizeExtractionReviewResponse(responseWithMalformedStoredSuggestions), null)
```

Also assert the built full-document messages still include all Docling source rows and current BOQ targets, and the provider contract never asks for item values in advisory output.

- [ ] **Step 5: Implement AI/client propagation and run GREEN**

Preserve `sourceRowSuggestions` through `executeExtractionReview` and durable proposal persistence without turning them into actions. Extend `validProposalShape` in `boq-extraction-review-state.ts` to accept only the same complete, exact, ordered advisory shape while keeping suggestions optional for legacy proposals.

Run:

```bash
npm test -- src/lib/boq-extraction-proposals.test.ts src/lib/boq-extraction-proposal-contract.test.ts src/lib/boq-extraction-ai-review.test.ts src/lib/boq-extraction-review-state.test.ts
npx tsc --noEmit
npm run check
graphify update .
```

Expected: all focused tests and the full check pass; TypeScript and graphify exit 0.

- [ ] **Step 6: Run diagnostics and commit**

Run pi-lens/LSP diagnostics on the eight changed files, then:

```bash
git diff --check
git add -- src/lib/boq-extraction-proposals.ts src/lib/boq-extraction-proposals.test.ts src/lib/boq-extraction-proposal-contract.ts src/lib/boq-extraction-proposal-contract.test.ts src/lib/boq-extraction-ai-review.ts src/lib/boq-extraction-ai-review.test.ts src/lib/boq-extraction-review-state.ts src/lib/boq-extraction-review-state.test.ts
git commit -m "feat: add AI row disposition suggestions"
```

---

### Task 2: Parse a closed human decision-batch request

**Files:**

- Modify: `src/lib/boq-user-entry.ts`
- Modify: `src/lib/boq-user-entry.test.ts`
- Modify: `src/app/api/boqs/[id]/extraction-runs/[runId]/proposals/proposals-api.test.ts`

**Interfaces:**

- Consumes: `SourceBackedItemRequest` and `parseSourceBackedItemRequest`.
- Produces:

```ts
export interface SourceRowAddDecisionRequest {
  sourceRowId: string
  action: "add"
  sectionIndex: number
  item: SourceBackedItemRequest["item"]
}

export interface SourceRowIgnoreDecisionRequest {
  sourceRowId: string
  action: "ignore"
  note?: string
}

export type SourceRowDecisionRequest =
  | SourceRowAddDecisionRequest
  | SourceRowIgnoreDecisionRequest

export type SourceBackedManualAddRequest =
  | { mode: "single"; value: SourceBackedItemRequest }
  | { mode: "decision_batch"; decisions: SourceRowDecisionRequest[] }
```

- Wire shapes remain `{ sectionIndex, item }` for single and `{ decisions: [...] }` for multi-row.

- [ ] **Step 1: Write failing parser tests**

Add tests for mixed, add-only, and ignore-only requests. Assert client order is preserved by the parser, blank notes are omitted after trimming, and a note such as `"  Already represented  "` becomes `"Already represented"`.

Add rejection tests for:

- obsolete `{ items: [...] }`;
- unknown top-level and decision keys;
- empty or over-limit decisions;
- duplicate/blank row IDs;
- missing/invalid action;
- add decisions missing `sectionIndex` or `item`;
- add decisions containing `note`;
- ignore decisions containing `sectionIndex` or `item`;
- non-string notes; and
- notes longer than 500 characters.

- [ ] **Step 2: Run the parser suite and verify RED**

Run:

```bash
npm test -- src/lib/boq-user-entry.test.ts
```

Expected: FAIL because `{ decisions }` is not recognized and the old `{ items }` shape is still accepted.

- [ ] **Step 3: Implement the closed discriminator parser**

Replace the old batch interfaces with the decision union. Detect a top-level own `decisions` key before the existing single parser. Use exact allowlists:

```ts
const DECISION_BATCH_KEYS = new Set(["decisions"])
const ADD_DECISION_KEYS = new Set(["sourceRowId", "action", "sectionIndex", "item"])
const IGNORE_DECISION_KEYS = new Set(["sourceRowId", "action", "note"])
```

Reuse `parseSourceBackedItemRequest({ sectionIndex, item })` for add decisions. Trim optional ignore notes and omit empty notes. Do not parse evidence text or explanations. Let the obsolete `{ items }` object fall into the single parser and fail on its unexpected field.

- [ ] **Step 4: Add API delegation coverage**

In `proposals-api.test.ts`, POST one mixed `{ decisions }` body and assert `dependencies.addSourceItem` receives `{ mode: "decision_batch", decisions: [...] }` unchanged after parsing. Assert obsolete `{ items }` and malformed decision requests return 400 without calling the store.

- [ ] **Step 5: Run verification and commit**

Run:

```bash
npm test -- src/lib/boq-user-entry.test.ts 'src/app/api/boqs/[id]/extraction-runs/[runId]/proposals/proposals-api.test.ts'
npx tsc --noEmit
npm run check
graphify update .
```

Run LSP diagnostics on the three changed files, then:

```bash
git diff --check
git add -- src/lib/boq-user-entry.ts src/lib/boq-user-entry.test.ts 'src/app/api/boqs/[id]/extraction-runs/[runId]/proposals/proposals-api.test.ts'
git commit -m "feat: parse source-row decision batches"
```

---

### Task 3: Persist mixed add/ignore decisions atomically with audit evidence

**Files:**

- Modify: `src/lib/boq-extraction-acceptance.ts`
- Modify: `src/lib/boq-extraction-acceptance.test.ts`
- Modify: `src/lib/boq-extraction-proposal-store.ts`
- Modify: `src/lib/boq-extraction-proposal-store.test.ts`

**Interfaces:**

- Consumes: Task 1 `SourceRowDispositionSuggestion[]`; Task 2 `SourceRowDecisionRequest[]` and `mode: "decision_batch"`.
- Produces:

```ts
export type SourceRowAuditDecision =
  | { sourceRowId: string; action: "add"; itemId: string }
  | { sourceRowId: string; action: "ignore"; note?: string }

// ExtractionProposalAudit additions
sourceRowSuggestions?: SourceRowDispositionSuggestion[]
sourceRowDecisions?: SourceRowAuditDecision[]
```

- New decision-batch audits always contain a complete `sourceRowDecisions` set in proposal order. Added audit entries bind to generated item IDs.

- [ ] **Step 1: Write failing audit-contract tests**

Extend acceptance tests so complete ordered `sourceRowSuggestions` and `sourceRowDecisions` are valid audit metadata, proposal/audit matching includes AI suggestions, and legacy audits without either field remain valid. Reject duplicate, missing, extra, unknown, invalid-action, blank-item-ID, overlong-note, or out-of-order decision metadata against `audit.sourceRowIds`.

- [ ] **Step 2: Implement audit types and structural validation**

Add the exported audit decision union and optional fields to `ExtractionProposalAudit`. Add strict pure guards that validate suggestions and decisions against `audit.sourceRowIds`. Update `toAudit`, `proposalMatchesAudit`, `auditComplete`, and manual `buildSourceItemAudit` paths so provider suggestions are copied when present and human decisions are supplied only by the manual decision-batch transaction.

Do not require the new fields on legacy accepted/rejected/skipped audits.

- [ ] **Step 3: Write failing transaction tests**

Add store tests with a three-row proposal and decisions in reversed client order:

```ts
{
  mode: "decision_batch",
  decisions: [
    { sourceRowId: "sr-3", action: "ignore", note: "Summary" },
    { sourceRowId: "sr-2", action: "add", sectionIndex: 0, item: validItem("Second") },
    { sourceRowId: "sr-1", action: "add", sectionIndex: 0, item: validItem("First") },
  ],
}
```

Assert:

- exactly two items are created in proposal row order;
- each created item has only its own `sourceRowId`, `[sourceRowId]`, and PDF `sourceRef`;
- the ignored row creates no item;
- audit decisions are ordered `sr-1`, `sr-2`, `sr-3`;
- add decisions contain the exact generated BOQ item IDs;
- the ignored note is preserved trimmed;
- AI suggestions and final human choices remain separate;
- one audit/lifecycle update occurs;
- one BOQ write contains the aggregate total;
- accepted retry is idempotent and returns the original audit/result;
- undo removes only the created items; and
- all-ignore accepts with unchanged sections/totals and a complete audit.

Add failure cases for single/obsolete batch requests on multi-row proposals, missing/extra/unknown rows, invalid section/item data, approved/stale/non-pending proposals, and injected failure on a later add proving no BOQ/audit/lifecycle write commits.

Retain explicit regression tests for mapped-draft and one-row single requests.

- [ ] **Step 4: Run the focused store suite and verify RED**

Run:

```bash
npm test -- src/lib/boq-extraction-acceptance.test.ts src/lib/boq-extraction-proposal-store.test.ts
```

Expected: FAIL because the store still requires `mode: "batch"`, creates an item for every row, and emits no row decisions.

- [ ] **Step 5: Implement the atomic mixed transaction**

In the multi-row no-draft branch:

1. require `request.mode === "decision_batch"`;
2. validate the exact decision row set against `proposal.sourceRowIds`;
3. map decisions by row ID and iterate proposal order;
4. for `ignore`, append `{ sourceRowId, action: "ignore", ...(note ? { note } : {}) }` and do not mutate sections;
5. for `add`, generate a new `user-` item ID with `randomUUID()`, call `addSourceBackedBoqItem` with that immutable row alone, and append `{ sourceRowId, action: "add", itemId }`;
6. pass ordered decisions into `buildSourceItemAudit`; and
7. retain the existing single final BOQ update, single accepted lifecycle event, and accepted retry path.

Return `decision_batch_required` for a multi-row proposal receiving any non-decision request. Keep transaction exceptions fail-closed.

- [ ] **Step 6: Run verification and commit**

Run:

```bash
npm test -- src/lib/boq-extraction-acceptance.test.ts src/lib/boq-extraction-proposal-store.test.ts
npx tsc --noEmit
npm run check
graphify update .
```

Run LSP diagnostics on the four changed files, then:

```bash
git diff --check
git add -- src/lib/boq-extraction-acceptance.ts src/lib/boq-extraction-acceptance.test.ts src/lib/boq-extraction-proposal-store.ts src/lib/boq-extraction-proposal-store.test.ts
git commit -m "feat: persist atomic source-row decisions"
```

---

### Task 4: Build undecided/add/ignore editor state and rendering

**Files:**

- Create: `src/components/evidence-only-batch-item-editor-state.ts`
- Create: `src/components/evidence-only-batch-item-editor-state.test.ts`
- Modify: `src/components/evidence-only-batch-item-editor.tsx`
- Modify: `src/components/evidence-only-batch-item-editor.test.ts`

**Interfaces:**

- Consumes: existing `deriveInitialSourceBackedForm`, `validateSourceBackedForm`, `computeSourceBackedLiveTotal`, and `buildSourceBackedItemPayload`; Task 1 proposal suggestions.
- Produces:

```ts
export type EvidenceOnlyRowDecision = "undecided" | "add" | "ignore"

export interface EvidenceOnlyBatchEditorState {
  decisions: Map<string, EvidenceOnlyRowDecision>
  forms: Map<string, SourceBackedEditableFields>
  sectionIndexes: Map<string, number>
  notes: Map<string, string>
}

export type EvidenceOnlyBatchEditorAction =
  | { type: "set_decision"; sourceRowId: string; decision: EvidenceOnlyRowDecision }
  | { type: "set_field"; sourceRowId: string; field: keyof SourceBackedEditableFields; value: string | number }
  | { type: "set_section"; sourceRowId: string; sectionIndex: number }
  | { type: "set_note"; sourceRowId: string; note: string }

export interface EvidenceOnlyDecisionBatchPayload {
  decisions: Array<
    | { sourceRowId: string; action: "add"; sectionIndex: number; item: SourceBackedItemPayload["item"] }
    | { sourceRowId: string; action: "ignore"; note?: string }
  >
}
```

Also produce `initializeEvidenceOnlyBatchEditorState`, `evidenceOnlyBatchEditorReducer`, `validateEvidenceOnlyDecisionBatch`, `buildEvidenceOnlyDecisionBatchPayload`, and `evidenceOnlyDecisionActionLabel`.

- [ ] **Step 1: Write failing pure-state tests**

Test that initialization creates one blank/manual form, valid default section, empty note, and `undecided` decision per proposal row in proposal order. Test reducer transitions add → ignore → undecided without copying AI advice into decisions and without losing typed form/note state.

Test validation:

- all-undecided and partially decided are invalid;
- an add row is invalid until its form and section are valid;
- an ignore row is valid with no note;
- a 501-character note is invalid;
- mixed complete, add-only complete, and ignore-only complete states are valid.

Test payload/order and labels:

```ts
assert.equal(evidenceOnlyDecisionActionLabel(state, proposal), "Add 5 BOQ items · Ignore 5 rows")
assert.equal(evidenceOnlyDecisionActionLabel(allAdd, proposal), "Add 10 BOQ items")
assert.equal(evidenceOnlyDecisionActionLabel(allIgnore, proposal), "Ignore 10 rows")
```

Assert the payload follows proposal order, includes each row exactly once, trims/omits blank ignore notes, and contains no AI suggestion, reason, confidence, raw evidence, or provider explanation fields.

- [ ] **Step 2: Run state tests and verify RED**

Run:

```bash
npm test -- src/components/evidence-only-batch-item-editor-state.test.ts
```

Expected: FAIL because the pure editor-state module does not exist.

- [ ] **Step 3: Implement the pure state module**

Move collection state, validation, payload construction, and action-label logic out of the component. Reuse existing source-backed helpers rather than duplicating financial validation. Iterate `proposal.sourceRowIds` for every validation and payload operation; never trust `Map` insertion order.

The reducer must preserve hidden add fields while a row is temporarily ignored, but only the currently selected action may enter the outgoing payload.

- [ ] **Step 4: Write failing render-contract tests**

Extend static render/source tests to require:

- one fieldset and unique source legend per proposal row;
- an advisory badge with reason and confidence when present;
- **AI suggestion unavailable** when absent;
- no checked Add/Do not add radio initially;
- accessible unique radio IDs and labels per row;
- add fields hidden while undecided;
- optional ignore-note control tied to ignore state;
- submit disabled initially; and
- no imports from extraction cell mapping or reads of `rawText`, `rawCells`, or `.explanation`.

Use pure reducer tests for action switching because the repository harness does not provide a DOM interaction library.

- [ ] **Step 5: Implement the decision renderer and run GREEN**

Refactor `EvidenceOnlyBatchItemEditor` to `useReducer` with the pure state module. Render suggestion metadata separately from an accessible radio group. Reveal manual item controls only for `add`, reveal `<textarea maxLength={500}>` only for `ignore`, and leave both hidden for `undecided`.

Use `validateEvidenceOnlyDecisionBatch` for disabled state and `buildEvidenceOnlyDecisionBatchPayload` on submit. Keep server errors, cancel, busy state, source labels, live totals, and destination sections. Change the heading to **Review source-row decisions** and use the dynamic primary action label.

Run:

```bash
npm test -- src/components/evidence-only-batch-item-editor-state.test.ts src/components/evidence-only-batch-item-editor.test.ts src/components/source-backed-item-editor.test.ts
npx tsc --noEmit
npm run check
graphify update .
```

Expected: all focused/full checks pass.

- [ ] **Step 6: Run diagnostics and commit**

Run LSP diagnostics on the four changed files, then:

```bash
git diff --check
git add -- src/components/evidence-only-batch-item-editor-state.ts src/components/evidence-only-batch-item-editor-state.test.ts src/components/evidence-only-batch-item-editor.tsx src/components/evidence-only-batch-item-editor.test.ts
git commit -m "feat: add explicit source-row review decisions"
```

---

### Task 5: Integrate decision batches and responsive styling

**Files:**

- Modify: `src/components/extraction-review.tsx`
- Modify: `src/components/extraction-review.test.ts`
- Modify: `src/app/globals.css`

**Interfaces:**

- Consumes: Task 4 `EvidenceOnlyDecisionBatchPayload`; existing `proposalManualAddMode` and `SourceBackedItemPayload`.
- Produces: one unchanged `/add-source-item` fetch path that posts either `SourceBackedItemPayload` or `EvidenceOnlyDecisionBatchPayload` verbatim.

- [ ] **Step 1: Write failing integration tests**

Extend extraction-review tests to prove:

- a no-draft multi-row proposal still mounts only `EvidenceOnlyBatchItemEditor`;
- mapped and one-row proposals still mount `SourceBackedItemEditor`;
- `submitSourceBackedItem` accepts `SourceBackedItemPayload | EvidenceOnlyDecisionBatchPayload`;
- the same endpoint receives `JSON.stringify(payload)` with no duplicated request logic;
- one **Review & add** action and one `editingProposalId` remain;
- automatic **Accept** remains suppressed for `needs_human_review`;
- a failed submit leaves the editor mounted with its in-memory human decisions intact; and
- Skip/history/read-only behavior remains unchanged.

Add source assertions that the obsolete `EvidenceOnlyBatchPayload`/`{ items }` contract is absent.

- [ ] **Step 2: Run the component test and verify RED**

Run:

```bash
npm test -- src/components/extraction-review.test.ts
```

Expected: FAIL because `ExtractionReview` still imports the obsolete batch payload type.

- [ ] **Step 3: Wire the new payload union**

Replace the imported batch payload type with `EvidenceOnlyDecisionBatchPayload`. Keep `proposalManualAddMode`, editor selection, source-row selection, endpoint URL, error handling, refresh, and proposal lifecycle logic unchanged.

- [ ] **Step 4: Add focused responsive styles**

In `globals.css`, add styles scoped to `.evidence-only-batch-item-editor` and its row/action/suggestion classes:

- clear row borders and spacing without gradients;
- visible focus states for Add/Do not add radios;
- restrained advisory badges distinct from human selections;
- add fields in a responsive grid at desktop widths;
- full-width controls and stacked actions below 640px;
- textarea/select/input widths constrained to the container; and
- no page-level horizontal overflow.

Do not alter catalog **Exclude** copy or unrelated workspace styles.

- [ ] **Step 5: Run verification and commit**

Run:

```bash
npm test -- src/components/extraction-review.test.ts src/components/evidence-only-batch-item-editor-state.test.ts src/components/evidence-only-batch-item-editor.test.ts
npx tsc --noEmit
npm run check
graphify update .
```

Run LSP diagnostics on the TypeScript files and inspect CSS diagnostics, then:

```bash
git diff --check
git diff -- src/app/globals.css | grep -F "Exclude" && exit 1 || true
git add -- src/components/extraction-review.tsx src/components/extraction-review.test.ts src/app/globals.css
git commit -m "feat: integrate mixed source-row decisions"
```

---

### Task 6: Full verification and corrected affected-BOQ browser QA

**Files:**

- Create: `.superpowers/sdd/2026-08-07-mixed-row-human-review-decisions/browser-qa-report.md`
- Create: `.superpowers/sdd/2026-08-07-mixed-row-human-review-decisions/final-report.md`

**Interfaces:**

- Consumes: completed Tasks 1–5 and the authenticated BuildEstimate browser profile.
- Produces: automated evidence, read-only preflight, one authorized atomic ten-decision submission, reload/idempotency evidence, and final repository state.

- [ ] **Step 1: Run final automated verification**

Run:

```bash
npx tsc --noEmit
npm run check
graphify update .
git diff --check
git diff --cached --exit-code
```

Run `lens_diagnostics mode=all` and LSP diagnostics on every source file changed since `40dffd6`. Record command exit codes and exact test counts.

- [ ] **Step 2: Perform read-only browser preflight**

Load agent-browser core and authenticate through the saved `buildestimate` profile. Open:

`http://localhost:3000/boqs/e262c286-8815-4617-9b96-ebd2734ed450?view=review`

At 1280×800 and 390×844, record before any mutation:

- BOQ total **฿80,584** and five items;
- source total **฿478,000** and difference **฿397,416**;
- approval disabled;
- proposal `d1` pending with **Review & add** and **Skip**, but no automatic **Accept**;
- ten source rows and ten initially undecided human controls;
- AI advisory badges after one full recheck when the configured provider returns a complete valid set, or explicit **AI suggestion unavailable** fallback without blocking review;
- primary submit disabled; and
- zero page-level horizontal overflow at both viewports.

Attempt screenshot capture once. If CDP capture still fails, record the exact error and use DOM/accessibility/API evidence without repeated retries.

- [ ] **Step 3: Enter the approved ten human decisions**

Match by immutable page/table/row label, not visual position alone.

Choose **Do not add** with optional notes:

| Source row | Note |
| --- | --- |
| p.1 t.1 r.5 | Already represented by existing STUB-END and welding items totaling ฿36,864. |
| p.1 t.1 r.9 | Existing STUD-BOLT item already represents this source row. |
| p.1 t.1 r.14 | Unsupported heading; not a priced BOQ line. |
| p.1 t.1 r.15 | Source subtotal; do not duplicate as an item. |
| p.1 t.1 r.16 | VAT/amount-in-words summary outside the ฿478,000 source subtotal. |

Choose **Add to BOQ** and enter only these human-verified values:

| Source row / description | Unit | Qty | Material rate | Labour rate | Line total |
| --- | ---: | ---: | ---: | ---: | ---: |
| p.1 t.1 r.7 — ON-OFF VALVE FA-10UBM 6\" | Pcs. | 4 | 77,200 | 2,000 | 316,800 |
| p.1 t.1 r.10 — MANUAL VALVE RELOCATION WORK | Lot | 4 | 0 | 1,500 | 6,000 |
| p.1 t.1 r.11 — TOOLS AND CONSUMABLE | Lot | 1 | 6,000 | 0 | 6,000 |
| p.1 t.1 r.12 — SAFETY COST | Lot | 1 | 7,000 | 0 | 7,000 |
| p.1 t.1 r.13 — EXPENSE | Lot | 1 | 61,616 | 0 | 61,616 |

Use the source-matched/default destination section unless the displayed immutable section label proves another existing section. Record every selected action, field value, section, and live total before submission. Verify the primary action reads **Add 5 BOQ items · Ignore 5 rows**.

- [ ] **Step 4: Submit exactly once and verify durable outcome**

Click the primary action once. If the result is ambiguous, inspect BOQ/proposal state before any retry; never blindly resubmit.

Verify:

- exactly five new items appear, bringing item count from five to ten;
- each new item carries only its own source row;
- no duplicate STUB-END or STUD-BOLT item is created;
- no KITZ heading, subtotal, or VAT summary item is created;
- added total is **฿397,416**;
- grand total becomes exactly **฿478,000**;
- `document_total_mismatch` disappears;
- proposal `d1` moves to accepted history;
- accepted audit contains ten ordered human decisions, five added item IDs, five ignored notes, and separate AI suggestions when available;
- five new items independently show unresolved catalog handling with **Exclude** wording unchanged;
- approval remains disabled because catalog decisions are unresolved; and
- no approval request is sent.

Reload the page and verify item count, total, proposal history, and catalog state are unchanged with no duplicates.

- [ ] **Step 5: Record final evidence and repository state**

Write both reports with commands, test counts, diagnostics, viewports, AI suggestion/fallback state, pre/post BOQ data, ten decisions, one-submit evidence, audit evidence, reload evidence, screenshot status, catalog blockers, approval state, and residual risks.

Confirm:

```bash
git diff --cached --exit-code
git diff --check
git status --short
```

The final status must still show only the preserved unrelated unstaged edits; no source file may be changed by QA. Do not commit SDD reports unless the controller explicitly requests it.
