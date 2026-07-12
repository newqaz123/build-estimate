# Catalog Approval and Shared Sync Design

## Goal

Make `/catalog` the shared standard-item registry for BOQ standardization and estimate building. Approved BOQ matches should become reusable catalog items, unmatched items should support either matching an existing item or creating a new item, catalog and matched BOQ edits should stay synchronized, and estimates should keep immutable snapshots of catalog data at the time they are added.

## Scope

### In scope

- `/catalog` Standard Catalog and Items to Review tabs.
- Fuzzy search and LLM-assisted existing-item suggestions in the match flow.
- Creating a new catalog item from an unmatched BOQ item.
- Stable catalog IDs linked from BOQ items.
- Bidirectional canonical-name/unit/alias synchronization between catalog entries and linked BOQ detail items.
- Global-sync confirmation when one shared catalog item affects multiple BOQ rows.
- Selecting catalog items in `/estimator`.
- AI estimate suggestions that prefer existing catalog IDs.
- An editable estimate-builder AI prompt in Settings.
- Snapshot-stable estimate rows.

### Out of scope

- Changes to `/compare`.
- Automatic rewriting of historical estimate rows after catalog edits.
- Destructive deletion of a catalog entry that is already linked or used.
- Replacing the existing BOQ source description; it remains available as provenance.

## Product semantics

“Approved” in the catalog means an item-level standardization has been accepted or manually matched. It does not require the parent BOQ to have overall status `approved`. The catalog may also contain manually created entries with no BOQ source yet so estimators can build projects from scratch.

Items to Review includes unmatched and pending items from all BOQs. Matched items leave that tab after a successful mutation. The Standard Catalog shows one canonical row per standard ID, with source BOQ/item counts and aliases.

When no existing match is suitable, the user chooses **Add as new catalog item**. The form is prefilled from the BOQ item and allows editing the canonical description, unit, and aliases before saving. The new entry is immediately linked to the BOQ item and treated as approved.

## Data model

### `StandardEntry`

Extend the existing standard record with stable provenance and lifecycle metadata:

```ts
interface StandardSourceItem {
  boqId: string
  sectionIndex: number
  itemCode: string
  sourceDescription: string
}

interface StandardEntry {
  id: string
  description: string
  unit: string
  category?: string
  aliases: string[]
  sourceItems: StandardSourceItem[]
  sourceBoqCount: number
  lastMatched?: string
  archivedAt?: string
  createdAt: string
  updatedAt: string
}
```

`sourceBoqCount` is derived from unique `sourceItems.boqId` values whenever a match is created or removed. Existing records without `sourceItems` are treated as having an empty list and remain editable.

### `BoqItem`

Add stable catalog linkage while retaining compatibility with existing fields:

```ts
interface BoqItem {
  // existing fields
  code: string
  desc: string                 // canonical display description after matching
  unit: string                 // canonical display unit after matching
  // ...
  stdStatus: 'matched' | 'unmatched' | 'pending'
  stdMatch?: string            // compatibility/display fallback
  stdId?: string               // canonical StandardEntry ID
  stdConfidence?: 'exact' | 'fuzzy' | 'llm' | 'manual'
  sourceDesc?: string          // original parsed description, set on first match
  sourceUnit?: string          // original parsed unit, set on first match
}
```

For legacy matched items without `stdId`, the catalog UI may temporarily resolve by canonical description/unit, but every new match and every edited matched row must write `stdId`.

### Estimate rows

Estimate rows keep their current display fields as a snapshot and add `stdId?: string`. Adding a catalog item copies description, unit, and current rate into the estimate row. Later catalog edits do not mutate existing estimate rows.

## Synchronization rules

1. Matching an existing catalog item sets the BOQ item’s `stdId`, canonical `desc`, canonical `unit`, `stdMatch`, `stdStatus: 'matched'`, and match confidence. It preserves the prior raw values in `sourceDesc` and `sourceUnit`.
2. Creating a new catalog item performs the same linkage after creating the new `StandardEntry`.
3. Editing a catalog description, unit, or aliases updates every linked BOQ item with the same `stdId` in the same database transaction. The linked BOQ rows retain `sourceDesc` and `sourceUnit`.
4. Editing a matched BOQ item’s canonical description or unit updates the shared `StandardEntry` and all other linked BOQ rows in the same transaction.
5. Before a global edit, the UI confirms the number of affected BOQ items and names the shared catalog item.
6. Editing an unmatched BOQ item changes only that BOQ item until it is matched or added as a new catalog item.
7. Deleting a linked standard is replaced with archive behavior. Archived entries are hidden from new matching and estimate selection but remain resolvable by existing `stdId` references.
8. Estimate rows never participate in global sync after insertion; their snapshot remains stable.

## UI design

### `/catalog` Standard Catalog tab

- Search matches description, unit, aliases, and archived state is excluded by default.
- Rows show canonical description, unit, aliases, source BOQ count, and last updated.
- Existing inline editing remains, with a linked-item count and global-sync confirmation before save.
- Add Entry remains available for estimate-first workflows with no BOQ source.
- Linked rows display a source count rather than duplicating every BOQ item into the catalog table.

### `/catalog` Items to Review tab

- Only `pending` and `unmatched` items are shown.
- Each row includes source BOQ, source vendor, item code, original description/unit, and current suggestion.
- **Match…** opens the catalog match modal.

### Catalog match modal

- Displays the raw BOQ item prominently.
- Default mode is fuzzy catalog search.
- Results are scored by normalized description tokens, aliases, and compatible unit; exact canonical matches rank first.
- **Suggest with AI** sends only the current item and catalog context to the existing standardization endpoint. The response must identify existing catalog IDs, and the user selects and verifies one before applying it.
- If the user does not want an existing result, **Add as new catalog item** opens an inline form for canonical description, unit, and aliases.
- Applying either choice uses one server mutation, closes the modal on success, refreshes both tabs, and shows a toast.

### `/estimator`

- Add a “From Standard Catalog” entry point that searches the same active catalog records.
- A selected entry is copied into the estimate as a snapshot with `stdId`.
- Existing AI chat suggestions include catalog IDs when a suitable standard exists; accepting a suggestion creates the same snapshot-stable estimate row.
- The chat’s system behavior is controlled by the editable Estimate Builder prompt in Settings.
- Manual estimate rows remain supported and do not require a catalog link.

### Settings — Estimate Builder prompt

Add a third prompt under the existing Prompt Settings section:

- Label: **Estimate Builder prompt**.
- Purpose text: “Controls how AI helps build estimates from a blank project.”
- Editable multiline textarea with token estimate, Save, and Reset to default controls matching the existing analysis and standardization prompt cards.
- The default prompt instructs the assistant to ask concise project-scoping questions, prefer active Standard Catalog entries, return `stdId` for existing matches, never invent catalog IDs, and clearly mark any proposed manual/new item.
- Saving updates the workspace `prompts` document and future estimate-chat requests; it does not rewrite existing estimate rows or previous chat messages.

## API and persistence design

Keep the existing authenticated standards and BOQ APIs, adding focused mutations rather than chaining independent client writes:

- `GET /api/standards` returns active catalog entries, optionally filtered by search.
- `POST /api/standards` creates a standalone catalog entry for estimate-first workflows.
- `POST /api/standards/match` atomically matches a BOQ item to an existing standard or creates a new standard and links it. Request includes `boqId`, `sectionIndex`, `itemCode`, and either `standardId` or `newStandard`.
- `PUT /api/standards/:id` edits canonical fields and synchronizes all linked BOQ items transactionally.
- `DELETE /api/standards/:id` archives linked entries and hard-deletes only unused entries.
- `PATCH /api/boqs/:id/items` continues to support BOQ edits; when a matched item’s canonical description/unit changes, it delegates to the same shared-sync transaction.

The Firestore helper layer gets a small transaction helper. The server validates authentication, record existence, section/index/code identity, and all required text fields before committing. A failed transaction returns a clear error and leaves both catalog and BOQ unchanged.

Extend `PromptSettings` with `estimatePrompt: string`. The settings GET endpoint supplies the default when older workspaces do not have it, and the settings PUT validator accepts and persists it alongside `analysisPrompt` and `stdPrompt`. The estimate AI route reads the saved prompt at request time, so changes take effect without redeploying.

## Matching and AI behavior

Use a shared pure matching helper for both the modal and server-side validation:

- normalize case and whitespace;
- normalize punctuation and common unit variants;
- compare canonical description and aliases;
- require compatible units for high-confidence matches;
- score token overlap and exact alias hits;
- sort deterministically by score, then description.

The LLM is advisory only. It receives the current item and active catalog entries, returns candidate IDs with confidence and a short reason, and never writes data directly. A human must select a candidate or create a new item.

The estimate-builder prompt is also advisory: the model may ask questions and suggest catalog-backed or manual rows, but only explicit user actions create estimate rows. The model must not fabricate `stdId` values or mutate the catalog.

## Error handling

- Catalog/API loading failures show retryable inline errors.
- Fuzzy search remains available if AI suggestions fail.
- AI failures never block manual matching or new-item creation.
- Match/save failures keep the modal open and preserve the user’s input.
- Global-sync confirmation states the exact affected row count.
- Archived or missing `stdId` references show a recoverable “catalog item unavailable” state rather than breaking estimate or BOQ rendering.

## Verification

- Unit tests cover normalization, unit compatibility, fuzzy ranking, and legacy records without `stdId`.
- Settings tests cover defaulting, validation, persistence, and reset behavior for `estimatePrompt`.
- API tests cover match-existing, create-new, catalog edit propagation, BOQ edit propagation, archive behavior, and transaction failure.
- UI verification covers catalog tab filtering, match modal fuzzy search, AI suggestion selection, create-new flow, global-sync confirmation, estimate prompt editing, AI prompt usage, and estimate snapshot stability.
- Run the project lint/build checks and a browser smoke test for `/catalog`, `/boqs/[id]`, and `/estimator`.
