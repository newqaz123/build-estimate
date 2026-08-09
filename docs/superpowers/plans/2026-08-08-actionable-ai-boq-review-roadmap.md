# Actionable AI BOQ Review Program Roadmap

**Approved specification:** `docs/superpowers/specs/2026-08-08-actionable-ai-boq-review-catalog-matching-design.md`

**Open Design project:** `buildestimate-actionable-ai-review`

**Open Design entry:** `buildestimate-ai-review.html`

**Preview:** <http://127.0.0.1:49828/api/projects/buildestimate-actionable-ai-review/raw/buildestimate-ai-review.html>

The corrected Open Design artifact passes 13/13 direct interaction tests, including no-safe-match Add to BOQ, Catalog pending, Add & match, Stage 2 Create & link / Find existing / Exclude, status-only Approve BOQ, audit restoration, and accessibility semantics. The project has no `package.json`, so direct Node tests and static artifact checks—not `npm run check`—are the relevant prototype verification.

## Why this is three plans

The approved design spans three independently rejectable subsystems. Combining them into one implementation task would mix shadow analytics, high-risk money conversion, Firestore mutation, approval semantics, and a new review UI. The program therefore ships in dependency order with a complete verification gate after each plan.

## Execution policy

- Use Pi subagents with the configured project models.
- Prefer `superpowers:subagent-driven-development`: one fresh implementer per task, task-scoped review after each commit, and a whole-plan review before proceeding.
- Use Open Design MCP for every UX/UI implementation or refinement task.
- Retrieve the latest artifact from project `buildestimate-actionable-ai-review` before writing UI code.
- Use TDD for every behavior change.
- Preserve unrelated working-tree edits. Capture per-task baseline patches and use hunk-level staging for any file already dirty at task start; a fresh reviewer must inspect the staged diff before commit.
- Never inspect `Quotation example/`.
- Never run production migrations locally.

## Plan 1 — Foundation and shadow mode

**File:** `docs/superpowers/plans/2026-08-08-actionable-review-foundation-shadow-mode.md`

**Outcome:** A stable application-owned actionable review projection is generated and measured without changing the UI or mutating BOQ/catalog state.

Key deliverables:

- rollout/cost settings,
- exact decimal contracts,
- approved conversion registry,
- conservative row-role classifier,
- represented-row reconciliation,
- maximum-three local catalog shortlist,
- mapping cache,
- one-batch closed AI advice,
- idempotent shadow snapshots and metrics.

**Gate to Plan 2:** Shadow generation is deterministic across provider proposal grouping and performs zero BOQ/catalog/proposal-lifecycle mutation.

## Plan 2 — Focused review and explicit decisions

**File:** `docs/superpowers/plans/2026-08-08-focused-actionable-review-decisions.md`

**Outcome:** Reviewers see only likely missing items, can inspect hidden evidence, and can Add to BOQ or Do not add safely. Stage 2 remains the catalog-readiness loop.

Key deliverables:

- Open Design evidence-first responsive workspace,
- closed client normalization/state,
- audit drawer and restore,
- closed decision API,
- atomic Add to BOQ / Do not add,
- focused catalog-pending Stage 2,
- transactional actionable-review approval blocker.

**Gate to Plan 3:** Focused workflow is safe and usable, but Add & match remains disabled until conversion-aware persistence is complete.

## Plan 3 — Conversion-aware Add & match and rollout

**File:** `docs/superpowers/plans/2026-08-08-conversion-aware-add-match-rollout.md`

**Outcome:** Reviewers can add a likely missing item and match it to an existing catalog item in one atomic action with exact normalized pricing evidence.

Key deliverables:

- source and normalization snapshots,
- conversion-aware server reconstruction,
- one Firestore transaction for Add & match,
- Open Design conversion UI,
- metric-gated `focused` → `add_and_match` → `default` rollout,
- old proposal/audit history retained.

**Completion gate:** Local-first and review-efficiency targets pass, AI authors no monetary values/factors, source totals remain preserved, approval stays status-only, and approved BOQs remain read-only.
