# Catalog Approval and Shared Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a stable, editable Standard Catalog that accepts approved BOQ matches, supports fuzzy/LLM matching or new-item creation, synchronizes canonical catalog fields with linked BOQ detail rows, exposes catalog items in `/estimator`, and supports an editable estimate-builder AI prompt while preserving estimate snapshots.

**Architecture:** Keep catalog identity in Firestore `standards` documents and link every matched `BoqItem` through `stdId`. Use a single authenticated match mutation and Firestore transactions for catalog↔BOQ synchronization. Keep fuzzy matching pure and shared, keep LLM actions advisory, and copy catalog fields into estimate rows as snapshots with a retained `stdId`.

**Tech Stack:** Next.js 16 App Router, React 19 client components, TypeScript, Firebase Admin Firestore, existing `callLLM` service, existing proto CSS classes, Node’s built-in test runner, ESLint, and Next build verification.

---

## File map

### Create

- `src/lib/prompt-defaults.ts` — shared default analysis, standardization, and estimate-builder prompts.
- `src/lib/standard-matching.ts` — pure normalization, unit compatibility, and fuzzy ranking helpers.
- `src/lib/standard-matching.test.ts` — deterministic unit tests for matching behavior.
- `src/app/api/standards/match/route.ts` — authenticated atomic match-existing/create-new mutation.
- `src/app/api/llm/estimate/route.ts` — authenticated estimate-builder LLM route that reads the saved estimate prompt.

### Modify

- `src/lib/standard-schema.ts` — add source-item provenance and archive metadata.
- `src/lib/boq-schema.ts` — add stable catalog link, confidence, and raw-source fields to `BoqItem`.
- `src/lib/estimate-schema.ts` — add optional `stdId` to estimate snapshots.
- `src/lib/settings-schema.ts` — add `estimatePrompt` to `PromptSettings`.
- `src/lib/db.ts` — add a Firestore transaction helper.
- `src/app/api/settings/route.ts` and `src/app/(authenticated)/settings/page.tsx` — use the shared prompt defaults.
- `src/app/api/settings/route.ts` — validate, default, and persist `estimatePrompt`.
- `src/app/api/standards/route.ts` — normalize new entries, return active entries, and maintain source counts.
- `src/app/api/standards/[id]/route.ts` — transactionally sync canonical catalog edits and archive linked entries.
- `src/app/api/boqs/[id]/items/route.ts` — route matched canonical edits through shared synchronization.
- `src/app/api/boqs/route.ts` — allow the catalog page’s authenticated all-BOQ read to retrieve its complete review corpus.
- `src/components/catalog-match-modal.tsx` — fuzzy search, AI suggestions, and create-new choice.
- `src/app/(authenticated)/catalog/page.tsx` — show only reviewable items in review, show canonical approved catalog entries, and use the atomic match endpoint.
- `src/app/(authenticated)/boqs/[id]/page.tsx` — persist stable catalog links and show global-sync confirmation for matched edits.
- `src/app/(authenticated)/settings/page.tsx` — add Estimate Builder prompt editor with token estimate, save, reset, and dirty-state behavior.
- `src/app/(authenticated)/estimator/page.tsx` — add catalog picker, preserve `stdId` snapshots, and wire chat to catalog-aware estimate suggestions with fallback behavior.

---

### Task 1: Add shared prompt defaults and schema coverage

**Files:**
- Create: `src/lib/prompt-defaults.ts`
- Modify: `src/lib/settings-schema.ts`
- Modify: `src/app/api/settings/route.ts`
- Test: `src/lib/settings-schema.test.ts`

- [ ] **Step 1: Write the failing prompt-default/schema test**

Create a Node test that proves the estimate prompt is present and nonblank, and that older prompt data can be completed with the default:

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_ESTIMATE_PROMPT, withPromptDefaults } from './prompt-defaults'

test('fills missing estimate prompt without changing saved prompts', () => {
  const result = withPromptDefaults({ analysisPrompt: 'analysis', stdPrompt: 'standardize' })
  assert.equal(result.analysisPrompt, 'analysis')
  assert.equal(result.stdPrompt, 'standardize')
  assert.equal(result.estimatePrompt, DEFAULT_ESTIMATE_PROMPT)
  assert.match(DEFAULT_ESTIMATE_PROMPT, /stdId/)
})
```

- [ ] **Step 2: Run the test and verify the expected failure**

Run: `node --experimental-strip-types --test src/lib/settings-schema.test.ts`

Expected: FAIL because `prompt-defaults.ts` and `estimatePrompt` do not exist yet.

- [ ] **Step 3: Implement the shared prompt contract**

Create `src/lib/prompt-defaults.ts` with the approved default and a defensive defaulting helper:

```ts
export const DEFAULT_ESTIMATE_PROMPT = `You are a construction estimating assistant helping a user build an estimate from scratch.
Ask concise questions about project type, location, scope, quantities, units, and rates before proposing items.
Prefer active Standard Catalog entries. When an existing catalog entry fits, return its exact stdId and never invent an ID.
If no catalog entry fits, mark the suggestion as manual/new and explain what the user should verify.
Return structured JSON with: message, suggestions[{stdId, description, unit, quantity, rate, source: "catalog"|"manual", reason}].
Do not mutate the catalog or create estimate rows; the user must explicitly accept suggestions.`

export function withPromptDefaults(input: Partial<{ analysisPrompt: string; stdPrompt: string; estimatePrompt: string }>) {
  return {
    analysisPrompt: input.analysisPrompt || 'Analyze the parsed BOQ items for consistency and accuracy:',
    stdPrompt: input.stdPrompt || 'Translate the following parsed BOQ items to standard descriptions:',
    estimatePrompt: input.estimatePrompt || DEFAULT_ESTIMATE_PROMPT,
  }
}
```

Extend `PromptSettings` to include `estimatePrompt: string` and make `WorkspaceSettings` use it.

- [ ] **Step 4: Add settings API validation/defaulting**

Update `src/app/api/settings/route.ts` so prompt validation accepts exactly `analysisPrompt`, `stdPrompt`, and `estimatePrompt`, and `fromStoredSettings()` calls `withPromptDefaults()`. Keep the existing 20,000-character limit and nonblank validation for all three fields.

The accepted payload remains:

```ts
{ section: 'prompts', data: { analysisPrompt, stdPrompt, estimatePrompt } }
```

- [ ] **Step 5: Run the settings test and lint**

Run: `node --experimental-strip-types --test src/lib/settings-schema.test.ts`

Expected: PASS.

Run: `npm run lint -- --file src/lib/prompt-defaults.ts --file src/lib/settings-schema.ts --file src/app/api/settings/route.ts`

Expected: no ESLint errors.

- [ ] **Step 6: Commit the prompt contract**

```bash
git add src/lib/prompt-defaults.ts src/lib/settings-schema.ts src/lib/settings-schema.test.ts src/app/api/settings/route.ts
git commit -m "feat: add estimate builder prompt setting"
```

### Task 2: Build and test deterministic fuzzy matching

**Files:**
- Create: `src/lib/standard-matching.ts`
- Create: `src/lib/standard-matching.test.ts`

- [ ] **Step 1: Write failing matching tests**

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { rankCatalogMatches, normalizeCatalogText, unitsCompatible } from './standard-matching'

const catalog = [
  { id: 'std-conc', description: 'Structural concrete C32/40 columns', unit: 'm³', aliases: ['conc C32/40 col'] },
  { id: 'std-rebar', description: 'Reinforcement bar SD40 16mm', unit: 'ton', aliases: ['rebar SD40 16 mm'] },
]

test('normalizes punctuation, case, and whitespace', () => {
  assert.equal(normalizeCatalogText('  Conc. C32/40 — COL  '), 'conc c32/40 col')
})

test('accepts configured unit equivalents and rejects incompatible units', () => {
  assert.equal(unitsCompatible('m2', 'm²', { m2: 'm²' }), true)
  assert.equal(unitsCompatible('ton', 'm³', {}), false)
})

test('ranks exact alias and token matches before unrelated catalog entries', () => {
  const result = rankCatalogMatches('Rebar SD40 16 mm', 'ton', catalog, { ton: ['tonne'] })
  assert.equal(result[0].id, 'std-rebar')
  assert.ok(result[0].score > result[1].score)
})
```

- [ ] **Step 2: Run the tests and verify the expected failure**

Run: `node --experimental-strip-types --test src/lib/standard-matching.test.ts`

Expected: FAIL because the matching helper does not exist.

- [ ] **Step 3: Implement the pure matching helper**

Export these exact types and functions:

```ts
export interface CatalogMatchCandidate {
  id: string
  description: string
  unit: string
  aliases: string[]
  score: number
  unitCompatible: boolean
  matchReason: 'exact' | 'alias' | 'fuzzy'
}

export function normalizeCatalogText(value: string): string
export function unitsCompatible(itemUnit: string, catalogUnit: string, unitMap: Record<string, string>): boolean
export function rankCatalogMatches(
  description: string,
  unit: string,
  catalog: Array<{ id: string; description: string; unit: string; aliases?: string[] }>,
  unitMap: Record<string, string>,
): CatalogMatchCandidate[]
```

Normalize lower case, whitespace, punctuation/dashes, and configured unit aliases. Score exact canonical text highest, exact alias next, and token overlap lower; exclude incompatible units unless there are no compatible results. Sort by score descending and description ascending for deterministic UI.

- [ ] **Step 4: Run matching tests and lint**

Run: `node --experimental-strip-types --test src/lib/standard-matching.test.ts`

Expected: PASS.

Run: `npm run lint -- --file src/lib/standard-matching.ts --file src/lib/standard-matching.test.ts`

Expected: no ESLint errors.

- [ ] **Step 5: Commit matching behavior**

```bash
git add src/lib/standard-matching.ts src/lib/standard-matching.test.ts
git commit -m "feat: add catalog fuzzy matching"
```

### Task 3: Extend catalog and BOQ schemas with stable links

**Files:**
- Modify: `src/lib/standard-schema.ts`
- Modify: `src/lib/boq-schema.ts`
- Modify: `src/lib/estimate-schema.ts`
- Modify: `src/lib/db.ts`

- [ ] **Step 1: Add the schema fields**

Add these exact shapes:

```ts
export interface StandardSourceItem {
  boqId: string
  sectionIndex: number
  itemCode: string
  sourceDescription: string
}

export interface StandardEntry {
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

Extend `BoqItem` with `stdId?: string`, `stdConfidence?: 'exact' | 'fuzzy' | 'llm' | 'manual'`, `sourceDesc?: string`, and `sourceUnit?: string`. Extend `EstimateItem` with `stdId?: string`.

- [ ] **Step 2: Add the transaction helper**

Add this function to `src/lib/db.ts`:

```ts
export async function runTransaction<T>(
  work: (transaction: FirebaseFirestore.Transaction, db: FirebaseFirestore.Firestore) => Promise<T>,
): Promise<T> {
  const db = getDb()
  return db.runTransaction((transaction) => work(transaction, db))
}
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`

Expected: no type errors from the new optional fields or transaction helper.

- [ ] **Step 4: Commit schema primitives**

```bash
git add src/lib/standard-schema.ts src/lib/boq-schema.ts src/lib/estimate-schema.ts src/lib/db.ts
git commit -m "feat: link BOQ and estimate rows to catalog IDs"
```

### Task 4: Implement atomic match-existing and create-new API behavior

**Files:**
- Create: `src/app/api/standards/match/route.ts`
- Modify: `src/app/api/standards/route.ts`
- Modify: `src/app/api/standards/[id]/route.ts`
- Modify: `src/app/api/boqs/route.ts`

- [ ] **Step 1: Define the match request contract in the route test fixture**

The route accepts exactly one of these bodies:

```ts
{ boqId: string; sectionIndex: number; itemCode: string; standardId: string; confidence: 'exact' | 'fuzzy' | 'llm' | 'manual' }
```

or:

```ts
{
  boqId: string
  sectionIndex: number
  itemCode: string
  newStandard: { description: string; unit: string; aliases: string[]; category?: string }
  confidence: 'manual'
}
```

Reject missing BOQ/item identifiers, invalid sections, missing standard IDs, blank new descriptions/units, and archived standard IDs with HTTP 400/404.

- [ ] **Step 2: Implement the transaction**

Inside `POST /api/standards/match`, authenticate, load the BOQ/item, and run one Firestore transaction that:

1. Reads the existing standard or creates a new ID.
2. Preserves the item’s current `desc`/`unit` as `sourceDesc`/`sourceUnit` when absent.
3. Sets item `stdId`, canonical `desc`, canonical `unit`, `stdMatch`, `stdStatus: 'matched'`, and `stdConfidence`.
4. Adds a unique `{ boqId, sectionIndex, itemCode, sourceDescription }` source record.
5. Recomputes `sourceBoqCount` from unique BOQ IDs and updates `lastMatched`.
6. Recomputes the BOQ-level `stdStatus` summary from all sections.

Return `{ standard, boq }` with HTTP 200 for an existing standard and HTTP 201 when a new standard is created.

- [ ] **Step 3: Make standard edits globally synchronize linked BOQ rows**

Update `PUT /api/standards/[id]` to read all BOQs containing the `stdId` inside the transaction, update the standard’s canonical fields, and update every linked item’s `desc`, `unit`, and `stdMatch` while preserving `sourceDesc`/`sourceUnit`. Return `{ standard, affectedItems }`.

Update `DELETE /api/standards/[id]` so entries with any linked BOQ item (found by `stdId` or legacy canonical match) receive `archivedAt` instead of being deleted; only entries with no linked BOQ item may be hard-deleted.

- [ ] **Step 4: Make the catalog read return active/provenance-safe records**

Update `GET /api/standards` to exclude records with `archivedAt` unless `includeArchived=true`, normalize legacy missing `aliases` and `sourceItems` to empty arrays, and accept a search query that checks description, unit, and aliases.

Update `POST /api/standards` to initialize `sourceItems: []` and `sourceBoqCount: 0`.

- [ ] **Step 5: Fix the catalog all-BOQ read bound**

Update `src/app/api/boqs/route.ts` so an authenticated `limit=1000` request uses `Math.min(1000, ...)` instead of the current 100-row cap. Preserve the existing default 10-row behavior for ordinary listing requests.

- [ ] **Step 6: Run typecheck and lint**

Run: `npx tsc --noEmit`

Expected: no type errors.

Run: `npm run lint -- --file src/app/api/standards/route.ts --file src/app/api/standards/match/route.ts --file src/app/api/standards/[id]/route.ts --file src/app/api/boqs/route.ts`

Expected: no ESLint errors.

- [ ] **Step 7: Commit catalog mutations**

```bash
git add src/app/api/standards src/app/api/boqs/route.ts
git commit -m "feat: atomically match and sync catalog items"
```

### Task 5: Upgrade the catalog review and match UI

**Files:**
- Modify: `src/components/catalog-match-modal.tsx`
- Modify: `src/app/(authenticated)/catalog/page.tsx`

- [ ] **Step 1: Add the review filtering test case**

Before changing rendering, verify the intended projection in a small pure helper or inline test fixture:

```ts
const items = [
  { stdStatus: 'unmatched' as const },
  { stdStatus: 'pending' as const },
  { stdStatus: 'matched' as const },
]
assert.equal(items.filter((item) => item.stdStatus !== 'matched').length, 2)
```

Run: `node --experimental-strip-types --test src/lib/standard-matching.test.ts`

Expected: PASS before UI changes; this locks the required review projection.

- [ ] **Step 2: Load canonical catalog entries and linked IDs**

Update `ReviewItem` with `stdId`, `sourceDesc`, and `sourceUnit`. Build review rows from all BOQ items and render only `stdStatus !== 'matched'`. Keep the stats counts based on pending/unmatched review rows. Keep the Standard Catalog tab backed by `standards`, showing canonical description/unit, aliases, source BOQ count, and edit/delete actions.

- [ ] **Step 3: Implement fuzzy search in the modal**

Replace the current `includes()` filter with `rankCatalogMatches(itemDesc, itemUnit, standards, unitMap)`. Preserve selection state, keyboard focus, loading/error/retry states, and show match reason/score context without exposing raw scores as a confusing percentage.

- [ ] **Step 4: Add AI suggestions and explicit new-item creation**

Add two modal actions:

```tsx
<Button onClick={() => void suggestWithAi()} disabled={loading || aiRunning}>
  {aiRunning ? 'Suggesting…' : 'Suggest with AI'}
</Button>
<Button variant="outline" onClick={() => setCreateMode(true)}>
  Add as new catalog item
</Button>
```

AI suggestions call `/api/llm/standardize` with the current item and active catalog context, parse candidate `stdId` values, and render selectable cards with confidence/reason. The new-item form validates description/unit and calls `POST /api/standards/match` with `newStandard`.

- [ ] **Step 5: Route existing matches through the atomic endpoint**

Replace the page’s current `PATCH /api/boqs/:id/items` match call with `POST /api/standards/match`. Send `standardId`, `confidence`, BOQ ID, section index, and item code. On success, close the modal, refresh both standards and BOQ review data, and show a success toast. On failure, keep the modal open and preserve the selected/new form values.

- [ ] **Step 6: Add global-sync warning to catalog editing**

When editing a standard with linked items, show a warning such as `This change will update 4 linked BOQ items.` before saving. After confirmation, call `PUT /api/standards/:id`; update the table from the response and show the affected count.

- [ ] **Step 7: Run lint and build**

Run: `npm run lint -- --file src/components/catalog-match-modal.tsx --file 'src/app/(authenticated)/catalog/page.tsx'`

Expected: no ESLint errors.

Run: `npm run build`

Expected: production build succeeds.

- [ ] **Step 8: Commit catalog UI**

```bash
git add src/components/catalog-match-modal.tsx 'src/app/(authenticated)/catalog/page.tsx'
git commit -m "feat: add catalog fuzzy match and create-new flow"
```

### Task 6: Synchronize matched BOQ detail edits

**Files:**
- Modify: `src/app/api/boqs/[id]/items/route.ts`
- Modify: `src/app/(authenticated)/boqs/[id]/page.tsx`

- [ ] **Step 1: Add canonical edit handling to the BOQ item PATCH route**

When a requested item update includes `stdId` and changes canonical `desc` or `unit`, use the same transaction logic as catalog edits: update the standard and every BOQ item with that `stdId`, then recompute affected BOQ totals/status summaries. Unmatched item edits remain local.

- [ ] **Step 2: Persist `stdId` when matching from BOQ detail**

Update `handleCatalogMatch` in `boqs/[id]/page.tsx` to call `POST /api/standards/match` with the real `standardId`, not only stage `stdMatch` text in local edits. Keep the page’s existing unsaved-edit guard and read-only behavior for overall-approved BOQs.

- [ ] **Step 3: Confirm global sync before saving matched detail edits**

Before committing a matched description/unit edit, show the linked-item count returned by the catalog/BOQ data. Confirming sends the canonical fields; canceling leaves the draft unchanged. After success, replace the page BOQ state with the transaction response and refresh any affected UI state.

- [ ] **Step 4: Verify BOQ detail synchronization**

Run: `npx tsc --noEmit`

Expected: no type errors.

Run: `npm run lint -- --file 'src/app/api/boqs/[id]/items/route.ts' --file 'src/app/(authenticated)/boqs/[id]/page.tsx'`

Expected: no ESLint errors.

- [ ] **Step 5: Commit BOQ synchronization**

```bash
git add 'src/app/api/boqs/[id]/items/route.ts' 'src/app/(authenticated)/boqs/[id]/page.tsx'
git commit -m "feat: sync matched BOQ edits with catalog"
```

### Task 7: Add editable Estimate Builder prompt to Settings

**Files:**
- Modify: `src/app/(authenticated)/settings/page.tsx`
- Modify: `src/app/api/settings/route.ts`
- Modify: `src/lib/settings-schema.ts`
- Modify: `src/lib/prompt-defaults.ts`

- [ ] **Step 1: Add prompt state and dirty tracking**

Add `estimatePrompt`, `savedEstimateRef`, `estimateCurrentRef`, `savingEstimatePrompt`, and `estimateTokenEstimate` alongside the existing analysis/standardization prompt state. When settings load, use `data.prompts.estimatePrompt || DEFAULT_ESTIMATE_PROMPT`; when older data is returned, the default remains visible.

- [ ] **Step 2: Add save/reset handlers**

Implement:

```ts
const updateEstimatePrompt = (value: string) => {
  setEstimatePrompt(value)
  estimateCurrentRef.current = value
  markDirty('prompts',
    analysisCurrentRef.current !== savedAnalysisRef.current ||
    stdCurrentRef.current !== savedStdRef.current ||
    value !== savedEstimateRef.current,
  )
}

const saveEstimatePrompt = async () => {
  const value = estimatePrompt.trim()
  if (!value) return toast.error('Estimate Builder prompt is required')
  setSavingEstimatePrompt(true)
  try {
    await saveSection('prompts', {
      analysisPrompt: savedAnalysisRef.current,
      stdPrompt: savedStdRef.current,
      estimatePrompt: value,
    })
    savedEstimateRef.current = value
    updateEstimatePrompt(value)
    toast.success('Estimate Builder prompt saved')
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Failed to save Estimate Builder prompt')
  } finally {
    setSavingEstimatePrompt(false)
  }
}
```

Update the existing analysis and standardization save payloads at the same time so each prompt save sends the current saved value of all three prompt fields; saving one card must not erase `estimatePrompt`.

- [ ] **Step 3: Add the prompt card**

Add a third card under `settings-prompts` with `data-od-id="estimate-prompt-settings"`, textarea `id="estimate-builder-prompt"`, token estimate, Save button, and Reset to default button. Disable prompt actions while any prompt save is active, matching the existing settings cards.

- [ ] **Step 4: Verify settings UI and API**

Run: `node --experimental-strip-types --test src/lib/settings-schema.test.ts`

Expected: PASS.

Run: `npm run lint -- --file 'src/app/(authenticated)/settings/page.tsx' --file src/app/api/settings/route.ts`

Expected: no ESLint errors.

- [ ] **Step 5: Commit settings UI**

```bash
git add 'src/app/(authenticated)/settings/page.tsx' src/app/api/settings/route.ts src/lib/settings-schema.ts src/lib/prompt-defaults.ts
git commit -m "feat: make estimate builder prompt editable"
```

### Task 8: Wire catalog items and prompt-aware AI into `/estimator`

**Files:**
- Create: `src/app/api/llm/estimate/route.ts`
- Modify: `src/app/(authenticated)/estimator/page.tsx`
- Modify: `src/lib/estimate-schema.ts`

- [ ] **Step 1: Preserve `stdId` in estimate rows**

Add `stdId?: string` to `EstimateItemLocal`, copy it through `normalizeEstimateItems`, accept it in `addItem`, and include it in the `POST /api/estimates` payload. Existing rows with no ID continue to load as manual/imported snapshots.

- [ ] **Step 2: Add the estimate LLM route**

Create `POST /api/llm/estimate` with this request shape:

```ts
{
  messages: { role: 'user' | 'assistant'; content: string }[]
  project?: { name?: string; description?: string }
  items?: { desc: string; unit: string; qty: number; rate: number; stdId?: string }[]
}
```

The route authenticates, loads `WorkspaceSettings`, uses `settings.prompts.estimatePrompt`, loads active catalog entries, appends catalog context with IDs, calls `callLLM`, and returns the provider result. It must never write catalog or estimate documents.

- [ ] **Step 3: Add “From Standard Catalog” picker to the item modal**

Load active standards when the estimator mounts or when the item modal opens. Add a search input that uses `rankCatalogMatches`; selecting a result fills description/unit and stores the selected `stdId` in modal state. Save creates an estimate snapshot with the current quantity/rate and the selected ID.

- [ ] **Step 4: Wire chat requests to `/api/llm/estimate` with deterministic fallback**

Replace the timer-only suggestion branch in `sendChatMsg` with an async request carrying the chat history, project metadata, current items, and active catalog entries through the server route. Parse suggestions as `{ stdId?, description, unit, quantity, rate, source, reason }`. If the route fails or returns invalid suggestions, retain the existing deterministic category-based suggestion fallback and show a non-blocking toast.

- [ ] **Step 5: Add catalog IDs to chat accept actions**

Update `ChatMessage.suggestions`, `chatAddSuggestion`, and `chatAddAll` so accepted catalog-backed suggestions call `addItem(..., { stdId, source: 'manual' })`. Manual/new suggestions omit `stdId`. The existing snapshot fields remain editable after insertion.

- [ ] **Step 6: Verify estimator behavior**

Run: `npx tsc --noEmit`

Expected: no type errors.

Run: `npm run lint -- --file 'src/app/(authenticated)/estimator/page.tsx' --file src/app/api/llm/estimate/route.ts --file src/lib/estimate-schema.ts`

Expected: no ESLint errors.

- [ ] **Step 7: Commit estimator integration**

```bash
git add src/app/api/llm/estimate/route.ts 'src/app/(authenticated)/estimator/page.tsx' src/lib/estimate-schema.ts
git commit -m "feat: add catalog-backed estimate building"
```

### Task 9: End-to-end verification and regression review

**Files:**
- Modify only files required by verification failures.
- Test: `src/lib/standard-matching.test.ts`
- Test: `src/lib/settings-schema.test.ts`

- [ ] **Step 1: Run all local unit tests**

Run: `node --experimental-strip-types --test src/lib/settings-storage.test.ts src/lib/settings-schema.test.ts src/lib/standard-matching.test.ts`

Expected: all tests pass with zero failures.

- [ ] **Step 2: Run the complete lint check**

Run: `npm run lint`

Expected: no ESLint errors.

- [ ] **Step 3: Run the production build**

Run: `npm run build`

Expected: Next production build completes successfully.

- [ ] **Step 4: Run browser smoke verification**

Start the app with: `npm run dev -- --hostname 127.0.0.1`

Verify these exact flows in a browser:

1. `/catalog` Standard Catalog lists canonical entries and source counts; Items to Review hides matched items.
2. Match modal fuzzy search ranks aliases and compatible units.
3. AI suggestions render selectable catalog IDs; Apply Match updates the BOQ item and catalog source count.
4. Add as new catalog item creates and links a new entry.
5. Editing a linked catalog row warns with the affected BOQ count and updates linked BOQ detail values after confirmation.
6. Editing a matched BOQ detail row produces the same global-sync warning and updates the catalog.
7. Settings shows, saves, reloads, and resets the Estimate Builder prompt.
8. `/estimator` can add a catalog item, AI chat can suggest catalog-backed items, and saved estimate rows retain their original snapshot after a catalog rename.

- [ ] **Step 5: Review the final diff and commit any verification fixes**

Run: `git diff --check` and `git status --short`.

Expected: no whitespace errors; existing user changes remain present; only intended feature files are changed by this implementation.
