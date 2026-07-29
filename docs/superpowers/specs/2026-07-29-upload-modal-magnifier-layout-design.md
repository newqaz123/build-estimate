# Upload Modal and PDF Magnifier Layout Design

**Date:** 2026-07-29
**Status:** Approved design, pending written-spec review

## Problem

The BOQ preflight interface has two reproducible layout failures:

1. The floating PDF page magnifier is clipped by the Upload BOQ dialog, so only a narrow fragment is visible.
2. The Upload BOQ dialog is shifted toward the top-left instead of centered in the full browser viewport.

The supplied 2940×1648 screenshot shows the dialog's right edge at the viewport midpoint and the magnifier clipped at the dialog's right and vertical content boundaries.

## Root Causes

### Magnifier clipping

`BoqPreflight` calculates magnifier coordinates from viewport values (`clientX`, `clientY`, `window.innerWidth`, and `window.innerHeight`) but renders the fixed-position magnifier inside the dialog subtree. The dialog is transformed, making it the containing block for fixed descendants. The popup and modal body also establish overflow clipping boundaries. Therefore the calculated viewport coordinates are interpreted inside the dialog and clipped by its ancestors. A higher z-index cannot escape an ancestor overflow clip.

### Dialog offset

The shared `DialogContent` uses Tailwind 4 individual translation utilities (`translate: -50% -50%`) with `top: 50%` and `left: 50%`. Upload/legacy modal CSS additionally applies `transform: translate(-50%, -50%)`. Individual `translate` and `transform` compose rather than replace each other, producing an effective double translation. The screenshot geometry matches this behavior.

## Approved Behavior

- Center Upload BOQ against the full browser viewport.
- Show the complete floating magnifier frame outside the modal's clipping boundaries.
- Keep at least 8 CSS pixels between the magnifier and each visual viewport edge when the viewport can contain it.
- Shrink the magnifier responsively when the viewport is smaller than its normal dimensions.
- Preserve mouse hover and keyboard focus behavior.
- Hover/focus must not change page selection; activation must continue to toggle selection.
- Preserve modal scrolling, focus trapping, Escape/close behavior, and responsive sizing.

## Design

### 1. Portal the magnifier to the document body

Render the visible magnifier with React's portal API under `document.body`. Keep its state and event ownership in `BoqPreflight`. The existing measured placement helper remains responsible for viewport flip and clamp calculations.

A client/body guard prevents rendering before the document is available. The portal keeps the magnifier outside transformed and overflow-clipping modal ancestors while preserving its semantic label and pointer-events behavior.

### 2. Use one dialog-centering mechanism

Treat shared `DialogContent` positioning as the single owner of viewport centering. Remove upload-specific and legacy transform declarations that duplicate its `-50%` translation. Avoid changing the shared dialog primitive unless source inspection proves a scoped class removal cannot resolve the conflict.

The Upload BOQ popup should not inherit the legacy `.modal` transform contract. Existing visual styles that are still required—surface, radius, shadow, dimensions, header/body/footer spacing—must remain available through scoped classes without adding a second centering transform.

### 3. Keep scrolling inside the dialog body

The dialog may retain its viewport-bounded maximum height. Long content should scroll in the intended inner body, while the body-portaled magnifier remains independent of that scroll clip.

## Alternatives Rejected

1. **Full shared-dialog grid/flex rewrite:** structurally clean but risks every dialog in the application and exceeds this bug's scope.
2. **Modal-contained magnifier:** requires translating viewport coordinates into dialog-local coordinates, couples the popup to scrolling, reduces usable preview size, and does not meet the floating-preview requirement.
3. **Higher z-index only:** cannot escape ancestor overflow clipping or a transformed containing block.

## Validation Contract

### Automated

- Add a failing regression test proving the magnifier is rendered through a body portal rather than inside the page-item/modal subtree.
- Add a failing regression test proving Upload BOQ has exactly one centering translation owner.
- Keep and run the pure magnifier placement edge tests.
- Run focused BOQ preflight and ingestion tests.
- Run `npm run check`.
- Run `git diff --check` and pi-lens diagnostics on changed files.

### Browser geometry

At 1440×900, 768×900, and 320×600:

- After dialog animation, the dialog center must be within 1 CSS pixel of the visual viewport center.
- Computed styles must not simultaneously apply centering through both individual `translate` and `transform`.
- Hover and keyboard-focus the first, middle, and last page thumbnails.
- The magnifier must be fully visible with its complete border and information bar.
- The magnifier must remain inside the visual viewport safe area; use intersection visibility or equivalent clipping evidence, not only its bounding rectangle.
- Exercise anchors near all four viewport edges.
- Confirm hover/focus does not alter the selected-page count and click/keyboard activation does.
- Confirm tall page lists still scroll and the modal closes correctly.

## Scope Boundaries

- No BOQ import/API behavior changes.
- No redesign of the preflight content or dialog visual language.
- No broad shared-dialog refactor unless the scoped approach is proven insufficient.
- No unrelated formatting or CSS cleanup.
