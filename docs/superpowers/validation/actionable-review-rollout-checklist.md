# Actionable review rollout validation checklist

**Plan:** `docs/superpowers/plans/2026-08-08-conversion-aware-add-match-rollout.md` (Task 5)
**Design:** `docs/superpowers/specs/2026-08-08-actionable-ai-boq-review-catalog-matching-design.md` (§14–15)
**Open Design reference (approved UX artifact project):** `buildestimate-actionable-ai-review`
**Gate implementation:** pure `evaluateActionableReviewRolloutGate` in `src/lib/actionable-review-metrics.ts`
**Rule:** Gate evaluation is advisory only. Client/ops metrics **must not** auto-advance workspace settings. An explicit human sign-off is required before changing `actionableReview.stage`.

---

## 1. Stage progression (ordered, safe)

| From | Next allowed target | UI effect |
| --- | --- | --- |
| `off` | `shadow` | Existing proposal-card review remains visible; shadow metrics may be generated. |
| `shadow` | `focused` | Actionable UI on; **Add & match disabled**. Old proposal/audit history remains readable. |
| `focused` | `add_and_match` | Actionable UI on; **Add & match enabled**. |
| `add_and_match` | `default` | Focused actionable review is the default workspace path; old proposal-card **routing** may be retired only after this gate. History readers stay. |

- Skipped stages and reverse jumps are rejected; **retained stage = current stage**.
- Missing, insufficient, or failed evidence → **retain current stage**.
- Evaluator never mutates settings, Firestore, or localStorage.

---

## 2. Metric definitions and formulas

Aggregate-only. Never persist raw descriptions, cells, provider reasons, catalog metadata, normalized prices, or conversion factors.

| Metric | Formula / definition | Threshold |
| --- | --- | --- |
| Sample size | `N = count(distinct BOQs in cohort)` | `N >= 30` |
| Local catalog preparation rate | `sum(locallyPreparedCatalogCount) / max(1, sum(actionableCount))` over cohort | `>= 0.70` |
| Normal AI calls per BOQ | `sum(initialCallCount) / N` (escalation calls measured separately, not in this gate) | `<= 1` |
| Accepted AI-authored numerics/factors | Count of accepted values where AI authored quantity, rate, total, or conversion factor | `= 0` |
| Projected reviewer-action reduction | `1 - (actionable_review_actions / proposal_card_baseline_actions)` using cohort totals | `>= 0.50` |
| Source-total mismatch escape rate | `mismatch_escapes / N` where an escape is an approval path that bypassed or failed source-total reconciliation incorrectly | `<= baselineSourceTotalMismatchEscapeRate` |
| False-dismissal / restoration review | Human review of false dismissals and restorations completed for the cohort | sign-off `true` |
| Approved / read-only mutation tests | Automated suite proving approved BOQs reject mutations (and UI read-only) | sign-off `true` |

**Constants** (code): `ACTIONABLE_REVIEW_ROLLOUT_THRESHOLDS`

- `minLocalCatalogPreparationRate = 0.7`
- `maxNormalAiCallsPerBoq = 1`
- `maxAcceptedAiAuthoredNumericValuesOrFactors = 0`
- `minProjectedReviewerActionReduction = 0.5`
- `minSampleSize = 30`

**Why 30 BOQs:** Minimum defensible ops cohort for rate estimates before stage promotion. It is not a claim of production A/B significance; it is enough to catch large regressions while remaining operable for early rollout.

---

## 3. Sample-size / evidence table

| Field | Value | Owner | Date | Status |
| --- | --- | --- | --- | --- |
| Cohort label | _pending_ | _pending_ | _pending_ | **pending** |
| Sample size `N` | _pending_ (need ≥ 30) | _pending_ | _pending_ | **pending** |
| Local catalog preparation rate | _pending_ | _pending_ | _pending_ | **pending** |
| Avg initial AI calls / BOQ | _pending_ | _pending_ | _pending_ | **pending** |
| Accepted AI-authored numerics/factors | _pending_ | _pending_ | _pending_ | **pending** |
| Projected reviewer-action reduction | _pending_ | _pending_ | _pending_ | **pending** |
| Source-total mismatch escape rate | _pending_ | _pending_ | _pending_ | **pending** |
| Baseline source-total mismatch escape rate | _pending_ | _pending_ | _pending_ | **pending** |
| False-dismissal/restoration review completed | _pending_ | _pending_ | _pending_ | **pending** |
| Approved/read-only mutation tests green | _pending_ | _pending_ | _pending_ | **pending** |
| `evaluateActionableReviewRolloutGate` result | _pending_ | _pending_ | _pending_ | **pending** |
| Explicit stage change approved (human) | _pending_ | _pending_ | _pending_ | **pending** |

---

## 4. Sanitized fixture / browser QA matrix

**Viewports:** `1280×800` (desktop) and `390×844` (mobile).
**Fixtures:** sanitized text-layer digital PDF BOQ + sanitized image-only scanned PDF BOQ only.
**Never use** `Quotation example/` or unsanitized customer documents.

| # | Check | Digital PDF 1280 | Digital PDF 390 | Scanned PDF 1280 | Scanned PDF 390 | Status |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | Actionable list smaller than raw evidence | | | | | **pending** |
| B2 | Hidden evidence inspectable/restorable | | | | | **pending** |
| B3 | Every suggestion requires Add or Do not add | | | | | **pending** |
| B4 | Source highlight provenance correct | | | | | **pending** |
| B5 | Reviewer-confirmed total preserved across conversion; BOQ total reconciles to source document total | | | | | **pending** |
| B6 | Add & match idempotent and atomic | | | | | **pending** |
| B7 | Stage 2 catalog-pending (Add to BOQ without safe match) unchanged | | | | | **pending** |
| B8 | Catalog/actionable/verification blockers prevent approval | | | | | **pending** |
| B9 | Approved BOQ fully read-only | | | | | **pending** |
| B10 | Exact **Exclude** wording/semantics unchanged | | | | | **pending** |
| B11 | `focused`: Add & match disabled; `add_and_match`/`default`: enabled | | | | | **pending** |
| B12 | Old proposal/audit history readable at every stage | | | | | **pending** |

### Current browser QA limitation

Automated Task 5 delivery validates the **pure gate**, unit/integration tests, `tsc`, and project check. **Interactive browser QA against sanitized PDFs at both viewports remains pending** and is required before any production workspace is advanced to `default` or before old proposal-card routing is retired. Open Design visual fidelity for `buildestimate-actionable-ai-review` must be re-checked during that browser pass.

---

## 5. Known unrelated test failures

`npm run check` may report **12 failing** tests in legacy `src/components/extraction-review.test.ts` (Tasks 3–9 `submitSourceBackedItem` / proposal-card flow). These are **known, unrelated** to actionable-review rollout gating and must not be “fixed” as part of this checklist unless they newly regress actionable paths.

Record check run:

| Command | Expected | Actual | Date |
| --- | --- | --- | --- |
| `npm test -- src/lib/actionable-review-metrics.test.ts` | pass | _pending_ | _pending_ |
| `npm test -- 'src/app/(authenticated)/boqs/[id]/page.test.ts'` | pass | _pending_ | _pending_ |
| `npm test -- src/components/extraction-review.test.ts` | may include known 12 legacy fails | _pending_ | _pending_ |
| `npx tsc --noEmit` | pass | _pending_ | _pending_ |
| `npm run check` | lint+tsc pass; tests may show known 12 | _pending_ | _pending_ |
| `graphify update .` | pass | _pending_ | _pending_ |
| `git diff --check` | pass | _pending_ | _pending_ |

---

## 6. Rollback steps

1. **Do not** rely on client metrics to change stage. An operator sets workspace `actionableReview.stage` explicitly.
2. To roll back a promotion, set stage to the previous value only:
   - `default` → `add_and_match`
   - `add_and_match` → `focused`
   - `focused` → `shadow` (or `off` if shadow must also stop)
   - `shadow` → `off`
3. Confirm BOQ detail `view=review` returns to the expected surface (`ExtractionReview` for `off`/`shadow`; actionable workspace for `focused`+).
4. Confirm old proposal/audit history readers still load; no data migration is required for rollback.
5. Leave additive pricing snapshots and decision history intact (rollback is routing/settings only).
6. Re-run approved/read-only mutation tests and a smoke browser pass after rollback.
7. Record rollback owner, date, from→to stage, and reason in the evidence table above.

---

## 7. Default rollout sign-off requirements

Before setting any production workspace to `default` (or retiring old proposal-card routing):

1. [ ] Cohort `N >= 30` with aggregate evidence filled (no raw content).
2. [ ] All metric thresholds pass via `evaluateActionableReviewRolloutGate` (`advanceAllowed: true` for `add_and_match` → `default`).
3. [ ] False-dismissal/restoration review signed off.
4. [ ] Approved/read-only mutation tests signed off green.
5. [ ] Browser QA matrix complete at `1280×800` and `390×844` for both sanitized fixture types.
6. [ ] Open Design artifact `buildestimate-actionable-ai-review` visual QA recorded.
7. [ ] Source-total mismatch escape rate ≤ baseline.
8. [ ] Rollback owner named and rollback drill acknowledged.
9. [ ] Explicit human approval recorded (name, date, workspace id). **No auto-advance from client-computed metrics.**

| Sign-off | Name | Date | Notes |
| --- | --- | --- | --- |
| Metrics owner | _pending_ | _pending_ | |
| QA owner | _pending_ | _pending_ | |
| Engineering owner | _pending_ | _pending_ | |
| Workspace stage change approver | _pending_ | _pending_ | Required before `default` |

---

## 8. Program completion gate (cross-check)

Mirror of plan completion gate — mark only when evidence exists:

- [ ] Open Design MCP artifact used for UX/UI and final visual QA
- [ ] Local-first resolution ≥ 70%
- [ ] Normal operation ≤ 1 initial AI call per BOQ; escalation measured separately
- [ ] AI supplied zero accepted monetary values or conversion factors
- [ ] Source and normalized pricing snapshots preserve quoted total
- [ ] Add & match is one idempotent Firestore transaction
- [ ] Add to BOQ without safe match stays catalog-pending
- [ ] Approval remains status-only with verification/catalog/actionable readiness
- [ ] Old proposal/audit history remains readable
- [ ] Approved BOQs reject every mutation
- [ ] Exact Exclude wording/semantics unchanged
- [ ] `npm run check`, `npx tsc --noEmit`, `graphify update .`, `git diff --check`, and browser QA pass
- [ ] No production migration ran locally; no unrelated edit staged
