# Source Quote Summary and Extraction Notes Design

**Date:** 2026-08-09

**Status:** Approved revision

**Scope:** Preserve source overhead/profit and discount as a read-only quote summary, keep them out of BOQ item comparison, and simplify extraction notes.

## 1. Problem

BOQ `2b93901e-b2c8-4931-a5f9-10ab0737d3f1` is blocked from approval because its direct items total ฿179,400 while the source subtotal is ฿215,280.

The exact difference, ฿35,880, is the source row **OVERHEAD & PROFIT**. The source then applies a ฿1,280 discount, producing a final payable amount of ฿214,000.

The parser retains the overhead row but does not derive it because its label is in a merged cell. The current verifier therefore sees an unexplained total gap.

Overhead and profit are not useful as catalog items:

- they should not be matched to catalog entries;
- they should not affect historical unit rates;
- they should not appear in line-item vendor comparison;
- they should not be imported into Estimator automatically.

The review also shows 29 extraction-warning occurrences as a long expanded list. Several warnings refer to the same source row, and some emitted codes have no friendly labels.

## 2. Approved product decisions

1. BOQ items represent direct construction work only.
2. Overhead/profit and discount remain source quote information, not BOQ items.
3. Add a small, fixed quote-summary model rather than a generic adjustment engine.
4. Quote-summary amounts are read-only evidence extracted from the source document.
5. Approval may use the quote summary to explain and reconcile the difference between direct items and source totals.
6. Catalog, comparison, and historical pricing ignore quote-summary amounts.
7. Estimator does not import overhead/profit or discount. Users create estimate adjustments independently when building an estimate.
8. No percentage is stored or recalculated. The UI may show only the fixed source amount.
9. Existing BOQs are not silently rewritten; re-extraction is required.
10. Extraction notes become concise and task-oriented while retaining full technical evidence.

## 3. Minimal data model

Add one optional object to extraction results and canonical BOQs:

```ts
interface BoqSourceQuoteSummary {
  directWorkTotal: string
  overheadProfitAmount?: string
  quotedSubtotal: string
  discountAmount?: string
  payableTotal?: string
  overheadProfitSourceRef?: BoqSourceRef
  discountSourceRef?: BoqSourceRef
  subtotalSourceRef?: BoqSourceRef
  payableTotalSourceRef?: BoqSourceRef
}
```

Rules:

- Amounts are canonical nonnegative decimal strings.
- The model has no percentage, formula, ordering engine, arbitrary adjustment type, catalog identity, or editable state.
- `directWorkTotal` is the sum of contributing BOQ items.
- `quotedSubtotal` remains equivalent to the existing `sourceTotal`.
- `payableTotal` is the final source amount after the source discount, when identifiable.
- Source references are retained when available.
- Missing optional amounts remain absent; the parser never invents them from unexplained differences alone.

For the current document:

```text
Direct work              ฿179,400
Overhead & profit         +฿35,880
Quoted subtotal           ฿215,280
Discount                   −฿1,280
Payable total             ฿214,000
```

## 4. Parser behavior

### 4.1 Recognize the source quote rows

The deterministic parser recognizes the current quote summary only when explicit source evidence exists:

- a merged or ordinary row label clearly identifies `OVERHEAD & PROFIT`;
- the same row contains a valid amount in the source amount column;
- an explicit discount row contains a valid discount amount;
- subtotal and payable-total rows are identifiable from source labels and layout.

Merged cells spanning the usual description columns are valid label evidence.

### 4.2 Fail closed

- An unlabeled amount does not become overhead or discount.
- An unexplained gap does not create a quote-summary amount.
- Ambiguous commercial rows remain extraction notes and continue blocking reconciliation.
- The parser stores fixed source amounts only; it does not derive or store `20%`.
- Original source rows and warning evidence remain available.

### 4.3 Contract validation

The extraction contract accepts an optional `sourceQuoteSummary` and validates:

- exact allowed keys;
- canonical decimal strings;
- nonnegative values;
- source references that point to known rows;
- `directWorkTotal` equals the deterministic contributing-item total;
- `directWorkTotal + overheadProfitAmount = quotedSubtotal` when overhead is present;
- `quotedSubtotal - discountAmount = payableTotal` when both are present;
- existing `sourceTotal` equals `quotedSubtotal`.

Validation uses exact decimal arithmetic and the existing currency tolerance only at the final comparison boundary.

## 5. Canonical BOQ and compatibility

Add optional `sourceQuoteSummary` to `Boq`.

Existing fields retain their meaning:

- `grandTotal`: direct BOQ item total;
- `sourceTotal`: quoted source subtotal before discount;
- `sections`: direct comparable work only.

Legacy BOQs without `sourceQuoteSummary` load unchanged and retain current verification behavior.

No production or local migration is required. Re-extraction is the explicit upgrade path for existing documents.

## 6. Verification and approval

When a valid quote summary exists, verification checks two separate layers:

1. Direct BOQ items equal `sourceQuoteSummary.directWorkTotal`.
2. The fixed quote-summary arithmetic reconciles to `sourceTotal` and, when present, `payableTotal`.

For the current BOQ:

```text
179,400 + 35,880 = 215,280
215,280 - 1,280 = 214,000
```

Approval behavior:

- A valid, reconciled quote summary resolves the current document-total mismatch.
- Direct BOQ items still require the existing catalog matched-or-excluded readiness.
- Quote-summary amounts create no catalog-readiness tasks.
- Missing or invalid quote-summary evidence remains blocking.
- Approved BOQs expose the summary read-only and reject every canonical mutation.
- Existing exact **Exclude** wording and semantics remain unchanged.

Replace the misleading normalization blocker with layer-specific copy, for example:

- `Direct BOQ items do not reconcile with the source quote summary.`
- `Source overhead/profit does not reconcile with the quoted subtotal.`
- `Source discount does not reconcile with the payable total.`

Do not mention normalization unless a real unit normalization is involved.

## 7. BOQ review UI

Show a compact read-only **Source quote summary** near the direct BOQ total:

```text
Direct work                         ฿179,400
Overhead & profit                  +฿35,880
Quoted subtotal                     ฿215,280
Discount                            −฿1,280
Payable total                       ฿214,000
```

UI rules:

- Direct work remains the table's grand total.
- Quote-summary rows are visually separate from BOQ items.
- Source-location controls highlight the corresponding PDF rows when references exist.
- Quote-summary rows have no Match, Add & match, Find match, Exclude, unit, quantity, rate, material, or labour controls.
- Quote-summary amounts are not editable in BOQ review.
- Approved/read-only BOQs retain the same summary.

## 8. Catalog, comparison, and Estimator boundaries

### Catalog and historical pricing

`sourceQuoteSummary` is never read by catalog matching, catalog readiness, standard-item history, or rate calculations.

### BOQ and vendor comparison

Line-item comparisons use direct BOQ items only. A future quote-level summary may display commercial totals, but this implementation does not add comparison behavior for overhead or discount.

### Estimator

No automatic transfer occurs.

- Direct BOQ items may continue to be imported using existing behavior.
- Source overhead/profit and discount are not imported.
- Estimator users create their own manual adjustments according to the new estimate they are building.
- No Estimator schema or calculation changes are required for this feature.

## 9. Extraction notes presentation

### 9.1 User-facing count

Replace occurrence-led copy such as `29 extraction notes need review` with a count of unique source rows requiring review.

Multiple warnings on one source row count as one affected row. Document-level information without a row is counted separately. The raw warning occurrence count remains visible only in Technical details.

### 9.2 Sections

Render two concise sections:

1. **Needs review** — incomplete, unreadable, ambiguous, or unreconciled evidence requiring action.
2. **Document information** — recognized source facts such as discount information that do not require correction.

Once overhead/profit is recognized in the quote summary, its row no longer appears as an incomplete item. Once arithmetic reconciles, stale section/document mismatch warnings are not regenerated.

### 9.3 Friendly labels

Add labels for codes currently shown as `Other extraction note`:

- `invalid_numeric_format` → `Unrecognized number format`
- `section_total_mismatch` → `Section total did not reconcile`

Unknown warning codes retain the neutral `Other extraction note` label but remain distinct groups by code.

### 9.4 Compact source locations

Group locations by page and table and compress consecutive rows:

```text
Page 2 · rows 3, 6–9, 11–19
```

Show a bounded preview with `+ N more` when needed.

### 9.5 Technical details

A collapsed **Technical details** disclosure preserves:

- raw occurrence count;
- warning code;
- original parser message;
- exact source location.

No evidence is deleted or rewritten for presentation.

## 10. Data flow

```text
PDF/source table
  → lossless source rows
  → direct BOQ item derivation
  → fixed source quote-summary extraction
  → strict contract validation
  → canonical BOQ {
       sections,
       grandTotal,
       sourceTotal,
       sourceQuoteSummary
     }
  → review verification and read-only summary
  → approved BOQ
```

Estimator consumes only existing direct-item import paths. It does not consume `sourceQuoteSummary`.

## 11. Error handling

- Invalid quote-summary arithmetic rejects the extraction contract.
- Ambiguous rows stay visible as review notes.
- Failed re-extraction leaves the current canonical BOQ unchanged.
- Failed persistence writes neither partial items nor a partial summary.
- Legacy reads remain additive and compatible.
- Approved BOQs reject mutations.
- No production migration runs locally.

## 12. Testing strategy

Use strict RED → GREEN tests.

### Parser and contract

- A merged `OVERHEAD & PROFIT` label plus ฿35,880 becomes fixed quote-summary evidence.
- The overhead row does not become a BOQ item and does not increase `totalItems`.
- Discount becomes fixed quote-summary evidence.
- Direct items remain unchanged.
- Exact summary arithmetic validates.
- Unlabeled amounts and ambiguous rows fail closed.
- Source references are preserved.
- No percentage field is produced.

### BOQ verification

- Direct items plus fixed overhead reconcile to `sourceTotal`.
- Discount reconciles quoted subtotal to payable total.
- Missing or altered summary evidence blocks approval.
- Valid summary evidence resolves the current false normalization message.
- Quote summary creates no catalog-readiness blocker.
- Legacy BOQs retain existing verification.
- Approved BOQs reject summary mutation.

### Feature boundaries

- Catalog matching ignores quote summary.
- Historical pricing ignores quote summary.
- Vendor line-item comparison ignores quote summary.
- Existing Estimator import includes direct items only.
- No Estimator schema change is introduced.

### Extraction notes and UI

- Summary counts unique affected rows, not warning occurrences.
- Needs-review and document-information notes are separated.
- Actual emitted warning codes receive friendly labels.
- Row ranges compress correctly.
- Technical details retain exact messages and locations.
- Source quote summary renders without catalog or editing controls.
- Summary is responsive and read-only after approval.

### Browser QA

Use sanitized synthetic digital and scanned PDFs at `1280×800` and `390×844`. Verify:

- direct items remain the only comparable rows;
- fixed source quote summary reconciles visibly;
- source highlighting reaches overhead and discount rows;
- extraction notes are concise by default and complete when expanded;
- approval and read-only safeguards remain intact;
- Estimator receives no automatic overhead or discount.

Never use `Quotation example/` or unsanitized customer documents.

## 13. Out of scope

- A generic adjustment engine.
- Percentage storage or recalculation.
- Automatic Estimator adjustment import.
- Cataloging or comparing overhead/profit.
- Inventing commercial terms from unexplained total differences.
- Tax, retention, contingency, escalation, or multi-currency calculations.
- Backfilling existing BOQs without re-extraction.
- Changing existing catalog Exclude behavior.
