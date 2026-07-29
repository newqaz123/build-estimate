# Upload Modal and Magnifier Geometry Validation

- Implementation commits:
  - `9f4e171652afc89ad210f2a5026188499246a5d5` — fix: center Upload BOQ with one translation owner (Task 1)
  - `665bbe40559a818a4fb3d4974ddb87e0478ec62b` — style: format upload modal layout test (Task 1)
  - `feada54d3d5eb495bcd43c5f9b5232faa3d19d06` — fix: body-portal the BOQ page magnifier (Task 2)
  - `2e15a85f2980cea933949b1f80eedd64a74fd4f0` — style: apply formatter to boq-preflight portal files (Task 2)
- Browser/version: Headless Chromium 150.0.0.0
  (`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/150.0.0.0 Safari/537.36`)
- Temporary fixture: `/tmp/buildestimate-preflight-9-pages.pdf` — 9 blank pages, 612×792 pt. Untracked, never added to the repository (generated with `pypdf` in a throwaway venv at `/tmp/task3-pdfvenv`).
- Preflight interception: `agent-browser network route "**/api/boqs/preflight" --body <fixture-json>` fulfilled the only `POST /api/boqs/preflight` with HTTP 200 and the 9-page fixture payload. Captured request log shows exactly one `POST http://localhost:3001/api/boqs/preflight (Fetch) 200` and **zero** `/api/boqs/import`, Firebase, or Docling requests — the real component and PDF.js client-side rendering were exercised without touching Firebase or Docling.
- `npm run check`: PASS — `tests 921, pass 921, fail 0`.
- Focused tests (`npx tsx --test src/components/upload-modal-layout.test.ts src/components/boq-preflight.test.ts src/lib/preflight-magnifier-position.test.ts src/components/boq-ingestion-flow.test.ts`): PASS — `tests 33, pass 33, fail 0`.
- pi-lens / `lsp_diagnostics`: **not applicable** — this worker session has only `read/write/edit/bash/grep/find/ls`; no LSP or `pi-lens` tool is available. Source contract is instead covered by the focused `tsx --test` suite (33 tests) plus the measured browser geometry below.
- Auth/dev-server deviation (transparent record): The dev server already running on port 3000 served the **main repo** (commit `8132292`, *before* the fixes) and produced the pre-fix state on a first measurement (dialog had both `transform` and `translate`; magnifier was *not* portaled, `intersectionRatio` 0). A fresh worktree dev server was therefore started on port 3001 to serve the reviewed commits. The worktree has no `.env.local`, so its server could not authenticate. Per an approved decision, a **throwaway, isolated** `AUTH_SECRET` and `ADMIN_PASSWORD` (random `openssl` tokens) were supplied to the port-3001 process only; the generated password was stored solely in a dedicated `agent-browser` auth profile via stdin and never printed or persisted to any project file. The real `.env.local` and application source were never read, copied, or modified. The throwaway server and auth profile were torn down after measurement. Auth is only a gate to reach `/boqs`; the measured geometry is independent of which password authenticates.

Measurement method: at each viewport the dialog was opened, ≥200 ms settled, then the relevant thumbnail was hovered/focused-managed and `captureLayoutGeometry()` ran an `IntersectionObserver` at `threshold:[1]` against the magnifier (no value inferred from a rectangle alone). Every figure below is a real measured value.

## Automated TDD and diff evidence

The following command outcomes are quoted from the existing Task 1 and Task 2 handoff reports:

- Task 1 RED — `npx tsx --test src/components/upload-modal-layout.test.ts`: **expected failure (exit 1)**; both tests failed because Upload BOQ still inherited `modal`, and `.upload-modal` lacked the explicit visual declarations while retaining a transform.
- Task 1 GREEN — `npx tsx --test src/components/upload-modal-layout.test.ts src/components/boq-ingestion-flow.test.ts`: **passed (exit 0), 18/18 tests**. Full `npm run check`: **passed (exit 0), 920 tests passed, 0 failed**. `git diff --check`: **passed (exit 0), no whitespace errors**.
- Task 2 RED — `npx tsx --test src/components/boq-preflight.test.ts`: **expected failure; 7 passed, 1 failed**. The new regression failed on the missing `createPortal` import while the magnifier was still a normal `.preflight-page-item` descendant.
- Task 2 GREEN — `npx tsx --test src/components/boq-preflight.test.ts src/lib/preflight-magnifier-position.test.ts src/components/boq-ingestion-flow.test.ts`: **passed; 31 tests passed, 0 failed**. Full `npm run check`: **passed; 921 tests passed, 0 failed**. `git diff --check`: **passed**.

## Acceptance summary table

| Viewport | Dialog center error X/Y | Computed translate | Computed transform | Portal outside dialog | Minimum safe inset | Intersection ratio | Hover/focus selection stable | Activation toggles | Inner scroll | Focus trap/Escape/close |
| --- | ---: | --- | --- | --- | ---: | ---: | --- | --- | --- | --- |
| 1440×900 | 0.0 / 0.0 | `-50% -50%` | `none` | true (portaled to `document.body`, `parentIsBody=true`, `insideDialog=false`) | 8.0 | 1 | stable (3 → 3 across hover/focus of pages 1/5/9) | click page 1: 3→2; focus page 5 + Space: 2→1 | scrollHeight 694 > clientHeight 629; scrollTop 0→40 moves; magnifier ratio 1 unchanged | Tab/Shift+Tab ×8 stay inside; Escape closes; Close button closes |
| 768×900 | 0.0 / 0.0 | `-50% -50%` | `none` | true (portaled to `document.body`) | 8.0 | 1 | stable (3 → 3) | click page 1: 3→2; focus page 5 + Space: 2→1 | scrollHeight 694 > clientHeight 629; scrollTop 0→40 moves; magnifier ratio 1 unchanged | Tab/Shift+Tab ×8 stay inside; Escape closes; reopen succeeds; Close button closes |
| 320×600 | 0.0 / 0.0 | `-50% -50%` | `none` | true (portaled to `document.body`) | 8.0 | 1 | stable (3 → 3) | click page 1: 3→2; focus page 5 + Space: 2→1 | scrollHeight 670 > clientHeight 389; scrollTop 24→140 moves; magnifier ratio 1 unchanged | Tab/Shift+Tab ×8 stay inside; Escape closes; reopen succeeds; Close button closes |

All per-sample thresholds hold for every recorded sample: `centerErrorX ≤ 1` and `centerErrorY ≤ 1`; `position === "fixed"`; the dialog never has **both** a non-`none` `transform` and non-`none` `translate` (here `transform: none`, `translate: -50% -50%` → single owner); `parentIsBody === true` and `insideDialog === false`; `intersection.ratio === 1`; all four magnifier borders are `1px` (nonzero); `infoContained === true`; every safe inset ≥ 8 px.

## First/Middle/Last Page Checks

Magnifier rect (L,T,R,B,WxH), safe insets (L,T,R,B), intersection ratio, portal/containment — hover and keyboard-focus for pages 1, 5, 9 at each viewport.

### 1440×900

- hover1: rect(617,169,937,583,320×414) insets(617,169,503,317) ratio=1 parentBody=true !inDlg=true info=true
- hover5: rect(735,330,1055,744,320×414) insets(735,330,385,156) ratio=1 parentBody=true !inDlg=true info=true
- hover9: rect(854,478,1174,892,320×414) insets(854,478,266,8) ratio=1 parentBody=true !inDlg=true info=true
- focus1: rect(687,169,1007,583,320×414) insets(687,169,433,317) ratio=1 parentBody=true !inDlg=true info=true
- focus5: rect(805,331,1125,744,320×414) insets(805,331,315,156) ratio=1 parentBody=true !inDlg=true info=true
- focus9: rect(924,478,1244,892,320×414) insets(924,478,196,8) ratio=1 parentBody=true !inDlg=true info=true

### 768×900

- hover1: rect(281,169,601,583,320×414) insets(281,169,167,317) ratio=1 parentBody=true !inDlg=true info=true
- hover5: rect(399,330,719,744,320×414) insets(399,330,49,156) ratio=1 parentBody=true !inDlg=true info=true
- hover9: rect(166,478,486,892,320×414) insets(166,478,282,8) ratio=1 parentBody=true !inDlg=true info=true
- focus1: rect(351,169,671,583,320×414) insets(351,169,97,317) ratio=1 parentBody=true !inDlg=true info=true
- focus5: rect(117,331,437,744,320×414) insets(117,331,331,156) ratio=1 parentBody=true !inDlg=true info=true
- focus9: rect(236,478,556,892,320×414) insets(236,478,212,8) ratio=1 parentBody=true !inDlg=true info=true

### 320×600 (responsive popup width = `min(320, 100vw-16)` = 304)

- hover1: rect(8,148,312,540,304×393) insets(8,148,8,60) ratio=1 parentBody=true !inDlg=true info=true
- hover5: rect(8,199,312,592,304×393) insets(8,199,8,8) ratio=1 parentBody=true !inDlg=true info=true
- hover9: rect(8,170,312,562,304×393) insets(8,170,8,38) ratio=1 parentBody=true !inDlg=true info=true
- focus1: rect(8,148,312,541,304×393) insets(8,148,8,59) ratio=1 parentBody=true !inDlg=true info=true
- focus5: rect(8,199,312,592,304×393) insets(8,199,8,8) ratio=1 parentBody=true !inDlg=true info=true
- focus9: rect(8,170,312,562,304×393) insets(8,170,8,38) ratio=1 parentBody=true !inDlg=true info=true

Note: at every viewport the last-thumbnail (page 9) sample parks the popup flush against the right/bottom clamp at exactly the 8 px padding (e.g. 1440 focus9 right inset 196 but bottom inset 8; 768 hover9 bottom inset 8; 320 samples at the 8 px left/right/bottom clamp). This is the responsive clamp holding, not clipping — `intersection.ratio === 1` in every case.

## Four-Edge Anchor Measurements

While page 5 was keyboard-focused, `mousemove` was dispatched on the thumbnail with `clientX/clientY` near each viewport corner; geometry was re-measured after each React update.

### 1440×900

- TL(1,1): ratio=1 insets(17,8,1103,478) min=8
- TR(1439,1): ratio=1 insets(1103,8,17,478) min=8
- BL(1,899): ratio=1 insets(17,478,1103,8) min=8
- BR(1439,899): ratio=1 insets(1103,478,17,8) min=8

### 768×900

- TL(1,1): ratio=1 insets(17,8,431,478) min=8
- TR(767,1): ratio=1 insets(431,8,17,478) min=8
- BL(1,899): ratio=1 insets(17,478,431,8) min=8
- BR(767,899): ratio=1 insets(431,478,17,8) min=8

### 320×600

- TL(1,1): ratio=1 insets(8,8,8,199) min=8
- TR(319,1): ratio=1 insets(8,8,8,199) min=8
- BL(1,599): ratio=1 insets(8,199,8,8) min=8
- BR(319,599): ratio=1 insets(8,199,8,8) min=8

The popup stays fully on-screen (ratio 1, minimum safe inset 8) for every extreme anchor position — the clamp logic flips/clamps correctly at all four edges.

## Inner scroll

`.modal-body` overflows and scrolls at every viewport, and the body-portaled magnifier (position: fixed) is unaffected by the modal-body scroll:

| Viewport | scrollHeight | clientHeight | scrolls? | scrollTop change | Magnifier after scroll |
| --- | ---: | ---: | --- | ---: | --- |
| 1440×900 | 694 | 629 | yes | 0 → 40 | visible, ratio=1, min inset 156 |
| 768×900 | 694 | 629 | yes | 0 → 40 | visible, ratio=1, min inset 49 |
| 320×600 | 670 | 389 | yes | 24 → 140 | visible, ratio=1, min inset 8 |

## Interaction invariants

- Selection stability: hovering and keyboard-focusing pages 1/5/9 left the selected count unchanged (3 → 3) at all three viewports.
- Activation toggles, measured independently at every viewport:
  - 1440×900: clicking page 1 changed 3 → 2; focusing page 5 and pressing Space changed 2 → 1.
  - 768×900: clicking page 1 changed 3 → 2; focusing page 5 and pressing Space changed 2 → 1.
  - 320×600: a real pointer click at the visible page-1 thumbnail center changed 3 → 2; focusing page 5 and pressing Space changed 2 → 1.
- Focus trap, measured independently at every viewport: 8× Tab and 8× Shift+Tab each kept `document.activeElement` inside `[data-od-id="upload-modal"]` on all 16 steps at 1440×900, 768×900, and 320×600.
- Close behaviors, measured independently at every viewport: Escape closed the dialog; reopening via "Upload BOQ" succeeded; the real Close button then closed it at 1440×900, 768×900, and 320×600.

## Fix Round 1 Browser Evidence

Reviewer-requested real-browser interaction coverage was rerun in the isolated Chromium session at 768×900 and 320×600. Each run began with three selected pages, exercised hover and keyboard focus on pages 1/5/9 without changing that count, then independently produced click `3→2` and Space `2→1`. After a 100 ms settle following each keyboard event, all eight Tab and eight Shift+Tab samples remained inside the dialog. Escape returned the dialog to closed, "Upload BOQ" reopened it, and the Close button returned it to closed at both viewports.

The development-only `nextjs-portal` indicator was hidden in the browser DOM for these checks and the replacement 320×600 capture. This removes non-application focus targets and ensures the complete magnifier information strip is unobscured; no application source or test code was changed. The replacement `320x600.png` is exactly 320×600 and shows the complete page-5 magnifier strip, including the magnifier icon, "Page 5", and "Suggested" badge.

## Console and Residual Notes

- Console/errors: page `errors` log empty after the run; zero `error|warn` console messages recorded during the session (console and error logs were cleared at the start of the port-3001 flow).
- Residual risks / caveats:
  - Geometry was measured in **headless** Chromium 150 on macOS. Real-device Chromium should render identically (same engine/CSS), but a human spot-check on a headed browser at 320×600 is the only way to confirm perceived (not just computed) visibility.
  - The dialog centering uses `position: fixed` + `translate: -50% -50%` with `transform: none`; this is the single-translation-owner state validated here. If a future change re-introduces a `transform` on `DialogContent`, the geometry contract breaks.
  - The 8 px minimum-inset boundary is hit exactly on several page-9 / mobile samples; this is the intended `MAGNIFIER_PADDING` clamp, not clipping (ratio stays 1).
  - pi-lens / `lsp_diagnostics` were not run (no such tool in this session); the source contract is covered by the 33-test focused suite and `npm run check` (921 tests).
