# Source-backed AI extraction recovery

## Problem

The quotation `a36c0daa-bd18-46db-9120-c404c46f6de1` contains seven valid priced rows totaling ฿80,640. Its two-level header uses this shape:

`UNIT | Q'TY | UNIT COST / MATERIAL | UNIT COST / TOTAL | UNIT COST / LABOUR | UNIT COST / TOTAL | AMOUNT`

The deterministic parser does not currently recognize the adjacent material and labour rate/total pairs. It therefore produces no immutable candidate items. The extraction reviewer is deliberately unable to offer **Accept**, because its current provider contract may select only existing server-owned candidates and may not author financial values.

The product needs to recognize this layout without disturbing other quotation formats and must let AI help when a future layout remains unfamiliar.

## Goals

- Extract the known two-level component-cost layout deterministically.
- Keep existing quotation layouts on their current parsing paths.
- Let AI identify which retained source cells represent BOQ fields when deterministic parsing has no candidate.
- Show **Accept** only for complete, source-backed, arithmetically valid proposals.
- Show **Review & add** for useful but incomplete or ambiguous AI mappings.
- Preserve PDF page, table, row, and cell provenance for accepted and manually corrected items.
- Never let the model invent descriptions, units, quantities, rates, or totals.

## Non-goals

- Re-extracting or modifying existing Firestore BOQs as part of this code change.
- Guessing financial values when source evidence is absent.
- Making `needs_human_review` proposals directly acceptable.
- Building a universal OCR or table-understanding system in one change.

## Architecture

### 1. Deterministic resolver registry

Column-role detection remains layered. The existing generic detector runs as it does today. Focused resolvers may refine the detected roles only when their complete structural signature matches.

The first resolver recognizes:

- shared unit and quantity columns;
- an ordered material rate followed by material total;
- an ordered labour rate followed by labour total;
- a separate aggregate amount column;
- compatible header-band geometry.

The resolver maps roles from header structure, not from the numeric values in a particular item row. It then uses the existing component derivation and reconciliation logic. If the signature is incomplete, conflicting, or ambiguous, it returns no match and leaves the existing behavior unchanged.

Resolvers expose a small common result: matched/not matched, resolved column roles, and a stable resolver name for tests and diagnostics. A single resolver may not partially overwrite roles unless its entire required signature is valid.

### 2. Server-owned AI cell-mapping contract

When a selected review row has no deterministic candidate, the review packet includes allowlisted cell references for that row. The model may return a field mapping, but not field values. A mapping refers to retained evidence by source-row ID, column index, and optional line index.

Supported semantic fields are:

- description;
- unit;
- quantity;
- rate and total; or
- material rate/total and labour rate/total;
- aggregate amount.

The server resolves every mapping back to the immutable source cells. It rejects unknown rows, columns, line indexes, duplicate/conflicting bindings, unsupported shapes, or any mapping outside the review selection. Numeric parsing uses the existing strict parser. The model cannot provide replacement text or numbers.

### 3. Validation outcomes

The server converts a complete mapping into the same canonical candidate/proposal shape already used by proposal acceptance. Existing evidence, fingerprint, staleness, and arithmetic validation remains authoritative.

There are three outcomes:

1. **Actionable proposal** — all required values are source-backed and arithmetic reconciles. The UI shows **Accept**.
2. **Review draft** — the mapping provides useful source-backed fields but is incomplete or has more than one safe interpretation. The UI shows **Review & add**.
3. **Human review only** — no useful safe mapping exists. The UI explains which required fields could not be identified and retains **Add missing item** as a general fallback.

AI confidence alone never makes a proposal acceptable.

### 4. Review & add workflow

**Review & add** opens a compact editor within the evidence review card. Source-backed values are prefilled and visually identified; missing fields remain blank. The user may correct description, unit, quantity, material cost, labour cost, rate, or total.

The editor displays live arithmetic and blocks saving non-finite, negative, or unreconciled values. Saving creates a user-validated BOQ item with:

- `entryOrigin: "user"`;
- the selected extraction run ID;
- source row IDs and PDF references;
- the accepted AI cell mapping;
- an audit record distinguishing source-derived values from user-entered corrections.

This path is a user correction, not an AI proposal acceptance, so its button is not labeled **Accept**.

## Data flow

1. Docling retains source rows and cells.
2. Registered deterministic resolvers attempt to derive candidates.
3. Successfully derived items enter the draft BOQ normally.
4. Unresolved review rows are sent to AI with allowlisted cell coordinates.
5. The server resolves AI mappings against immutable cells.
6. Complete mappings become validated proposals; incomplete mappings become review drafts.
7. **Accept** applies a validated proposal through the existing transactional acceptance path.
8. **Review & add** applies an explicitly user-confirmed item through an audited source-backed manual-entry path.

## Error handling and safety

- Resolver failures are local no-matches, not parser crashes.
- Unknown quotation layouts continue to retain evidence and warnings.
- Model-authored values are rejected at the contract boundary.
- Arithmetic mismatches cannot reach **Accept**.
- Stale mappings are rejected when the canonical BOQ or immutable extraction evidence changes.
- Provider failure leaves deterministic extraction unchanged and preserves manual correction controls.
- Approved BOQs remain read-only.

## Testing

Test-first coverage will include:

- the exact two-level material/labour quotation header;
- combined component rows and labour-only rows;
- aggregate and section-total reconciliation;
- a similar-looking but incomplete header that must not activate the resolver;
- regression coverage for existing fixtures and quotation layouts;
- valid AI cell mappings resolving only from retained source cells;
- rejection of invented values, unknown cells, conflicting bindings, and bad arithmetic;
- actionable mappings showing **Accept**;
- incomplete mappings showing **Review & add** but not **Accept**;
- persistence of source provenance and user-correction audit data;
- stale and approved-BOQ mutation guards.

## Rollout

This change updates code and tests only. Existing BOQs are not migrated or re-extracted automatically. A user may explicitly re-extract an affected BOQ after deployment to obtain the corrected deterministic items.
