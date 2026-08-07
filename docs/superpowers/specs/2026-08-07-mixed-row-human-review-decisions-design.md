# Mixed-row human-review decisions

## Context

The multi-row manual-add workflow originally required one new BOQ item for every source row in a no-draft `needs_human_review` proposal. Read-only QA of BOQ `e262c286-8815-4617-9b96-ebd2734ed450` proved that assumption unsafe.

Proposal `d1` contains ten immutable source rows mixing:

- genuinely missing priced items;
- item rows already represented by current BOQ items;
- unsupported heading text;
- a subtotal; and
- VAT/amount-in-words content misclassified as an item.

The existing batch editor therefore renders **Add 10 BOQ items** and cannot safely submit without inventing values or creating duplicates and summary items.

This design supersedes the all-rows-must-create-items rule in `2026-08-06-multi-row-human-review-batch-design.md`. Its atomicity and provenance requirements remain, but every source row now receives an explicit reviewer decision rather than necessarily producing an item.

## Decisions

- Every proposal source row starts **Undecided**.
- The reviewer explicitly chooses **Add to BOQ** or **Do not add** for every row.
- **Do not add** supports an optional free-text note; no reason is required.
- No parser classification, warning, provider explanation, raw text, or duplicate heuristic preselects a decision.
- The complete ordered decision set is submitted atomically.
- The proposal becomes accepted after every row has a persisted decision, even when no rows are added.
- Proposal-level **Skip** remains the incomplete/exception outcome.
- Automatic **Accept** remains disabled for `needs_human_review`.
- Catalog mutation remains outside extraction review; added items independently expose match/create/**Exclude** later.

## Approaches considered

### Explicit per-row decisions — selected

The reviewer decides every source row. This is safest because live data contains both parser misclassification and semantic duplication that classification alone cannot resolve.

### Automatic filtering

The server would remove totals, unsupported rows, or detected duplicates. This is brittle: the VAT row is classified as `item`, while an existing source line may be represented by several BOQ items without matching provenance IDs.

### Proposal splitting

The review system would split addable and non-addable rows into separate provider proposals. This creates cleaner proposal shapes but adds provider, lifecycle, migration, and cross-proposal consistency complexity without removing the need for human judgment.

## Editor design

`EvidenceOnlyBatchItemEditor` keeps one compact panel per `proposal.sourceRowIds` entry in proposal order.

Each panel initially shows two unselected choices:

- **Add to BOQ**
- **Do not add**

Choosing **Add to BOQ** reveals the existing blank/manual fields:

- destination section;
- description;
- unit;
- quantity;
- material rate; and
- labour rate.

The form reuses the existing source-backed validation, precision, and live-total helpers. No value is initialized from `rawText`, `rawCells`, provider explanations, classifications, or warnings.

Choosing **Do not add** hides item fields and shows an optional note input. Notes are trimmed, limited to 500 characters, and treated only as reviewer-authored audit text.

Changing a row back to **Undecided** or between actions does not submit anything. Cancel discards all in-memory decisions.

Submission is disabled until:

- every proposal row has exactly one action;
- every added row has a valid destination section and valid item fields; and
- every ignored-row note satisfies its length constraint.

The primary action summarizes the pending atomic result:

- mixed: **Add 5 BOQ items · Ignore 5 rows**;
- add-only: **Add N BOQ items**;
- ignore-only: **Ignore N rows**.

The surrounding extraction card retains its source evidence, one **Review & add** entry point, proposal-level **Skip**, history, and read-only behavior.

## Client request contract

Replace the multi-row `{ items }` wire shape with a closed decision union:

```ts
type SourceRowDecisionRequest =
  | {
      sourceRowId: string
      action: "add"
      sectionIndex: number
      item: SourceBackedItemRequest
    }
  | {
      sourceRowId: string
      action: "ignore"
      note?: string
    }

interface SourceBackedDecisionBatchRequest {
  decisions: SourceRowDecisionRequest[]
}
```

The endpoint remains:

`POST /api/boqs/[id]/extraction-runs/[runId]/proposals/[proposalId]/add-source-item`

Existing mapped-draft and one-row evidence-only requests retain their current single-item wire shape. Multi-row no-draft proposals require `{ decisions }`; the former `{ items }` batch shape is rejected rather than interpreted as an implicit add-all decision.

The parser rejects:

- unknown keys;
- empty or oversized decision arrays;
- duplicate source row IDs;
- invalid action discriminators;
- missing or forbidden action-specific fields;
- non-string or overlong notes;
- malformed item fields; and
- non-finite, negative, or excessive-precision numeric values.

## Transaction and provenance

Inside `BoqExtractionProposalStore.addSourceItem`, existing authentication, immutable-context, lifecycle, approved/read-only, stale-fingerprint, and accepted-idempotency checks remain unchanged.

For a multi-row no-draft proposal, the transaction:

1. requires a decision batch;
2. verifies that decision IDs exactly equal `proposal.sourceRowIds` with no missing, duplicate, extra, or unknown row;
3. orders decisions by `proposal.sourceRowIds`, never client order;
4. processes each decision against immutable source rows;
5. creates an item only for `action: "add"`, using that row alone for `sourceRowId`, `[sourceRowId]`, and PDF `sourceRef`;
6. creates nothing for `action: "ignore"`;
7. persists final sections/totals once;
8. writes one accepted audit and lifecycle update; and
9. commits nothing if any validation, item creation, or persistence step fails.

An all-ignore decision set is valid and accepts the proposal with an unchanged BOQ snapshot. It means every row was reviewed and intentionally excluded from the BOQ. Proposal-level **Skip** remains available when the reviewer cannot complete that determination.

Accepted retries return the original accepted result without creating duplicate items or replacing the recorded decisions. Undo reverts only BOQ items created by the accepted decision batch and advances the existing lifecycle normally.

## Audit contract

`ExtractionProposalAudit` gains an optional ordered field so legacy audits remain readable:

```ts
type SourceRowAuditDecision =
  | {
      sourceRowId: string
      action: "add"
      itemId: string
    }
  | {
      sourceRowId: string
      action: "ignore"
      note?: string
    }

sourceRowDecisions?: SourceRowAuditDecision[]
```

New decision-batch audits always include the field in proposal order. Added decisions bind each immutable source row to the resulting BOQ item ID. Ignored decisions preserve the optional trimmed reviewer note. Proposal-level `sourceRowIds` and `sourceRefs` still cover the complete reviewed proposal.

Audit readers accept older records without `sourceRowDecisions`. New audit construction and validation require a complete, unique, exact decision set for this manual decision-batch path.

## Error handling

- A former `{ items }` batch request returns a safe validation error and performs no mutation.
- Missing, duplicate, extra, or unknown decision rows fail before mutation.
- An added row with invalid item or section data identifies the failing row without echoing source text.
- An ignored row with invalid note data fails before mutation.
- Approved, stale, skipped, rejected, undone, or superseded proposals remain blocked.
- Client/server errors preserve in-memory decisions so the reviewer can correct and retry.
- Any transaction failure leaves BOQ sections, totals, audit, and proposal lifecycle unchanged.

## Corrected affected-BOQ disposition

The current BOQ has five items totaling **฿80,584**. Its exact source-total blocker is **฿397,416** against source total **฿478,000**.

The ten-row proposal should be reviewed as follows:

| Source row | Decision | Reason / value |
| --- | --- | --- |
| p.1 t.1 r.5 — STUB-END 6B BS4 | Do not add | Already represented by existing STUB-END and welding items totaling ฿36,864 |
| p.1 t.1 r.7 — ON-OFF VALVE FA-10UBM 6\" | Add | 4 Pcs.; material rate ฿77,200; labour rate ฿2,000; total ฿316,800 |
| p.1 t.1 r.9 — STUD-BOLT M20 | Do not add | Existing item already carries the same immutable source row and totals ฿22,000 |
| p.1 t.1 r.10 — MANUAL VALVE RELOCATION WORK | Add | 4 Lot; material rate ฿0; labour rate ฿1,500; total ฿6,000 |
| p.1 t.1 r.11 — TOOLS AND CONSUMABLE | Add | 1 Lot; material rate ฿6,000; labour rate ฿0; total ฿6,000 |
| p.1 t.1 r.12 — SAFETY COST | Add | 1 Lot; material rate ฿7,000; labour rate ฿0; total ฿7,000 |
| p.1 t.1 r.13 — EXPENSE | Add | 1 Lot; material rate ฿61,616; labour rate ฿0; total ฿61,616 |
| p.1 t.1 r.14 — KITZ heading | Do not add | Unsupported heading, not a priced BOQ line |
| p.1 t.1 r.15 — SUB TOTAL | Do not add | Summary row |
| p.1 t.1 r.16 — BAHT / VAT 7% | Do not add | Amount-in-words and tax summary, outside source subtotal |

The five additions total **฿397,416**, bringing the BOQ to **฿478,000** and clearing `document_total_mismatch` exactly. The action must not approve the BOQ. The five new items remain independently unresolved for catalog readiness until the user matches, creates, or **Exclude**s each item.

## Testing

Test-first coverage must include:

- parsing valid mixed, add-only, and ignore-only decision batches;
- rejecting old implicit add-all batches, unknown keys, invalid actions, duplicates, missing/extra rows, malformed items, and invalid notes;
- exact proposal-row-set validation and proposal-order normalization;
- atomic mixed processing where only added rows create items;
- one-row provenance and returned item IDs in audit decisions;
- ignored rows creating no item and preserving optional trimmed notes;
- all-ignore acceptance with an unchanged BOQ snapshot;
- rollback when any add or ignore decision is invalid;
- accepted retry idempotency and undo of only created items;
- mapped and single-row flows remaining unchanged;
- editor initial undecided state, action switching, blank/manual add forms, optional notes, per-row validation, live totals, and dynamic action copy;
- automatic **Accept** remaining absent;
- desktop and mobile layout without page-level overflow;
- corrected affected-BOQ browser QA with ten explicit decisions, one submission, exact total **฿478,000**, accepted history, reload idempotency, and catalog blockers/**Exclude** controls;
- approval never being triggered automatically.

## Rollout

No stored proposal migration is required. Existing pending mixed proposals are interpreted through their immutable source-row IDs. Existing audits remain valid because `sourceRowDecisions` is optional for legacy actions. Clients with the obsolete `{ items }` multi-row shape receive a safe validation error and must reload before submitting.
