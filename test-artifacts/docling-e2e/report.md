# Docling BOQ ingestion QA report

Date: 2026-07-15
Branch: `codex/docling-ingestion-repair`

## Outcome

All six supplied quotations now parse through the feature-branch Docling sidecar with correct metadata and normalized quantity/unit/rate semantics. Eastern material/labour columns remain distinct when their source units or quantities differ. Every final normalized item sum reconciles to `sourceTotal`.

The real browser upload could not progress past persistence because the configured Firebase Storage bucket returns `404 The specified bucket does not exist`. This occurs before Docling is called. Configuration was not changed. The review UI was therefore also tested using clearly labeled Playwright route interception with a draft built from the real ayt001 sidecar response, the exact original PDF bytes, and a local AI fallback response. This is client-integration evidence, not full end-to-end evidence.

## Real sidecar results

| PDF | Metadata | Items | Item sum / sourceTotal | Warnings |
|---|---|---:|---:|---|
| ayt001 | Eastern Group; pump/pipe installation; 2026-06-11; MEP | 26 | 500,000 / 500,000 | 0 |
| ayt074 | Eastern Group; on-off valve installation; 2026-06-04; MEP | 11 | 478,000 / 478,000 | 0 |
| Modify stage floor & Pipe | Surasak; exact subject; 2026-01-15; MEP | 19 | 47,000 / 47,000 | 2 detail rows |
| Install submersible pump | Surasak; exact subject; 2026-05-13; MEP | 21 | 258,000 / 258,000 | 10 descriptive equipment rows |
| Grating & Concrete pavement | N.P. Civil; exact project; 2026-06-16; Structural | 10 | 337,224 / 337,224 | 10 detail rows + discount context |
| Slab Concrete Biomass | N.P. Civil; exact project; 2026-07-10; Structural | 9 | 277,728 / 277,728 | 4 detail rows + discount context |

N.P. Civil discounts remain document-level context. The item-reconciling pre-discount total is `sourceTotal`; `source_discount` states the discount and payable final (Grating: 3,224 → 334,000; Slab: 728 → 277,000). No negative or altered line item is invented.

## Client-integration evidence

- ayt001 review metadata: Eastern Group, exact pump/pipe project, MEP, 2026-06-11.
- First editable row: `PIPE 1B BS1 L=6000`, `Pcs.`, quantity `3`, rate `1,781`.
- Review headers contain Description, Unit, Qty, Rate, Total, Std. Code and Type are absent.
- Source route requested twice; fetched bytes SHA-256 exactly match the uploaded ayt001 PDF: `f2099bb84e69f21f12db8efcb831de1ab5f5019a1de8a6e8c028a43cfc6e5e8d`.
- Approval is enabled for the reconciled draft.
- Provider-not-configured fallback shows: `AI verification unavailable. Local checks completed: 0 issues found.`
- Retry sends a second verification request and remains actionable.
- At 768px, document body width equals viewport width (768px); no page-level overflow, console errors, or failed requests.

Screenshots:

- `screenshots/review-ayt001-intercepted-1440.png`
- `screenshots/review-ayt001-local-fallback-1440.png`
- `screenshots/review-ayt001-local-fallback-768.png`
- `screenshots/boqs-768.png`
- `screenshots/upload-modal-768.png`

## Automated verification

- Python parser: 36/36 pass using the Docling-enabled virtualenv.
- TypeScript: 152/152 pass.
- ESLint: pass.
- `git diff --check`: pass.
- A clean pre-dev `npx tsc --noEmit` passed. After Next generated route type files, typecheck surfaces existing invalid named exports in route/page modules, including the inherited estimator page.
- Turbopack build cannot run from this worktree because `node_modules` is a symlink outside Turbopack's filesystem root. Webpack compilation succeeds, then Next type validation stops on inherited `estimator/page.tsx` export `normalizeEstimateItems`.

## Environment blocker

Read-only bucket metadata check:

```text
bucket-fail 404 The specified bucket does not exist.
```

Observed browser request:

```text
POST /api/boqs/import 500
```

The server returns the safe user-facing import failure and sends no request to the healthy local Docling sidecar. Exact private source routing, real approval persistence, and live-provider fallback could not be exercised against Firebase until the configured bucket exists.
