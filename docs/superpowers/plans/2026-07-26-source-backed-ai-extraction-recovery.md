# Source-backed AI Extraction Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reliably extract the affected two-level material/labour quotation layout and let AI turn unfamiliar source rows into either safely acceptable proposals or editable source-backed drafts.

**Architecture:** Add deterministic column resolvers as strict, additive parser strategies. Add a server-owned cell-mapping boundary where the model returns only immutable source-cell coordinates; the server reconstructs values and revalidates them during review, persistence, and acceptance. Keep incomplete mappings on a separate audited **Review & add** path rather than weakening **Accept**.

**Tech Stack:** Python 3/Docling/Pydantic/`unittest`, TypeScript, Node test runner via `tsx --test`, React 19 client components, Next.js 16.2 route handlers, Firebase Admin/Firestore transactions.

---

## File structure

- Create `py-sidecar/boq_column_resolvers.py`: isolated deterministic resolver registry and two-level material/labour resolver.
- Modify `py-sidecar/boq_compound_parser.py`: apply a complete resolver result after generic role detection.
- Modify `py-sidecar/test_boq_parser.py`: exact quotation, labour-only, and negative-lookalike regressions.
- Create `src/lib/boq-extraction-cell-mapping.ts`: cell-reference schema, immutable source resolution, candidate/draft construction, and arithmetic validation.
- Create `src/lib/boq-extraction-cell-mapping.test.ts`: mapping security and reconstruction tests.
- Modify `src/lib/boq-extraction-proposals.ts`: carry source mappings/drafts and validate mapped candidates.
- Modify `src/lib/boq-extraction-proposal-contract.ts`: provider decision DTO accepts mappings but never values.
- Modify `src/lib/boq-extraction-evidence.ts`: expose allowlisted source-cell coordinates in the provider packet.
- Modify `src/lib/boq-extraction-ai-review.ts`: prepare complete mappings as actionable proposals and incomplete mappings as review drafts.
- Modify the matching contract/evidence/AI-review tests.
- Modify `src/lib/boq-extraction-acceptance.ts`: reconstruct mapped candidates from immutable rows during every accept/reject validation.
- Modify `src/lib/boq-extraction-proposal-store.ts`: persist and reload mapping metadata and source-backed manual-entry audits transactionally.
- Create `src/app/api/boqs/[id]/extraction-runs/[runId]/proposals/[proposalId]/add-source-item/handler.ts`: authenticated handler for reviewed manual corrections.
- Create its route and handler test beside it.
- Create `src/components/source-backed-item-editor.tsx`: focused inline correction form.
- Modify `src/components/extraction-review.tsx`, review state/types/tests, and `src/app/globals.css`: render **Accept** for complete mappings and **Review & add** for incomplete mappings.

### Task 1: Deterministic two-level component resolver

**Files:**
- Create: `py-sidecar/boq_column_resolvers.py`
- Modify: `py-sidecar/boq_compound_parser.py`
- Test: `py-sidecar/test_boq_parser.py`

- [ ] **Step 1: Write failing resolver tests**

Add tests that build source rows with these headers and assert exact roles and items:

```python
def component_source_row(headers, values):
    cells = [RawCell(
        column=column, rawText=value, lines=[value], rowSpan=1, columnSpan=1,
        startRowOffset=0, endRowOffset=1, startColumnOffset=column,
        endColumnOffset=column + 1, columnHeader=False, rowHeader=False,
        rowSection=False, carried=False,
    ).model_dump() for column, value in values.items()]
    return SourceRow(
        id="row-1", page=1, table=1, row=1, section="Unsectioned",
        headers=headers, rawCells=cells,
        rawText=" | ".join(values[column] for column in sorted(values)),
        classification="item", confidence=1.0, warnings=[],
    ).model_dump()

def test_unit_cost_component_pairs_resolve_shared_quantity_and_unit(self):
    row = component_source_row(
        headers=[
            "ITEM", "DESCRIPTION", "UNIT", "Q'TY",
            "UNIT COST / MATERIAL", "UNIT COST / TOTAL",
            "UNIT COST / LABOUR", "UNIT COST / TOTAL", "AMOUNT", "Remark",
        ],
        values={1: "Installation New Wall", 2: "m2", 3: "18.00", 4: "980.00",
                5: "17,640.00", 6: "650.00", 7: "11,700.00", 8: "29,340.00"},
    )
    self.assertEqual(_find_columns(row), {
        "desc": 1, "unit": 2, "qty": 3,
        "material_rate": 4, "material_total": 5,
        "labour_rate": 6, "labour_total": 7, "amount": 8,
    })
    result = derive_document([row])
    item = result["sections"][0]["items"][0]
    self.assertEqual((item["qty"], item["rate"], item["total"]), (18.0, 1630.0, 29340.0))
```

Add a labour-only row test (`-`, `-`, `7,000`, `7,000`, amount `7,000`) and a lookalike header missing one adjacent `TOTAL`; the lookalike must not return component roles.

- [ ] **Step 2: Verify RED**

Run:

```bash
.venv-docling/bin/python -m unittest py-sidecar.test_boq_parser.BoqParserTest.test_unit_cost_component_pairs_resolve_shared_quantity_and_unit -v
```

Expected: FAIL because the current detector assigns component `unit` roles and no component rate/total pairs.

- [ ] **Step 3: Implement the resolver registry**

Create a small immutable result contract and an ordered registry:

```python
from dataclasses import dataclass
from typing import Callable

@dataclass(frozen=True)
class ColumnResolution:
    resolver: str
    roles: dict[str, int]

Resolver = Callable[[list[str]], ColumnResolution | None]

def resolve_columns(headers: list[str]) -> ColumnResolution | None:
    for resolver in RESOLVERS:
        result = resolver(headers)
        if result is not None:
            return result
    return None
```

Implement `resolve_two_level_component_pairs()` with all-or-nothing checks: exactly one material anchor before exactly one labour anchor; each anchor immediately followed by a `TOTAL` leaf; one earlier shared `UNIT`, one earlier shared `Q'TY`, and one later aggregate `AMOUNT`. Return no match for duplicates, missing leaves, reversed order, or overlapping indexes.

In `_find_columns`, run the registry after ordinary detection and replace only the conflicting role set when a complete resolution exists:

```python
resolution = resolve_columns([str(value) for value in headers])
if resolution is not None:
    for role in (*COMPONENT_ROLES, "unit", "qty", "amount"):
        roles.pop(role, None)
    roles.update(resolution.roles)
```

- [ ] **Step 4: Verify GREEN and regression safety**

Run:

```bash
.venv-docling/bin/python -m unittest py-sidecar.test_boq_parser.BoqParserTest.test_unit_cost_component_pairs_resolve_shared_quantity_and_unit py-sidecar.test_boq_parser.BoqParserTest.test_unit_cost_component_pairs_resolve_labour_only_row py-sidecar.test_boq_parser.BoqParserTest.test_incomplete_component_pair_does_not_activate_resolver -v
.venv-docling/bin/python -m unittest discover -s py-sidecar -p 'test_*.py'
```

Expected: new tests PASS; full sidecar suite PASS.

- [ ] **Step 5: Commit**

```bash
git add py-sidecar/boq_column_resolvers.py py-sidecar/boq_compound_parser.py py-sidecar/test_boq_parser.py
git commit -m "fix: resolve two-level component cost headers"
```

### Task 2: Immutable source-cell mapping boundary

**Files:**
- Create: `src/lib/boq-extraction-cell-mapping.ts`
- Test: `src/lib/boq-extraction-cell-mapping.test.ts`

- [ ] **Step 1: Write failing source-resolution tests**

Define tests around this public API:

```ts
const result = resolveSourceCellMapping({
  mapping: {
    sourceRowIds: ['row-1'],
    description: [{ sourceRowId: 'row-1', column: 1 }],
    unit: { sourceRowId: 'row-1', column: 2 },
    quantity: { sourceRowId: 'row-1', column: 3 },
    materialRate: { sourceRowId: 'row-1', column: 4 },
    materialTotal: { sourceRowId: 'row-1', column: 5 },
    labourRate: { sourceRowId: 'row-1', column: 6 },
    labourTotal: { sourceRowId: 'row-1', column: 7 },
    amount: { sourceRowId: 'row-1', column: 8 },
  },
  allowedSourceRowIds: new Set(['row-1']),
  sourceRows: [pricedSourceRow],
  section: { index: 0, header: 'Unsectioned' },
})
assert.equal(result.kind, 'candidate')
assert.deepEqual(result.candidate.sourceCosts, {
  material: { qty: 18, unit: 'm2', rate: 980, total: 17640 },
  labour: { qty: 18, unit: 'm2', rate: 650, total: 11700 },
})
```

Add separate tests for unknown rows, missing columns, invalid line indexes, conflicting bindings, values not present in retained cells, negative/non-finite numbers, bad `qty × rate`, component sum mismatch, and incomplete mappings returning `{ kind: 'draft' }` with explicit `missingFields`.

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- src/lib/boq-extraction-cell-mapping.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement exact mapping and result types**

Export only source-coordinate inputs and server-resolved outputs:

```ts
export interface SourceCellRef {
  sourceRowId: string
  column: number
  line?: number
}

export interface SourceCellMapping {
  sourceRowIds: string[]
  description?: SourceCellRef[]
  unit?: SourceCellRef
  quantity?: SourceCellRef
  rate?: SourceCellRef
  total?: SourceCellRef
  materialRate?: SourceCellRef
  materialTotal?: SourceCellRef
  labourRate?: SourceCellRef
  labourTotal?: SourceCellRef
  amount?: SourceCellRef
}

export type SourceMappingResolution =
  | { kind: 'candidate'; candidate: ExtractionCandidateItem; mapping: SourceCellMapping }
  | { kind: 'draft'; draft: SourceBackedReviewDraft }
  | { kind: 'invalid'; code: SourceCellMappingFailureCode }
```

Resolve `rawText`/`lines` only from matching immutable `rawCells`. Parse numbers with a strict currency/comma/parentheses grammar; never accept numeric strings from the model. Build stable mapped-candidate IDs from the mapping and resolved evidence fingerprint.

- [ ] **Step 4: Verify GREEN**

Run `npm test -- src/lib/boq-extraction-cell-mapping.test.ts`.

Expected: all mapping tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/boq-extraction-cell-mapping.ts src/lib/boq-extraction-cell-mapping.test.ts
git commit -m "feat: resolve AI mappings from immutable source cells"
```

### Task 3: Provider contract and review execution

**Files:**
- Modify: `src/lib/boq-extraction-proposal-contract.ts`
- Modify: `src/lib/boq-extraction-evidence.ts`
- Modify: `src/lib/boq-extraction-ai-review.ts`
- Test: `src/lib/boq-extraction-proposal-contract.test.ts`
- Test: `src/lib/boq-extraction-evidence.test.ts`
- Test: `src/lib/boq-extraction-ai-review.test.ts`

- [ ] **Step 1: Write failing provider-contract tests**

Add a model decision containing only IDs, confidence, explanation, and `cellMapping`. Assert that a complete mapping becomes an `insert_missing_item` proposal and an incomplete mapping becomes `needs_human_review` with a `reviewDraft`. Assert that any key such as `qty`, `rate`, `total`, `description`, or `unit` supplied as a value is rejected as `invalid_shape`.

```ts
const decision = {
  id: 'mapped-1', operation: 'map_source_item', sourceRowIds: ['row-1'], targetItemIds: [],
  confidence: 0.96, explanation: 'Mapped from retained cells.',
  cellMapping: {
    sourceRowIds: ['row-1'],
    description: [{ sourceRowId: 'row-1', column: 1 }],
    unit: { sourceRowId: 'row-1', column: 2 },
    quantity: { sourceRowId: 'row-1', column: 3 },
    materialRate: { sourceRowId: 'row-1', column: 4 },
    materialTotal: { sourceRowId: 'row-1', column: 5 },
    labourRate: { sourceRowId: 'row-1', column: 6 },
    labourTotal: { sourceRowId: 'row-1', column: 7 },
    amount: { sourceRowId: 'row-1', column: 8 },
  },
}
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- src/lib/boq-extraction-proposal-contract.test.ts src/lib/boq-extraction-evidence.test.ts src/lib/boq-extraction-ai-review.test.ts
```

Expected: FAIL because `map_source_item` and mapping preparation are unsupported.

- [ ] **Step 3: Extend the allowlisted evidence packet**

Add `cellRefs` to selected source rows only:

```ts
cellRefs: row.rawCells
  .filter((cell) => !cell.carried)
  .map((cell) => ({ column: cell.column, lineCount: cell.lines.length }))
```

Context-only rows remain non-addressable. Do not add raw provider output or duplicate values to the durable response.

- [ ] **Step 4: Extend and prepare the decision DTO**

Allow `operation: 'map_source_item'` only at the provider boundary. It is not a canonical proposal operation. `prepareProviderDecision()` resolves its `cellMapping` through `resolveSourceCellMapping()`:

- candidate → canonical `insert_missing_item` or `replace_item` proposal with `sourceCellMapping` and server-generated `mappedCandidate`;
- draft → canonical `needs_human_review` proposal with `reviewDraft`;
- invalid → rejected provider response with an allowlisted validation code.

Update system instructions to say: “Return cell coordinates only. Never return source values.”

- [ ] **Step 5: Update review execution**

Build candidate maps per prepared decision by merging deterministic candidates with the one server-generated mapped candidate. Validate canonical proposals with the merged map. Ensure raw mappings and model prose never bypass `prepareProviderDecision()`.

- [ ] **Step 6: Verify GREEN**

Run the three focused test files from Step 2.

Expected: all PASS, including invented-value rejection.

- [ ] **Step 7: Commit**

```bash
git add src/lib/boq-extraction-proposal-contract.ts src/lib/boq-extraction-evidence.ts src/lib/boq-extraction-ai-review.ts src/lib/boq-extraction-proposal-contract.test.ts src/lib/boq-extraction-evidence.test.ts src/lib/boq-extraction-ai-review.test.ts
git commit -m "feat: add source-cell mapping review decisions"
```

### Task 4: Revalidate mapped candidates during persistence and acceptance

**Files:**
- Modify: `src/lib/boq-extraction-proposals.ts`
- Modify: `src/lib/boq-extraction-acceptance.ts`
- Modify: `src/lib/boq-extraction-proposal-store.ts`
- Test: `src/lib/boq-extraction-proposals.test.ts`
- Test: `src/lib/boq-extraction-acceptance.test.ts`
- Test: `src/lib/boq-extraction-proposal-store.test.ts`

- [ ] **Step 1: Write failing round-trip and tamper tests**

Test that a mapped proposal validates when created, persists, reloads, and accepts. Then mutate each of these independently and assert rejection: mapping column, mapped candidate total, source-row fingerprint, canonical BOQ revision, and destination index.

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- src/lib/boq-extraction-proposals.test.ts src/lib/boq-extraction-acceptance.test.ts src/lib/boq-extraction-proposal-store.test.ts
```

Expected: FAIL because acceptance reconstructs only deterministic run candidates.

- [ ] **Step 3: Extend canonical proposal metadata**

Add optional server-owned fields:

```ts
sourceCellMapping?: SourceCellMapping
mappedCandidate?: ExtractionCandidateItem
reviewDraft?: SourceBackedReviewDraft
```

Include them in canonical proposal fingerprints and audit identity. `reviewDraft` remains valid only on `needs_human_review`; `sourceCellMapping` and `mappedCandidate` remain valid only on insert/replace.

- [ ] **Step 4: Reconstruct instead of trusting stored candidates**

In `validateExtractionProposal()`, call `resolveSourceCellMapping()` against immutable source rows. Require the reconstructed candidate to equal the stored `mappedCandidate` byte-for-byte under `stableCanonicalJson()`, then merge it into `buildExtractionCandidates()` before `validateProposal()`.

Store and acceptance paths must call this same function; no `prevalidatedProposal` may skip mapped-candidate reconstruction.

- [ ] **Step 5: Verify GREEN**

Run the three focused test files, then:

```bash
npm test -- src/lib/boq-extraction-proposal-contract.test.ts src/lib/boq-extraction-ai-review.test.ts
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/boq-extraction-proposals.ts src/lib/boq-extraction-acceptance.ts src/lib/boq-extraction-proposal-store.ts src/lib/boq-extraction-proposals.test.ts src/lib/boq-extraction-acceptance.test.ts src/lib/boq-extraction-proposal-store.test.ts
git commit -m "feat: revalidate mapped candidates on acceptance"
```

### Task 5: Audited Review & add mutation

**Files:**
- Modify: `src/lib/boq-user-entry.ts`
- Test: `src/lib/boq-user-entry.test.ts`
- Create: `src/app/api/boqs/[id]/extraction-runs/[runId]/proposals/[proposalId]/add-source-item/handler.ts`
- Create: `src/app/api/boqs/[id]/extraction-runs/[runId]/proposals/[proposalId]/add-source-item/handler.test.ts`
- Create: `src/app/api/boqs/[id]/extraction-runs/[runId]/proposals/[proposalId]/add-source-item/route.ts`
- Modify: `src/app/api/route-exports.test.ts`

- [ ] **Step 1: Write failing manual-correction tests**

Define the request as user-entered values plus identity, never client-supplied provenance:

```ts
{
  sectionIndex: 0,
  item: { desc: 'Wall installation', unit: 'm2', qty: 18, materialCost: 980, labourCost: 650 },
}
```

The handler must load the pending proposal by route IDs, require `reviewDraft`, revalidate its source mapping, calculate rate/total server-side, add a `user` item with immutable source rows/refs, create a manual-entry audit, and supersede the draft proposal in one transaction. Test unauthorized, approved, stale, missing proposal, invalid arithmetic, and idempotency/conflict behavior.

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- src/lib/boq-user-entry.test.ts src/app/api/boqs/[id]/extraction-runs/[runId]/proposals/[proposalId]/add-source-item/handler.test.ts
```

Expected: FAIL because the source-backed request and handler do not exist.

- [ ] **Step 3: Implement pure source-backed entry validation**

Add `parseSourceBackedItemRequest()` and `addSourceBackedBoqItem()`. Require non-empty description/unit, finite non-negative cents, and exact reconciliation. Populate `sourceRowId`, `sourceRowIds`, `sourceRef`, `entryOrigin: 'user'`, `sourceCosts` when both components exist, and manual cost allocation.

- [ ] **Step 4: Implement the Next.js 16 handler and route**

Use native `Request`/`Response`, await `context.params`, authenticate before body processing, and inject Firestore dependencies into the handler for unit tests. The thin route wires `auth`, the extraction/proposal stores, `runTransaction`, `crypto.randomUUID()`, and current time.

- [ ] **Step 5: Verify GREEN**

Run focused tests from Step 2 and `npm test -- src/app/api/route-exports.test.ts`.

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/boq-user-entry.ts src/lib/boq-user-entry.test.ts src/app/api/boqs/[id]/extraction-runs/[runId]/proposals/[proposalId]/add-source-item src/app/api/route-exports.test.ts
git commit -m "feat: add audited source-backed manual correction"
```

### Task 6: Review & add user interface

**Files:**
- Create: `src/components/source-backed-item-editor.tsx`
- Create: `src/components/source-backed-item-editor.test.ts`
- Modify: `src/components/extraction-review.tsx`
- Modify: `src/components/extraction-review.test.ts`
- Modify: `src/lib/boq-extraction-review-state.ts`
- Modify: `src/lib/boq-extraction-review-state.test.ts`
- Modify: `src/app/globals.css`

- [ ] **Step 1: Write failing UI and normalization tests**

Assert that valid `reviewDraft` data survives response normalization; malformed refs/fields reject the entire response. Assert source code contains **Review & add**, posts to the source-item route, refreshes the BOQ/review after success, and never renders **Accept** for `needs_human_review`.

Add pure editor tests for:

- source-backed values prefilled;
- missing fields blank and labeled;
- live `qty × rate` total;
- material + labour rate derivation;
- invalid numeric input disabling save.

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- src/components/source-backed-item-editor.test.ts src/components/extraction-review.test.ts src/lib/boq-extraction-review-state.test.ts
```

Expected: FAIL because the editor and response shape are absent.

- [ ] **Step 3: Implement the focused client component**

`SourceBackedItemEditor` owns only its form state and emits a validated request payload. Use existing `Input` and `Button` components, visible field-level errors, keyboard-accessible labels, and source/manual badges. Do not import server mapping logic into the client bundle.

- [ ] **Step 4: Integrate it with ExtractionReview**

For non-actionable proposals:

```tsx
{humanReview && proposal.reviewDraft && !readOnly ? (
  <Button type="button" variant="outline" onClick={() => setEditingProposalId(proposal.id)}>
    Review & add
  </Button>
) : null}
```

On save, POST only editable values to the route. Use the returned BOQ with `onBoqChange`, reload durable review state, close the editor, and toast “BOQ item added from reviewed source.” Existing **Accept** logic remains unchanged.

- [ ] **Step 5: Add restrained responsive styling**

Reuse existing extraction card tokens. Keep the editor single-column below 920px, preserve numeric alignment, visible focus, and readable source/manual badges. Do not add a new visual system.

- [ ] **Step 6: Verify GREEN**

Run the three focused test files from Step 2.

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/source-backed-item-editor.tsx src/components/source-backed-item-editor.test.ts src/components/extraction-review.tsx src/components/extraction-review.test.ts src/lib/boq-extraction-review-state.ts src/lib/boq-extraction-review-state.test.ts src/app/globals.css
git commit -m "feat: add source-backed review correction UI"
```

### Task 7: End-to-end verification and documentation alignment

**Files:**
- Modify if evidence requires it: tests or implementation files from Tasks 1–6 only

- [ ] **Step 1: Run the complete Python suite**

```bash
.venv-docling/bin/python -m unittest discover -s py-sidecar -p 'test_*.py'
```

Expected: PASS with no errors or failures.

- [ ] **Step 2: Run the complete application check**

```bash
npm run check
```

Expected: ESLint, `tsc --noEmit`, and all Node tests PASS.

- [ ] **Step 3: Run a production build**

```bash
npm run build
```

Expected: Next.js 16.2 production build succeeds.

- [ ] **Step 4: Verify the exact quotation fixture behavior**

Run the focused Python regression and assert seven priced rows, derived subtotal ฿80,640, combined material/labour source costs for dual-component rows, and valid labour-only items. Do not write to Firestore or re-extract the existing BOQ.

- [ ] **Step 5: Inspect the final diff**

```bash
git diff --check
git status --short
git log --oneline -8
```

Expected: no whitespace errors; only planned code, tests, and plan/spec files changed; commits are task-scoped.

- [ ] **Step 6: Commit any verification-only corrections**

If verification required a correction, return to the failed task, rerun its focused test and full affected suite, and create a new commit using that task's explicit file list. If verification required no edits, create no empty commit.
