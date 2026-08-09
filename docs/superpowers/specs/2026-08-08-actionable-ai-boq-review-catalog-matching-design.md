# Actionable AI BOQ Review and Catalog Matching — Design

**Date:** 2026-08-08

**Status:** Approved in brainstorming; awaiting written-spec review

**Scope:** PDF extraction exception review, catalog-aware suggestions, deterministic unit normalization, and minimum-cost AI routing

## 1. Summary

BuildEstimate will replace proposal-card sprawl with a focused review experience that shows only likely missing BOQ items requiring a human decision.

The parser still preserves every source row. Deterministic rules hide obvious non-items such as headers, notes, repeated labels, subtotals, totals, VAT, and amount-in-words. Existing-item reconciliation removes rows already represented by the draft BOQ. AI reviews only the remaining ambiguous rows.

For each likely missing item, the system checks the catalog before showing the suggestion. It first uses approved mapping history, exact aliases, local fuzzy matching, unit compatibility, and configured conversion rules. AI is called only when these local methods leave an ambiguous shortlist. The reviewer sees editable fields, source evidence, the proposed catalog relationship, and one of two safe paths:

- **Add & match** when an existing catalog item is suitable.
- **Add to BOQ** when no safe catalog match exists; catalog creation remains a separate readiness step before approval.

Every likely missing item still requires an explicit human **Add** or **Do not add** decision. AI never adds an item automatically and never invents quantities, rates, totals, or conversion factors.

## 2. Goals

1. Show reviewers only actionable likely-missing-item suggestions.
2. Hide useless extracted rows from the normal workflow while retaining an inspectable audit trail.
3. Reduce manual catalog matching by preparing existing-item matches before a missing BOQ item is added.
4. Normalize names, units, quantities, and unit rates without changing the quoted source total.
5. Preserve both immutable source values and normalized catalog values.
6. Minimize AI cost through local matching, batching, caching, and escalation only for ambiguity.
7. Preserve existing provenance, atomicity, reconciliation, catalog-readiness, and approval safeguards.
8. Support mixed digital and scanned PDFs, primarily under 100 BOQ rows.

## 3. Non-goals

1. AI will not automatically add a likely missing item to a BOQ.
2. AI will not create or change unit-conversion factors.
3. AI will not replace quoted prices with catalog or historical prices.
4. BOQ approval will not bulk-create catalog entries; current catalog-readiness semantics remain.
5. The first release will not replace the complete proposal persistence and audit engine.
6. The first release will not attempt a full document-graph rewrite.
7. Headers, notes, totals, and other dismissed evidence will not be deleted.

## 4. Research findings

### 4.1 Industry patterns

Reliable construction and document-AI systems consistently separate extraction from approval:

1. Preserve the original document and visual provenance.
2. Normalize extraction into typed rows and cells.
3. Apply deterministic structural and arithmetic checks before AI.
4. Use confidence and disagreement to route exceptions to human review.
5. Keep the application—not the model—as the owner of review-queue structure.
6. Treat catalog/rate-book mapping as an auditable decision.
7. Preserve model output and human revisions separately.

Commercial takeoff products such as Togal.AI, Kreo, and RIB CostX market AI-assisted measurement and estimating, but their practical workflows retain estimator review, assemblies/rate libraries, and source-linked correction rather than unattended final BOQ publication.

### 4.2 Document AI

- AWS Textract represents tables using cells, geometry, row/column indexes, spans, and semantic table roles.
- Google Document AI provides structured rows, spans, text anchors, evaluation metrics, and processor-version management.
- Azure Document Intelligence provides text spans, polygons, and word confidence; field confidence must be calibrated for each document class.
- Docling preserves page/table provenance and supports complex table extraction; TableFormer addresses merged, borderless, multiline, and complex-header tables.
- Confidence is not a universal truth. Thresholds must be calibrated against labeled BuildEstimate BOQs and combined with deterministic validation.

### 4.3 BOQ domain modeling

RICS NRM and ICMS treat BOQs as hierarchical, typed documents containing measured work, preliminaries, allowances, summaries, taxes, and other non-item roles. Subtotals and taxes are valid source evidence but must not be converted into ordinary priced items. Units, classifications, allowances, taxes, and source totals require explicit modeling rather than flat-table assumptions.

### 4.4 Key sources

- RICS NRM: <https://www.rics.org/profession-standards/rics-standards-and-guidance/sector-standards/construction-standards/nrm>
- ICMS 3: <https://icms-coalition.org/wp-content/uploads/2022/06/icms_3rd_edition_final.pdf>
- AWS Textract tables: <https://docs.aws.amazon.com/textract/latest/dg/how-it-works-tables.html>
- AWS Textract Block API: <https://docs.aws.amazon.com/textract/latest/APIReference/API_Block.html>
- AWS A2I: <https://docs.aws.amazon.com/sagemaker/latest/dg/a2i-textract-task-type.html>
- Azure Document Intelligence response model: <https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/concept/analyze-document-response>
- Google Document AI evaluation: <https://docs.cloud.google.com/document-ai/docs/evaluate>
- Google Document schema: <https://docs.cloud.google.com/document-ai/docs/reference/rest/v1/Document>
- Docling document model: <https://docling-project.github.io/docling/reference/docling_document/>
- TableFormer: <https://arxiv.org/abs/2203.01017>
- Trimble estimate verification: <https://help.trimble.com/doc/procontractor/procontractor/estimating/estimating/estimating-tasks/estimate-tab/verify-the-estimate/verify-the-estimate>
- Autodesk cost validation: <https://help.autodesk.com/cloudhelp/ENU/Fabrication-UsersGuide/files/GUID-4CB9D6BE-11C1-4770-9889-DC4E3E601C73.htm>
- Buildxact assemblies: <https://help.buildxact.com/en/articles/2997432-creating-and-loading-assemblies-recipes>

## 5. Existing BuildEstimate findings

### 5.1 Strengths to preserve

- Source PDF, extraction runs, source rows, and cell provenance are durable.
- AI extraction review proposes changes but does not mutate the BOQ directly.
- `needs_human_review` proposals cannot be automatically accepted.
- Source-backed additions preserve row-level provenance.
- Mixed decision batches are exact-row-set, atomic, ordered, and audited.
- `document_total_mismatch` is a deterministic approval blocker.
- Priced BOQ items must be catalog-matched or explicitly Excluded before approval.
- Approved BOQs are read-only.

### 5.2 Main weaknesses

1. **Provider-controlled proposal cardinality.** The same source problem can become one mixed proposal or many single-row proposals.
2. **Proposal-centric UI.** A BOQ with sixteen single-row proposals produces sixteen Review & Add / Skip cards.
3. **No server-owned grouping/projection.** Validated non-overlapping AI proposals are stored individually; the server does not coalesce or normalize them into a stable application queue.
4. **No real unit conversion.** Current unit handling supports aliases and canonical equality, not conversion factors.
5. **Unsafe semantics if conversion were added naively.** Current catalog acceptance applies the catalog description and unit but leaves quantity and rate unchanged.
6. **Catalog schema lacks conversion rules.** `StandardEntry` has a name, unit, aliases, source links, and historical pricing, but no global or item-specific conversion definitions.
7. **AI catalog suggestions are row-by-row.** Current optional LLM standardization can cause avoidable request cost.
8. **No operational calibration loop.** The system has strong tests but limited production metrics for review time, acceptance rate, false dismissals, or AI cost.

### 5.3 Current approval-to-catalog lifecycle

The existing safe lifecycle remains:

```text
Extract and correct BOQ
  → resolve catalog readiness per priced item
      → match existing catalog item
      → create and link new catalog item
      → or Exclude
  → approve BOQ
```

Approval verifies totals and readiness, then changes status. It does not create catalog records. The current success message that says the BOQ was “approved and linked” is misleading because linking already occurred.

## 6. Approved product decisions

1. Normal review shows only actionable likely-missing-item suggestions.
2. Dismissed rows remain hidden by default in a collapsed audit drawer.
3. Automatic behavior uses balanced guardrails.
4. Likely missing items always require explicit human Add or Do not add.
5. OCR/source verification and catalog readiness remain two stages in one workspace.
6. The workflow is optimized for mixed PDFs under 100 rows.
7. Global and catalog-item-specific conversion rules are supported.
8. Source and normalized values are both preserved.
9. Quoted source totals remain authoritative; catalog historical pricing is comparison-only.
10. A safe existing catalog candidate supports one-action **Add & match**.
11. If no safe candidate exists, **Add to BOQ** creates only the draft BOQ item; catalog creation/linking occurs in Stage 2 before approval.
12. AI uses a local-first, cached, one-batch strategy with optional escalation.
13. Rollout begins in shadow mode.

## 7. Target architecture

### 7.1 Application-owned actionable review projection

Add an application-owned `ActionableReview` projection over existing extraction rows, deterministic findings, BOQ items, catalog entries, and validated AI proposals.

The projection defines stable reviewer work independently of AI proposal IDs or grouping. Existing proposal persistence remains the durable proposal/audit engine during migration.

```text
Source rows
  + parser classifications/warnings
  + deterministic reconciliation
  + current BOQ items
  + active catalog and conversions
  + validated AI advice
        ↓
ActionableReview
  ├─ actionableItemSuggestions[]
  ├─ dismissedEvidence[]
  ├─ representedRows[]
  ├─ validationSummary
  └─ versions/fingerprints
```

### 7.2 Deterministic row triage

Every source row receives a role:

- `priced_item`
- `continuation`
- `section_header`
- `column_header`
- `note`
- `subtotal`
- `total`
- `tax`
- `amount_in_words`
- `blank_or_noise`
- `uncertain`

Rules handle cases that can be proven structurally or arithmetically. Dismissed rows are retained with reason codes and source references. Uncertain or priced-looking rows proceed to represented-item reconciliation.

Deterministic triage must be conservative. If classification affects a priced amount and cannot be proven, the row remains eligible for AI review.

### 7.3 Existing-item reconciliation

Before suggesting a new item, compare source rows with current BOQ items using:

1. immutable source row IDs,
2. prior accepted audit decisions,
3. section/table context,
4. normalized description and code,
5. canonical or convertible unit,
6. quantity, rates, and total,
7. duplicate/continuation relationships.

Rows already represented by the BOQ are removed from the actionable queue and retained in audit metadata.

### 7.4 Catalog shortlisting

For each remaining possible missing item:

1. reuse an approved mapping cache,
2. search exact normalized names and aliases,
3. apply current local fuzzy matching,
4. reject incompatible units,
5. evaluate configured global and catalog-item conversion rules,
6. preserve at most three safe candidates for AI or human review.

The shortlist includes stable catalog IDs and concise metadata. It never sends the entire catalog to AI.

### 7.5 Batched AI review

Only ambiguous rows are included in one structured AI request per extraction review. AI can recommend:

- `match` with an existing catalog ID,
- `create` with proposed descriptive metadata,
- `dismiss`,
- `uncertain`.

AI may provide a short reason and confidence. It cannot provide:

- quantities,
- monetary values,
- totals,
- conversion factors,
- catalog IDs not included in the shortlist.

The application validates every response against source evidence, catalog versions, and exact allowlists.

### 7.6 Focused human review

The reviewer sees only `match`, `create`, or `uncertain` rows that could represent missing BOQ items. A selected suggestion shows:

- PDF/page source evidence,
- why the row is actionable,
- editable BOQ fields,
- proposed BOQ section,
- existing catalog match or pending-new-item proposal,
- deterministic conversion explanation,
- source total and normalized total,
- catalog historical-price comparison.

Actions:

- **Add & match**
- **Add to BOQ**
- **Find another**
- **Do not add**

The collapsed audit drawer exposes dismissed, represented, and non-item rows and permits restoring a row to actionable review.

### 7.7 Catalog readiness stage

After extraction suggestions are resolved:

- Existing safe matches added through **Add & match** are already ready.
- New items added through **Add to BOQ** remain catalog-pending.
- Existing imported BOQ items use the same local-first catalog suggestion engine.
- Stage 2 shows only catalog-pending items.
- Cached AI metadata pre-fills new catalog name, canonical unit, category, and aliases.
- The reviewer chooses **Create & link**, **Find existing**, or **Exclude**.

No additional AI call is needed when Stage 1 already produced valid cached metadata for the same item/catalog/conversion versions.

### 7.8 Approval

Approval remains status-only. It requires:

- no pending extraction suggestions,
- source totals reconciled,
- deterministic verification clean,
- no unsaved edits,
- each catalog-priced item matched or Excluded.

Approval does not create catalog entries. New entries must be created and linked during Stage 2.

## 8. Data model

### 8.1 Actionable item suggestion

```ts
type ActionableItemSuggestion = {
  id: string
  extractionRunId: string
  sourceRowIds: string[]
  sourceCellRefs: SourceCellRef[]
  rowRole: RowRole
  deterministicReasons: string[]
  suggestedSectionIndex: number
  sourceItem: SourcePricingSnapshot
  catalogCandidates: CatalogCandidateSnapshot[]
  aiAdvice?: {
    decision: 'match' | 'create' | 'dismiss' | 'uncertain'
    catalogId?: string
    proposedCatalogMetadata?: ProposedCatalogMetadata
    confidence: number
    reason: string
  }
  normalization?: PricingNormalization
  status: 'pending' | 'added_matched' | 'added_pending_catalog' | 'dismissed' | 'stale'
  versions: SuggestionVersions
}
```

Names are illustrative; implementation may reuse existing domain types where boundaries remain clear.

### 8.2 Source and normalized pricing

Preserve immutable source pricing and deterministic normalized pricing:

```ts
type SourcePricingSnapshot = {
  description: string
  unit: string
  quantity: DecimalString
  materialRate: DecimalString
  labourRate: DecimalString
  total: DecimalString
}

type PricingNormalization = {
  catalogId: string
  catalogDescription: string
  catalogUnit: string
  ruleId: string
  catalogUnitsPerSourceUnit: DecimalString
  normalizedQuantity: DecimalString
  normalizedMaterialRate: DecimalString
  normalizedLabourRate: DecimalString
  normalizedTotal: DecimalString
}
```

For factor `f = catalogUnitsPerSourceUnit`:

```text
normalized quantity = source quantity × f
normalized component rate = source component rate ÷ f
normalized total = normalized quantity × sum(normalized component rates)
```

The source and normalized totals must agree at the workspace currency minor-unit boundary. Decimal arithmetic is mandatory.

### 8.3 Conversion registry

Two rule families:

1. **Global conversion rules** for universal dimensions and aliases.
2. **Catalog-item conversion rules** for packaging or product-specific units.

Each rule stores:

- stable ID,
- source unit,
- catalog unit,
- exact factor,
- scope,
- catalog ID when item-specific,
- effective version,
- actor and approval timestamp,
- active/archived status.

AI can select an existing rule but cannot author or change its factor. A new product-specific factor requires explicit human confirmation before reuse.

### 8.4 Mapping cache

Cache keys include:

```text
normalized source signature
+ supplier/workspace scope where applicable
+ catalog version
+ conversion-rule version
+ prompt version
+ model version
```

Human-approved mappings take priority over model-only advice. Archived catalog entries or conversion rules invalidate affected cache entries.

### 8.5 Audit separation

Persist separately:

- raw parser output,
- deterministic classification,
- local catalog candidates,
- AI advice,
- reviewer-authored edits,
- reviewer decision,
- applied normalized values,
- catalog action,
- approval event.

AI advice is never treated as the reviewer decision.

## 9. Minimum-cost AI design

### 9.1 Zero-AI path

Run locally:

1. deterministic row triage,
2. represented-row detection,
3. prior approved mapping lookup,
4. exact name and alias match,
5. canonical-unit check,
6. known conversion-rule check,
7. fuzzy candidate ranking.

Exact/approved cases require no AI. The UI may still require human confirmation for likely missing items.

### 9.2 Compact prompt

For ambiguous rows only, send:

- source row ID,
- concise source description and unit,
- structural context needed to distinguish item/non-item,
- no more than three candidate catalog entries,
- known compatible conversion-rule IDs,
- explicit closed response schema.

Do not send the full catalog or full PDF text.

### 9.3 Batched routing

- One normal AI request per BOQ review.
- A low-cost model handles the initial batch.
- Only `uncertain` rows may be escalated to a stronger model.
- Set configurable row, token, and monetary-budget limits.
- If AI is unavailable or over budget, local candidates and manual search remain usable.

### 9.4 Reuse

Repeated supplier descriptions and approved catalog mappings should become zero-AI on later BOQs unless catalog or conversion versions change.

## 10. UI design

### 10.1 Review summary

After extraction:

```text
7 existing BOQ items verified
4 catalog matches prepared locally
3 possible missing items need review
18 non-item rows dismissed
Source total difference: ฿42,000
```

### 10.2 Suggestion list

The suggestion list shows only likely missing items. Each row includes source location, suggested action, confidence, source amount, and catalog state.

### 10.3 Suggestion detail

The detail panel shows:

- highlighted PDF source row,
- editable BOQ fields,
- AI/local explanation,
- existing catalog candidate when available,
- known conversion rule and arithmetic,
- normalized source rate versus historical catalog median,
- action buttons.

Historical pricing is advisory. It never replaces the source quote.

### 10.4 Hidden audit drawer

The drawer groups hidden evidence by reason:

- structural headers,
- notes/continuations,
- summaries/taxes,
- already represented items,
- AI-dismissed ambiguous rows.

Reviewers may inspect provenance and restore a row to the actionable queue.

### 10.5 Catalog stage

Catalog-pending items show prefilled create/link metadata. The current `Exclude` wording and semantics remain unchanged.

## 11. Atomicity and failure handling

1. **Add & match** creates the BOQ item, source provenance, normalized pricing, catalog link, source-item history, and audit event atomically.
2. **Add to BOQ** creates the BOQ item, source provenance, pending catalog state, and audit event atomically.
3. **Do not add** creates no item and records the human disposition.
4. AI failure does not block local candidates or manual review.
5. Unknown conversion disables acceptance until the reviewer selects or confirms a valid rule.
6. Source/normalized total mismatch disables acceptance and shows exact arithmetic.
7. Stale suggestions are disabled and regenerated.
8. Archived or changed catalog candidates trigger refresh.
9. Transaction failure leaves the editor and reviewer inputs intact.
10. Duplicate submissions are idempotent.
11. Concurrent BOQ, catalog, or conversion changes are guarded by revision/fingerprint checks.
12. Approved BOQs remain immutable.

## 12. Module boundaries

Introduce small focused modules rather than expanding existing god nodes:

- row-role classification
- actionable-review projection
- represented-row reconciliation
- catalog candidate shortlisting
- conversion registry and decimal normalization
- AI request/response contract
- suggestion persistence and application
- metrics and shadow comparison

Keep UI projection logic out of `boq-extraction-proposal-store.ts` and keep conversion arithmetic out of React components. Existing proposal store and acceptance logic remain authoritative during migration.

## 13. Testing strategy

### 13.1 Deterministic triage

- headers, notes, repeated labels, subtotals, totals, VAT, and amount-in-words stay out of normal review,
- continuation rows attach correctly,
- uncertain priced-looking rows remain actionable,
- dismissed rows retain provenance and can be restored.

### 13.2 Catalog matching

- exact aliases resolve locally,
- fuzzy ranking distinguishes size/class/material,
- incompatible units are rejected,
- global and item-specific conversions use exact factors,
- source and normalized totals remain equal,
- archived candidates and rules invalidate caches.

### 13.3 AI contract

- only shortlisted catalog IDs are accepted,
- AI numeric values and conversion factors are rejected,
- malformed responses fail closed,
- one request batches ambiguous rows,
- provider unavailability uses local/manual fallback.

### 13.4 Persistence

- Add & match is atomic,
- Add to BOQ remains catalog-pending,
- Do not add creates no item,
- staleness and duplicate submission are enforced,
- approved BOQs cannot mutate.

### 13.5 End-to-end

Use sanitized fixtures for mixed digital/scanned PDFs. Verify:

- actionable suggestions are substantially fewer than raw rows,
- useless rows never appear in normal review,
- highlighted source evidence is correct,
- quoted total is preserved across normalization,
- catalog readiness still blocks approval,
- reload/retry is idempotent,
- responsive review remains usable at mobile widths.

## 14. Rollout

### Phase 0 — Instrumentation and sanitized fixtures

Capture anonymized structural review snapshots and establish baseline metrics without using sensitive source documents.

### Phase 1 — Shadow mode

Generate actionable review projections alongside the current UI. Do not expose or apply the new decisions. Compare:

- suggested missing items,
- false dismissals,
- catalog candidates,
- conversion validity,
- projected review actions,
- estimated AI cost.

### Phase 2 — Focused review behind a workspace flag

Enable the new actionable suggestion UI while retaining old proposal history and server safeguards.

### Phase 3 — Catalog-aware one-action matching

Enable Add & match and conversion-aware normalization after shadow metrics and conversion tests pass.

### Phase 4 — Default workflow and cleanup

Make focused review the default. Retire old proposal-card routing only after operational metrics remain stable.

## 15. Success metrics

Initial targets:

- at least 70% of catalog candidate preparation resolved without AI,
- normally one AI request per BOQ review,
- zero AI-authored monetary values or conversion factors,
- at least 50% fewer reviewer actions than proposal-card review,
- no increase in source-total mismatch escapes,
- tracked rates for accepted unchanged, edited, dismissed, restored, and incorrect suggestions,
- measured review time and AI cost per BOQ.

Thresholds become more automatic only after labeled data proves safe precision and recall.

## 16. Open implementation sequencing

The design is complete. Detailed file-level sequencing, migrations, compatibility handling, test order, and rollout flags will be defined in a separate implementation plan after the user approves this written specification.
