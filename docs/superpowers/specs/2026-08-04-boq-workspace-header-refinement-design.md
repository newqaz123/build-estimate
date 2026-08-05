# BOQ Workspace Header Refinement — Design

**Date:** 2026-08-04  
**Status:** Approved for planning

## Objective

Simplify the BOQ workspace header by removing redundant navigation, integrating the workspace view switch into the command bar, and giving the two review controls distinct, user-oriented labels.

## Current UX problem

The header currently presents three competing navigation layers:

1. the application navigation and page-level Back control;
2. a workspace-level **Back to Compare** link;
3. a separate full-width **Review Extraction / Compare Catalog** tab row.

The workspace back link duplicates the application navigation. The phrases **Review Extraction** and **Extraction review** are also too similar even though they control different layers: the first changes the whole workspace view, while the second opens a focused panel of extraction correction proposals.

## Approved layout

### Command bar

The BOQ command bar remains one visual unit:

- left: BOQ project, vendor, lifecycle badge, and read-only state when applicable;
- right: workspace switch, contextual review controls, save/approval actions, blocker feedback, and overflow menu.

The **Back to Compare** link is removed. Users reach Compare through the existing application navigation. Validated `returnTo` behavior remains supported by the route contract; this refinement removes only the visible workspace link.

### Workspace switch

The existing URL-addressable tabs become a compact segmented switch on the right side of the command bar:

- **Edit & Verify** — the editable extraction-review workspace;
- **Compare Catalog** — the read-only catalog comparison workspace.

The existing issue and unmatched-count badges remain attached to their corresponding choices. The switch retains tab semantics, focus visibility, `aria-selected`, and panel relationships.

### Contextual extraction control

The button that toggles the right pane is renamed:

- when BOQ items are visible: **Extraction Suggestions**;
- when extraction suggestions are visible: **BOQ Items**.

**Extraction Suggestions** describes the panel accurately: it contains AI-assisted checks, source evidence, and proposed corrections. Opening it does not change the BOQ; corrections still require explicit acceptance.

### Persistent actions

The following controls remain visible and behaviorally unchanged:

- **Save draft**;
- **Approve BOQ**;
- approval-blocker feedback;
- overflow actions.

No action is moved into another panel or hidden behind the overflow menu as part of this refinement.

## Responsive behavior

At wide desktop widths, the workspace switch and actions share the command bar to the right of the BOQ identity.

At constrained widths:

1. the header may wrap;
2. the workspace switch occupies a clean full-width row;
3. the action group occupies a following row and remains right aligned;
4. controls preserve usable touch targets and visible keyboard focus;
5. BOQ identity truncation continues to prevent horizontal overflow.

The removed standalone tab row must not leave empty vertical space.

## Behavior preserved

This change does not alter:

- `view=review|compare` URL behavior;
- strict `safeCompareReturnPath` validation;
- opaque BOQ ID handling;
- comparison loading or read-only behavior;
- extraction suggestion mutation rules;
- save or approval behavior;
- approval blocker calculation;
- approved BOQ mutation protection.

## Component boundaries

- `BoqWorkspaceTabs` continues to own the accessible workspace switch markup and badges. Its presentation changes from a standalone row to an embeddable segmented control.
- `CanonicalBoqWorkspace` moves `BoqWorkspaceTabs` into the header action area, removes the visible back link, and updates the extraction-pane labels.
- Responsive styling remains in `src/app/globals.css` under the existing BOQ workspace selectors.
- Route helpers and comparison data logic require no behavioral changes.

## Verification

Automated coverage must verify:

- the visible **Back to Compare** link is absent from the workspace header;
- **Edit & Verify** and **Compare Catalog** preserve tab semantics, counts, and selection behavior;
- the contextual control shows **Extraction Suggestions** and toggles back to **BOQ Items**;
- existing save, approval, and comparison tests remain green;
- TypeScript and lint checks pass.

Browser QA must verify desktop and narrow/mobile layouts, including wrapping, focus visibility, no empty tab-row gap, and unchanged navigation between the two URL-addressable workspace views.

## Out of scope

- changing the main application navigation;
- removing or weakening validated `returnTo` handling;
- changing extraction suggestion behavior;
- changing comparison behavior or approval rules;
- adding a workflow progress rail;
- reorganizing actions beyond the approved command-bar placement.
