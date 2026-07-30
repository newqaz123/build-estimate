# BOQ Detail Controls Refinement Design

**Date:** 2026-07-30  
**Status:** Approved interaction design; awaiting written-spec review  
**Open Design reference:** `buildestimate-boq-full-table-controls`  
**Interactive prototype:** <http://127.0.0.1:49828/api/projects/buildestimate-boq-full-table-controls/raw/index.html>

## 1. Goal

Refine the BOQ detail item table so the unit selector and row delete action are visually clear, usable inside the horizontally scrolling table, and safe while local edits are unsaved. Replace session-only custom units with workspace-wide persistence. Preserve every production table column and all existing catalog behavior.

## 2. Scope

### In scope

- Redesign `UnitCombobox` as a compact trigger with a portaled searchable menu.
- Persist user-added units workspace-wide.
- Keep added-unit selection local to the BOQ draft until the user clicks **Save draft**.
- Replace the scrolling Actions column behavior with a sticky visible-edge action rail.
- Allow delete and other row actions while unrelated drafts are unsaved.
- Replace positional draft keys with stable item-identity keys.
- Narrow global busy state into action-specific busy states.
- Add an unobtrusive **Unsaved changes** status beside **Save draft**.
- Let users approve the saved BOQ version while explicitly discarding unsaved drafts.
- Preserve delete Undo for six seconds.

### Out of scope

- No change to the **Match BOQ item to catalog** dialog. Chromium measurement confirms that it is centered; the reported Safari offset was stale rendering.
- No redesign of PDF controls, metadata fields, Material/Labour behavior, Rate calculation, Total calculation, or catalog-matching logic.
- No unit-management screen in Settings. This cycle supports adding and consuming workspace units only.
- No production migration is run locally.

## 3. Root causes

### Unit combobox

The current menu is absolutely positioned inside a narrow table cell and an overflow context. Its intended minimum width is defeated by the table/scroll layout, producing an unframed narrow text stack.

### Row delete

The current delete control lives in a normal final table column. The table is wider than the visible BOQ panel, so the action scrolls outside the viewport and becomes undiscoverable.

### Save-before-delete restriction

Drafts are currently keyed as `${sectionIndex}-${itemIndex}`. Deleting an item or pruning an empty section changes later positions, so drafts can be applied to the wrong row. The current code prevents all deletion while any draft exists to avoid that corruption.

### Session-only units

Custom units currently live only in component state. Reloading the page or opening another BOQ loses them.

## 4. Full table contract

The production table keeps the following column order:

1. Description
2. Unit
3. Qty
4. Rate — calculated and read-only
5. Material — editable where applicable, with source evidence
6. Labour — editable where applicable, with source evidence
7. Total — formatted currency
8. Catalog — existing matched/unmatched/excluded states and actions
9. Sticky delete action rail — visually unlabeled; accessible name remains

The table may scroll horizontally. Material, Labour, Total, and Catalog remain real columns rather than being collapsed into a drawer or omitted. The action rail stays at the visible right edge while these columns scroll beneath it.

## 5. Unit combobox design

### Trigger

- Width: fills the existing 80–96px Unit column.
- Height: 28–32px to match other dense table inputs.
- Radius: 7px or the nearest existing small-radius token.
- Displays the selected unit and a compact chevron.
- Uses `aria-haspopup="listbox"`, `aria-expanded`, and `aria-controls`.
- Open/focus state uses the existing Airtable-blue focus ring.

### Floating menu

- Render through a portal outside the table overflow context.
- Width: 244px; acceptable implementation range 240–260px.
- Position relative to the trigger with viewport collision handling and flipping.
- Close on outside pointer, Escape, trigger re-click, and relevant scroll/resize.
- Return focus to the trigger on close.
- Search field height: 34px.
- Option height: 32px.
- Option list maximum height: 192px.
- Selected option has a visible check and `aria-selected="true"`.
- Keyboard support: Arrow Up/Down, Home/End, Enter, Escape, and type/search input.

Use the existing Base UI primitives when they provide portal positioning and keyboard behavior; do not recreate a partial accessibility model if the primitive can supply it.

### Add workspace unit

The footer action is labeled **Add workspace unit**.

The add state replaces the browse state inside the same floating surface:

- Label: **Workspace unit**
- One text input, maximum 24 characters
- Supporting copy: **Available in all BOQs in this workspace.**
- Explicit buttons: **Cancel** and **Add unit**
- No icon-only confirmation/cancel buttons

Normalization rules:

- Trim leading/trailing whitespace.
- Reject blank values and control characters.
- Maximum 24 characters after trimming.
- Compare duplicates case-insensitively.
- Preserve the first stored display casing.
- Maximum 200 custom workspace units.
- Preserve insertion order.

On success:

1. Persist the unit to workspace settings.
2. Add it to the current option list.
3. Select it as a local draft for the current BOQ row.
4. Close the menu.
5. Show quiet confirmation: `“<unit>” added to workspace units`.
6. Show **Unsaved changes** because the row selection is not persisted until **Save draft**.

If the unit already exists, select the existing unit without writing a duplicate.

On failure, keep the add form open, preserve the typed value, and show an inline error. Do not report success.

## 6. Workspace-unit persistence

Extend `WorkspaceSettings` with:

```ts
interface UnitSettings {
  customUnits: string[]
}

interface WorkspaceSettings {
  llm: LlmSettings
  docling: DoclingSettings
  fuzzy: FuzzySettings
  prompts: PromptSettings
  units: UnitSettings
}
```

`DEFAULT_SETTINGS.units` is `{ customUnits: [] }`. Reading an older settings document without `units` returns this default without requiring an offline migration.

### Read flow

The BOQ detail page loads `/api/settings` and combines:

```ts
[...STANDARD_UNITS, ...settings.units.customUnits]
```

The combined list is normalized and deduplicated case-insensitively. Standard units retain their existing order; custom units follow in stored insertion order.

If settings loading fails, standard units remain usable and the menu shows a nonblocking workspace-unit load error. Existing BOQ editing must remain available.

### Add flow

Add authenticated `POST /api/settings/units`.

Request:

```json
{ "unit": "bag" }
```

Success response:

```json
{ "unit": "bag", "customUnits": ["bag"] }
```

The route atomically reads the workspace settings document, normalizes the submitted unit, merges it into `units.customUnits`, and writes the merged list in one transaction. It returns status 200 for both a new unit and an idempotent duplicate. Concurrent additions must not overwrite one another. Validation failures return 400, unauthenticated calls return 401, and the 200-unit cap returns 409.

The visual prototype uses local storage only to simulate persistence. Production code must use this workspace settings endpoint.

## 7. Sticky delete rail

- Width: 40px.
- `position: sticky; right: 0` inside the table scroller.
- A 20–24px white-to-transparent edge scrim separates it from scrolling content.
- Delete target: minimum 32×32px.
- Tooltip and accessible label: **Delete item** (row description may be appended for assistive context).
- Hidden at rest on hover-capable pointers.
- Revealed by row hover, row `focus-within`, and direct keyboard focus.
- Always visible for coarse/touch pointers.
- Neutral icon color initially; danger color/background only on hover or focus.
- Section and informational rows do not show a delete control unless they are independently deletable under existing rules.

Clicking delete:

1. Removes the row from the visible table immediately.
2. Removes only that row's local draft from the active draft map and stores it in the delete stash.
3. Shows **Item deleted** with **Undo** for six seconds.
4. Does not disable unrelated rows or actions.
5. Commits deletion after the Undo window.

Undo restores the row at its original visible position and restores only that row's stashed draft.

If the backend delete fails, restore the row and its draft automatically and show the returned error.

## 8. Stable draft identity

Replace positional draft keys with stable BOQ item identity from `getBoqItemIdentityKey(item)` (`id` first, then `code`). No draft key may be derived from `sectionIndex` or `itemIndex`.

Editable canonical BOQ items must have an item identity that is unique within the BOQ. Existing ingestion, accepted-proposal, and add-missing-item paths are expected to assign IDs; tests must enforce this invariant. If a legacy item lacks both `id` and `code`, or if the resulting identity is duplicated within the BOQ, persistent row actions must fail explicitly for the affected row rather than silently falling back to a positional key.

`BoqDetailEdits` becomes keyed by stable identity. Save logic resolves each identity against the latest BOQ before building PATCH updates. Reconciliation after immediate server mutations also resolves by identity.

Reconciliation rules:

- Unrelated drafts survive item insertion, deletion, section pruning, catalog actions, and server refreshes.
- A mutation that changes the same row's canonical Description or Unit clears only the conflicting local `desc` or `unit` draft field.
- Other fields on that row remain local.
- A deleted row's draft moves into its delete stash; commit discards it, Undo restores it.
- Missing or ambiguous identity resolution produces a visible error and leaves other drafts untouched.

## 9. Non-blocking actions and busy states

Unsaved drafts do not disable:

- Delete item
- Unit selection
- Add workspace unit
- AI suggest
- Find match / Change match
- Accept or dismiss catalog suggestion
- Exclude
- Include optional item
- Add missing item
- Metadata editing

Replace the current broad `mutationBusy` usage with action-specific state:

- Saving disables draft inputs and **Save draft** only for the save request.
- Catalog mutation disables the affected catalog controls, not the whole table.
- Add-item mutation disables **Add missing item** only.
- Pending delete hides the affected row but does not disable unrelated rows.
- Background delete commit does not disable unrelated rows.
- Approval disables approval controls while in flight.
- Approved BOQs remain fully read-only under existing rules.

Deferred delete commits run through one serialized promise queue. Immediately before each request, the queue resolves the item's current section from the latest `boqRef.current` by stable identity, then sends the current section index plus item request identity. This prevents one committed deletion or section prune from staling the next deletion's locator.

A pending delete/Undo window may temporarily block final approval because the saved version is not settled; it must not block ordinary row editing or catalog actions.

## 10. Unsaved status and explicit save semantics

When item or metadata drafts exist, show a small amber-dot status beside **Save draft**:

> Unsaved changes

Drafts remain local until **Save draft** succeeds. If the user navigates away without saving, existing navigation behavior governs; this design does not add autosave.

Adding a workspace unit persists the unit definition immediately, but applying it to the current BOQ row remains a local draft until **Save draft**.

## 11. Approve saved version

Unsaved drafts no longer disable **Approve BOQ**. Existing saved-data blockers—verification issues, catalog readiness, pending destructive mutation, authentication, and server validation—continue to govern approval.

When drafts exist, clicking **Approve BOQ** opens an accessible alert dialog:

**Title:** Approve saved version?  
**Body:** `<count> unsaved change(s) will not be included and will be discarded.`  
**Actions:** **Cancel** / **Approve saved version**

On confirmation:

1. Send only `{ status: "approved" }`; do not save drafts.
2. Clear item and metadata drafts only after approval succeeds.
3. Transition to existing read-only approved state.
4. Show the existing approval success feedback.

Confirming closes the warning and starts approval. If approval fails, show the server error toast and preserve every draft; the user can click **Approve BOQ** to retry.

## 12. Catalog behavior

The Match BOQ item dialog is unchanged.

Catalog actions remain available while drafts exist. After a catalog mutation returns an updated BOQ, reconcile drafts by stable identity. Canonical Description/Unit changes win over conflicting local fields, while unrelated local fields and drafts on other rows remain.

## 13. Accessibility

- Portaled menu follows listbox/combobox semantics and is keyboard operable.
- Focus is never trapped in a closed unit menu.
- Sticky delete button is reachable in logical row tab order even when visually hidden.
- Delete reveal never depends on hover alone.
- Tooltips supplement, not replace, accessible names.
- Approval warning uses an alert-dialog pattern with initial focus on the safe action.
- Toasts remain announced through the existing live region.
- Reduced-motion preferences suppress nonessential popover/toast motion.

## 14. Responsive behavior

- Desktop keeps the existing split PDF/table workspace.
- The full table remains horizontally scrollable at narrow widths.
- Sticky action rail remains visible at the scroller edge.
- Portaled unit menu constrains itself to viewport gutters and flips when needed.
- Existing card-style narrow table layout remains supported; the action is visible on touch and the unit menu remains portaled.

## 15. Error handling

- Workspace-unit load failure: use standard units and show nonblocking status.
- Workspace-unit add failure: preserve form/input and show inline error.
- Duplicate workspace unit: select canonical existing value; no duplicate record.
- Delete commit failure: restore row and its draft automatically.
- Draft reconciliation failure: preserve unrelated drafts and identify the affected row.
- Approval failure: preserve all drafts.
- Save failure: preserve all unsaved item/metadata drafts.

## 16. Testing strategy

### Unit and API tests

- Normalize, trim, limit, deduplicate, and preserve custom units.
- Read older settings documents without `units`.
- Auth, validation, idempotency, 200-unit cap, and concurrent-safe add behavior.
- Combine standard and custom units without duplicates.

### Draft-state tests

- Stable identity keys survive item insertion/deletion and section pruning.
- Delete with unrelated drafts remains allowed.
- Deleting a drafted row stashes only that draft.
- Undo restores that row and draft.
- Successful commit discards only that draft.
- Failed commit restores row/draft.
- Catalog mutation clears only conflicting Description/Unit fields.
- Save resolves current item locations by identity.

### Component/source contract tests

- Unit menu is portaled/floating and not nested under table overflow.
- Add form has named Cancel/Add actions and workspace-scope copy.
- Table has the complete production column order.
- Action rail is sticky and has hover, focus-within, keyboard, and coarse-pointer visibility.
- Approve button is not disabled solely by unsaved drafts.
- Approval warning uses the exact approved copy.

### Browser QA

At desktop and narrow widths:

1. Open Unit menu near top, bottom, left, and right edges.
2. Search/select standard and custom units with mouse and keyboard.
3. Add a workspace unit; reload and open another BOQ to confirm persistence.
4. Horizontally scroll to Material/Labour/Total/Catalog while the delete rail stays visible.
5. Edit two rows, delete one, Undo, then let deletion expire; confirm the other draft remains.
6. Run catalog actions while drafts exist.
7. Approve with drafts; cancel once, then approve saved version and confirm drafts are excluded.
8. Verify touch/coarse-pointer delete visibility and keyboard focus.

## 17. Success criteria

- The unit menu never collapses or clips inside the table.
- Added units survive reload and are available in other BOQs/users in the workspace.
- The delete action remains visible/reachable at the scroller's right edge.
- Unsaved drafts never block ordinary row/catalog actions.
- Item/section deletion cannot move a draft onto another row.
- Approving with drafts explicitly approves only the saved version.
- All existing table columns and catalog states remain intact.
- `npm run check` passes after implementation.
