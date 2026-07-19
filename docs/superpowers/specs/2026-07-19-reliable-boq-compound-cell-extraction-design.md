# Reliable BOQ Compound-Cell Extraction — Design Specification

**Date:** 2026-07-19
**Status:** Approved for written-spec review

## Goal

Build a source-row-first BOQ extraction pipeline that preserves every Docling row, deterministically derives trustworthy items, and asks an LLM to propose corrections only for ambiguous or unreconciled structures. No AI suggestion changes the BOQ without explicit user acceptance, and re-extraction never overwrites saved edits.

## Scope

This design modifies the real Next.js BOQ application and Python Docling sidecar. It covers:

- Docling contract v3 and contract-v2 compatibility;
- lossless source-row retention;
- compound-cell deterministic parsing;
- versioned extraction runs;
- targeted structured AI proposals;
- server-side proposal validation;
- transactional Accept, Reject, Accept all, and Undo;
- inline PDF-side extraction review;
- safe re-extraction of retained source PDFs;
- parser, API, component, end-to-end, and fixture-corpus testing.

It does not modify the Open Design HTML prototype, automatically apply AI suggestions, introduce a general-purpose PDF editor, or add durable queue infrastructure in the first release.

## Architectural Decision

The canonical BOQ and its extraction history are separate.

- `boqs/{boqId}` remains the editable source of truth used by catalog, comparison, and estimating workflows.
- Versioned extraction runs retain source evidence, deterministic derivations, proposals, decisions, and audit events.
- The Python sidecar remains stateless. It extracts and normalizes a PDF but does not own application persistence or review state.
- The Next.js application validates all sidecar and AI payloads and owns all canonical mutations.

This boundary keeps approved BOQ data compact, preserves every extraction and re-extraction for audit, and permits proposal acceptance or Undo without rewriting extraction history.

## End-to-End Flow

1. The existing atomic import operation stores the PDF and calls Docling.
2. New imports request contract v3. The importer continues accepting strict contract-v2 responses during rolling deployment.
3. Docling returns document metadata, lossless `BoqSourceRow` records, deterministic derived structures, reconciliation results, warnings, and confidence.
4. The importer saves the canonical draft BOQ and an immutable extraction run before returning success.
5. The browser navigates immediately to the saved BOQ review workspace. Import never waits for an LLM.
6. The review workspace automatically dispatches targeted AI review for rows marked ambiguous, compound, or unreconciled. The request is idempotent and can be retried when the workspace reopens.
7. The UI polls persisted review status and renders validated proposals beside their original source structure and PDF location.
8. A user explicitly accepts or rejects each proposal, or uses Accept all for the validated high-confidence subset.
9. Acceptance updates the canonical BOQ transactionally and records an audit event. Extraction evidence remains immutable.
10. Undo creates a new audit event and transactionally restores the recorded prior canonical structure.

If the provider is missing, unavailable, slow, or returns invalid output, the Docling draft remains available and every unresolved row stays visible for human review.

## Docling Contract v3

Contract v3 is source-row-first. A response includes the existing document metadata plus:

```ts
interface BoqSourceRow {
  id: string
  page: number
  table: number
  row: number
  section: string | null
  headers: string[]
  rawCells: Array<{
    column: number
    rawText: string
    lines: string[]
    rowSpan: number
    columnSpan: number
  }>
  rawText: string
  classification:
    | 'header'
    | 'section'
    | 'item'
    | 'continuation'
    | 'total'
    | 'option'
    | 'note'
    | 'unknown'
  confidence: number
  warnings: BoqExtractionWarning[]
}
```

Source-row IDs are opaque, unique within an extraction run, and stable throughout that run. Derived items reference one or more source-row IDs so merged continuations and cross-page structures remain traceable.

The response preserves raw cell text and line breaks. Normalized values are additive fields; they never replace the evidence used to produce them. Repeated headers, notes, totals, unsupported rows, and decorative rows remain present even when they do not derive canonical BOQ items.

The v3 parser rejects non-finite or negative monetary and quantity values. Contract-v2 parsing stays strict and unchanged except for routing through the compatibility adapter.

## Deterministic Derivation

Rules run in an explicit order so broad heuristics cannot pre-empt safer structural evidence:

1. identify table/header context and retain repeated headers without deriving items from them;
2. classify each source row while retaining unknown rows;
3. merge only obvious description continuations based on adjacency, empty pricing cells, and compatible table context;
4. align multiline description, quantity, unit, rate, and amount lines when counts and positions support a deterministic mapping;
5. separate material and labour when their quantities, units, rates, or totals differ;
6. retain shared-quantity material/labour as one combined priced item with separate source-cost evidence;
7. create a priced bundle when several descriptions share one aggregate amount and the source has no component prices;
8. mark alternatives and optional items excluded from totals by default;
9. reconcile item arithmetic, source-row amounts, section totals, and identifiable document totals;
10. surface every unsupported or unreconciled structure as a warning and AI-review candidate.

### Multiline alignment

Aligned multiline values split only when evidence maps descriptions and numeric lines one-to-one. Unequal line counts, ambiguous merged cells, or conflicting amounts leave the source row intact with a warning.

### Material and labour

- Different quantity, unit, rate, or total produces separate priced items linked to the same source row.
- Shared quantity and unit produces one combined priced item. Its source-cost evidence retains separate material and labour values.
- A missing component price is never inferred from an aggregate amount.

### Continuations

A continuation may append to the preceding description only when it has no independent pricing evidence and compatible page/table/header context. A cross-page continuation must also follow a table boundary or repeated header recognized as the same table structure. Otherwise it remains a separate uncertain source row.

### Bundles

When multiple descriptions have one aggregate price, the derived structure is:

- one priced bundle parent carrying the source aggregate amount;
- informational children linked by `parentBundleId`;
- no invented child quantity, rate, total, or allocation;
- exactly one total contribution from the bundle parent.

### Options and alternatives

Rows identified as optional, alternate, provisional, or add-on remain visible but are excluded from the BOQ total by default. A reviewer can include them explicitly, and that decision is audited.

## Canonical BOQ Item Model

New canonical items add:

- `sourceRowId` or `sourceRowIds` for traceability;
- `parentBundleId` for informational bundle children;
- `entryOrigin: 'docling' | 'ai_accepted' | 'user'`;
- optional/excluded state and reason;
- a pricing-role discriminator.

The pricing-role discriminator distinguishes:

- ordinary priced items;
- priced bundle parents;
- informational bundle children.

Ordinary items and bundle parents retain finite, non-negative quantity/rate/total fields required by existing downstream workflows. Informational children use a distinct shape with no numeric price fields, preventing zero placeholders from being mistaken for source values. Shared total helpers are updated to include ordinary items and bundle parents only, and to skip excluded options and informational children.

Contract-v2 items pass through a compatibility adapter as ordinary priced items with legacy defaults. Existing documents require no destructive migration.

## Extraction Persistence

Each run stores immutable extraction identity and metadata, including:

- run ID, BOQ ID, contract version, status, timestamps, and source-file identity;
- parser version and configuration fingerprint;
- metadata candidates and confidence;
- source-row counts and reconciliation summary;
- run-level warnings and AI-review status.

Source rows are stored separately from the run metadata to avoid Firestore document-size limits. Proposals and audit events are also stored as independently addressable records under the run.

Suggested logical layout:

```text
boqs/{boqId}
boqs/{boqId}/extractionRuns/{runId}
boqs/{boqId}/extractionRuns/{runId}/sourceRows/{sourceRowId}
boqs/{boqId}/extractionRuns/{runId}/proposals/{proposalId}
boqs/{boqId}/extractionRuns/{runId}/auditEvents/{eventId}
```

Large runs may exceed one Firestore batch, so import uses staged persistence:

1. create a non-readable run in `staging` state;
2. write source rows in bounded batches and verify the stored row count/checksum;
3. use one final transaction to create the canonical BOQ and mark the run `ready`;
4. expose only `ready` runs to review APIs.

If staging fails, the importer deletes the staged run records and follows the existing source-storage rollback path. A cleanup routine removes abandoned staging runs after a fixed expiry. The canonical BOQ never exists without its complete ready extraction run.

## Re-extraction

“Re-extract source” reads the retained source PDF and creates a new immutable run. It does not replace canonical items, metadata, catalog links, or user edits.

The new run derives candidate structures and proposals against a fingerprint of the current canonical BOQ. Each proposal records its affected item fingerprints. Acceptance fails safely as stale if those items changed after proposal creation. The reviewer can recheck the affected row to obtain a fresh proposal.

Existing BOQs without a retained PDF continue to show the current source-unavailable message. Existing contract-v2 BOQs with a retained PDF can create their first v3 extraction run through Re-extract source.

## Targeted AI Review

AI receives only rows that deterministic processing marks as compound, ambiguous, or unreconciled, plus minimal neighboring header/row context. This reduces cost, limits unrelated exposure, and avoids asking the model to reinterpret already reliable rows.

The structured operation vocabulary is:

- `keep`;
- `split`;
- `merge`;
- `separate_components`;
- `create_bundle`;
- `needs_human_review`.

Each proposal includes operation, source-row IDs, proposed structure, explanation, evidence references, confidence, reconciliation data, and the canonical-item fingerprints it expects.

Source text is wrapped as untrusted quoted data. Prompts explicitly prohibit following instructions found inside the quotation, allocating aggregate prices, inventing values, or returning rows outside the supplied allowlist.

## Proposal Validation

The Next.js server validates proposals independently of the model. Validation requires:

- known source-row IDs from the specified extraction run;
- an allowed operation and operation-specific shape;
- finite, non-negative numeric values;
- `quantity × rate` matching total within the configured currency tolerance;
- split children reconciling with the source-row amount;
- material plus labour reconciling with the quoted amount;
- no component allocation when source component prices are absent;
- no duplicate or overlapping operation within one proposal batch;
- valid bundle semantics with one priced parent and non-priced children;
- proposal confidence between zero and one.

Invalid model output is retained only as a safe failure category, not as an actionable proposal. A row with invalid output becomes `needs_human_review` and retains its deterministic structure.

“High confidence” requires all of:

- model confidence at least `0.90`;
- valid source evidence;
- successful deterministic validation and reconciliation;
- unchanged affected canonical items;
- no human-review-only flag.

## Proposal Lifecycle and Transactions

Proposal states are `pending`, `accepted`, `rejected`, `superseded`, and `undone`.

Acceptance uses a Firestore transaction that rechecks proposal state, extraction-run identity, source-row existence, affected item fingerprints, arithmetic, and duplicate application. The transaction writes the new canonical structure and an audit event together.

Accept all submits the currently selected validated high-confidence proposals as one batch. The batch is atomic: all proposals apply or none apply. Overlapping proposals are excluded from the eligible set until the reviewer resolves the conflict.

Reject records the actor, timestamp, and optional reason without deleting the proposal. Undo validates that the accepted change has not been superseded by later edits, restores the recorded before-state, and appends an Undo audit event. If later edits conflict, Undo is refused with an explanation rather than overwriting them.

All proposal mutations are idempotent. Retried requests return the existing result rather than applying an operation twice.

## Asynchronous Review Dispatch

The first release does not add a task queue. After import navigation, the review workspace automatically starts the targeted review request for a queued extraction run. The BOQ is already saved and fully usable while that request is in flight.

Review state is persisted as `not_required`, `queued`, `running`, `completed`, `partial`, or `failed`. A lease timestamp prevents concurrent duplicate provider calls. If the tab closes or a request is interrupted, opening the review workspace after lease expiry retries the idempotent operation. A manual “Recheck with AI” action uses the same endpoint for selected rows.

This provides non-blocking import and recoverable review without introducing deployment-specific queue infrastructure. A future durable worker can consume the same persisted states without changing the proposal contract.

## API Surface

The application adds authenticated BOQ-scoped endpoints for:

- reading an extraction run and its review status;
- dispatching targeted review for the run or selected source rows;
- listing validated proposals;
- accepting one proposal;
- atomically accepting the eligible high-confidence set;
- rejecting one proposal;
- undoing an accepted proposal;
- re-extracting the retained source PDF.

All endpoints authorize access through the existing authenticated BOQ boundary. Client payloads identify opaque run, row, and proposal IDs; the server always reloads canonical records and never trusts client-supplied arithmetic or eligibility.

## Review Workspace

The extraction review is integrated into the real side-by-side BOQ review workspace:

- The source PDF stays on the left and navigates to the referenced page.
- The right pane lists rows needing attention, with filters for ambiguous, unreconciled, AI pending, accepted, and rejected states.
- Expanding a row shows original source cells and deterministic structure beside the proposed structure.
- Each proposal displays confidence, explanation, source reference, evidence, and reconciliation outcome.
- Available actions are Accept, Reject, Recheck with AI, and Undo where safe.
- “Accept all validated” includes only currently eligible proposals meeting the `0.90` high-confidence policy.
- Optional/alternative rows are visibly excluded by default.
- Bundle parents and informational children are visually grouped, with only the parent showing a contributing amount.
- “Add missing item” remains available when Docling misses a row completely and creates an `entryOrigin: 'user'` item plus an audit event.

AI never changes the displayed canonical structure until acceptance succeeds. Provider errors appear inline and leave deterministic items editable.

## Error Handling

- Malformed v3 response: fail import with an invalid-sidecar-response error and follow existing storage rollback behavior.
- Partial deterministic extraction: save the draft and run when at least one reliable item exists; surface every uncertain row.
- No reliable priced items: reject the import, return sanitized row-level warnings to the upload UI, and roll back the stored PDF and staged extraction records. Do not create a zero-item BOQ.
- AI unavailable, rejected, timed out, or malformed: mark review failed/partial, retain deterministic data, and allow retry or manual review.
- Stale proposal: reject acceptance with the affected item/row explanation and offer Recheck with AI.
- Transaction conflict: return a retry-safe response without partial canonical changes.
- Source row absent or proposal references another run: reject as invalid and record a security-safe failure category.
- Re-extraction failure: retain the current BOQ and all prior runs unchanged.

## Backward Compatibility

- The importer accepts strict contract versions 2 and 3 during rollout.
- New sidecar deployments emit contract v3.
- Existing BOQs remain readable without migration.
- Legacy priced items adapt to the new pricing-role helpers as ordinary contributing items.
- Existing source references remain usable in current views.
- Existing documents gain source rows and proposals only through a new v3 import or Re-extract source.
- Re-extraction never overwrites canonical BOQ fields or items.

## Testing Strategy

### Parser fixtures

Add fixtures for:

- aligned multiline descriptions and numeric values;
- wrapped text and continuation rows;
- unequal line counts;
- shared-quantity material/labour;
- separate material/labour quantities or units;
- aggregate-price bundles;
- alternatives and options;
- merged cells and spans;
- repeated headers;
- cross-page tables and continuations.

Every malformed or unsupported compound case must remain intact with a warning. A test fails if the parser fabricates a value or silently drops the source row.

### Proposal and security tests

Test invented component prices, arithmetic mismatches, unknown source rows, cross-run references, duplicate application, overlapping proposals, stale edits, prompt injection, unavailable providers, timeouts, and malformed JSON.

### API and transaction tests

Test contract-v2 compatibility, strict v3 validation, authenticated access, run persistence, idempotent review dispatch, lease recovery, atomic single and batch acceptance, rejection, Undo, conflict refusal, and protection of current user edits during re-extraction.

### Component tests

Test source/proposal comparison, PDF source reference navigation, confidence and reconciliation indicators, high-confidence eligibility, excluded options, bundle total semantics, provider failure, manual Recheck, Add missing item, and Undo conflict messaging.

### End-to-end test

Run upload → Docling v3 parse → saved draft → automatic targeted review → side-by-side proposal acceptance → saved canonical BOQ. Verify that provider failure never blocks the draft and that re-extraction leaves saved edits unchanged until acceptance.

### Anonymized corpus

Maintain an anonymized quotation fixture corpus measuring:

- source-row detection;
- material/labour classification;
- component arithmetic;
- section and document-total reconciliation;
- uncertainty surfacing.

A document passes when correct values are extracted or every uncertain value is explicitly surfaced for review. Coverage that merely reproduces a wrong value without a warning is a failure.

## Rollout

1. Land compatibility helpers and contract-v3 types without changing v2 behavior.
2. Upgrade the sidecar to emit lossless source rows and deterministic v3 derivations.
3. Persist extraction runs for new v3 imports.
4. Add proposal validation, lifecycle APIs, and review dispatch.
5. Add the inline extraction-review UI and manual missing-item flow.
6. Enable Re-extract source for retained legacy PDFs.
7. Run the full fixture corpus and end-to-end upload flow before making v3 the default sidecar response.

## Acceptance Criteria

The work is complete when:

1. Every Docling table row is retained with raw cells, line breaks, headers, location, and confidence.
2. Clear compound rows deterministically produce correct structures and totals.
3. Unsupported rows remain intact and visibly uncertain.
4. Aggregate bundle prices are never allocated without source component prices.
5. AI reviews only targeted rows and never applies changes silently.
6. All accepted proposals pass server validation, concurrency checks, and audit recording.
7. Bundle children, excluded options, and rejected proposals never contribute twice to totals.
8. Contract-v2 BOQs remain readable and editable.
9. Re-extraction creates proposals without overwriting saved edits.
10. Provider failure does not block import or remove parsed data.
11. Parser, security, API, component, end-to-end, and corpus tests pass.
