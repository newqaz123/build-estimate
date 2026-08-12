# Source Adjustment Separation and Extraction Notes Design

**Date:** 2026-08-09

**Status:** Approved design

**Scope:** Source-backed overhead/profit and discount handling from BOQ extraction through Estimator, plus concise extraction-note presentation

## 1. Problem

The BOQ review for `2b93901e-b2c8-4931-a5f9-10ab0737d3f1` shows a blocking total mismatch:

- Direct BOQ work: ฿179,400
- Source subtotal: ฿215,280
- Difference: ฿35,880
- Source discount: ฿1,280
- Quoted payable total: ฿214,000

The missing ฿35,880 is the source row **OVERHEAD & PROFIT**, equal to 20% of the direct-work subtotal. Its label occupies a merged source cell. The parser does not find a normal description cell, classifies the row as unsupported, and excludes the amount from deterministic reconciliation.

Treating this row as a normal BOQ item would make it catalog-matchable and pollute future unit-rate and vendor comparisons. Ignoring it would lose quoted commercial terms and prevent an auditable bridge from direct work to the source total.

The same review displays 29 warning occurrences as an expanded list. Multiple warnings can refer to the same source row, two emitted warning codes lack friendly labels, and every source location is shown inline. The result is technically accurate but noisy and difficult to act on.

## 2. Product decisions

1. BOQ comparison represents **direct work only**.
2. Overhead, profit, discount, and similar commercial adjustments never become catalog items.
3. Source adjustments remain immutable source evidence and participate in quote-total reconciliation.
4. Estimator receives source adjustments separately from imported BOQ items.
5. Percentage overhead/profit recalculates when the estimate's direct-work subtotal changes while retaining the original source snapshot.
6. The source discount is imported as a separate fixed negative adjustment.
7. Existing BOQs are not silently rewritten. A BOQ must be re-extracted to gain the new adjustment evidence.
8. Extraction notes summarize unique affected rows and separate actionable review from document information. Exact parser evidence remains available under Technical details.

## 3. Domain boundaries

### 3.1 Direct BOQ items

Direct BOQ items continue to drive:

- catalog matching and catalog readiness;
- historical unit-rate comparison;
- cross-vendor BOQ comparison;
- material/labour allocation;
- direct-work BOQ subtotal;
- actionable extraction decisions for missing work items.

No source adjustment is converted into `BoqPricedItem` merely to make arithmetic reconcile.

### 3.2 Source adjustments

Introduce a separate additive `sourceAdjustments` collection on extraction results and canonical BOQs. Each adjustment is source-backed and not catalog-addressable.

Conceptual shape:

```ts
interface BoqSourceAdjustment {
  id: string
  label: string
  kind: 'overhead_profit' | 'discount' | 'other'
  operation: 'add' | 'subtract'
  stage: 'subtotal' | 'payable'
  basis:
    | { kind: 'percentage'; rate: string; baseAmount: string }
    | { kind: 'fixed' }
  amount: string
  sourceRef: BoqSourceRef
  sourceRowIds: string[]
}
```

Rules:

- `amount`, percentage `rate`, and `baseAmount` are canonical nonnegative decimal strings. `operation` supplies the sign.
- `sourceRowIds` and `sourceRef` preserve immutable provenance.
- `kind` is determined only from explicit source language and layout evidence. Ambiguous rows remain review notes; the parser must not infer a commercial category from an amount alone.
- `stage: 'subtotal'` adjusts direct work to the quoted pre-discount subtotal.
- `stage: 'payable'` adjusts the quoted subtotal to the final payable total.
- The parser preserves source order for adjustments applied at the same stage.
- Adjustments do not carry `stdId`, `stdStatus`, cost component, unit normalization, or catalog candidates.

The example becomes:

```text
Direct work                              179,400.00
+ OVERHEAD & PROFIT (20%)                 35,880.00
= sourceTotal / quoted subtotal          215,280.00
- Discount                                1,280.00
= sourcePayableTotal                     214,000.00
```

### 3.3 Existing total fields

Preserve additive compatibility:

- `Boq.grandTotal` remains the direct-work total calculated from contributing BOQ items.
- Existing `Boq.sourceTotal` remains the quoted pre-discount subtotal used by current documents.
- Add optional `Boq.sourcePayableTotal` for the final quoted amount after payable-stage adjustments.
- Add optional `Boq.sourceAdjustments`.

Legacy BOQs without these fields continue to load and retain current verification behavior.

## 4. Parser behavior

### 4.1 Adjustment-row recognition

The deterministic parser recognizes an adjustment only when all of the following are present:

1. A nonblank label is retained in the row, including a merged cell spanning the ordinary description columns.
2. A valid amount is retained in the row's amount/total column.
3. The label contains explicit adjustment language supported by a closed, tested classifier, such as overhead, profit, discount, rebate, or equivalent approved terms.
4. The row is not a document grand-total or section-total row.
5. Percentage classification is used only when an explicit percentage is present or when the exact rate can be deterministically derived from a clearly identified base and source amount. The derivation and original values are retained.

For the current source, the parser reads the merged label `OVERHEAD & PROFIT`, the amount `35,880.00`, and derives the exact rate `0.20` from direct work `179,400.00`.

### 4.2 Fail-closed behavior

- A merged label without a valid amount remains a review note.
- An amount without a deterministic label is never silently converted into an adjustment.
- An ambiguous base prevents percentage derivation; the adjustment may remain fixed only if its amount and commercial role are explicit.
- Conflicting totals remain blocking.
- Parser warnings and source rows are append-only evidence; no raw evidence is discarded when a row becomes a recognized adjustment.

### 4.3 Contract and ingestion

The extraction contract gains optional `sourceAdjustments` and `sourcePayableTotal`. Validation checks:

- exact allowed keys;
- unique deterministic adjustment IDs;
- known source-row bindings;
- valid source locations;
- canonical decimal strings;
- valid operation, stage, kind, and basis combinations;
- exact percentage arithmetic at the configured currency scale;
- exact ordered reconciliation.

Ingestion copies validated adjustments into the BOQ without converting them into sections or line items.

## 5. Reconciliation and approval

Verification computes three layers:

1. **Direct total** = sum of contributing BOQ items.
2. **Quoted subtotal** = direct total plus ordered `subtotal` adjustments.
3. **Quoted payable total** = quoted subtotal plus ordered `payable` adjustments.

Approval rules:

- If `sourceTotal` exists, the computed quoted subtotal must equal it within the existing currency tolerance.
- If `sourcePayableTotal` exists, the computed payable total must equal it within the existing currency tolerance.
- Invalid, ambiguous, or unbound source adjustments are blocking.
- Source adjustments never affect catalog readiness.
- All direct priced items retain the existing matched-or-excluded catalog requirement.
- Approved BOQs reject every adjustment mutation, like every other canonical mutation.
- Exact existing **Exclude** wording and semantics remain unchanged.

The current generic blocker, “Normalized item total does not match the source document total,” becomes a layer-specific message. Examples:

- `Direct items plus source adjustments are ฿35,880 below the quoted subtotal.`
- `Quoted subtotal and source discount do not reconcile to the payable total.`

No unit-normalization language is shown unless a pricing normalization actually caused the mismatch.

## 6. BOQ review UI

### 6.1 Source totals bridge

Show a compact, read-only totals bridge near the direct BOQ total:

```text
Direct work                         ฿179,400
Overhead & profit · 20%             +฿35,880
Quoted subtotal                     ฿215,280
Discount                             −฿1,280
Quoted payable total                ฿214,000
```

Interaction rules:

- Adjustment rows use source-evidence styling, not catalog badges.
- A source-location action highlights the originating PDF row.
- No Match, Add & match, Find match, or Exclude control appears for adjustments.
- Editing direct BOQ items updates the computed bridge and exposes any resulting mismatch, but never rewrites immutable source snapshots.
- In approved/read-only state, the bridge remains visible and immutable.

### 6.2 Compare surfaces

Catalog comparison and cross-vendor line-item comparison consume direct BOQ items only. A quote-level summary may show source adjustments separately, but it must not rank or match them as equivalent work items.

## 7. Estimator transfer

### 7.1 First-class estimate adjustments

Do not represent signed discounts as `EstimateItem`, because estimate items are nonnegative work rows. Add an ordered `EstimateAdjustment[]` beside `Estimate.items`.

Conceptual shape:

```ts
interface EstimateAdjustment {
  id: string
  label: string
  operation: 'add' | 'subtract'
  calculation:
    | { kind: 'percentage'; rate: string; base: 'direct_items' }
    | { kind: 'fixed'; amount: string }
  source: 'imported' | 'manual'
  sourceSnapshot?: {
    boqId: string
    adjustmentId: string
    label: string
    operation: 'add' | 'subtract'
    amount: string
    basisKind: 'percentage' | 'fixed'
    rate?: string
    baseAmount?: string
    sourceRef: BoqSourceRef
  }
}
```

### 7.2 Import behavior

Creating an estimate from this BOQ imports:

- seven direct BOQ items as `source: 'imported'` items;
- overhead/profit as an imported 20% additive adjustment;
- discount as an imported fixed subtractive adjustment.

Percentage adjustments recalculate from the estimate's current direct-item subtotal. The source snapshot retains the original 20%, ฿179,400 base, and ฿35,880 amount for audit. The fixed discount remains ฿1,280 unless the estimator explicitly edits it.

Estimate totals are calculated in stable adjustment order:

```text
items subtotal
→ percentage/fixed additive adjustments
→ fixed or percentage subtractive adjustments
→ estimate total
```

Manual adjustment edits do not mutate the BOQ or its source evidence.

## 8. Extraction notes presentation

### 8.1 Summary counts

Replace occurrence-led copy such as `29 extraction notes need review` with counts that match user work:

- unique source rows needing review;
- document-level information notes without a source row.

Multiple warning codes on one row count as one affected row. The exact raw warning occurrence count remains available in Technical details.

### 8.2 Sections

Render two sections:

1. **Needs review** — warnings that require correction, confirmation, or source inspection.
2. **Document information** — recognized discounts, adjustments, and other non-blocking source facts.

Once overhead/profit is recovered as a valid adjustment, it is shown in the totals bridge and not as an incomplete row. Once totals reconcile, stale section/document mismatch warnings are not regenerated.

### 8.3 Group labels and locations

- Map the actual emitted code `invalid_numeric_format` to `Unrecognized number format`.
- Map `section_total_mismatch` to `Section total did not reconcile`.
- Preserve existing friendly labels for known codes.
- Unknown codes remain `Other extraction note` but are grouped by code, never merged across distinct unknown codes.
- Compress source locations by page/table into row ranges, for example `Page 2 · rows 3, 6–9, 11–19`.
- Show a bounded location preview and `+ N more` where needed.

### 8.4 Technical details

A collapsed **Technical details** disclosure preserves:

- raw warning code;
- original parser message;
- exact source location;
- total raw occurrence count.

This is audit evidence, not the primary task list.

## 9. Data flow

```text
PDF/source table
  → lossless source rows
  → deterministic direct-item derivation
  → deterministic source-adjustment derivation
  → extraction contract validation
  → canonical BOQ {
       sections: direct items,
       sourceAdjustments,
       grandTotal,
       sourceTotal,
       sourcePayableTotal
     }
  → review verification + totals bridge
  → approved BOQ
  → create estimate
       ├─ direct items → Estimate.items
       └─ source adjustments → Estimate.adjustments
```

The source row is the immutable root of both derived branches.

## 10. Error handling and compatibility

- All new BOQ and extraction fields are optional for legacy reads.
- New extraction writes use the expanded validated contract.
- Existing warning readers remain compatible.
- Existing BOQs are not backfilled or migrated locally; re-extraction is the explicit upgrade path.
- A failed adjustment parse leaves evidence and a blocking review note rather than manufacturing a row.
- A failed Estimator transfer creates neither partial items nor partial adjustments.
- Retrying estimate creation/import is idempotent by BOQ ID plus source item/adjustment identity.
- No production migration runs as part of implementation or validation.

## 11. Testing strategy

Strict RED → GREEN tests cover:

### Parser and contract

- merged `OVERHEAD & PROFIT` label plus amount produces a separate 20% subtotal adjustment;
- direct items remain unchanged and catalog-addressable;
- fixed and percentage adjustments validate exact arithmetic;
- discount becomes a payable-stage subtractive adjustment;
- unlabeled amounts and ambiguous percentage bases fail closed;
- source provenance is preserved;
- quoted subtotal and payable total reconcile exactly;
- adjustment rows do not increase `totalItems`.

### BOQ verification and persistence

- direct items plus subtotal adjustments reconcile to `sourceTotal`;
- payable adjustments reconcile to `sourcePayableTotal`;
- missing or altered adjustments block approval;
- adjustments do not create catalog-readiness blockers;
- approved BOQs reject adjustment mutation;
- legacy BOQs retain current behavior.

### Compare and Estimator

- catalog and vendor item comparisons exclude source adjustments;
- estimate import creates direct items and separate ordered adjustments atomically;
- 20% overhead recalculates after direct-item edits;
- the original source snapshot remains unchanged;
- fixed discount remains negative and fixed;
- retry does not duplicate imported adjustments.

### Extraction notes and UI

- summary counts unique affected source rows rather than warning occurrences;
- actionable and informational notes are separated;
- actual emitted warning codes receive friendly labels;
- compact row ranges are correct and bounded;
- Technical details retain every distinct original message and location;
- totals bridge is responsive and read-only after approval;
- no catalog action is rendered for an adjustment.

### Browser QA

Use sanitized synthetic digital and scanned PDFs at `1280×800` and `390×844`. Verify:

- the direct-item table remains focused on comparable work;
- the totals bridge reconciles direct, subtotal, discount, and payable layers;
- PDF source highlighting reaches the adjustment row;
- extraction notes are concise by default and complete when expanded;
- Estimator receives a recalculating percentage overhead and fixed discount;
- approval and read-only safeguards remain intact.

Never use `Quotation example/` or unsanitized customer documents.

## 12. Out of scope

- Adding overhead/profit to the catalog.
- Comparing overhead percentages as standard work items.
- Automatically inventing adjustments from unexplained total gaps.
- Rewriting existing BOQs without re-extraction.
- General tax, retention, escalation, contingency, or multi-currency engines beyond the source-backed adjustment primitives required here.
- Changing current catalog Exclude semantics.
