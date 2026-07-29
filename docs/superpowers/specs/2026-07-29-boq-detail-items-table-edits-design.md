# BOQ Detail — Items Table Edits (Review Workspace)

- **Date:** 2026-07-29
- **Status:** Draft — awaiting user review
- **Owner:** frontend
- **Scope:** `src/app/(authenticated)/boqs/[id]/page.tsx` and the unified BOQ items table it renders.

## Context

The BOQ detail page (`/boqs/[id]`) shows parsed BOQ line items in a unified table
(`UnifiedBoqItemsTable`) with columns: Description, Unit, Qty, Rate, Material, Labour, Total,
and a Catalog match cell. A row of type filter chips (`All / Unit / Lump Sum / Job`) sits
above the table.

During review the consultant flagged five friction points on this table:

1. The type filter chips are not useful and add noise.
2. There is no way to delete a line item (a `DELETE /api/boqs/[id]/items` endpoint already
   exists, but no UI exposes it).
3. The **Unit** column is free-text; it should be a dropdown of standard units with an inline
   way to add a new unit.
4. The **Qty** column uses a native `type="number"` input whose up/down spinners are unwanted.
5. The **Rate** column is frequently a *disabled* number input, which the browser renders as a
   grey background with low-contrast text — hard to read. Rate is a calculated value
   (material + labour, set at extraction), so it should be a clearly-readable read-only display.

> Note: an "undo when accidentally clicked Exclude" was originally requested but **dropped** by
> the user — the existing "Find match" recovery on excluded rows is sufficient. No change there.

## Goals

- Remove the type filter chips.
- Add per-row delete with a non-destructive Undo.
- Make Unit a searchable dropdown (combobox) with inline "+ add new unit".
- Make Qty a clean text field (no spinners), still editable.
- Make Rate an always-read-only, readable display.

## Non-goals

- Exclude-undo (out of scope — dropped).
- Live recompute of Rate from Material/Labour edits (Rate is a stored, extraction-derived
  value; making the cell read-only is the extent of this change).
- Persisting newly-added units to a shared master list (session-scoped only for now).
- Any backend change — the `DELETE` endpoint already exists and is reused as-is.
- Changes to the BOQ *listing* page (`/boqs`) or other pages.

## Resolved decisions (from brainstorming)

| Decision | Choice |
| --- | --- |
| Exclude undo | **Dropped** — keep current "Find match" recovery. |
| Delete semantics | **Permanent delete + Undo toast** (client-side restore window, then commit). |
| Delete control placement | **Hover-revealed trash** at the row's right edge (no permanent column header). |
| Unit control | **Combobox** (searchable dropdown) with inline "+ add new unit". |
| Qty control | **Plain text, no spinners** (still editable). |
| Rate control | **Always read-only** display — Rate is a calculated value, never typed. |

## Detailed design

### 1. Remove the type filter chips

**File:** `src/app/(authenticated)/boqs/[id]/page.tsx`

- Delete `const FILTERS = ["All", "Unit", "Lump Sum", "Job"]`.
- Delete the `activeFilter` state and the `type`-filter branch in the section memo
  (the branch that maps `Unit/Lump Sum/Job` to `item.type`).
- Delete the chip JSX block (`FILTERS.map(...)` rendering `.filter-chip` buttons).
- **Keep** the search input and its filtering.

**Effect:** every priced row renders regardless of `item.type`; search still narrows the list.

### 2. Unit column → combobox + inline "+ add new unit"

**New file:** `src/lib/units.ts`

```ts
// Aligned with the units documented on the Settings page.
export const STANDARD_UNITS = [
  "m³", "m²", "m", "ton", "ea", "set", "kg", "LS", "no.", "lot", "hr", "day",
] as const
export type UnitOption = string
```

**New file:** `src/components/unit-combobox.tsx` (client component)

A **lightweight combobox built from existing primitives** (consistent with the search pattern
already used in `catalog-match-modal.tsx`, which is a plain `<input>` + filtered list — there is
no `cmdk`/`@radix-ui/react-popover` in the project today).

- **Trigger:** a `<Button variant="outline">` showing the current unit (or placeholder "Unit").
- **Panel:** an absolutely-positioned dropdown (high z-index) containing:
  - a search `<Input>` that filters the unit list by substring (case-insensitive),
  - the matching units as clickable options (select → `onChange(value)`),
  - an **"➕ Add new unit"** row → reveals an inline text input with Save / Cancel;
    Save trims the value and, if non-empty and not already present, calls `onAddUnit(value)`
    and selects it.
- Closes on: option select, outside-click, or `Escape`.
- `disabled` when the row is locked; honours `readOnly`.

**Props:**

```ts
interface UnitComboboxProps {
  value: string
  units: string[]               // STANDARD_UNITS ∪ session custom units
  onChange: (unit: string) => void
  onAddUnit: (unit: string) => void
  disabled?: boolean
  readOnly?: boolean
  ariaLabel?: string
}
```

**Wire-up in `unified-boq-items-table.tsx`:** replace the Unit `<Input>` cell with
`<UnitCombobox value={row.item.unit} units={units} onChange={(u)=>onFieldChange(row,"unit",u)}
onAddUnit={onAddUnit} disabled={locked} readOnly={readOnly} ... />`.

**Wire-up in `boqs/[id]/page.tsx`:**

- Add `const [customUnits, setCustomUnits] = useState<string[]>([])`.
- Pass `units={[...STANDARD_UNITS, ...customUnits]}` and
  `onAddUnit={(u)=>setCustomUnits(prev => prev.includes(u) ? prev : [...prev, u])}` through the
  table to each `UnitCombobox`.

New units are **session-scoped** (available to other rows during the session, not persisted).

> **Alternative considered:** `npx shadcn add popover command` to install a canonical shadcn
> combobox (adds `cmdk` + `@radix-ui/react-popover`). **Not chosen** to avoid new dependencies
> and to stay consistent with the existing in-repo search pattern. Can be revisited if a richer
> combobox is wanted elsewhere.

### 3. Qty → plain text, no spinners

**File:** `src/components/unified-boq-items-table.tsx`

Replace the Qty cell:

```tsx
<Input
  aria-label={`Quantity for ${row.item.desc}, row ${rowNumber}`}
  type="text"                 // was type="number"
  inputMode="decimal"
  value={row.item.qty ?? ""}
  disabled={locked}
  onChange={(e) => onFieldChange(row, "qty", parseQtyInput(e.target.value))}
/>
```

- `parseQtyInput`: accept empty string → store `undefined` (do **not** coerce `""` to `0`).
  Otherwise coerce to a finite non-negative number; reject garbage.
- Right-aligned mono numeric styling preserved (existing `.num-col`).

**CSS (`src/app/globals.css`)** — belt-and-suspenders spinner hide, scoped to this table:

```css
.unified-boq-items-table input[type="number"]::-webkit-inner-spin-button,
.unified-boq-items-table input[type="number"]::-webkit-outer-spin-button {
  -webkit-appearance: none; margin: 0;
}
.unified-boq-items-table input[type="number"] { -moz-appearance: textfield; }
```

### 4. Rate → always read-only, restyled

**File:** `src/components/unified-boq-items-table.tsx`

Replace the Rate cell (currently `<Input type="number" disabled={rateLocked} ...>`) with a
read-only display:

```tsx
<td className="num-col unified-boq-rate" data-label="Rate">
  <span className="unified-boq-rate-value">
    {row.item.rate != null ? formatRate(row.item.rate) : "—"}
  </span>
</td>
```

- `formatRate`: `Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })`
  (e.g. `3,850`), matching the table's mono/tabular numeric style.
- **Value source:** `row.item.rate` — the unit rate computed at extraction
  (`combinedRate` = material + labour). It is **not** live-recomputed on Material/Labour edits
  in this change.
- **Behavior change (confirmed):** Rate is **never directly editable**. Price adjustments happen
  via the Material / Labour columns. The previous "editable when unlocked" path is removed.

**CSS (`src/app/globals.css`)** — readable, not disabled-grey:

```css
.unified-boq-items-table td.unified-boq-rate {
  background: color-mix(in oklab, var(--accent) 6%, transparent);
}
.unified-boq-rate-value {
  display: block;
  text-align: right;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--fg);          /* full-opacity foreground, not disabled grey */
}
```

Subtle accent tint + full-opacity `--fg` text gives an easy visual check without the
browser "disabled" look.

### 5. Delete row + Undo toast

**`src/components/unified-boq-items-table.tsx`:**

- Add prop `onDelete?: (row: UnifiedBoqPricedRow) => void`.
- Add a trailing actions cell to each priced row (and an empty cell on informational rows to
  keep column counts consistent — update the informational row's `colSpan` accounting):

  ```tsx
  <td className="unified-boq-row-actions" data-label="Actions">
    {!readOnly && (
      <Button type="button" variant="ghost" size="icon" aria-label={`Delete row ${rowNumber}`}
              disabled={disabled} onClick={() => onDelete?.(row)}>
        <Trash2 className="size-4" />
      </Button>
    )}
  </td>
  ```

- Add a matching empty `<th></th>` in the header (or omit header label) so the column aligns.

**CSS** — hover-reveal:

```css
.unified-boq-items-table .unified-boq-row-actions {
  opacity: 0;
  transition: opacity 0.12s ease;
  text-align: right;
  white-space: nowrap;
}
.unified-boq-items-table tbody tr:hover .unified-boq-row-actions,
.unified-boq-items-table .unified-boq-row-actions:focus-within { opacity: 1; }
/* keep visible on touch / no-hover devices */
@media (hover: none) {
  .unified-boq-items-table .unified-boq-row-actions { opacity: 1; }
}
```

**`src/app/(authenticated)/boqs/[id]/page.tsx` — `handleDelete(row)`:**

Optimistic remove + Undo window + commit-on-expire, reusing the existing endpoint.

```ts
async function handleDelete(row: UnifiedBoqPricedRow) {
  // Stash the row plus the index of its item within its section, so Undo can
  // re-insert it in the same position. (sectionItemsIndex is read from the
  // section the row belongs to, before removal.)
  const stash = { sectionIndex: row.sectionIndex, sectionItemsIndex: row.sectionItemsIndex, item: row.item }
  // 1) optimistically remove from local sections state
  removeRowLocally(stash)
  let undone = false
  toast("Line item deleted", {
    duration: 6000,
    action: { label: "Undo", onClick: () => { undone = true; restoreRowLocally(stash) } },
    onAutoClose: async () => {
      if (undone) return
      // 2) commit via existing DELETE endpoint
      const res = await fetch(`/api/boqs/${id}/items`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sectionIndex: stash.sectionIndex, itemId: stash.item.id }),
      })
      if (!res.ok) {
        toast.error("Could not delete item — restored.")
        restoreRowLocally(stash)     // rollback on failure
        return
      }
      // 3) apply returned boq (sections / totalItems / grandTotal / stdStatus)
      const { boq } = await res.json()
      applyBoqState(boq)
    },
  })
}
```

- **Undo** restores the row locally and sets `undone` so the auto-close handler skips the
  `DELETE`. (Sonner fires `onAutoClose` after the duration; using the `undone` flag avoids a
  double path when the action is clicked.)
- **Commit body:** `{ sectionIndex, itemId }` (the endpoint also accepts `itemCode`). The
  endpoint returns the recomputed BOQ and prunes orphaned standards — applied to local state.
- Disabled / hidden in `readOnly` mode (no delete control rendered).

## Data flow summary

- **Unit:** `UnitCombobox` → `onFieldChange(row,"unit",u)` (unchanged field-change path); new
  units flow `onAddUnit` → page `customUnits` state → merged back into every combobox's list.
- **Qty:** text input → `parseQtyInput` → `onFieldChange(row,"qty",n|undefined)`.
- **Rate:** read-only render of `row.item.rate` (no write path).
- **Delete:** `onDelete(row)` → optimistic local remove → Undo toast → (on expire) `DELETE`
  endpoint → apply returned BOQ state.

## Files touched

| File | Change |
| --- | --- |
| `src/app/(authenticated)/boqs/[id]/page.tsx` | Remove type chips; `customUnits` state + `units`/`onAddUnit` props; `handleDelete` + toast + `DELETE`; pass `onDelete`. |
| `src/components/unified-boq-items-table.tsx` | Unit → `UnitCombobox`; Qty → text; Rate → read-only; delete button + `onDelete` prop; header/colspan accounting. |
| `src/components/unit-combobox.tsx` | **New** — lightweight combobox (search + inline add). |
| `src/lib/units.ts` | **New** — `STANDARD_UNITS`. |
| `src/app/globals.css` | Rate styling, qty spinner hide, row-actions hover, combobox panel styles. |

## Testing

- `src/components/unified-boq-items-table.test.ts`
  - Qty renders a `type="text"` `inputMode="decimal"` input (no native spinner).
  - Rate renders a read-only value (not an `<input>`), with `formatRate` text.
  - Unit cell renders the `UnitCombobox` trigger.
  - Delete button calls `onDelete` with the row; absent when `readOnly`.
  - `.unified-boq-row-actions` present (hover-reveal is CSS, not asserted beyond presence).
- `src/components/unit-combobox.test.ts` (**new**)
  - Renders given `units`; filters by search substring; selecting calls `onChange`.
  - "Add new unit" flow calls `onAddUnit` with the trimmed value and selects it; empty/duplicate
    values are ignored.
- BOQ detail page test
  - The `All / Unit / Lump Sum / Job` chips are no longer rendered.
  - `handleDelete` fires `DELETE /api/boqs/:id/items` with `{ sectionIndex, itemId }` on
    auto-close; Undo prevents the request; failed delete restores the row.
- Run `npm run check` (per project rules).

## Assumptions & open items

- **Row identity for delete:** `UnifiedBoqPricedRow` is assumed to expose `sectionIndex`,
  `sectionItemsIndex` (the item's position within its section, for Undo re-insertion), and
  `item.id` (or `item.code`). To be verified at the start of implementation; if any of these
  aren't on the row, derive them from the containing section in the page handler.
- **Rate value source:** `row.item.rate`. No live recompute from Material/Labour edits.
- **New units** are session-scoped; persistence to a master list is a follow-up.
- **Combobox** uses existing primitives (no new deps). Canonical shadcn `popover`+`command` is
  the documented alternative if a richer shared combobox is later desired.
- **Undo window** is 6s and client-side only; the backend `DELETE` is the source of truth on
  commit.

## Alternatives considered

- **Exclude undo** — dropped by user (current "Find match" recovery is sufficient).
- **Unit control** — native `<select>` + "Add new unit" (simpler) vs **combobox (chosen)** vs
  `<datalist>`.
- **Delete control** — trailing actions column vs **hover trash (chosen)**.
- **Rate** — editable-when-unlocked vs **always read-only (chosen)**.
- **Combobox deps** — install `cmdk` + radix-popover vs **lightweight from existing primitives
  (chosen)**.
