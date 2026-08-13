# Task 1 report — fixed source quote summary in Python

## Status

Implemented, validated, and committed Task 1.

## Scope and files

Task-owned changes:

- `py-sidecar/boq_compound_parser.py`
  - recognizes only explicit overhead/profit or overhead/expenses labels
  - reads the resolved amount column
  - derives canonical fixed decimal strings without percentage or gap inference
  - requires closed direct + overhead = quoted subtotal arithmetic
  - requires closed subtotal/discount/payable evidence where present
  - keeps overhead out of items and removes validated summary evidence from review candidates
  - reconciles against quoted subtotal while preserving direct `itemTotal`
- `py-sidecar/boq_contract.py`
  - adds strict `SourceQuoteSummary`
  - validates canonical nonnegative decimal strings, exact arithmetic, source refs, and response reconciliation invariants
  - extends `build_reconciliation(..., source_quote_summary=None)`
- `py-sidecar/main.py`
  - minimal authorized plumbing of deterministic `sourceQuoteSummary` into `build_reconciliation` and `ParseResponseV3`
- `py-sidecar/test_boq_parser.py`
  - merged-row extraction regression using actual synthetic rows 4–7
  - contract rejection/serialization regressions
  - Surasak direct-item/summary expectations
- `py-sidecar/test_main.py`
  - verifies `build_parse_response` preserves the deterministic summary and reconciliation
- `py-sidecar/fixtures/compound/surasak-unit-price.json`
  - removes the overhead item from the golden sections
  - updates warning/reconciliation expectations to 18 direct items and 40,620 direct total
- `src/lib/boq-extraction-proposal-store.test.ts`
  - approved Surasak-only expectation hunks: 18 items, 40,620 direct total, no overhead item ID

Explicitly unchanged:

- `py-sidecar/boq_parser.py`
- legacy N.P. Civil v2 test
- TypeScript production code
- `Quotation example/` was not inspected, staged, or committed

## Plan inaccuracies resolved

- The synthetic `build_source_rows` locations are rows 4–7, not 25–28. Assertions use page/table/row locations 4–7.
- The Surasak subtotal evidence is the amount-only source row 25 immediately following explicit overhead row 24; row 26 is the matching grand-total row.
- The shared Surasak golden fixture is consumed by the TypeScript proposal-store harness, so minimal approved TS expectation updates were necessary.

## Preserved RED evidence

Inherited from `.pi/subagents/artifacts/70b85182_worker_0_transcript.jsonl`; the proven RED tests were not restarted:

1. Parser RED under `.venv-docling/bin/python`:
   - `test_merged_overhead_profit_builds_fixed_quote_summary_without_item`
   - failure: direct items summed to `215280.0`, expected `179400.0`; overhead was still an item.
2. Contract RED under `.venv-docling/bin/python`:
   - `ContractV3InvariantTest`
   - valid summary errored because `sourceQuoteSummary` was an extra forbidden field.
3. Combined RED:
   - merged parser regression: `215280.0 != 179400.0`
   - Surasak regression: `19 != 18`
   - valid contract summary: extra input forbidden.

The earlier bare `python3` import error (`pydantic` unavailable) was environmental and not counted as behavioral RED.

## GREEN and validation evidence

- `.venv-docling/bin/python -m unittest py-sidecar.test_boq_parser.CompoundDerivationTest py-sidecar.test_boq_parser.ContractV3InvariantTest py-sidecar.test_boq_parser.BoqParserTest.test_normalizes_actual_np_civil_headers_and_uses_pre_discount_total_for_reconciliation`
  - PASS: 72 tests.
- `.venv-docling/bin/python -m unittest py-sidecar.test_boq_parser`
  - PASS: 147 tests.
- `PYTHONPATH=py-sidecar .venv-docling/bin/python -m unittest py-sidecar/test_main.py`
  - PASS: 7 tests; expected OCR fallback warning only.
- `npx tsx --test src/lib/boq-extraction-proposal-store.test.ts`
  - PASS: 84 tests.
- `npx tsc --noEmit`
  - PASS, no output.
- `npm run check`
  - PARTIAL/KNOWN FAILURE: lint and TypeScript compilation passed; test suite reported 1,568 pass / 12 fail. All 12 failures are the known unrelated extraction-review UI tests (test numbers 341, 348–350, 358, 361, 365, 367, 370–372, 374). The Surasak focused regression passed and the previous 13th Surasak failure is gone.
- `graphify update .`
  - PASS: rebuilt 4,033 nodes / 9,723 edges / 243 communities; no tracked graph diff.
- `git diff --check`
  - PASS, no whitespace errors.

## Dirty-tree and cached-diff safety

- Before Task 1, `src/lib/boq-extraction-proposal-store.test.ts` differed from HEAD by exactly the saved baseline patch at `pre-task-1-proposal-store-dirty.patch` (matching SHA-1 `29570e04a1fa8ce66f414d424d9dada1bce63057`).
- The pre-existing formatting hunk near `candidate` was preserved and excluded from staging.
- Only the approved Surasak hunks were staged from that pre-dirty file; the cached diff was inspected before commit.
- All unrelated dirty files remain unstaged and uncommitted.

## Self-review

- Closed extraction only: no percentage field, percentage engine, or inferred overhead gap.
- Explicit overhead rows are never items, even when a summary cannot close; unresolved evidence remains reviewable.
- Summary arithmetic is exact `Decimal` arithmetic and serialized strings are canonical/non-exponent.
- Contract source references must match retained source locations.
- `itemTotal` remains the direct contribution while summary reconciliation compares the quoted subtotal to `sourceTotal`.
- Minimal main plumbing is covered by a focused test.
- Legacy parser behavior and N.P. Civil v2 coverage are untouched.

## Concerns / residual risks

- `npm run check` remains red only because of 12 known unrelated extraction-review UI failures in the pre-existing dirty worktree.
- `sourceQuoteSummary` is intentionally optional for legacy v3 payload compatibility.

## Commit

- `97f18ae` — `feat: extract source quote summaries`

## Fix Round 1

### Status

All three Important review findings were fixed regression-first, validated, and committed.

### Findings and fixes

1. **Incomplete payable evidence could incorrectly validate a summary.**
   - Added `test_summary_rejects_incompatible_payable_without_explicit_discount` in `py-sidecar/test_boq_parser.py`.
   - `_quote_summary` now rejects any explicit grand/payable row whose fixed amount differs from the selected subtotal when no explicit discount row closes that difference. Matching grand rows remain compatible subtotal/payable evidence.
2. **Selected subtotal precision passed through binary float before summary derivation.**
   - Added `test_quote_summary_preserves_high_precision_subtotal_decimal` using subtotal `9007199254740993`, which cannot survive an exact binary-float/string round trip.
   - `_source_total` now returns the selected/aggregated `Decimal`; `_quote_summary` receives that exact value. The legacy JSON-number `sourceTotal` is produced with `_finite_float` only in `derive_source_rows` at the response boundary.
3. **Unresolved overhead evidence classified as `total` was not reviewable.**
   - Added `test_unresolved_total_classified_overhead_is_reviewable` and asserts the synthetic row is actually classified `total`.
   - The derivation loop now detects and records every explicit overhead/profit row before classification-based skips. It still never derives overhead as an item and adds unresolved overhead IDs to review candidates.

Changed code/files:

- `py-sidecar/boq_compound_parser.py`
- `py-sidecar/test_boq_parser.py`
- `.superpowers/sdd/2026-08-09-source-quote-summary/task-1-report.md`

No TypeScript file, fixture, contract, main plumbing, legacy parser, or customer quotation file was changed by this round.

### RED evidence

Command (run after writing all three regressions and before production edits):

```bash
.venv-docling/bin/python -m unittest \
  py-sidecar.test_boq_parser.CompoundDerivationTest.test_summary_rejects_incompatible_payable_without_explicit_discount \
  py-sidecar.test_boq_parser.CompoundDerivationTest.test_quote_summary_preserves_high_precision_subtotal_decimal \
  py-sidecar.test_boq_parser.CompoundDerivationTest.test_unresolved_total_classified_overhead_is_reviewable
```

Output: `Ran 3 tests`; `FAILED (failures=1, errors=1)`. Specifically:

- incompatible payable: summary was incorrectly present as `{directWorkTotal: '100', overheadProfitAmount: '20', quotedSubtotal: '120', ...}`;
- high precision: `sourceQuoteSummary` was `None` because subtotal `9007199254740993` had rounded through float to `9007199254740992`;
- unresolved total-classified overhead: with explicit overhead amount `100` and incompatible subtotal `130`, its ID was absent from `reviewCandidateRowIds` (`FAILED`, 1 test).

The exact combined RED for findings 1 and 2 is retained in `/tmp/task1-fix1-final-regressions-red.txt`; finding 3 RED is in `/tmp/task1-fix1-overhead-final-red.txt`. The final three-regression GREEN is retained in `/tmp/task1-fix1-green-regressions-final-true.txt`.

### GREEN evidence

- Three new regressions command above: PASS, `Ran 3 tests ... OK`.
- `.venv-docling/bin/python -m unittest py-sidecar.test_boq_parser.CompoundDerivationTest py-sidecar.test_boq_parser.ContractV3InvariantTest py-sidecar.test_boq_parser.BoqParserTest.test_normalizes_actual_np_civil_headers_and_uses_pre_discount_total_for_reconciliation`
  - PASS: 75 tests.
- `.venv-docling/bin/python -m unittest py-sidecar.test_boq_parser`
  - PASS: 150 tests.
- `PYTHONPATH=py-sidecar .venv-docling/bin/python -m unittest py-sidecar/test_main.py`
  - PASS: 7 tests; expected OCR fallback warning only.
- `npx tsx --test src/lib/boq-extraction-proposal-store.test.ts`
  - PASS: 84 tests.
- `npx tsc --noEmit`
  - PASS, no output.
- `npm run check`
  - KNOWN UNRELATED FAILURE: lint completed with warnings only, TypeScript compilation passed, and tests remained exactly `1,568 pass / 12 fail`. Failing test numbers and names are unchanged from Task 1: 341, 348–350, 358, 361, 365, 367, 370–372, and 374 (extraction-review UI dirty work).
- `graphify update .`
  - PASS: rebuilt 4,050 nodes / 9,746 edges / 239 communities; no tracked graph diff.
- `git diff --check`
  - PASS.

### Residual risk and dirty-tree safety

- Full `npm run check` remains red only on the same 12 unrelated extraction-review UI failures.
- `src/lib/boq-extraction-proposal-store.test.ts` retains its pre-existing unstaged formatting hunk and was not touched or staged in this round.
- All other unrelated dirty edits remain unstaged and uncommitted.
- `Quotation example/` was not inspected.

### Fix commit

- `f60468d` — `fix: harden source quote summary extraction`

## Fix Round 2

### Status and finding

Fixed the remaining Important finding regression-first: exact high-precision `sourceQuoteSummary` strings could not pass `ParseResponseV3` after the compatible legacy `sourceTotal` JSON number rounded at the float boundary.

### Changed code and coverage

- `py-sidecar/boq_contract.py`
  - preserves exact canonical summary validation and exact direct + overhead = quoted arithmetic;
  - converts the exact quoted subtotal through the same checked legacy float round trip only for the final `sourceTotal` comparison and reconciliation representation;
  - compares at `RECONCILIATION_TOLERANCE` only at that final legacy boundary;
  - continues rejecting a real one-minor-unit (`0.01`) currency mismatch.
- `py-sidecar/test_main.py`
  - adds `test_build_parse_response_preserves_exact_summary_across_rounded_legacy_total`, exercising `build_parse_response` with exact quoted subtotal `9007199254740993` and rounded legacy JSON number `9007199254740992.0`.
- `py-sidecar/test_boq_parser.py`
  - adds `test_source_quote_summary_allows_only_legacy_float_rounding_at_boundary`, covering accepted unavoidable float rounding and explicit rejection of `120` versus `120.01`.
- `.superpowers/sdd/2026-08-09-source-quote-summary/task-1-report.md`
  - records this fix round.

No parser extraction rules, TypeScript file, fixture, percentage/gap inference, or unrelated product surface changed.

### RED evidence

Command, run after the two regressions and before production changes:

```bash
PYTHONPATH=py-sidecar .venv-docling/bin/python -m unittest \
  py-sidecar.test_main.SelectedPageTests.test_build_parse_response_preserves_exact_summary_across_rounded_legacy_total \
  py-sidecar.test_boq_parser.ContractV3InvariantTest.test_source_quote_summary_allows_only_legacy_float_rounding_at_boundary
```

Output: `Ran 2 tests`; `FAILED (errors=2)`. Both failed with `Value error, sourceTotal must match sourceQuoteSummary.quotedSubtotal`. Exact output: `/tmp/task1-fix2-red.txt`.

### GREEN and validation evidence

- Focused command above: PASS, `Ran 2 tests ... OK` (`/tmp/task1-fix2-green-focused-final-3.txt`).
- `.venv-docling/bin/python -m unittest py-sidecar.test_boq_parser`
  - PASS: 151 tests.
- `PYTHONPATH=py-sidecar .venv-docling/bin/python -m unittest py-sidecar/test_main.py`
  - PASS: 8 tests; expected OCR fallback warning only.
- `npx tsx --test src/lib/boq-extraction-proposal-store.test.ts`
  - PASS: 84 tests.
- `npx tsc --noEmit`
  - PASS, no output.
- `npm run check`
  - KNOWN UNRELATED FAILURE: lint and TypeScript compilation completed; test result remains exactly `1,568 pass / 12 fail`. The same unrelated extraction-review UI tests fail: 341, 348–350, 358, 361, 365, 367, 370–372, and 374.
- `graphify update .`
  - PASS: rebuilt 4,059 nodes / 9,757 edges / 256 communities; no tracked graph diff.
- `git diff --check`
  - PASS.

### Residual risk and dirty-tree safety

- Full `npm run check` remains red only on the unchanged 12 unrelated UI tests.
- Exact summary strings and all internal summary arithmetic remain strict; tolerance is confined to the legacy numeric response boundary.
- `src/lib/boq-extraction-proposal-store.test.ts` retains its pre-existing unstaged formatting change and was neither touched nor staged.
- All unrelated dirty work remains unstaged and uncommitted.
- `Quotation example/` was not inspected.

### Fix commit

- `67c4061` — `fix: preserve quote summary precision at boundary`

## Fix Round 3

### Status and finding

Fixed the remaining narrow Important finding regression-first: `ParseResponseV3` still had a dead exact-float equality guard ahead of the intended final currency-tolerance comparison.

### Changed code and coverage

- `py-sidecar/boq_contract.py`
  - removes only `self.sourceTotal != legacy_quoted_float` from the final summary-to-legacy-number boundary;
  - retains `abs(response_source - legacy_quoted_representation) > RECONCILIATION_TOLERANCE`;
  - leaves exact canonical summary parsing, direct/item equality, direct + overhead = quoted arithmetic, and discount/payable arithmetic unchanged.
- `py-sidecar/test_boq_parser.py`
  - extends `test_source_quote_summary_allows_only_legacy_float_rounding_at_boundary` to accept `sourceTotal=120.005` for exact `quotedSubtotal="120"`;
  - preserves the high-precision `9007199254740993` case;
  - preserves meaningful one-minor-unit rejection using the next representable float above `120.01` (`120.01000000000002`), avoiding the established inclusive `0.01` tolerance edge.
- `.superpowers/sdd/2026-08-09-source-quote-summary/task-1-report.md`
  - records this fix round.

No extraction rules, response plumbing, TypeScript, fixture, percentage/gap inference, or unrelated product code changed.

### RED evidence

Command, run after adding the `120.005` assertion and before production changes:

```bash
.venv-docling/bin/python -m unittest \
  py-sidecar.test_boq_parser.ContractV3InvariantTest.test_source_quote_summary_allows_only_legacy_float_rounding_at_boundary
```

Output: `Ran 1 test`; `FAILED (errors=1)` with `Value error, sourceTotal must match sourceQuoteSummary.quotedSubtotal`. Exact output: `/tmp/task1-fix3-red.txt`.

### GREEN and validation evidence

- Focused regression above: PASS, `Ran 1 test ... OK` (`/tmp/task1-fix3-green-focused-2.txt`).
- `.venv-docling/bin/python -m unittest py-sidecar.test_boq_parser.ContractV3InvariantTest`
  - PASS: 16 tests.
- `.venv-docling/bin/python -m unittest py-sidecar.test_boq_parser`
  - PASS: 151 tests.
- `PYTHONPATH=py-sidecar .venv-docling/bin/python -m unittest py-sidecar/test_main.py`
  - PASS: 8 tests; expected OCR fallback warning only.
- `npx tsx --test src/lib/boq-extraction-proposal-store.test.ts`
  - PASS: 84 tests.
- `npx tsc --noEmit`
  - PASS, no output.
- `npm run check`
  - KNOWN UNRELATED FAILURE: lint and TypeScript compilation completed; tests remain exactly `1,568 pass / 12 fail`. The same extraction-review UI tests fail: 341, 348–350, 358, 361, 365, 367, 370–372, and 374.
- `graphify update .`
  - PASS: rebuilt 4,066 nodes / 9,760 edges / 254 communities; no tracked graph diff.
- `git diff --check`
  - PASS.

### Residual risk and dirty-tree safety

- Full `npm run check` remains red only on the unchanged 12 unrelated UI failures.
- The established tolerance is inclusive (`<= 0.01`); the regression verifies rejection immediately beyond a one-minor-unit difference.
- `src/lib/boq-extraction-proposal-store.test.ts` retains its pre-existing unstaged formatting change and was neither touched nor staged.
- All unrelated dirty work remains unstaged and uncommitted.
- `Quotation example/` was not inspected.

### Fix commit

- See current `fix: apply quote boundary currency tolerance` commit; final hash is reported in the completion response.
