# Actionable Review Foundation and Shadow Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic, application-owned actionable-review projection with local-first catalog shortlisting, exact unit normalization, minimum-cost batched AI advice, and shadow metrics without changing the visible review UI or applying any BOQ/catalog decision.

**Architecture:** New focused library modules classify source rows, reconcile represented rows, shortlist catalog candidates, validate conversions with decimal arithmetic, and call AI only for ambiguous cache misses. A versioned shadow snapshot is persisted beside the extraction run while the existing proposal store, review UI, BOQ sections, catalog links, approval state, and audit lifecycle remain authoritative and unchanged.

**Tech Stack:** Current project Next.js App Router version, TypeScript, React, Firestore Admin transactions, existing Docling v3 extraction contracts, existing LLM provider abstraction, Node test runner through `npm test`, Graphify.

## Global Constraints

- Use 2-space indentation in every new or touched TypeScript/TSX file; do not reformat unrelated tab-indented files.
- Follow strict RED → verify RED → minimal GREEN → verify GREEN for every behavior.
- Run `npm run check` after each task and `graphify update .` after every code-changing commit.
- Never run production migrations locally.
- Never read, copy, stage, or commit `Quotation example/`; use sanitized fixtures created for this feature.
- Preserve all unrelated unstaged edits and stage only the files named by the current task; never use `git add .`.
- Dirty-tree staging protocol: at each task start, save `git status --short` and `git diff --binary -- <every touched existing file>` under the gitignored task SDD workspace. If a touched file was already dirty, path-wide `git add <file>` is forbidden; use `git add -p -- <file>` and stage only new task hunks. Before every commit, inspect `git diff --cached --name-only` and the complete `git diff --cached`; a fresh task reviewer must confirm no baseline hunk is staged.
- Preserve exact **Exclude** wording and existing exclusion semantics.
- Shadow mode must not mutate BOQ sections, proposal lifecycle/audits, catalog links, catalog entries, conversion rules, or approval state.
- Client and AI payloads must never supply authoritative source provenance, quantities, rates, totals, normalized values, or conversion factors.
- AI may reference only server-allowlisted source row IDs, catalog IDs, and conversion rule IDs.
- Existing proposal persistence remains authoritative throughout this plan.
- Before modifying route handlers, read completely:
  - `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`
  - `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`
  - `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/dynamic-routes.md`
  - `node_modules/next/dist/docs/01-app/01-getting-started/10-error-handling.md`

---

## File Structure

### New focused modules

- `src/lib/actionable-review-types.ts` — closed domain contracts shared by projection, persistence, API, and later UI.
- `src/lib/decimal-string.ts` — exact decimal parsing and arithmetic for conversion evidence.
- `src/lib/catalog-conversion.ts` — human-approved conversion rule validation and normalization.
- `src/lib/catalog-conversion-storage.ts` — Firestore conversion-rule persistence.
- `src/lib/boq-row-role-classifier.ts` — deterministic, conservative row-role findings.
- `src/lib/boq-represented-row-reconciliation.ts` — source rows already represented by the BOQ.
- `src/lib/catalog-candidate-shortlist.ts` — local-first, maximum-three catalog candidates.
- `src/lib/catalog-mapping-cache.ts` — versioned approved/model mapping cache contracts.
- `src/lib/actionable-review-ai.ts` — one-batch closed AI request/response contract.
- `src/lib/actionable-review-projection.ts` — stable projection independent of provider proposal cardinality.
- `src/lib/actionable-review-storage.ts` — idempotent shadow snapshots.
- `src/lib/actionable-review-metrics.ts` — count/cost/quality metrics without raw document content.

### Existing modules changed carefully

- `src/lib/settings-schema.ts`, `src/lib/settings-storage.ts` — additive rollout and budget settings.
- `src/lib/standard-matching.ts` — expose/reuse local scoring without changing current match acceptance.
- `src/lib/llm.ts` — dependency-injected provider call used by batched advice.
- Existing proposal store and extraction-review components are not modified in this plan.

---

### Task 1: Add rollout and AI-budget settings

**Files:**

- Modify: `src/lib/settings-schema.ts`
- Modify: `src/lib/settings-storage.ts`
- Test: `src/lib/settings-storage.test.ts`
- Modify: `src/app/api/settings/route.ts`
- Test: `src/app/api/settings/settings-api.test.ts`

**Interfaces:**

- Consumes: existing `WorkspaceSettings`, default settings, stored-settings decoder, and settings API section validation.
- Produces:

```ts
export type ActionableReviewStage =
  | 'off'
  | 'shadow'
  | 'focused'
  | 'add_and_match'
  | 'default'

export interface ActionableReviewSettings {
  stage: ActionableReviewStage
  lowCostModel?: string
  escalationModel?: string
  maxRows: number
  maxPromptTokens: number
  maxEstimatedCostMinor: number
  escalationEnabled: boolean
}
```

- [ ] **Step 1: Read current settings contracts and route-handler docs**

Read `src/lib/settings-schema.ts`, `src/lib/settings-storage.ts`, `src/app/api/settings/route.ts`, their tests, and the Next.js route-handler documents listed in Global Constraints. Record the existing section decoder pattern before editing.

- [ ] **Step 2: Write failing storage tests**

Add cases equivalent to:

```ts
test('defaults actionable review to off for existing settings documents', () => {
  const settings = fromStoredSettings({})
  assert.equal(settings.actionableReview.stage, 'off')
  assert.equal(settings.actionableReview.maxRows, 100)
  assert.equal(settings.actionableReview.escalationEnabled, true)
})

test('rejects unknown stages and negative budgets', () => {
  assert.throws(() => fromStoredSettings({
    actionableReview: {
      stage: 'automatic',
      maxRows: -1,
      maxPromptTokens: 0,
      maxEstimatedCostMinor: -1,
      escalationEnabled: true,
    },
  }))
})
```

Add an API test proving PUT accepts the closed fields and rejects an extra `autoAdd: true` field.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
npm test -- src/lib/settings-storage.test.ts src/app/api/settings/settings-api.test.ts
```

Expected: FAIL because `actionableReview` is absent and the API does not validate it.

- [ ] **Step 4: Implement additive settings decoding**

Add the exact union/interface above, a closed parser, and defaults:

```ts
export const DEFAULT_ACTIONABLE_REVIEW_SETTINGS: ActionableReviewSettings = {
  stage: 'off',
  maxRows: 100,
  maxPromptTokens: 8_000,
  maxEstimatedCostMinor: 0,
  escalationEnabled: true,
}
```

`maxEstimatedCostMinor: 0` disables paid AI requests until an explicit workspace budget is configured. Free/cache/local paths may still run. The AI executor added later must also enforce row and token caps.

- [ ] **Step 5: Verify GREEN and project checks**

Run the focused command, then:

```bash
npm run check
graphify update .
git diff --check
```

- [ ] **Step 6: Commit named files only**

```bash
git add src/lib/settings-schema.ts src/lib/settings-storage.ts \
  src/lib/settings-storage.test.ts src/app/api/settings/route.ts \
  src/app/api/settings/settings-api.test.ts
git commit -m "feat: add actionable review rollout settings"
```

---

### Task 2: Define projection and exact-decimal contracts

**Files:**

- Create: `src/lib/actionable-review-types.ts`
- Test: `src/lib/actionable-review-types.test.ts`
- Create: `src/lib/decimal-string.ts`
- Test: `src/lib/decimal-string.test.ts`

**Interfaces:**

- Consumes: existing `BoqSourceRef`/source-cell reference types; no storage or React dependency.
- Produces the following contracts and exact arithmetic helpers:

```ts
export type DecimalString = string

export type RowRole =
  | 'priced_item'
  | 'continuation'
  | 'section_header'
  | 'column_header'
  | 'note'
  | 'subtotal'
  | 'total'
  | 'tax'
  | 'amount_in_words'
  | 'blank_or_noise'
  | 'uncertain'

export interface ExtractedPricingSnapshot {
  description: string
  unit: string
  quantity: DecimalString
  materialRate: DecimalString
  labourRate: DecimalString
  total: DecimalString
}

export interface ReviewerPricingSnapshot {
  description: string
  unit: string
  quantity: DecimalString
  materialRate: DecimalString
  labourRate: DecimalString
  total: DecimalString
  correctionReason?: string
  confirmedAt: string
  confirmedBy: string
}

export interface PricingNormalization {
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

export interface ProposedCatalogMetadata {
  description: string
  unit: string
  category?: string
  aliases: string[]
}

export interface SuggestionVersions {
  extractionFingerprint: string
  boqSectionsFingerprint: string
  catalogFingerprint: string
  conversionFingerprint: string
  promptVersion: string
  modelVersion?: string
}
```

- [ ] **Step 1: Write failing decimal and closed-contract tests**

Cover canonical decimal strings and exact addition, multiplication, and division:

```ts
test('normalizes quantity and component rates without changing total', () => {
  const quantity = multiplyDecimal('6', '6')
  const materialRate = divideDecimalExact('6000', '6', 6)
  assert.equal(quantity, '36')
  assert.equal(materialRate, '1000')
  assert.equal(equalAtMinorUnit('36000', multiplyDecimal(quantity, materialRate), 2), true)
})

test('rejects exponent notation and zero divisors', () => {
  assert.throws(() => parseDecimalString('1e3'))
  assert.throws(() => divideDecimalExact('1', '0', 6))
})
```

Add type/parser tests rejecting unknown `RowRole` values and incomplete version fingerprints.

- [ ] **Step 2: Run tests and verify RED**

```bash
npm test -- src/lib/decimal-string.test.ts src/lib/actionable-review-types.test.ts
```

Expected: FAIL because modules do not exist.

- [ ] **Step 3: Implement exact scale/integer arithmetic**

Implement decimal parsing as sign + integer digits + scale. Reject exponent notation, `NaN`, `Infinity`, empty input, zero divisor, and negative conversion factors. Canonicalize trailing zeros and `-0`. Addition must align integer scales exactly and never use floating-point arithmetic.

Export:

```ts
export function parseDecimalString(value: unknown): DecimalString
export function addDecimal(left: DecimalString, right: DecimalString): DecimalString
export function multiplyDecimal(left: DecimalString, right: DecimalString): DecimalString
export function divideDecimalExact(
  dividend: DecimalString,
  divisor: DecimalString,
  scale: number,
): DecimalString
export function equalAtMinorUnit(
  left: DecimalString,
  right: DecimalString,
  currencyScale?: number,
): boolean
```

Define the closed domain contracts above. `ExtractedPricingSnapshot` preserves parser interpretation unchanged; `ReviewerPricingSnapshot` separately records bounded human-confirmed values when a decision is applied. Numeric divergence requires `correctionReason`. Raw source rows/cells remain immutable in the extraction run. Do not include client-authored provenance fields.

- [ ] **Step 4: Verify GREEN and project checks**

```bash
npm test -- src/lib/decimal-string.test.ts src/lib/actionable-review-types.test.ts
npm run check
graphify update .
git diff --check
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/actionable-review-types.ts src/lib/actionable-review-types.test.ts \
  src/lib/decimal-string.ts src/lib/decimal-string.test.ts
git commit -m "feat: define actionable review contracts"
```

---

### Task 3: Add the human-approved conversion registry

**Files:**

- Create: `src/lib/catalog-conversion.ts`
- Test: `src/lib/catalog-conversion.test.ts`
- Create: `src/lib/catalog-conversion-storage.ts`
- Test: `src/lib/catalog-conversion-storage.test.ts`
- Create: `src/app/api/catalog-conversions/route.ts`
- Test: `src/app/api/catalog-conversions/catalog-conversions-api.test.ts`

**Interfaces:**

- Consumes: Task 2 decimal and pricing contracts; existing authentication/Firestore dependency patterns.
- Produces:

```ts
export interface HumanApprovedCatalogConversionRule {
  id: string
  sourceUnit: string
  catalogUnit: string
  catalogUnitsPerSourceUnit: DecimalString
  scope: 'global' | 'catalog_item'
  catalogId?: string
  version: number
  approvedBy: string
  approvedAt: string
  archivedAt?: string
}

export interface IdentityCatalogConversionRule {
  id: string
  sourceUnit: string
  catalogUnit: string
  catalogUnitsPerSourceUnit: '1'
  scope: 'identity'
  version: 1
}

export type CatalogConversionRule =
  | HumanApprovedCatalogConversionRule
  | IdentityCatalogConversionRule

export const IDENTITY_CONVERSION_RULE_VERSION = 1

export function identityConversionRule(canonicalUnit: string): IdentityCatalogConversionRule

export function normalizePricingWithRule(input: {
  source: ReviewerPricingSnapshot
  catalogId: string
  catalogDescription: string
  catalogUnit: string
  rule: CatalogConversionRule
  currencyScale: number
}): PricingNormalization
```

- [ ] **Step 1: Write failing rule and normalization tests**

Test global and catalog-item scope, exact quantity/rate conversion, component-rate conversion, total preservation, archived rules, wrong catalog IDs, negative/zero factors, and the stable system identity convention. Canonically equal units must use factor `1` and persist `identity:<canonical-unit>:v1` as `PricingNormalization.ruleId` without a Firestore rule document.

```ts
test('applies an item-specific length-to-metre rule', () => {
  const result = normalizePricingWithRule({
    source: reviewerPricing({ unit: 'length', quantity: '6', materialRate: '6000', total: '36000' }),
    catalogId: 'pipe-100',
    catalogDescription: 'PVC Pipe 100 mm',
    catalogUnit: 'm',
    rule: conversionRule({ catalogId: 'pipe-100', sourceUnit: 'length', catalogUnit: 'm', factor: '6' }),
    currencyScale: 2,
  })
  assert.equal(result.normalizedQuantity, '36')
  assert.equal(result.normalizedMaterialRate, '1000')
  assert.equal(result.normalizedTotal, '36000')
})
```

Write API tests proving only authenticated human input can create/archive `HumanApprovedCatalogConversionRule` documents and that unknown keys, `scope: 'identity'`, or AI-origin fields are rejected. Identity rules are generated only by `identityConversionRule()`.

- [ ] **Step 2: Verify RED**

```bash
npm test -- src/lib/catalog-conversion.test.ts \
  src/lib/catalog-conversion-storage.test.ts \
  src/app/api/catalog-conversions/catalog-conversions-api.test.ts
```

- [ ] **Step 3: Implement registry and server-mediated API**

Use collection `catalogConversionRules/{ruleId}`. Initial access is by document ID or bounded collection read; do not require a production index. Validate:

- stored global rules have no `catalogId`,
- stored item rules require `catalogId`,
- identity rules are never accepted by the storage/API layer,
- factor is positive and non-zero,
- version is a positive integer,
- archived rules cannot normalize pricing,
- reviewer-confirmed/normalized totals agree at currency minor-unit precision,
- identity rules are generated only for canonically equal units, always use factor `1`, and are not user- or AI-authored.

No production migration or backfill is needed.

- [ ] **Step 4: Verify GREEN and project checks**

```bash
npm test -- src/lib/catalog-conversion.test.ts \
  src/lib/catalog-conversion-storage.test.ts \
  src/app/api/catalog-conversions/catalog-conversions-api.test.ts
npm run check
graphify update .
git diff --check
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/catalog-conversion.ts src/lib/catalog-conversion.test.ts \
  src/lib/catalog-conversion-storage.ts src/lib/catalog-conversion-storage.test.ts \
  src/app/api/catalog-conversions/route.ts \
  src/app/api/catalog-conversions/catalog-conversions-api.test.ts
git commit -m "feat: add approved catalog conversion registry"
```

---

### Task 4: Classify source rows conservatively

**Files:**

- Create: `src/lib/boq-row-role-classifier.ts`
- Test: `src/lib/boq-row-role-classifier.test.ts`
- Create: `test-fixtures/actionable-review/row-role-cases.json`

**Interfaces:**

- Consumes: `BoqExtractionRun`, `BoqSourceRowV3`, parser classifications/warnings/cell roles.
- Produces:

```ts
export interface RowRoleFinding {
  sourceRowId: string
  role: RowRole
  reasonCodes: string[]
  deterministic: boolean
  sourceRef: BoqSourceRef
}

export function classifySourceRows(input: {
  run: BoqExtractionRun
  sourceRows: readonly BoqSourceRowV3[]
}): RowRoleFinding[]
```

- [ ] **Step 1: Create sanitized fixture cases and failing tests**

Fixture cases must include section/column headers, repeated headers, continuation descriptions, notes, subtotals, grand totals, VAT, amount-in-words, blank noise, clear priced items, and amount-bearing ambiguous rows.

Assert that obvious non-items receive deterministic roles while any amount-bearing uncertain row remains `uncertain` rather than dismissed.

- [ ] **Step 2: Verify RED**

```bash
npm test -- src/lib/boq-row-role-classifier.test.ts
```

- [ ] **Step 3: Implement evidence-only classification rules**

Classification may use parser roles, cell positions, repeated normalized header labels, arithmetic relationship to nearby items, and warning codes. It must not convert raw text/classification values into authoritative BOQ pricing.

Every finding retains immutable source row/page/table/row references and one or more explicit reason codes.

- [ ] **Step 4: Verify GREEN and project checks**

```bash
npm test -- src/lib/boq-row-role-classifier.test.ts
npm run check
graphify update .
git diff --check
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/boq-row-role-classifier.ts \
  src/lib/boq-row-role-classifier.test.ts \
  test-fixtures/actionable-review/row-role-cases.json
git commit -m "feat: classify actionable review source rows"
```

---

### Task 5: Reconcile rows already represented by the BOQ

**Files:**

- Create: `src/lib/boq-represented-row-reconciliation.ts`
- Test: `src/lib/boq-represented-row-reconciliation.test.ts`

**Interfaces:**

- Consumes: BOQ items, immutable source rows, validated proposals/audits, Task 4 role findings, workspace unit aliases.
- Produces:

```ts
export interface RepresentedRowFinding {
  sourceRowIds: string[]
  boqItemId: string
  reason: 'source_identity' | 'accepted_audit' | 'normalized_identity' | 'continuation'
  sourceRefs: BoqSourceRef[]
}

export function reconcileRepresentedRows(input: {
  boq: Boq
  sourceRows: readonly BoqSourceRowV3[]
  proposals: readonly ValidatedProposal[]
  audits: readonly ExtractionProposalAudit[]
  roles: readonly RowRoleFinding[]
  unitMap: Record<string, string>
}): RepresentedRowFinding[]
```

- [ ] **Step 1: Write failing precedence and duplicate tests**

Test immutable source identity first, accepted audit second, strict normalized identity third, and continuation linking. Prove description similarity alone cannot mark a row represented when units or amounts conflict.

- [ ] **Step 2: Verify RED**

```bash
npm test -- src/lib/boq-represented-row-reconciliation.test.ts
```

- [ ] **Step 3: Implement stable reconciliation**

Return findings in source-row order. Never merge or delete evidence. A source row may be represented once; conflicts remain actionable/uncertain and carry audit reasons.

- [ ] **Step 4: Verify GREEN and checks**

```bash
npm test -- src/lib/boq-represented-row-reconciliation.test.ts
npm run check
graphify update .
git diff --check
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/boq-represented-row-reconciliation.ts \
  src/lib/boq-represented-row-reconciliation.test.ts
git commit -m "feat: reconcile represented extraction rows"
```

---

### Task 6: Build local-first catalog shortlisting and cache keys

**Files:**

- Create: `src/lib/catalog-candidate-shortlist.ts`
- Test: `src/lib/catalog-candidate-shortlist.test.ts`
- Create: `src/lib/catalog-mapping-cache.ts`
- Test: `src/lib/catalog-mapping-cache.test.ts`
- Create: `src/lib/catalog-mapping-cache-storage.ts`
- Test: `src/lib/catalog-mapping-cache-storage.test.ts`
- Modify: `src/lib/standard-matching.ts`
- Test: `src/lib/standard-matching.test.ts`

**Interfaces:**

- Consumes: current `rankCatalogMatches`, active `StandardEntry` values, workspace aliases, Task 3 conversion rules, and Task 2 extracted pricing.
- Produces maximum-three catalog candidates and deterministic catalog/conversion/mapping fingerprints:

```ts
export interface CatalogCandidateSnapshot {
  catalogId: string
  description: string
  unit: string
  matchKind: 'approved_history' | 'exact' | 'alias' | 'fuzzy' | 'conversion'
  score: number
  conversionRuleId?: string
}

export interface ApprovedCatalogMapping {
  sourceSignature: string
  catalogId: string
  conversionRuleId?: string
  approvedBy: string
  approvedAt: string
}

export interface CatalogMappingCache {
  get(key: string): Promise<ApprovedCatalogMapping | null>
  put(key: string, mapping: ApprovedCatalogMapping): Promise<void>
  remove(key: string): Promise<void>
}
```

- [ ] **Step 1: Write failing ordering and invalidation tests**

```ts
test('returns no more than three candidates in safe priority order', () => {
  const candidates = shortlistCatalogCandidates(inputWithManyMatches())
  assert.ok(candidates.length <= 3)
  assert.equal(candidates[0]?.matchKind, 'approved_history')
})

test('rejects incompatible units without an active conversion rule', () => {
  assert.deepEqual(shortlistCatalogCandidates(incompatibleUnitsInput()), [])
})
```

Also prove archived standards/rules change fingerprints, human-approved mappings outrank model advice, and item-specific rules cannot leak across catalog IDs. Storage tests use a fake Firestore adapter and prove keys are hashed, reads are server-mediated, and model-only advice cannot overwrite a human-approved mapping.

- [ ] **Step 2: Verify RED**

```bash
npm test -- src/lib/standard-matching.test.ts \
  src/lib/catalog-candidate-shortlist.test.ts \
  src/lib/catalog-mapping-cache.test.ts \
  src/lib/catalog-mapping-cache-storage.test.ts
```

- [ ] **Step 3: Implement without changing current match acceptance**

Reuse scoring functions from `standard-matching.ts`; expose a pure candidate score if needed. Do not alter current `applyStandardToBoqItem()` or current API acceptance in this plan.

Priority: approved mapping → exact → alias → compatible fuzzy → valid conversion. Apply stable catalog-ID tie-breaking and cap at three after filtering.

- [ ] **Step 4: Verify GREEN and checks**

```bash
npm test -- src/lib/standard-matching.test.ts \
  src/lib/catalog-candidate-shortlist.test.ts \
  src/lib/catalog-mapping-cache.test.ts \
  src/lib/catalog-mapping-cache-storage.test.ts
npm run check
graphify update .
git diff --check
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/catalog-candidate-shortlist.ts \
  src/lib/catalog-candidate-shortlist.test.ts \
  src/lib/catalog-mapping-cache.ts src/lib/catalog-mapping-cache.test.ts \
  src/lib/catalog-mapping-cache-storage.ts \
  src/lib/catalog-mapping-cache-storage.test.ts \
  src/lib/standard-matching.ts src/lib/standard-matching.test.ts
git commit -m "feat: shortlist catalog candidates locally"
```

---

### Task 7: Add the closed batched AI advice contract

**Files:**

- Create: `src/lib/actionable-review-ai.ts`
- Test: `src/lib/actionable-review-ai.test.ts`
- Modify: `src/lib/llm.ts`
- Test provider behavior through dependency injection in `src/lib/actionable-review-ai.test.ts`; there is no existing `src/lib/llm.test.ts`.

**Interfaces:**

- Consumes: Task 1 settings, Task 6 shortlists/cache, current provider-call abstraction.
- Produces one normal batch call and an optional uncertain-only escalation result.

- [ ] **Step 1: Write failing cost-routing and allowlist tests**

Test zero calls for cache/exact cases, one call for multiple ambiguous rows, optional second call only for uncertain rows, and local fallback when provider fails. Inject a cost estimator that exceeds `maxEstimatedCostMinor` and assert the provider call count remains zero.

Reject a response containing `rate`, `quantity`, `total`, `conversionFactor`, an unknown row ID, catalog ID outside that row’s shortlist, or conversion rule ID outside its allowlist.

- [ ] **Step 2: Verify RED**

```bash
npm test -- src/lib/actionable-review-ai.test.ts
```

- [ ] **Step 3: Implement the exact closed contract**

```ts
export interface ActionableReviewAiConversionCandidate {
  ruleId: string
  sourceUnit: string
  catalogUnit: string
  catalogUnitsPerSourceUnit: DecimalString
  scope: 'identity' | 'global' | 'catalog_item'
}

export interface ActionableReviewAiCatalogCandidate {
  catalogId: string
  description: string
  unit: string
  matchKind: CatalogCandidateSnapshot['matchKind']
  matchEvidence: string[]
  conversion?: ActionableReviewAiConversionCandidate
}

export interface ActionableReviewAiRequestRow {
  sourceRowId: string
  description: string
  unit: string
  structuralContext: string[]
  candidates: ActionableReviewAiCatalogCandidate[]
}

export interface ActionableReviewAiAdvice {
  sourceRowId: string
  decision: 'match' | 'create' | 'dismiss' | 'uncertain'
  catalogId?: string
  conversionRuleId?: string
  proposedCatalogMetadata?: ProposedCatalogMetadata
  confidence: number
  reason: string
}

export interface ActionableReviewAiBatchResult {
  advice: ActionableReviewAiAdvice[]
  cacheHitCount: number
  initialCallCount: 0 | 1
  escalationCallCount: 0 | 1
  estimatedCostMinor: number
  providerUnavailable: boolean
}

export type ActionableReviewProviderCall = (input: {
  model: string
  rows: readonly ActionableReviewAiRequestRow[]
  maxPromptTokens: number
}) => Promise<unknown>

export type ActionableReviewCostEstimator = (input: {
  model: string
  rows: readonly ActionableReviewAiRequestRow[]
  maxPromptTokens: number
}) => number

export async function executeActionableReviewAiBatch(input: {
  rows: readonly ActionableReviewAiRequestRow[]
  settings: ActionableReviewSettings
  callProvider: ActionableReviewProviderCall
  estimateCostMinor: ActionableReviewCostEstimator
  cache: CatalogMappingCache
}): Promise<ActionableReviewAiBatchResult>
```

Send only concise row evidence and at most three closed candidate snapshots with description, unit, match evidence, and allowlisted conversion metadata. Never send the full PDF or catalog. Call `estimateCostMinor` before each provider invocation; if the estimate exceeds the remaining configured budget—or the budget is `0`—make no paid call and return local/manual fallback. RED tests must assert provider call count remains zero when over budget.

- [ ] **Step 4: Verify GREEN and checks**

```bash
npm test -- src/lib/actionable-review-ai.test.ts
npm run check
graphify update .
git diff --check
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/actionable-review-ai.ts src/lib/actionable-review-ai.test.ts \
  src/lib/llm.ts
git commit -m "feat: batch minimum-cost actionable review advice"
```

---

### Task 8: Build and persist the shadow projection

**Files:**

- Create: `src/lib/actionable-review-projection.ts`
- Test: `src/lib/actionable-review-projection.test.ts`
- Create: `src/lib/actionable-review-storage.ts`
- Test: `src/lib/actionable-review-storage.test.ts`
- Create: `src/lib/actionable-review-metrics.ts`
- Test: `src/lib/actionable-review-metrics.test.ts`
- Create: `src/app/api/boqs/[id]/extraction-runs/[runId]/actionable-review/route.ts`
- Test: `src/app/api/boqs/[id]/extraction-runs/[runId]/actionable-review/actionable-review-api.test.ts`

**Interfaces:**

- Consumes: Tasks 2–7, current extraction storage/auth patterns.
- Produces stable suggestion/review contracts independent of provider proposal IDs/grouping:

```ts
export interface ActionableItemSuggestion {
  id: string
  extractionRunId: string
  sourceRowIds: string[]
  sourceRefs: BoqSourceRef[]
  sourceCellMapping?: SourceCellMapping
  rowRole: RowRole
  deterministicReasons: string[]
  suggestedSectionIndex: number
  extractedItem: ExtractedPricingSnapshot
  catalogCandidates: CatalogCandidateSnapshot[]
  aiAdvice?: ActionableReviewAiAdvice
  normalization?: PricingNormalization
  status: 'pending' | 'added_matched' | 'added_pending_catalog' | 'dismissed' | 'stale'
  versions: SuggestionVersions
}

export interface ActionableReviewValidationSummary {
  rawRowCount: number
  actionableCount: number
  dismissedCount: number
  representedCount: number
  locallyPreparedCatalogCount: number
  aiReviewedCount: number
  sourceTotalDifference: DecimalString | null
  rejectedReasonCounts: Record<string, number>
}

export interface ActionableReview {
  id: string
  extractionRunId: string
  actionableItemSuggestions: ActionableItemSuggestion[]
  dismissedEvidence: RowRoleFinding[]
  representedRows: RepresentedRowFinding[]
  validationSummary: ActionableReviewValidationSummary
  versions: SuggestionVersions
  generatedAt: string
  mode: 'shadow' | 'focused'
}
```

- [ ] **Step 1: Write failing stable-projection tests**

Build two inputs with identical source rows but one provider emits one multi-row proposal and the other emits many single-row proposals. Assert identical actionable/dismissed/represented projection content and fingerprints.

Test at most 100 rows, preserved source refs, idempotent snapshot writes, no raw PDF text in metrics, read-only GET for approved BOQs, and POST rejection for approved BOQs.

- [ ] **Step 2: Verify RED**

```bash
npm test -- src/lib/actionable-review-projection.test.ts \
  src/lib/actionable-review-storage.test.ts \
  src/lib/actionable-review-metrics.test.ts \
  'src/app/api/boqs/[id]/extraction-runs/[runId]/actionable-review/actionable-review-api.test.ts'
```

- [ ] **Step 3: Implement projection, storage, metrics, and route**

Store:

```text
boqs/{boqId}/extractionRuns/{runId}/actionableReviewSnapshots/{fingerprint}
boqs/{boqId}/extractionRuns/{runId}/actionableReviewMetrics/{fingerprint}
```

The route must use dependency-injected handlers for tests. `POST` is allowed only for `shadow` or later and writes only the snapshot/metrics/cache/advice collections. It must not update BOQ sections, catalog standards, proposal lifecycle/audits, or approval state.

- [ ] **Step 4: Verify focused GREEN and full project checks**

```bash
npm test -- src/lib/actionable-review-projection.test.ts \
  src/lib/actionable-review-storage.test.ts \
  src/lib/actionable-review-metrics.test.ts \
  'src/app/api/boqs/[id]/extraction-runs/[runId]/actionable-review/actionable-review-api.test.ts'
npm run check
npx tsc --noEmit
graphify update .
git diff --check
git status --short
```

Confirm only baseline unstaged files plus this task’s named files are present and nothing unrelated is staged.

- [ ] **Step 5: Commit**

```bash
git add src/lib/actionable-review-projection.ts \
  src/lib/actionable-review-projection.test.ts \
  src/lib/actionable-review-storage.ts src/lib/actionable-review-storage.test.ts \
  src/lib/actionable-review-metrics.ts src/lib/actionable-review-metrics.test.ts \
  'src/app/api/boqs/[id]/extraction-runs/[runId]/actionable-review/route.ts' \
  'src/app/api/boqs/[id]/extraction-runs/[runId]/actionable-review/actionable-review-api.test.ts'
git commit -m "feat: generate actionable review in shadow mode"
```

---

## Plan Completion Gate

- [ ] Every focused RED was observed for the intended missing behavior.
- [ ] `npm run check` and `npx tsc --noEmit` pass.
- [ ] `graphify update .` completed after each code commit.
- [ ] Shadow generation caused no BOQ, proposal lifecycle, catalog, or approval mutation.
- [ ] AI accepted no numeric value or unknown allowlist ID.
- [ ] Catalog candidate list never exceeded three.
- [ ] Source and normalized totals were compared using exact decimal arithmetic.
- [ ] No production migration ran locally.
- [ ] `Quotation example/` was never inspected.
- [ ] Only named files were staged per commit; unrelated working-tree edits remain preserved.

**Next plan:** `docs/superpowers/plans/2026-08-08-focused-actionable-review-decisions.md`
