# Source Quote Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover explicit source overhead/profit and discount as a fixed read-only quote summary, reconcile approval without creating comparable BOQ items, and make Extraction notes concise.

**Architecture:** The Python sidecar derives a closed `sourceQuoteSummary` beside direct BOQ items and validates it with exact decimal arithmetic. TypeScript revalidates and persists the same immutable summary on the extraction run and canonical BOQ, then local approval verification bridges direct items to the quoted subtotal. A focused client component renders the summary while extraction-warning helpers produce unique-row task counts, informational separation, and compact locations.

**Tech Stack:** Python 3, Pydantic v2, TypeScript, React Client Components, Next.js App Router, Node test runner via `tsx --test`, Firestore storage adapters, exact decimal-string helpers, CSS.

## Global Constraints

- BOQ items represent direct construction work only; overhead/profit and discount never become catalog items.
- Store fixed source amounts only. Do not store, derive, display, or recalculate `20%`.
- Estimator receives no overhead/profit or discount and requires no schema or calculation changes.
- Catalog matching, catalog readiness, historical pricing, and line-item vendor comparison ignore `sourceQuoteSummary`.
- Preserve immutable source rows, warning messages, and source locations; never manufacture an adjustment from an unexplained total gap.
- Keep new BOQ and extraction fields optional for additive legacy compatibility.
- Existing BOQs are upgraded only by explicit re-extraction; do not run local or production migrations.
- Approved BOQs remain read-only and reject every mutation.
- Preserve exact existing **Exclude** wording and semantics.
- Use strict RED → GREEN TDD. Every production behavior requires a test observed failing for the intended reason first.
- Work directly on `main`, preserve unrelated dirty edits, and stage only intended files/hunks.
- Never inspect, stage, or commit `Quotation example/`.
- Before editing Next.js/React files, follow `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`; keep static formatting logic outside the large page component where practical.
- After every code task run focused tests, `npx tsc --noEmit`, `npm run check`, `graphify update .`, and `git diff --check`. The known 12 unrelated failures in `src/components/extraction-review.test.ts` may remain only if the count and failure signatures are unchanged.

---

## File Structure

### New files

- `src/lib/boq-source-quote-summary.ts` — strict parsing, exact arithmetic, verification projection, and display-row derivation for the fixed quote-summary model.
- `src/lib/boq-source-quote-summary.test.ts` — pure unit tests for canonical parsing and reconciliation.
- `src/components/source-quote-summary.tsx` — read-only quote-summary presentation and source-page navigation controls.
- `src/components/source-quote-summary.test.ts` — component contract tests.

### Modified files

- `py-sidecar/boq_compound_parser.py` — recognize explicit merged overhead/profit, discount, subtotal, and payable rows; keep overhead out of derived items.
- `py-sidecar/boq_contract.py` — Pydantic quote-summary contract and adjusted reconciliation invariants.
- `py-sidecar/test_boq_parser.py` — synthetic parser and contract regressions; update old expectations that treated overhead as a priced item.
- `src/lib/boq-extraction-schema.ts` — strict TypeScript v3 quote-summary parser.
- `src/lib/boq-ingestion.ts` — copy validated summary to BOQ and extraction-run seed; verify the summary when approving.
- `src/lib/boq-ingestion.test.ts` — ingestion and local verification coverage.
- `src/lib/boq-schema.ts` — optional canonical `sourceQuoteSummary` field and source-summary types.
- `src/lib/boq-extraction-run.ts` — persist summary in run identity and fingerprints.
- `src/lib/boq-extraction-run.test.ts` — identity/fingerprint coverage.
- `src/lib/boq-extraction-storage.test.ts` — staged persistence round-trip coverage.
- `src/lib/boq-review-state.ts` / `src/lib/boq-review-state.test.ts` — verify live edited direct totals against immutable summary.
- `src/app/api/boqs/boq-id-api.test.ts` — approval and read-only route tests.
- `src/lib/boq-extraction-warnings.ts` / `.test.ts` — actionable/informational classification, unique-row counts, friendly labels, and location compression.
- `src/components/extraction-warnings.tsx` / `.test.ts` — tidy notes rendering while retaining Technical details.
- `src/app/(authenticated)/boqs/[id]/page.tsx` / `.test.ts` — render source summary, navigate to its source page, and use layer-specific blocker copy.
- `src/app/globals.css` — responsive summary and tidy-note styles.

The plan intentionally does **not** modify `src/lib/estimate-schema.ts` or `src/app/(authenticated)/estimator/page.tsx`.

---

### Task 1: Derive and validate a fixed source quote summary in Python

**Files:**

- Modify: `py-sidecar/boq_compound_parser.py:616-978`
- Modify: `py-sidecar/boq_contract.py:19-347`
- Test: `py-sidecar/test_boq_parser.py`

**Interfaces:**

- Produces `sourceQuoteSummary?: SourceQuoteSummary` in the v3 parse response.
- Produces fixed string amounts only:

```python
class SourceQuoteSummary(ContractModel):
    directWorkTotal: str
    overheadProfitAmount: str | None = None
    quotedSubtotal: str
    discountAmount: str | None = None
    payableTotal: str | None = None
    overheadProfitSourceRef: SourceRef | None = None
    discountSourceRef: SourceRef | None = None
    subtotalSourceRef: SourceRef | None = None
    payableTotalSourceRef: SourceRef | None = None
```

- Changes `build_reconciliation(sections, source_total, source_quote_summary=None)` so `itemTotal` remains the direct-item total while `difference` and `reconciled` compare the quote summary's validated quoted subtotal with `sourceTotal` when a summary exists.
- Overhead/profit rows are never returned in `sections[*].items` and never increase `totalItems`.

- [ ] **Step 1: Add a failing parser regression for the current merged-row shape**

Add `test_merged_overhead_profit_builds_fixed_quote_summary_without_item` beside `test_adjusted_grand_totals_and_cross_table_cumulative_subtotal`. Construct the sanitized table entirely with the existing lossless test helpers:

```python
cell = LosslessContractV3Test._cell
columns = ("Description", "Qty", "Unit", "Rate", "Amount")
table = LosslessContractV3Test._table(
    page=1,
    table=1,
    num_rows=7,
    num_cols=5,
    cells=[
        *[cell(value, 0, column, column_header=True)
          for column, value in enumerate(columns)],
        *[cell(value, 1, column)
          for column, value in enumerate(("Direct work A", "1", "L/S", "100000", "100000"))],
        *[cell(value, 2, column)
          for column, value in enumerate(("Direct work B", "1", "L/S", "79400", "79400"))],
        cell("OVERHEAD & PROFIT", 3, 0, col_span=4, end_col_offset_idx=4),
        cell("35,880.00", 3, 4),
        cell("TOTAL", 4, 0, col_span=4, end_col_offset_idx=4),
        cell("215,280.00", 4, 4),
        cell("DISCOUNT", 5, 0, col_span=4, end_col_offset_idx=4),
        cell("(1,280.00)", 5, 4),
        cell("GRAND TOTAL", 6, 0, col_span=4, end_col_offset_idx=4),
        cell("214,000.00", 6, 4),
    ],
)
source_rows = build_source_rows([table])
```

Use the IDs assigned by `build_source_rows`; assert source refs by page/table/row rather than depending on generated row IDs. This test is fully synthetic and must not read any customer fixture.

Assert:

```python
result = derive_document(source_rows)
items = [item for section in result["sections"] for item in section["items"]]
self.assertEqual(sum(item["total"] for item in items), 179400.0)
self.assertNotIn("OVERHEAD & PROFIT", [item["desc"] for item in items])
self.assertEqual(result["totalItems"], len(items))
self.assertEqual(result["sourceQuoteSummary"], {
    "directWorkTotal": "179400",
    "overheadProfitAmount": "35880",
    "quotedSubtotal": "215280",
    "discountAmount": "1280",
    "payableTotal": "214000",
    "overheadProfitSourceRef": {"page": 1, "table": 1, "row": 25},
    "discountSourceRef": {"page": 1, "table": 1, "row": 27},
    "subtotalSourceRef": {"page": 1, "table": 1, "row": 26},
    "payableTotalSourceRef": {"page": 1, "table": 1, "row": 28},
})
self.assertEqual(result["reconciliation"], {
    "itemTotal": 179400.0,
    "sourceTotal": 215280.0,
    "reconciled": True,
    "difference": 0.0,
})
self.assertNotIn("document_total_mismatch", result["warningCodes"])
```

Update the existing N.P. Civil and `OVERHEAD&EXPENSES` assertions to expect direct items only and a quote summary rather than a lump-sum item. This deliberately locks the new product boundary across existing fixtures.

- [ ] **Step 2: Run the parser test and verify RED**

Run:

```bash
python3 -m unittest \
  py-sidecar.test_boq_parser.CompoundDerivationTest.test_merged_overhead_profit_builds_fixed_quote_summary_without_item \
  py-sidecar.test_boq_parser.BoqParserTest.test_normalizes_actual_np_civil_headers_and_uses_pre_discount_total_for_reconciliation
```

Expected: FAIL because `sourceQuoteSummary` is absent and overhead is still derived as a priced item.

- [ ] **Step 3: Add failing Pydantic contract tests**

Extend `ContractV3InvariantTest._response` with an optional `source_quote_summary` argument and add cases that reject:

```python
# noncanonical strings
{"directWorkTotal": "0179400", "quotedSubtotal": "215280"}
# unexplained subtotal
{"directWorkTotal": "179400", "quotedSubtotal": "215280"}
# bad overhead arithmetic
{"directWorkTotal": "179400", "overheadProfitAmount": "35879", "quotedSubtotal": "215280"}
# bad discount arithmetic
{"directWorkTotal": "179400", "overheadProfitAmount": "35880", "quotedSubtotal": "215280",
 "discountAmount": "1280", "payableTotal": "214001"}
# dangling source ref
{"directWorkTotal": "179400", "overheadProfitAmount": "35880", "quotedSubtotal": "215280",
 "overheadProfitSourceRef": {"page": 99, "table": 1, "row": 1}}
# forbidden percentage field
{"directWorkTotal": "179400", "overheadProfitAmount": "35880", "quotedSubtotal": "215280",
 "percentage": "20"}
```

Also assert a valid summary is serialized unchanged and `totalItems` still counts direct priced items only.

- [ ] **Step 4: Run contract tests and verify RED**

Run:

```bash
python3 -m unittest py-sidecar.test_boq_parser.ContractV3InvariantTest
```

Expected: FAIL because `ParseResponseV3` forbids/does not validate `sourceQuoteSummary`.

- [ ] **Step 5: Implement canonical decimal-string helpers and Pydantic models**

In `boq_contract.py`, add a closed canonical string parser:

```python
CANONICAL_DECIMAL = re.compile(r"^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$")

def _canonical_nonnegative_decimal(value: Any, name: str) -> Decimal:
    if not isinstance(value, str) or not CANONICAL_DECIMAL.fullmatch(value):
        raise ValueError(f"{name} must be a canonical nonnegative decimal string")
    parsed = Decimal(value)
    if not parsed.is_finite() or parsed < 0:
        raise ValueError(f"{name} must be a canonical nonnegative decimal string")
    return parsed
```

Add `SourceQuoteSummary` with `extra='forbid'` inherited from `ContractModel`. In `ParseResponseV3.validate_response_invariants`, verify:

```python
direct = _canonical_nonnegative_decimal(summary.directWorkTotal, "sourceQuoteSummary.directWorkTotal")
quoted = _canonical_nonnegative_decimal(summary.quotedSubtotal, "sourceQuoteSummary.quotedSubtotal")
overhead = Decimal(0) if summary.overheadProfitAmount is None else _canonical_nonnegative_decimal(...)
if direct != serialized_total or direct + overhead != quoted:
    raise ValueError("sourceQuoteSummary does not reconcile direct work to quoted subtotal")
if response_source != quoted:
    raise ValueError("sourceTotal must match sourceQuoteSummary.quotedSubtotal")
```

Require discount/payable to be both absent or arithmetically compatible, and require every present source ref to match a known source location.

- [ ] **Step 6: Implement closed quote-summary extraction**

In `boq_compound_parser.py`:

1. Add `_row_label(row)` that joins nonnumeric label cells, including merged cells spanning the ordinary description columns.
2. Add `_quote_summary(rows, direct_total, source_total)` that recognizes only closed explicit labels:
   - `/\boverhead\b.*\bprofit\b|\boverhead\s*&\s*(?:profit|expenses)\b/`
   - existing `_total_kind(label) == 'discount'`
   - selected pre-discount subtotal row
   - selected grand/payable row
3. Read values only from the resolved amount column.
4. Return canonical strings using a helper that removes trailing decimal zeroes without exponent notation.
5. Do not infer overhead from `source_total - direct_total`.
6. Before `_derive_row`, skip any explicit overhead/profit row from item derivation; it becomes quote-summary evidence instead.
7. Remove that row from `reviewCandidateRowIds` only when the closed summary validates.
8. Pass the summary to `build_reconciliation` and suppress the document-total warning only when the summary validates.

- [ ] **Step 7: Run focused Python tests and verify GREEN**

Run:

```bash
python3 -m unittest \
  py-sidecar.test_boq_parser.CompoundDerivationTest \
  py-sidecar.test_boq_parser.ContractV3InvariantTest \
  py-sidecar.test_boq_parser.BoqParserTest.test_normalizes_actual_np_civil_headers_and_uses_pre_discount_total_for_reconciliation
```

Expected: PASS.

- [ ] **Step 8: Run the complete sidecar suite**

Run:

```bash
python3 -m unittest py-sidecar.test_boq_parser
```

Expected: PASS with no overhead/profit fixture still represented as a priced comparison item.

- [ ] **Step 9: Commit Task 1**

```bash
git add py-sidecar/boq_compound_parser.py py-sidecar/boq_contract.py py-sidecar/test_boq_parser.py
git diff --cached --check
git commit -m "feat: extract source quote summaries"
```

---

### Task 2: Strictly parse and persist quote summaries in TypeScript

**Files:**

- Create: `src/lib/boq-source-quote-summary.ts`
- Create: `src/lib/boq-source-quote-summary.test.ts`
- Modify: `src/lib/boq-schema.ts:14-121`
- Modify: `src/lib/boq-extraction-schema.ts:248-747`
- Modify: `src/lib/boq-ingestion.ts:118-254`
- Modify: `src/lib/boq-ingestion.test.ts`
- Modify: `src/lib/boq-extraction-run.ts:14-227`
- Modify: `src/lib/boq-extraction-run.test.ts`
- Modify: `src/lib/boq-extraction-storage.test.ts`

**Interfaces:**

- Produces canonical type:

```ts
export interface BoqSourceQuoteSummary {
  directWorkTotal: DecimalString
  overheadProfitAmount?: DecimalString
  quotedSubtotal: DecimalString
  discountAmount?: DecimalString
  payableTotal?: DecimalString
  overheadProfitSourceRef?: BoqSourceRef
  discountSourceRef?: BoqSourceRef
  subtotalSourceRef?: BoqSourceRef
  payableTotalSourceRef?: BoqSourceRef
}
```

- Produces:

```ts
export function parseSourceQuoteSummary(
  value: unknown,
  options: { directWorkTotal: DecimalString; sourceTotal: DecimalString; knownLocations: ReadonlySet<string> },
): BoqSourceQuoteSummary

export function quoteSummaryReconciliation(
  summary: BoqSourceQuoteSummary,
): { quotedSubtotal: DecimalString; payableTotal?: DecimalString }
```

- Adds optional `sourceQuoteSummary` to `DoclingResultV3`, `Boq`, `BoqExtractionRunSeed`, `BoqExtractionRun`, and `BoqExtractionRunIdentity`.

- [ ] **Step 1: Write failing pure TypeScript parser tests**

Create `src/lib/boq-source-quote-summary.test.ts` covering:

```ts
const parsed = parseSourceQuoteSummary({
  directWorkTotal: "179400",
  overheadProfitAmount: "35880",
  quotedSubtotal: "215280",
  discountAmount: "1280",
  payableTotal: "214000",
  overheadProfitSourceRef: { page: 2, table: 1, row: 25 },
}, {
  directWorkTotal: "179400",
  sourceTotal: "215280",
  knownLocations: new Set(["2:1:25"]),
})
assert.equal(parsed.payableTotal, "214000")
```

Reject noncanonical strings, negative strings, extra keys such as `percentage`, dangling refs, mismatched direct totals, bad subtotal arithmetic, and bad discount arithmetic.

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
npm test -- src/lib/boq-source-quote-summary.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure quote-summary module**

Use only `parseDecimalString`, `addDecimal`, and `equalAtMinorUnit` from `decimal-string.ts`. Express subtraction by adding `-${discount}` after rejecting negative input. Use exact allowed-key sets and a local source-ref parser. Never coerce numbers into strings.

- [ ] **Step 4: Run pure tests and verify GREEN**

Run:

```bash
npm test -- src/lib/boq-source-quote-summary.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing extraction-schema and ingestion tests**

In `src/lib/boq-ingestion.test.ts`, extend the v3 fixture with the valid summary and assert:

```ts
const parsed = parseDoclingResult(payload)
const draft = buildDraftImport("boq-quote", "boqs/boq-quote/source.pdf", parsed, "run-quote")
assert.deepEqual(draft.boq.sourceQuoteSummary, payload.sourceQuoteSummary)
assert.deepEqual(draft.run?.sourceQuoteSummary, payload.sourceQuoteSummary)
assert.equal(draft.boq.grandTotal, 179400)
assert.equal(draft.boq.sourceTotal, 215280)
assert.equal(draft.boq.totalItems, 7)
```

Add fail-closed tests for extra keys, numeric rather than string amounts, bad refs, bad arithmetic, and mismatch with parsed `sourceTotal`.

- [ ] **Step 6: Run extraction/ingestion tests and verify RED**

Run:

```bash
npm test -- src/lib/boq-ingestion.test.ts
```

Expected: FAIL because the v3 exact-key parser rejects `sourceQuoteSummary`.

- [ ] **Step 7: Extend TypeScript extraction and canonical types**

In `boq-extraction-schema.ts`:

1. Add `sourceQuoteSummary?: BoqSourceQuoteSummary` to `DoclingResultV3`.
2. Allow the key in `parseV3` only.
3. Build known locations from parsed source rows.
4. Convert the checked contributing float total and `sourceTotal` to canonical decimal strings without exponent notation; reject unsafe conversion.
5. Call `parseSourceQuoteSummary`.
6. When a summary exists, validate `reconciliation.itemTotal` against direct items and `reconciliation.difference` against the summary's quoted subtotal minus `sourceTotal`.
7. Preserve current legacy behavior when the field is absent.

In `boq-schema.ts`, add the optional canonical field to `Boq`.

- [ ] **Step 8: Persist the summary through ingestion and run identity**

In `boq-ingestion.ts`, clone the summary into both `boq` and `run`. In `boq-extraction-run.ts`, add it to `BoqExtractionRun`, `BoqExtractionRunIdentity`, `extractionRunIdentity`, and the `buildExtractionRun` output. This ensures retry identity changes if source commercial evidence changes.

Add tests showing:

```ts
assert.notEqual(
  extractionRunIdentityFingerprint(run),
  extractionRunIdentityFingerprint({ ...run, sourceQuoteSummary: { ...run.sourceQuoteSummary!, discountAmount: "1200", payableTotal: "214080" } }),
)
```

Add a storage fixture assertion proving `persistStagedRun` round-trips the field without altering it.

- [ ] **Step 9: Run focused TypeScript tests and diagnostics**

Run:

```bash
npm test -- \
  src/lib/boq-source-quote-summary.test.ts \
  src/lib/boq-ingestion.test.ts \
  src/lib/boq-extraction-run.test.ts \
  src/lib/boq-extraction-storage.test.ts
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 10: Commit Task 2**

```bash
git add \
  src/lib/boq-source-quote-summary.ts \
  src/lib/boq-source-quote-summary.test.ts \
  src/lib/boq-schema.ts \
  src/lib/boq-extraction-schema.ts \
  src/lib/boq-ingestion.ts \
  src/lib/boq-ingestion.test.ts \
  src/lib/boq-extraction-run.ts \
  src/lib/boq-extraction-run.test.ts \
  src/lib/boq-extraction-storage.test.ts
git diff --cached --check
git commit -m "feat: persist source quote summaries"
```

---

### Task 3: Reconcile approval through the quote summary without weakening catalog safeguards

**Files:**

- Modify: `src/lib/boq-source-quote-summary.ts`
- Modify: `src/lib/boq-source-quote-summary.test.ts`
- Modify: `src/lib/boq-ingestion.ts:34-392`
- Modify: `src/lib/boq-ingestion.test.ts`
- Modify: `src/lib/boq-review-state.ts:53-65`
- Modify: `src/lib/boq-review-state.test.ts`
- Modify: `src/app/api/boqs/boq-id-api.test.ts`
- Modify: `src/lib/boq-detail-state.ts:27-42`
- Modify: `src/lib/boq-detail-state.test.ts:150-164`

**Interfaces:**

- Produces:

```ts
export type SourceQuoteSummaryIssueCode =
  | "quote_direct_total_mismatch"
  | "quote_subtotal_mismatch"
  | "quote_payable_total_mismatch"

export function verifySourceQuoteSummary(input: {
  directItemTotal: DecimalString
  sourceTotal?: DecimalString
  summary?: BoqSourceQuoteSummary
}): Array<{ code: SourceQuoteSummaryIssueCode; message: string }>
```

- `verifyBoqLocally` continues to emit `document_total_mismatch` for legacy BOQs without a summary, but emits layer-specific quote issue codes when a summary is present.
- Catalog readiness remains unchanged and still evaluates direct priced items only.

- [ ] **Step 1: Write failing pure verification tests**

Add cases proving:

```ts
assert.deepEqual(verifySourceQuoteSummary({
  directItemTotal: "179400",
  sourceTotal: "215280",
  summary: validSummary,
}), [])
```

and layer-specific failures for changed direct items, changed overhead/subtotal, and changed discount/payable arithmetic. Assert messages contain the relevant layer and amounts, not `Normalized item total`.

- [ ] **Step 2: Run pure tests and verify RED**

Run:

```bash
npm test -- src/lib/boq-source-quote-summary.test.ts
```

Expected: FAIL because `verifySourceQuoteSummary` is absent.

- [ ] **Step 3: Implement exact summary verification**

Reuse decimal-string arithmetic. Format display amounts only at the message boundary. Do not mutate the summary and do not fall back to unexplained gap inference.

- [ ] **Step 4: Write failing local approval and live-edit tests**

In `boq-ingestion.test.ts` and `boq-review-state.test.ts`, prove:

1. A direct total of `179400`, source total `215280`, and valid fixed summary has no blocking mismatch.
2. Editing a direct item to produce `179401` creates `quote_direct_total_mismatch`.
3. A legacy BOQ with direct `179400` and source `215280` still creates `document_total_mismatch`.
4. Suspicious zero warnings and bundle-child behavior remain unchanged.

In `boq-id-api.test.ts`, add route cases:

```ts
await t.test("approval accepts reconciled source quote summary", ... status 200 ...)
await t.test("approval rejects a tampered source quote summary", ... status 400 ...)
await t.test("draft PUT cannot replace immutable sourceQuoteSummary", ... response retains existing summary ...)
```

The body allowlist must continue ignoring `sourceQuoteSummary`; only extraction persistence can create it.

- [ ] **Step 5: Run approval tests and verify RED**

Run:

```bash
npm test -- \
  src/lib/boq-ingestion.test.ts \
  src/lib/boq-review-state.test.ts \
  src/app/api/boqs/boq-id-api.test.ts \
  src/lib/boq-detail-state.test.ts
```

Expected: FAIL because current verification compares direct items directly with `sourceTotal`.

- [ ] **Step 6: Integrate summary-aware local verification**

Extend `VerificationIssueCode` with the three quote codes. In `verifyBoqLocally`:

```ts
if (candidate.sourceQuoteSummary) {
  for (const summaryIssue of verifySourceQuoteSummary({
    directItemTotal: canonicalMoney(itemTotalSum),
    sourceTotal: canonicalMoney(candidate.sourceTotal),
    summary: candidate.sourceQuoteSummary,
  })) issue(issues, summaryIssue.code, "blocking", summaryIssue.message)
} else {
  // retain current document_total_mismatch logic unchanged
}
```

Extend the `Pick<Boq, ...>` signature to include `sourceQuoteSummary`. `buildReviewVerification` passes the immutable summary while recalculating direct items from current edits.

Replace `documentTotalMismatchMessage` with a helper that selects the exact blocking issue message; keep legacy formatting tests for legacy BOQs.

- [ ] **Step 7: Verify catalog and mutation boundaries**

Add assertions that:

- `getBoqCatalogReadiness` count is unchanged with or without a summary;
- approving still fails if any direct priced item is neither matched nor explicitly excluded;
- approved BOQs still return `409` for attempted updates;
- PUT does not accept client-supplied quote-summary changes.

Run:

```bash
npm test -- \
  src/lib/boq-catalog-readiness.test.ts \
  src/app/api/boqs/boq-id-api.test.ts
```

Expected: PASS.

- [ ] **Step 8: Run focused suite and TypeScript diagnostics**

Run:

```bash
npm test -- \
  src/lib/boq-source-quote-summary.test.ts \
  src/lib/boq-ingestion.test.ts \
  src/lib/boq-review-state.test.ts \
  src/lib/boq-detail-state.test.ts \
  src/lib/boq-catalog-readiness.test.ts \
  src/app/api/boqs/boq-id-api.test.ts
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 9: Commit Task 3**

```bash
git add \
  src/lib/boq-source-quote-summary.ts \
  src/lib/boq-source-quote-summary.test.ts \
  src/lib/boq-ingestion.ts \
  src/lib/boq-ingestion.test.ts \
  src/lib/boq-review-state.ts \
  src/lib/boq-review-state.test.ts \
  src/lib/boq-detail-state.ts \
  src/lib/boq-detail-state.test.ts \
  src/app/api/boqs/boq-id-api.test.ts
git diff --cached --check
git commit -m "feat: reconcile approval with source quote summary"
```

---

### Task 4: Turn Extraction notes into a concise unique-row task summary

**Files:**

- Modify: `src/lib/boq-extraction-warnings.ts:1-98`
- Modify: `src/lib/boq-extraction-warnings.test.ts`
- Modify: `src/components/extraction-warnings.tsx:1-67`
- Modify: `src/components/extraction-warnings.test.ts`
- Modify: `src/app/globals.css:1545-1565`

**Interfaces:**

- Produces:

```ts
export type ExtractionWarningSection = "needs_review" | "document_information"

export interface ExtractionWarningSummary {
  affectedRowCount: number
  documentInformationCount: number
  rawOccurrenceCount: number
  needsReview: ExtractionWarningGroup[]
  documentInformation: ExtractionWarningGroup[]
}

export function summarizeExtractionWarnings(
  warnings: ReadonlyArray<BoqExtractionWarning>,
): ExtractionWarningSummary

export function compactExtractionWarningLocations(
  refs: ReadonlyArray<BoqSourceRef>,
  maxSegments?: number,
): { label: string; hiddenCount: number }
```

- `source_discount` is document information. Parser ambiguity, unsupported rows, and reconciliation failures require review.
- Unknown codes fail safe into `needs_review`.

- [ ] **Step 1: Write failing warning-summary tests**

Add tests for the exact current distribution:

```ts
const summary = summarizeExtractionWarnings([
  warning("unsupported_row", "Incomplete", { page: 2, table: 1, row: 3 }),
  warning("unparsed_row", "Unreadable", { page: 2, table: 1, row: 3 }),
  warning("unsupported_row", "Incomplete", { page: 2, table: 1, row: 7 }),
  warning("source_discount", "Discount 1,280"),
  warning("document_total_mismatch", "Mismatch"),
])
assert.equal(summary.affectedRowCount, 2)
assert.equal(summary.documentInformationCount, 1)
assert.equal(summary.rawOccurrenceCount, 5)
```

Add friendly-label assertions:

```ts
assert.equal(extractionWarningLabel("invalid_numeric_format"), "Unrecognized number format")
assert.equal(extractionWarningLabel("section_total_mismatch"), "Section total did not reconcile")
```

Add location compression:

```ts
assert.deepEqual(compactExtractionWarningLocations([
  { page: 2, table: 1, row: 3 },
  { page: 2, table: 1, row: 6 },
  { page: 2, table: 1, row: 7 },
  { page: 2, table: 1, row: 8 },
  { page: 2, table: 1, row: 9 },
  { page: 2, table: 1, row: 11 },
]), { label: "Page 2 · rows 3, 6–9, 11", hiddenCount: 0 })
```

Test stable grouping of distinct unknown codes and a bounded preview returning `hiddenCount > 0`.

- [ ] **Step 2: Run warning tests and verify RED**

Run:

```bash
npm test -- src/lib/boq-extraction-warnings.test.ts
```

Expected: FAIL because summary and compression helpers are absent and emitted code labels are missing.

- [ ] **Step 3: Implement pure warning summary helpers**

Use stable code groups. Deduplicate affected rows by `page:table:row`; do not claim that document-level warnings represent rows. Define an explicit information-code set containing `source_discount`; all unspecified codes remain review-required. Preserve every detail and raw occurrence count.

Compress sorted unique refs by page/table and consecutive row ranges. A segment is one page/table group; limit segments rather than silently dropping rows from a displayed segment.

- [ ] **Step 4: Run pure warning tests and verify GREEN**

Run:

```bash
npm test -- src/lib/boq-extraction-warnings.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing component-contract tests**

Replace old occurrence-copy assertions with:

```ts
assert.match(source, /summarizeExtractionWarnings/)
assert.match(source, /Needs review/)
assert.match(source, /Document information/)
assert.match(source, /source row.*need.*review/i)
assert.match(source, /rawOccurrenceCount/)
assert.match(source, /Technical details/)
assert.doesNotMatch(source, /occurrenceCount/)
```

Assert compact locations use `compactExtractionWarningLocations` and render `+ N more`. Retain assertions for one native `<details>` and exact `detail.message` rendering.

- [ ] **Step 6: Run component tests and verify RED**

Run:

```bash
npm test -- src/components/extraction-warnings.test.ts
```

Expected: FAIL because the component still renders occurrence-led copy and full inline locations.

- [ ] **Step 7: Implement the tidy Extraction notes component**

Render:

```tsx
<strong>Extraction notes</strong>
<p>{affectedRowCount} source rows need review.</p>
<section aria-label="Needs review">...</section>
<section aria-label="Document information">...</section>
<details>
  <summary>Technical details · {rawOccurrenceCount} raw notes</summary>
  {/* exact code, message, exact location */}
</details>
```

Omit empty sections. For document-only review failures, use `1 document-level issue needs review` rather than calling it a row. Use compact location labels in the default groups and exact locations inside Technical details.

Update CSS with restrained section labels, compact row ranges, mobile-safe wrapping, and no new page-level overflow rule.

- [ ] **Step 8: Run warning UI tests and diagnostics**

Run:

```bash
npm test -- \
  src/lib/boq-extraction-warnings.test.ts \
  src/components/extraction-warnings.test.ts \
  src/components/extraction-review.test.ts
npx tsc --noEmit
```

Expected: focused warning tests PASS. If the legacy extraction-review file retains the known unrelated failures, record exact signatures and verify no new warning-component failure appears.

- [ ] **Step 9: Commit Task 4**

```bash
git add \
  src/lib/boq-extraction-warnings.ts \
  src/lib/boq-extraction-warnings.test.ts \
  src/components/extraction-warnings.tsx \
  src/components/extraction-warnings.test.ts \
  src/app/globals.css
git diff --cached --check
git commit -m "feat: tidy extraction notes"
```

---

### Task 5: Render the read-only source quote summary in BOQ review

**Files:**

- Create: `src/components/source-quote-summary.tsx`
- Create: `src/components/source-quote-summary.test.ts`
- Modify: `src/app/(authenticated)/boqs/[id]/page.tsx:745-1645`
- Modify: `src/app/(authenticated)/boqs/[id]/page.test.ts`
- Modify: `src/app/globals.css`

**Interfaces:**

- Consumes `BoqSourceQuoteSummary`.
- Produces:

```ts
export interface SourceQuoteSummaryProps {
  summary: BoqSourceQuoteSummary
  onNavigateToSource?: (sourceRef: BoqSourceRef) => void
}

export function sourceQuoteSummaryRows(
  summary: BoqSourceQuoteSummary,
): Array<{
  key: "direct" | "overhead" | "subtotal" | "discount" | "payable"
  label: string
  operation: "base" | "add" | "subtract" | "result"
  amount: DecimalString
  sourceRef?: BoqSourceRef
}>
```

- No props permit editing, catalog matching, exclusion, or Estimator transfer.

- [ ] **Step 1: Write failing pure row-projection and component tests**

Create tests asserting:

```ts
assert.deepEqual(sourceQuoteSummaryRows(validSummary).map(({ key, label, operation, amount }) => ({ key, label, operation, amount })), [
  { key: "direct", label: "Direct work", operation: "base", amount: "179400" },
  { key: "overhead", label: "Overhead & profit", operation: "add", amount: "35880" },
  { key: "subtotal", label: "Quoted subtotal", operation: "result", amount: "215280" },
  { key: "discount", label: "Discount", operation: "subtract", amount: "1280" },
  { key: "payable", label: "Payable total", operation: "result", amount: "214000" },
])
```

Source tests must assert:

- heading `Source quote summary`;
- `data-od-id="source-quote-summary"`;
- source buttons only for rows with refs;
- no `input`, `Match`, `Add & match`, `Exclude`, `Estimator`, `percentage`, or `20%` copy.

- [ ] **Step 2: Run new component tests and verify RED**

Run:

```bash
npm test -- src/components/source-quote-summary.test.ts
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the focused read-only component**

Use semantic `<section>`, `<dl>`, `<dt>`, and `<dd>`. Format amounts as Thai baht at render time. Prefix only additive/subtractive rows with `+`/`−`; the stored amount remains nonnegative. Source buttons call the provided callback and use `View source: <label>` accessible names.

- [ ] **Step 4: Run component tests and verify GREEN**

Run:

```bash
npm test -- src/components/source-quote-summary.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing BOQ-page integration tests**

Extend `page.test.ts` to assert:

```ts
assert.match(source, /SourceQuoteSummary/)
assert.match(source, /displayBoq\.sourceQuoteSummary/)
assert.match(source, /setPdfEvidenceFocus/)
```

Within the review panel, require the summary to appear after Extraction notes and before the Parsed Items heading. Assert the compare panel has no `SourceQuoteSummary`, catalog actions remain unchanged, and the page contains no Estimator transfer logic.

Add a blocker-copy assertion that quote summary issue messages render directly and the page no longer forces `documentTotalMismatchMessage` for summary-backed BOQs.

- [ ] **Step 6: Run page tests and verify RED**

Run:

```bash
npm test -- \
  src/app/'(authenticated)'/boqs/'[id]'/page.test.ts \
  src/components/source-quote-summary.test.ts
```

Expected: FAIL because the summary is not wired into the page.

- [ ] **Step 7: Wire summary and source-page navigation**

Import the focused component into the existing client page. Render only when `displayBoq.sourceQuoteSummary` exists:

```tsx
<SourceQuoteSummary
  summary={displayBoq.sourceQuoteSummary}
  onNavigateToSource={(sourceRef) =>
    setPdfEvidenceFocus((current) => ({ page: sourceRef.page, key: current.key + 1 }))
  }
/>
```

Extend `pdfEvidenceFocus` from `{ page, key }` to `{ page, table, row, key }`. Pass both `requestedPage` and `evidenceFocus={{ page, table, row, cells: [] }}` to `PdfReviewViewer`. Its existing evidence marker supplies the visible/accessible row focus even without cell-box geometry. The button contract is therefore: navigate to the exact page and expose `Focus marker for table N, row N`; do not claim a geometric cell highlight.

Use `blockingIssues` messages as the approval reason for quote-summary issue codes. Keep the legacy source-vs-item detail message for BOQs without a summary.

- [ ] **Step 8: Add responsive, restrained styles**

Add `.source-quote-summary` styles using the existing surface, border, typography, spacing, and numeric tokens. Requirements:

- two-column label/amount grid on desktop;
- amount remains aligned and uses tabular numerals;
- source action wraps below the label on narrow screens;
- subtotal/payable rows receive a divider, not a heavy card or gradient;
- no horizontal scrolling at `390px`;
- visible keyboard focus;
- no animation required.

- [ ] **Step 9: Run UI tests, LSP diagnostics, and TypeScript**

Run:

```bash
npm test -- \
  src/components/source-quote-summary.test.ts \
  src/app/'(authenticated)'/boqs/'[id]'/page.test.ts \
  src/components/extraction-warnings.test.ts \
  src/lib/boq-review-state.test.ts
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 10: Browser QA with sanitized fixtures**

Using `agent-browser`, authenticate through an existing local test session and re-extract a sanitized synthetic PDF containing:

- direct work `179400`;
- merged overhead/profit `35880`;
- subtotal `215280`;
- discount `1280`;
- payable total `214000`.

At both `1280×800` and `390×844`, verify:

1. only direct rows appear in the BOQ table;
2. Source quote summary shows all five fixed amounts;
3. source buttons navigate to the correct PDF page;
4. no catalog action appears for overhead/discount;
5. Extraction notes show unique affected rows and compact locations;
6. Technical details retain exact raw warnings;
7. approval is no longer blocked by the explained quote gap;
8. unresolved direct catalog items still block approval;
9. approved view is read-only;
10. Estimator receives no automatic overhead/discount.

Save screenshots under `.superpowers/sdd/2026-08-09-source-quote-summary/` and write `browser-qa-report.md`. Never use `Quotation example/`.

If sanitized fixtures are unavailable, record browser QA as blocked and do not claim release readiness.

- [ ] **Step 11: Commit Task 5**

```bash
git add \
  src/components/source-quote-summary.tsx \
  src/components/source-quote-summary.test.ts \
  src/app/'(authenticated)'/boqs/'[id]'/page.tsx \
  src/app/'(authenticated)'/boqs/'[id]'/page.test.ts \
  src/app/globals.css \
  .superpowers/sdd/2026-08-09-source-quote-summary/browser-qa-report.md
git diff --cached --check
git commit -m "feat: show source quote summary"
```

If browser QA is blocked and no report is created, omit that path from `git add` and record the block in the final task report.

---

### Task 6: Whole-feature validation and review gate

**Files:**

- Create: `.superpowers/sdd/2026-08-09-source-quote-summary/final-report.md`
- Modify only if a reviewer identifies a Critical or Important defect in Task 1–5 files.

**Interfaces:**

- Consumes all Task 1–5 commits.
- Produces verification evidence and a release decision; no new feature behavior.

- [ ] **Step 1: Run the complete focused Python suite**

```bash
python3 -m unittest py-sidecar.test_boq_parser
```

Expected: PASS.

- [ ] **Step 2: Run the complete focused TypeScript suite**

```bash
npm test -- \
  src/lib/boq-source-quote-summary.test.ts \
  src/lib/boq-ingestion.test.ts \
  src/lib/boq-extraction-run.test.ts \
  src/lib/boq-extraction-storage.test.ts \
  src/lib/boq-review-state.test.ts \
  src/lib/boq-detail-state.test.ts \
  src/lib/boq-catalog-readiness.test.ts \
  src/lib/boq-extraction-warnings.test.ts \
  src/components/extraction-warnings.test.ts \
  src/components/source-quote-summary.test.ts \
  src/app/'(authenticated)'/boqs/'[id]'/page.test.ts \
  src/app/api/boqs/boq-id-api.test.ts
```

Expected: PASS.

- [ ] **Step 3: Prove the Estimator and comparison boundaries**

Run unchanged boundary tests:

```bash
npm test -- \
  src/app/'(authenticated)'/estimator/estimator-page.test.ts \
  src/lib/boq-catalog-comparison.test.ts \
  src/app/'(authenticated)'/compare/compare-pricing-ui.test.ts
```

Expected: PASS with no new quote-summary import or comparison behavior.

- [ ] **Step 4: Run repository verification**

```bash
npx tsc --noEmit
npm run check
graphify update .
git diff --check
```

Expected:

- TypeScript PASS.
- Graphify PASS.
- Diff check PASS.
- `npm run check` PASS except the already-known 12 unrelated legacy `src/components/extraction-review.test.ts` failures, whose names and count must match the baseline exactly. Any new failure blocks completion.

- [ ] **Step 5: Inspect dirty-tree and staged-file safety**

```bash
git status --short -- ':!Quotation example'
git diff --cached --name-status
git diff --check
```

Confirm no unrelated dirty edit is staged, no `Quotation example/` path was inspected or staged, and no production migration ran.

- [ ] **Step 6: Request semantic review**

Use the `requesting-code-review` skill against the full feature range. Require the reviewer to check:

- overhead/profit never becomes a BOQ/catalog item;
- no percentage or Estimator calculation was introduced;
- exact summary arithmetic and source binding fail closed;
- legacy BOQs retain current behavior;
- approval remains blocked for unexplained gaps and unresolved direct catalog items;
- API clients cannot mutate immutable source summaries;
- warnings preserve complete evidence while default UI counts unique rows;
- no Critical or Important findings remain.

- [ ] **Step 7: Write and commit the final report**

Record commands, results, known unrelated failures, browser screenshots/report path, review findings, and residual rollout risk in:

`.superpowers/sdd/2026-08-09-source-quote-summary/final-report.md`

Then:

```bash
git add .superpowers/sdd/2026-08-09-source-quote-summary/final-report.md
git diff --cached --check
git commit -m "docs: validate source quote summary"
```

Do not mark the feature release-ready if browser QA is blocked or the semantic review has unresolved Critical/Important findings.
