# BOQ Post-Parse Review Workspace Design

**Date:** 2026-07-18
**Status:** Approved for implementation planning

## Goal

After a BOQ PDF is uploaded and parsed successfully, take the user directly to the saved BOQ's detail route in an immediately usable review mode. The user must be able to compare the source PDF with parsed data, complete missing metadata, resolve catalog matches, and approve the BOQ without first clicking **Review matches after save** or a separate **Review** action.

## User Flow

1. The user selects a PDF and chooses **Upload & Parse** on the BOQs page.
2. The existing atomic import endpoint stores the source PDF, parses it through Docling, and returns the saved BOQ.
3. On success, the client navigates to `/boqs/{id}?mode=review`.
4. The BOQ detail page loads the saved BOQ and opens the embedded review workspace immediately.
5. The user checks the source PDF, completes missing project metadata, edits parsed line items, and confirms or creates catalog matches.
6. The user can save a draft or approve the BOQ using the existing persistence and validation rules.
7. A later row-level **Review** action opens the same detail route and review mode. Normal detail navigation can continue to open the standard BOQ detail view.

Upload or parse failures remain in the upload modal with the existing safe error message and retry path. Navigation occurs only after the server has returned a successfully saved BOQ.

## Review Workspace Layout

Review mode is embedded in the BOQ detail page rather than shown as a second modal over the BOQs list.

- The existing application sidebar and BOQ detail context remain visible.
- A compact review header identifies the BOQ and provides **Save draft** and **Approve BOQ** actions.
- The main workspace uses a balanced side-by-side layout:
  - source PDF on the left;
  - metadata, parsed items, verification findings, and catalog matching on the right.
- The matching panel is available immediately. There is no intermediate **Review matches after save** gate.
- On narrow screens, the workspace uses the project's responsive fallback rather than allowing unusably narrow panes.

The implementation should reuse the existing review editing, verification, matching, and approval logic. The route-level workspace may extract reusable state and content from `ReviewPanel`, but it must not create a second independent review workflow.

## Resizable Split

A visible separator between the PDF and matching panels supports pointer dragging.

- The initial ratio is balanced, approximately 50/50.
- Dragging the separator updates the left-panel width continuously.
- The ratio is clamped so both panels retain a usable minimum width.
- The separator exposes appropriate accessibility semantics and keyboard adjustment where supported.
- The last active split is retained while the user toggles Collapse or Full PDF during the current review session.
- Cross-page persistence is not required.

## PDF Pane Display Modes

Only the left PDF pane owns display controls. The right matching pane does not have a Collapse action.

### Collapse

- **Collapse** hides the PDF pane and expands the matching panel to the full workspace width.
- A compact **Show PDF** affordance remains at the left edge.
- Restoring the PDF returns to the previously active split ratio.

### Full PDF

- **Full PDF** expands the PDF inside the same detail page and temporarily hides the matching panel.
- An **Exit full PDF** action restores the previous split ratio.
- Full PDF does not open a new browser tab.

### State Preservation

Collapse, restore, Full PDF, and Exit full PDF preserve the current document page, zoom level, and pan position for the active BOQ. Opening another BOQ initializes the viewer in Fit Page mode.

## PDF Area Zoom and Pan

The embedded viewer provides an application-controlled PDF canvas instead of relying solely on the browser's native embedded-PDF controls.

The toolbar includes:

- **Box Zoom**;
- **Zoom Out**;
- **Fit Page**;
- **Reset**;
- the current zoom percentage;
- the previously approved Collapse and Full PDF display controls.

### Box Zoom Interaction

1. The user selects **Box Zoom**.
2. The pointer changes to a crosshair over the PDF canvas.
3. The user drags a rectangle around a specific BOQ row or document area.
4. Releasing the pointer scales and positions that selection to fit the available PDF viewport.
5. The viewer automatically switches to Pan mode.

An unfinished selection can be cancelled with `Escape`. A tiny or accidental selection is ignored rather than producing an extreme zoom.

### Pan Interaction

- When the document is zoomed, click-dragging moves the visible document area.
- The cursor communicates the available and active pan states.
- Selecting Box Zoom again permits another area selection.
- Zoom and pan calculations are constrained so the document cannot become irretrievably lost outside the viewport; **Fit Page** and **Reset** always recover a known view.

## Data and State Boundaries

- The import response remains the source of the BOQ identifier used for navigation.
- The detail route loads canonical BOQ data rather than trusting a browser-only draft from the upload modal.
- Review form state remains local until Save draft or Approve BOQ invokes the existing APIs.
- PDF display state consists of split ratio, display mode, zoom, pan offset, current page, and active tool.
- Review data state and PDF display state remain separate so visual operations cannot reset form edits.
- Changing BOQ identity resets PDF display state and initializes review state from the newly loaded BOQ.

## Error Handling

- Upload or parse errors keep the user on the BOQs page with the upload modal available for retry.
- If the BOQ detail fetch fails, show the existing route-level error and retry behavior.
- If the source PDF cannot load, the matching panel remains usable and the PDF pane offers **Retry preview** and **Open PDF** fallbacks.
- Save or approval failures preserve all metadata, item edits, catalog decisions, and PDF display state, and show the existing safe error message.
- Box Zoom or pan errors must fail back to Fit Page without affecting review edits.

## Accessibility

- All PDF toolbar actions have visible labels or accessible names and expose pressed state where applicable.
- The resizer is identified as a separator and supports keyboard adjustment.
- Box Zoom selection is not the only way to zoom; toolbar controls remain keyboard operable.
- Focus remains predictable when entering or leaving collapsed and full-PDF modes.
- Status, parsing, loading, and save feedback continue to use appropriate live-region behavior.

## Testing Strategy

Implementation follows test-driven development with focused behavior tests before production changes.

Automated coverage must verify:

1. successful import navigates to the returned BOQ detail route with `mode=review`;
2. unsuccessful import does not navigate away;
3. review mode renders the existing source-and-matching workflow immediately, without a **Review matches after save** gate;
4. a later **Review** action targets the same detail review route;
5. divider dragging respects the configured minimum and maximum ratios;
6. Collapse hides only the PDF pane and Show PDF restores the prior ratio;
7. Full PDF hides matching and Exit full PDF restores the prior ratio;
8. Box Zoom converts a dragged rectangle into the expected scale and pan position;
9. tiny selections and `Escape` cancellation do not change the view;
10. post-zoom dragging pans the document and Reset/Fit Page recover the default view;
11. PDF display changes do not reset unsaved review edits;
12. save, source-loading, and parse failure paths preserve their current safe fallbacks.

Run the relevant unit and component tests, the broader project test suite, lint/type checks, a production build, and targeted browser verification of the complete upload-to-review flow.

## Out of Scope

- Cross-session persistence of split ratio, zoom, or pan position.
- Opening Full PDF in a separate tab.
- Collapsing the right matching panel.
- Replacing the existing BOQ parsing, review validation, catalog matching, or approval business rules.
- General-purpose PDF annotation, drawing, or OCR correction tools.
