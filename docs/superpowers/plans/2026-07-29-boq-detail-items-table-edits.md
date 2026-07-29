# BOQ Detail Items-Table Edits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply five review-table edits to the BOQ detail page (`/boqs/[id]`): remove the type filter chips, add per-row delete with Undo, make Unit a combobox with inline add, make Qty a spinner-less text field, and make Rate an always-read-only readable display.

**Architecture:** All edits live in `UnifiedBoqItemsTable` (`src/components/unified-boq-items-table.tsx`) and its sole consumer `src/app/(authenticated)/boqs/[id]/page.tsx`, plus a new `UnitCombobox` component, a new `STANDARD_UNITS` lib, and CSS in `src/app/globals.css`. Delete reuses the existing `DELETE /api/boqs/[id]/items` endpoint via the page's established mutation pattern (`applyMutationBoq(await res.json())`), with an optimistic-hide (`pendingDeletes`) + 6s Undo toast + deferred-commit-via-ref flow.

**Tech Stack:** Next.js (App Router, client components), React 19, TypeScript (`strict`), Tailwind + a `globals.css` design system, shadcn-style `ui/*` primitives, `lucide-react` icons, `sonner` ^2.0.7 toasts, `tsx --test` (node:test) for tests.

## Global Constraints

- Run `npm run check` after code changes (it runs `eslint && tsc --noEmit && npm test`). (From `AGENTS.md`.)
- Do not run production migrations locally. (From `AGENTS.md`.)
- Tests use `node:test` + `node:assert/strict` and render components with `renderToStaticMarkup` + regex asserts (no jsdom). **Interactive behavior** (combobox open/filter/add, delete undo) is therefore covered by (a) unit tests on pure helpers and (b) a manual QA checklist — not by DOM event simulation.
- Run a single test file with: `npx tsx --test <path>` (e.g. `npx tsx --test src/lib/units.test.ts`). Run the whole suite with `npm test`.
- Follow existing patterns: item identity in request bodies via `getBoqItemRequestIdentity(item)`; server mutations applied via `applyMutationBoq(await response.json() as Boq)`; toast via `toast`/`toast.success`/`toast.error`.
- Reference spec: `docs/superpowers/specs/2026-07-29-boq-detail-items-table-edits-design.md`.

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/lib/units.ts` (**new**) | `STANDARD_UNITS`, `filterUnits`, `normalizeNewUnit` pure helpers | T1 |
| `src/lib/units.test.ts` (**new**) | unit tests for the helpers | T1 |
| `src/components/unit-combobox.tsx` (**new**) | Lightweight combobox (search + inline add) built from `Button`/`Input` | T2 |
| `src/components/unit-combobox.test.ts` (**new**) | SSR tests for the combobox trigger | T2 |
| `src/components/unified-boq-items-table.tsx` (modify) | Rate read-only (T3), Qty text (T4), Unit→combobox + props (T5), delete cell + prop (T6) | T3–T6 |
| `src/components/unified-boq-items-table.test.ts` (modify) | update/add assertions for each table change | T3–T6 |
| `src/app/globals.css` (modify) | rate styling, qty spinner-hide, actions column + hover, combobox styles | T3, T4, T6, T2 |
| `src/app/(authenticated)/boqs/[id]/page.tsx` (modify) | remove chips (T7); delete handler + Undo + wire units/onAddUnit/onDelete (T8) | T7, T8 |
| `src/app/(authenticated)/boqs/[id]/page.test.ts` (**new**) | source-level regression guards (chips gone; delete wiring present) | T7, T8 |

---

## Task 1: `STANDARD_UNITS` + unit helpers

**Files:**

- Create: `src/lib/units.ts`
- Test: `src/lib/units.test.ts`

**Interfaces:**

- Produces:
  - `STANDARD_UNITS: readonly string[]`
  - `filterUnits(units: readonly string[], query: string): string[]` — case-insensitive substring filter, de-duplicated, order-preserving
  - `normalizeNewUnit(raw: string, existing: readonly string[]): string | null` — trim; reject empty or case-insensitive duplicates; otherwise return trimmed value

- [ ] **Step 1: Write the failing test**

Create `src/lib/units.test.ts`:

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { STANDARD_UNITS, filterUnits, normalizeNewUnit } from './units'

test('STANDARD_UNITS includes the settings-documented construction units', () => {
  const units = STANDARD_UNITS as readonly string[]
  for (const expected of ['m³', 'm²', 'm', 'ton', 'ea', 'set', 'kg', 'LS']) {
    assert.ok(units.includes(expected), `missing unit: ${expected}`)
  }
})

test('filterUnits matches case-insensitively, de-duplicates, preserves order', () => {
  assert.deepEqual(filterUnits(['m³', 'm²', 'm', 'ton'], 'm'), ['m³', 'm²', 'm'])
  assert.deepEqual(filterUnits(['m', 'M', 'kg'], ''), ['m', 'kg'])
  assert.deepEqual(filterUnits(['ton', 'Ton'], 'to'), ['ton'])
})

test('normalizeNewUnit trims, rejects empty and case-insensitive duplicates', () => {
  assert.equal(normalizeNewUnit('  m³  ', ['m', 'kg']), 'm³')
  assert.equal(normalizeNewUnit('', ['m']), null)
  assert.equal(normalizeNewUnit('   ', ['m']), null)
  assert.equal(normalizeNewUnit('m', ['m³', 'M']), null)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/units.test.ts`
Expected: FAIL — cannot resolve `./units` (module not found).

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/units.ts`:

```ts
/** Canonical construction units, aligned with the Settings page rate-book docs. */
export const STANDARD_UNITS = [
  'm³', 'm²', 'm', 'ton', 'ea', 'set', 'kg', 'LS', 'no.', 'lot', 'hr', 'day',
] as const

export type UnitOption = string

/** Case-insensitive substring filter; de-duplicates (case-insensitive), preserving first-seen order. */
export function filterUnits(units: readonly string[], query: string): string[] {
  const needle = query.trim().toLowerCase()
  const seen = new Set<string>()
  const out: string[] = []
  for (const unit of units) {
    const key = unit.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (needle === '' || key.includes(needle)) out.push(unit)
  }
  return out
}

/** Trim a newly-typed unit. Returns null when empty or already present (case-insensitive). */
export function normalizeNewUnit(raw: string, existing: readonly string[]): string | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (existing.some((unit) => unit.toLowerCase() === trimmed.toLowerCase())) return null
  return trimmed
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/lib/units.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/units.ts src/lib/units.test.ts
git commit -m "feat(boq): add STANDARD_UNITS list and unit filter/normalize helpers"
```

---

## Task 2: `UnitCombobox` component

A lightweight combobox built from existing primitives (`Button`, `Input`) + a div popover. Default-closed, so SSR tests cover the trigger; open/filter/add behavior is covered by the T1 helper tests + manual QA.

**Files:**

- Create: `src/components/unit-combobox.tsx`
- Modify: `src/app/globals.css` (append combobox styles)
- Test: `src/components/unit-combobox.test.ts`

**Interfaces:**

- Consumes: `filterUnits`, `normalizeNewUnit` from `@/lib/units` (T1); `Button` from `@/components/ui/button`; `Input` from `@/components/ui/input`.
- Produces: `UnitCombobox` component with props:
  - `value: string`
  - `units: string[]`
  - `onChange: (unit: string) => void`
  - `onAddUnit: (unit: string) => void`
  - `disabled?: boolean`
  - `readOnly?: boolean`
  - `ariaLabel?: string` (default `"Unit"`)

- [ ] **Step 1: Write the failing test**

Create `src/components/unit-combobox.test.ts`:

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { UnitCombobox } from './unit-combobox'

const baseProps = { units: ['m³', 'm²', 'ton'], onChange: () => undefined, onAddUnit: () => undefined }

test('renders a trigger button showing the current unit, not a bare input', () => {
  const html = renderToStaticMarkup(createElement(UnitCombobox, { ...baseProps, value: 'm³' }))
  assert.match(html, /<button[^>]*unit-combobox-trigger/)
  assert.match(html, /unit-combobox-value/)
  assert.match(html, />m³</)
})

test('renders a placeholder and the disabled attribute when empty/disabled', () => {
  const html = renderToStaticMarkup(createElement(UnitCombobox, { ...baseProps, value: '', disabled: true }))
  assert.match(html, /Unit…/)
  assert.match(html, /disabled/)
})

test('readOnly renders plain text and no trigger', () => {
  const html = renderToStaticMarkup(createElement(UnitCombobox, { ...baseProps, value: 'ton', readOnly: true }))
  assert.match(html, /unit-combobox-readonly/)
  assert.match(html, />ton</)
  assert.doesNotMatch(html, /unit-combobox-trigger/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/components/unit-combobox.test.ts`
Expected: FAIL — cannot resolve `./unit-combobox`.

- [ ] **Step 3: Write minimal implementation**

Create `src/components/unit-combobox.tsx`:

```tsx
"use client"

import { useEffect, useId, useRef, useState } from "react"
import { Check, ChevronDown, Plus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { filterUnits, normalizeNewUnit } from "@/lib/units"

export interface UnitComboboxProps {
  value: string
  units: string[]
  onChange: (unit: string) => void
  onAddUnit: (unit: string) => void
  disabled?: boolean
  readOnly?: boolean
  ariaLabel?: string
}

export function UnitCombobox({
  value,
  units,
  onChange,
  onAddUnit,
  disabled,
  readOnly,
  ariaLabel = "Unit",
}: UnitComboboxProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState("")
  const rootRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false) }
    document.addEventListener("mousedown", onPointer)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onPointer)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  if (readOnly) {
    return <span className="unit-combobox-readonly">{value || "—"}</span>
  }

  const filtered = filterUnits(units, query)

  const commitAdd = () => {
    const created = normalizeNewUnit(draft, units)
    if (!created) { setAdding(false); setDraft(""); return }
    onAddUnit(created)
    onChange(created)
    setAdding(false); setDraft(""); setQuery(""); setOpen(false)
  }

  return (
    <div className="unit-combobox" ref={rootRef} data-od-id="unit-combobox">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="unit-combobox-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="unit-combobox-value">{value || "Unit…"}</span>
        <ChevronDown className="size-3.5" aria-hidden="true" />
      </Button>
      {open ? (
        <div className="unit-combobox-popover" role="dialog" aria-label={ariaLabel}>
          <div className="unit-combobox-search">
            <Input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search units…"
              aria-label={`Search ${ariaLabel}`}
              className="h-7 text-xs"
              autoFocus
            />
          </div>
          <ul id={listId} role="listbox" className="unit-combobox-list">
            {filtered.length === 0 ? (
              <li className="unit-combobox-empty">No units match</li>
            ) : filtered.map((unit) => (
              <li key={unit} role="option" aria-selected={unit === value}>
                <button
                  type="button"
                  className="unit-combobox-option"
                  onClick={() => { onChange(unit); setOpen(false); setQuery("") }}
                >
                  <span>{unit}</span>
                  {unit === value ? <Check className="size-3" aria-hidden="true" /> : null}
                </button>
              </li>
            ))}
          </ul>
          <div className="unit-combobox-add">
            {adding ? (
              <div className="unit-combobox-add-form">
                <Input
                  type="text"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="New unit"
                  aria-label={`New ${ariaLabel} name`}
                  className="h-7 text-xs"
                  autoFocus
                  onKeyDown={(event) => {
                    if (event.key === "Enter") { event.preventDefault(); commitAdd() }
                    if (event.key === "Escape") { setAdding(false); setDraft("") }
                  }}
                />
                <Button type="button" size="icon-xs" variant="ghost" aria-label="Save new unit" onClick={commitAdd}><Check className="size-3" /></Button>
                <Button type="button" size="icon-xs" variant="ghost" aria-label="Cancel add unit" onClick={() => { setAdding(false); setDraft("") }}><X className="size-3" /></Button>
              </div>
            ) : (
              <button type="button" className="unit-combobox-add-toggle" onClick={() => setAdding(true)}>
                <Plus className="size-3" aria-hidden="true" /> Add new unit
              </button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 4: Add combobox CSS**

In `src/app/globals.css`, append (after the `.unified-boq-items-table` block, e.g. after the `.review-verification-row` rule near line 1314):

```css
/* Unit combobox */
.unit-combobox { position: relative; display: inline-block; min-width: 0; }
.unit-combobox-trigger { justify-content: space-between; width: 100%; height: 28px; padding-inline: 7px; font-size: 12px; }
.unit-combobox-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.unit-combobox-readonly { display: inline-block; padding: 5px 7px; color: var(--fg-2); font-size: 12px; }
.unit-combobox-popover { position: absolute; z-index: 30; top: calc(100% + 2px); left: 0; min-width: 168px; padding: 6px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); box-shadow: var(--shadow-md); }
.unit-combobox-search { margin-bottom: 4px; }
.unit-combobox-list { max-height: 180px; overflow-y: auto; margin: 0; padding: 0; list-style: none; }
.unit-combobox-empty { padding: 6px 8px; color: var(--muted-text); font-size: 11px; }
.unit-combobox-option { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 6px; padding: 4px 6px; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--fg); font-size: 12px; text-align: left; cursor: pointer; }
.unit-combobox-option:hover { background: color-mix(in oklab, var(--accent) 8%, transparent); }
.unit-combobox-add { margin-top: 4px; border-top: 1px solid var(--border); padding-top: 4px; }
.unit-combobox-add-toggle { display: flex; width: 100%; align-items: center; gap: 4px; padding: 4px 6px; border: 0; background: transparent; color: var(--accent); font-size: 11px; cursor: pointer; }
.unit-combobox-add-form { display: flex; align-items: center; gap: 2px; }
.unit-combobox-add-form input { flex: 1; min-width: 0; }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test src/components/unit-combobox.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/components/unit-combobox.tsx src/components/unit-combobox.test.ts src/app/globals.css
git commit -m "feat(boq): add UnitCombobox component (search + inline add new unit)"
```

---

## Task 3: Rate column → always read-only, restyled

**Files:**

- Modify: `src/components/unified-boq-items-table.tsx` (Rate cell + remove now-unused `rateLocked` + add `formatRateValue` helper)
- Modify: `src/app/globals.css` (rate styling)
- Modify: `src/components/unified-boq-items-table.test.ts` (update the rate assertion in the first test)

**Interfaces:**

- Consumes: existing `currency`/`formatNumber2` local helpers (patterns to mirror).
- Produces: a read-only `<td class="num-col unified-boq-rate">…<span class="unified-boq-rate-value">…</span></td>` cell.

- [ ] **Step 1: Update the existing test (will fail after impl change)**

In `src/components/unified-boq-items-table.test.ts`, in the test `'keeps rate visible in the canonical BOQ columns and removes legacy row details'`, replace this line:

```ts
  assert.match(html, /aria-label="Rate for Valve installation, row 1"[^>]*min="0"[^>]*value="100"/)
```

with:

```ts
  assert.match(html, /aria-label="Rate for Valve installation, row 1"/)
  assert.match(html, /unified-boq-rate-value/)
  assert.match(html, />100</)
```

Leave the `headers` deepEqual unchanged (still 8 columns here — the actions column arrives in T6).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/components/unified-boq-items-table.test.ts`
Expected: FAIL — `unified-boq-rate-value` not found (rate is still an input).

- [ ] **Step 3: Implement**

In `src/components/unified-boq-items-table.tsx`:

(a) Add a rate formatter next to the existing `formatNumber2` helper (near the top, after `formatNumber2`):

```ts
function formatRateValue(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 })
}
```

(b) Remove the now-unused declaration (line ~316):

```ts
        const rateLocked = locked || isSeparateComponentRow || allocation !== undefined
```

(c) Replace the Rate cell. Find:

```tsx
            <td className="num-col" data-label="Rate">
              <Input
                aria-label={`Rate for ${row.item.desc}, row ${rowNumber}`}
                type="number"
                min="0"
                value={row.item.rate}
                disabled={rateLocked}
                onChange={(event) => onFieldChange(row, "rate", Number(event.target.value))}
              />
            </td>
```

Replace with:

```tsx
            <td className="num-col unified-boq-rate" data-label="Rate">
              <span className="unified-boq-rate-value" aria-label={`Rate for ${row.item.desc}, row ${rowNumber}`}>
                {Number.isFinite(row.item.rate) ? formatRateValue(row.item.rate) : "—"}
              </span>
            </td>
```

- [ ] **Step 4: Add rate CSS**

In `src/app/globals.css`, within/after the `.unified-boq-items-table` rules, add:

```css
.unified-boq-items-table td.unified-boq-rate { background: color-mix(in oklab, var(--accent) 6%, transparent); }
.unified-boq-rate-value { display: block; text-align: right; padding: 6px 8px; border-radius: var(--radius-sm); font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--fg); }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test src/components/unified-boq-items-table.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/unified-boq-items-table.tsx src/components/unified-boq-items-table.test.ts src/app/globals.css
git commit -m "feat(boq): make Rate column read-only with readable styling"
```

---

## Task 4: Qty column → plain text, no spinners

Switch `type="number"` → `type="text" inputMode="decimal"`. Keep the existing `Number(event.target.value)` coercion so empty clears to `0` and non-numeric input is rejected by the controlled input (matches prior behavior; `qty` is typed `number`).

**Files:**

- Modify: `src/components/unified-boq-items-table.tsx` (Qty cell)
- Modify: `src/app/globals.css` (spinner-hide safety rule)
- Modify: `src/components/unified-boq-items-table.test.ts` (add a qty assertion)

- [ ] **Step 1: Add the failing test**

In `src/components/unified-boq-items-table.test.ts`, inside the test `'keeps rate visible in the canonical BOQ columns and removes legacy row details'`, append (after the headers/rate asserts):

```ts
  const qtyInput = html.match(/<input[^>]*aria-label="Quantity for Valve installation, row 1"[^>]*>/)?.[0] ?? ""
  assert.match(qtyInput, /type="text"/)
  assert.match(qtyInput, /inputmode="decimal"/i)
  assert.doesNotMatch(qtyInput, /type="number"/)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/components/unified-boq-items-table.test.ts`
Expected: FAIL — qty input is still `type="number"`.

- [ ] **Step 3: Implement**

In `src/components/unified-boq-items-table.tsx`, find the Qty cell:

```tsx
            <td className="num-col" data-label="Quantity">
              <Input
                aria-label={`Quantity for ${row.item.desc}, row ${rowNumber}`}
                type="number"
                min="0"
                value={row.item.qty}
                disabled={locked}
                onChange={(event) => onFieldChange(row, "qty", Number(event.target.value))}
              />
            </td>
```

Replace with:

```tsx
            <td className="num-col" data-label="Quantity">
              <Input
                aria-label={`Quantity for ${row.item.desc}, row ${rowNumber}`}
                type="text"
                inputMode="decimal"
                value={row.item.qty}
                disabled={locked}
                onChange={(event) => onFieldChange(row, "qty", Number(event.target.value))}
              />
            </td>
```

- [ ] **Step 4: Add spinner-hide CSS (belt-and-suspenders)**

In `src/app/globals.css`, after the existing `.unified-boq-items-table input[type="number"]` rule, add:

```css
.unified-boq-items-table input[type="number"]::-webkit-inner-spin-button,
.unified-boq-items-table input[type="number"]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
.unified-boq-items-table input[type="number"] { -moz-appearance: textfield; }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test src/components/unified-boq-items-table.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/unified-boq-items-table.tsx src/components/unified-boq-items-table.test.ts src/app/globals.css
git commit -m "feat(boq): make Qty a spinner-less text input"
```

---

## Task 5: Unit column uses the combobox

Add optional `units` / `onAddUnit` props (with safe defaults) to the table and replace the Unit `<Input>` with `<UnitCombobox>`. Defaults keep the change backward-compatible with the test helper and any future consumer.

**Files:**

- Modify: `src/components/unified-boq-items-table.tsx`
- Modify: `src/components/unified-boq-items-table.test.ts` (pass new props in `renderTable`; add a unit assertion)

**Interfaces:**

- Consumes: `UnitCombobox` from `@/components/unit-combobox` (T2); `STANDARD_UNITS` from `@/lib/units` (T1).
- Produces: two new optional props on `UnifiedBoqItemsTable`:
  - `units?: string[]` (default `STANDARD_UNITS`)
  - `onAddUnit?: (unit: string) => void` (default no-op)

- [ ] **Step 1: Update the test helper + add failing assertion**

In `src/components/unified-boq-items-table.test.ts`:

(a) In `renderTable`'s options type, add:

```ts
    units = ['m³', 'm²', 'Pcs'],
    onAddUnit = () => undefined,
```

(b) In the `createElement(UnifiedBoqItemsTable, { … })` call inside `renderTable`, add:

```ts
    units,
    onAddUnit,
```

(c) Add a new test:

```ts
test('renders the unit combobox trigger instead of a bare unit input', () => {
  const html = renderTable([{ header: 'Valves', items: [item({ unit: 'Pcs' })] }])
  assert.match(html, /unit-combobox-trigger/)
  assert.match(html, /aria-label="Unit for Valve installation, row 1"/)
  assert.doesNotMatch(html, /<input[^>]*aria-label="Unit for Valve installation, row 1"/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/components/unified-boq-items-table.test.ts`
Expected: FAIL — the table still renders a `<input aria-label="Unit for …">` (no `unit-combobox-trigger`).

- [ ] **Step 3: Implement**

In `src/components/unified-boq-items-table.tsx`:

(a) Add imports at the top (with the existing `Input` import):

```tsx
import { UnitCombobox } from "@/components/unit-combobox"
import { STANDARD_UNITS } from "@/lib/units"
```

(b) Add the props to `UnifiedBoqItemsTableProps`:

```tsx
  units?: string[]
  onAddUnit?: (unit: string) => void
```

(c) Destructure them in `UnifiedBoqItemsTable` (with defaults):

```tsx
  units = STANDARD_UNITS,
  onAddUnit = () => undefined,
```

(d) Thread `units` and `onAddUnit` into the `FragmentSection` call (add to its props and destructure there too), and through to each row.

(e) Replace the Unit cell. Find:

```tsx
            <td data-label="Unit">
              <Input
                aria-label={`Unit for ${row.item.desc}, row ${rowNumber}`}
                value={row.item.unit}
                disabled={locked}
                onChange={(event) => onFieldChange(row, "unit", event.target.value)}
              />
            </td>
```

Replace with:

```tsx
            <td data-label="Unit">
              <UnitCombobox
                value={row.item.unit}
                units={units}
                onAddUnit={onAddUnit}
                onChange={(unit) => onFieldChange(row, "unit", unit)}
                disabled={locked}
                readOnly={readOnly}
                ariaLabel={`Unit for ${row.item.desc}, row ${rowNumber}`}
              />
            </td>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/components/unified-boq-items-table.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/unified-boq-items-table.tsx src/components/unified-boq-items-table.test.ts
git commit -m "feat(boq): use UnitCombobox for the Unit column"
```

---

## Task 6: Delete control (hover-revealed trash)

Add an optional `onDelete` prop and a trailing hover-revealed actions cell. Adding a 9th column requires re-pointing the existing `th:last-child { width: 30% }` rule (Catalog) to `th:nth-child(8)`, and giving the new last column a small width.

**Files:**

- Modify: `src/components/unified-boq-items-table.tsx`
- Modify: `src/app/globals.css`
- Modify: `src/components/unified-boq-items-table.test.ts`

**Interfaces:**

- Consumes: `Button` from `@/components/ui/button`; `Trash2` from `lucide-react`.
- Produces: `onDelete?: (row: UnifiedBoqPricedRow) => void` on `UnifiedBoqItemsTable`.

- [ ] **Step 1: Update the test helper, headers assertion, and add delete tests**

In `src/components/unified-boq-items-table.test.ts`:

(a) In `renderTable` options type add `onDelete = () => undefined,` and pass `onDelete` into the `createElement` call.

(b) In the test `'keeps rate visible in the canonical BOQ columns and removes legacy row details'`, update the headers deepEqual to include the trailing empty actions header:

```ts
  assert.deepEqual(headers, ['Description', 'Unit', 'Qty', 'Rate', 'Material', 'Labour', 'Total', 'Catalog', ''])
```

(c) Add two tests:

```ts
test('renders a hover-revealed delete action on each priced row when editable', () => {
  const html = renderTable([{ header: 'Valves', items: [item()] }])
  assert.match(html, /unified-boq-row-actions/)
  assert.match(html, /aria-label="Delete row 1"/)
})

test('omits the delete action when readOnly', () => {
  const html = renderTable([{ header: 'Valves', items: [item()] }], { readOnly: true })
  assert.doesNotMatch(html, /Delete row/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/components/unified-boq-items-table.test.ts`
Expected: FAIL — no `unified-boq-row-actions`, and headers deepEqual mismatch.

- [ ] **Step 3: Implement**

In `src/components/unified-boq-items-table.tsx`:

(a) Add imports:

```tsx
import { Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
```

(b) Add `onDelete?: (row: UnifiedBoqPricedRow) => void` to `UnifiedBoqItemsTableProps`, destructure it (default `() => undefined`), and thread it through `FragmentSection` (prop + destructure) to each priced row.

(c) In the header `<tr>`, append an empty header cell after `<th>Catalog</th>`:

```tsx
        <th aria-label="Actions" />
```

(d) In the priced row `<tr>`, append a trailing cell after the Catalog cell:

```tsx
            <td className="unified-boq-row-actions" data-label="Actions">
              {!readOnly ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete row ${rowNumber}`}
                  disabled={disabled}
                  onClick={() => onDelete?.(row)}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              ) : null}
            </td>
```

(e) In the **informational** (non-priced) row `<tr>`, append an empty trailing cell so column counts match (after its Catalog cell):

```tsx
              <td className="unified-boq-row-actions" data-label="Actions" aria-hidden="true" />
```

- [ ] **Step 4: Add CSS**

In `src/app/globals.css`, **replace** the existing rule:

```css
.unified-boq-items-table th:last-child { width: 30%; }
```

with:

```css
.unified-boq-items-table th:nth-child(8) { width: 30%; }
.unified-boq-items-table th:last-child { width: 44px; }
```

Then add (after the `.unified-boq-catalog-cell` rule):

```css
.unified-boq-items-table .unified-boq-row-actions { opacity: 0; transition: opacity 0.12s ease; text-align: right; white-space: nowrap; }
.unified-boq-items-table tbody tr:hover .unified-boq-row-actions,
.unified-boq-items-table .unified-boq-row-actions:focus-within { opacity: 1; }
@media (hover: none) { .unified-boq-items-table .unified-boq-row-actions { opacity: 1; } }
.unified-boq-row-actions button { color: var(--muted-text); }
.unified-boq-row-actions button:hover { color: var(--danger); }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test src/components/unified-boq-items-table.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/unified-boq-items-table.tsx src/components/unified-boq-items-table.test.ts src/app/globals.css
git commit -m "feat(boq): add hover-revealed delete action to BOQ item rows"
```

---

## Task 7: Remove the All / Unit / Lump Sum / Job filter chips

**Files:**

- Modify: `src/app/(authenticated)/boqs/[id]/page.tsx`
- Test: `src/app/(authenticated)/boqs/[id]/page.test.ts` (**new**)

**Interfaces:** none new.

- [ ] **Step 1: Write the failing test**

Create `src/app/(authenticated)/boqs/[id]/page.test.ts`:

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

test('no longer renders the All/Unit/Lump Sum/Job type filter chips', () => {
  assert.doesNotMatch(source, /FILTERS\s*=\s*\[/)
  assert.doesNotMatch(source, /boq-detail-filters/)
  assert.doesNotMatch(source, /activeFilter/)
})
```

> Note: this is a source-level regression guard because the page is a client component using `useParams`/`useRouter`/`useSearchParams` and cannot be exercised with `renderToStaticMarkup`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test "src/app/(authenticated)/boqs/[id]/page.test.ts"`
Expected: FAIL — `FILTERS`, `boq-detail-filters`, and `activeFilter` still present.

- [ ] **Step 3: Implement**

In `src/app/(authenticated)/boqs/[id]/page.tsx`:

(a) Delete the constant near the top:

```ts
const FILTERS = ["All", "Unit", "Lump Sum", "Job"] as const
```

(b) Delete the state (inside `CanonicalBoqWorkspace`):

```ts
  const [activeFilter, setActiveFilter] = useState<string>("All")
```

(c) In the `unifiedSections` memo, delete the type-filter branch so only search remains. Replace:

```tsx
  const unifiedSections = useMemo(() => allUnifiedSections
    .map((section) => ({
      ...section,
      rows: section.rows.filter((row) => {
        if (activeFilter !== "All") {
          const filterType: Record<string, BoqPricedItem["type"]> = { Unit: "unit", "Lump Sum": "lump_sum", Job: "job" }
          if (!isPricedBoqItem(row.item) || row.item.type !== filterType[activeFilter]) return false
        }
        const query = search.trim().toLowerCase()
        if (!query) return true
        return row.item.desc.toLowerCase().includes(query) || (row.item.code ?? "").toLowerCase().includes(query)
      }),
    }))
    .filter((section) => section.rows.length > 0), [activeFilter, allUnifiedSections, search])
```

with:

```tsx
  const unifiedSections = useMemo(() => {
    const query = search.trim().toLowerCase()
    return allUnifiedSections
      .map((section) => ({
        ...section,
        rows: section.rows.filter((row) => {
          if (!query) return true
          return row.item.desc.toLowerCase().includes(query) || (row.item.code ?? "").toLowerCase().includes(query)
        }),
      }))
      .filter((section) => section.rows.length > 0)
  }, [allUnifiedSections, search])
```

(d) Delete the filters JSX block inside the toolbar. Remove:

```tsx
            <div className="boq-detail-filters" aria-label="Filter BOQ items">
              {FILTERS.map((filter) => (
                <button type="button" key={filter} onClick={() => setActiveFilter(filter)} aria-pressed={activeFilter === filter} className={`filter-chip ${activeFilter === filter ? "active" : ""}`}>{filter}</button>
              ))}
            </div>
```

Leave the `.search-wrap` block in place.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test "src/app/(authenticated)/boqs/[id]/page.test.ts"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(authenticated)/boqs/[id]/page.tsx" "src/app/(authenticated)/boqs/[id]/page.test.ts"
git commit -m "feat(boq): remove type filter chips from BOQ detail toolbar"
```

---

## Task 8: Delete handler + Undo toast + wire Unit props

Add `customUnits`/`pendingDeletes` state, an optimistic-hide filter in `allUnifiedSections`, a ref-based deferred commit to `DELETE /api/boqs/[id]/items`, a 6s Undo toast, and pass `units`/`onAddUnit`/`onDelete` to the table.

**Files:**

- Modify: `src/app/(authenticated)/boqs/[id]/page.tsx`
- Modify: `src/app/(authenticated)/boqs/[id]/page.test.ts` (add delete-wiring regression guard)

**Interfaces:**

- Consumes: `UnifiedBoqItemsTable`'s new `units`/`onAddUnit`/`onDelete` props (T5, T6); `STANDARD_UNITS` (T1); `getBoqItemRequestIdentity`; `applyMutationBoq`; `replaceEdits`; `editsRef`; existing `deleting` state; `toast` (sonner).
- Produces: in-page `handleDelete(row)` with optimistic hide + undo + deferred commit.

- [ ] **Step 1: Add the failing regression guard**

Append to `src/app/(authenticated)/boqs/[id]/page.test.ts`:

```ts
test('wires row delete with an optimistic hide and an undoable DELETE commit', () => {
  assert.match(source, /pendingDeletes/)
  assert.match(source, /method:\s*"DELETE"/)
  assert.match(source, /label:\s*"Undo"/)
  assert.match(source, /onAutoClose:/)
  assert.match(source, /unit-combobox|UnitCombobox|units=\{units\}|onAddUnit=/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test "src/app/(authenticated)/boqs/[id]/page.test.ts"`
Expected: FAIL — `pendingDeletes`/`DELETE`/`Undo`/`onAutoClose` not yet present.

- [ ] **Step 3: Implement**

In `src/app/(authenticated)/boqs/[id]/page.tsx`:

(a) Add imports (near the existing lib imports):

```tsx
import { STANDARD_UNITS } from "@/lib/units"
```

(b) Define the stash type at module scope (e.g. just above `CanonicalBoqWorkspace`, or beside the other local types):

```tsx
type StashedDelete = { sectionIndex: number; itemIndex: number; item: BoqPricedItem }
```

(c) Inside `CanonicalBoqWorkspace`, add state + a units memo (next to the other `useState` calls):

```tsx
  const [customUnits, setCustomUnits] = useState<string[]>([])
  const [pendingDeletes, setPendingDeletes] = useState<StashedDelete[]>([])
  const units = useMemo(() => [...STANDARD_UNITS, ...customUnits], [customUnits])
```

(d) Update `allUnifiedSections` to hide pending deletes. Replace:

```tsx
  const allUnifiedSections = useMemo(
    () => buildUnifiedBoqSections(displayBoq.sections),
    [displayBoq.sections],
  )
```

with:

```tsx
  const allUnifiedSections = useMemo(() => {
    const built = buildUnifiedBoqSections(displayBoq.sections)
    if (pendingDeletes.length === 0) return built
    return built.map((section) => ({
      ...section,
      rows: section.rows.filter((row) => !pendingDeletes.some(
        (pending) => pending.sectionIndex === row.sectionIndex && pending.itemIndex === row.itemIndex,
      )),
    }))
  }, [displayBoq.sections, pendingDeletes])
```

(e) Add the deferred-commit ref + effect (after `applyMutationBoq` is defined):

```tsx
  const commitDeleteRef = useRef<(stash: StashedDelete) => Promise<void>>(async () => {})
  useEffect(() => {
    commitDeleteRef.current = async (stash) => {
      setDeleting(true)
      try {
        const response = await fetch(`/api/boqs/${encodeURIComponent(boq.id)}/items`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sectionIndex: stash.sectionIndex, ...getBoqItemRequestIdentity(stash.item) }),
        })
        if (!response.ok) throw new Error(await readError(response, "The item could not be deleted."))
        applyMutationBoq(await response.json() as Boq)
        const editKey = `${stash.sectionIndex}-${stash.itemIndex}`
        if (editsRef.current[editKey]) {
          const nextEdits = { ...editsRef.current }
          delete nextEdits[editKey]
          replaceEdits(nextEdits)
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "The item could not be deleted.")
      } finally {
        setPendingDeletes((prev) => prev.filter(
          (pending) => !(pending.sectionIndex === stash.sectionIndex && pending.itemIndex === stash.itemIndex),
        ))
        setDeleting(false)
      }
    }
  }, [boq, applyMutationBoq, replaceEdits])
```

(f) Add `handleDelete` (next to `handleIncludeOptional`):

```tsx
  const handleDelete = useCallback((row: UnifiedBoqPricedRow) => {
    if (isReadOnly || mutationBusy) return
    const stash: StashedDelete = { sectionIndex: row.sectionIndex, itemIndex: row.itemIndex, item: row.item }
    setPendingDeletes((prev) => [...prev, stash])
    const toastId = `delete-${row.sectionIndex}-${row.itemIndex}`
    let undone = false
    toast("Line item deleted", {
      id: toastId,
      duration: 6000,
      action: {
        label: "Undo",
        onClick: () => {
          undone = true
          setPendingDeletes((prev) => prev.filter(
            (pending) => !(pending.sectionIndex === stash.sectionIndex && pending.itemIndex === stash.itemIndex),
          ))
          toast.dismiss(toastId)
        },
      },
      onAutoClose: () => { if (!undone) void commitDeleteRef.current(stash) },
    })
  }, [isReadOnly, mutationBusy])
```

(g) Wire the new props into the existing `<UnifiedBoqItemsTable …>` JSX (add these three props alongside the others):

```tsx
            units={units}
            onAddUnit={(unit) => setCustomUnits((prev) => (prev.includes(unit) ? prev : [...prev, unit]))}
            onDelete={handleDelete}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test "src/app/(authenticated)/boqs/[id]/page.test.ts"`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(authenticated)/boqs/[id]/page.tsx" "src/app/(authenticated)/boqs/[id]/page.test.ts"
git commit -m "feat(boq): delete BOQ item rows with undo + wire unit combobox"
```

---

## Task 9: Full check + manual QA

**Files:** none (verification only).

- [ ] **Step 1: Run the full check**

Run: `npm run check`
Expected: eslint clean, `tsc --noEmit` clean, all tests pass.

- [ ] **Step 2: Manual QA in the browser** (`npm run dev`, open a non-approved BOQ `/boqs/<id>`)

- Toolbar: the `All / Unit / Lump Sum / Job` chips are gone; the search box still filters by description/code.
- **Unit**: click a Unit cell → combobox opens, search filters, selecting a unit updates the cell; "Add new unit" → type a new unit → Save → it is selected and now appears in other rows' comboboxes (same session).
- **Qty**: no up/down spinners; typing a number updates the row total; clearing sets it to `0`.
- **Rate**: rendered as read-only text on a subtle tinted background, full-opacity (not greyed); not focusable/editable.
- **Delete**: clicking the trash (on row hover) hides the row immediately and shows a "Line item deleted · Undo" toast.
  - Click **Undo** within 6s → the row reappears and no network `DELETE` fires.
  - Let the toast expire → a `DELETE /api/boqs/<id>/items` request fires; on success the row stays gone and totals update; on failure an error toast shows and the row is restored.
  - In read-only (approved) BOQs, the trash does not appear.

- [ ] **Step 3: Note known limitations (not blocking)**

- New units added via the combobox are session-scoped only (not persisted to a master list).
- Rate is not live-recomputed from Material/Labour edits (it is the stored, extraction-derived value).
- Saving while a delete Undo window is open could still PATCH edits for the about-to-be-deleted item; acceptable for this prototype (the `DELETE` reapplies server state on commit).

- [ ] **Step 4: Final commit (if any QA fixups)**

Only if QA surfaced fixups; otherwise this task is verification-only.

---

## Self-Review

**Spec coverage** — each spec section maps to a task:

- Remove type filter chips → T7.
- Delete row + Undo toast (hover trash, optimistic + deferred DELETE) → T6 (control) + T8 (handler).
- Unit combobox + inline add → T1 (helpers) + T2 (component) + T5 (wiring) + T8 (session units).
- Qty plain text, no spinners → T4.
- Rate read-only, restyled → T3.
- CSS (rate, qty spinner-hide, actions hover, combobox) → T2/T3/T4/T6.
- `npm run check` + QA → T9.

**Placeholder scan** — each code step contains real code; no TBD/TODO/"add validation". Source-level page tests are explicitly labeled as regression guards (honest about the SSR-only harness).

**Type consistency** — `UnifiedBoqPricedRow` (from `@/lib/boq-unified-rows`) exposes `sectionIndex`, `itemIndex`, `item: BoqPricedItem` (verified). `getBoqItemRequestIdentity(item)` returns `{ itemId?, itemCode? }` (verified). `STANDARD_UNITS`/`filterUnits`/`normalizeNewUnit` defined in T1, consumed unchanged in T2/T5/T8. Table props `units`/`onAddUnit`/`onDelete` defined in T5/T6, consumed in T8. `StashedDelete` uses `sectionIndex`/`itemIndex` matching the row fields and the `rowEditKey` format `${sectionIndex}-${itemIndex}`.
