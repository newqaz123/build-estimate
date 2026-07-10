# BuildEstimate — UI Polish Design

## Objective
Match the current Next.js app's visual design to the HTML prototype (`shared.css` + individual page HTMLs) across 4 pages: BOQs listing, BOQ Detail, Compare, Catalog. Fix all component-level styling discrepancies.

## Architecture
Two-layer fix:
1. **CSS Foundation** — Add missing custom properties to `globals.css`
2. **Component Kit** — Create lightweight styled wrappers that render the prototype's exact HTML/CSS, then apply them to each page

No page restructuring. No new features. Only visual + presentational changes.

---

## Layer 1: CSS Foundation (`globals.css`)

### Add these custom properties to `@theme inline`

```
--radius-pill: 9999px
--motion-fast: 150ms
--motion-base: 200ms
--ease-standard: cubic-bezier(0.2, 0, 0, 1)
--elev-raised:
  0 0 1px rgba(0,0,0,0.32),
  0 0 2px rgba(0,0,0,0.08),
  0 1px 3px rgba(45,127,249,0.28),
  inset 0 0 0 0.5px rgba(0,0,0,0.06)
```

### Override `--radius-md` to 16px (currently 10px from shadcn)
Add `--radius-md: 16px` in `@theme inline` (or set `--radius: 0.875rem` to get ~14px, then define `--radius-md: 16px` specifically).

### Add utility classes for reusable component styles
```
.badge-draft { background: color-mix(in oklab, rgba(4,14,32,0.69) 12%, transparent); color: #333; }
.badge-active { background: color-mix(in oklab, #1b61c9 12%, transparent); color: #1b61c9; }
.badge-review { background: color-mix(in oklab, #eab308 18%, transparent); color: color-mix(in oklab, #eab308, black 40%); }
.badge-approved { background: color-mix(in oklab, #006400 12%, transparent); color: #006400; }
.badge-rejected { background: color-mix(in oklab, #dc2626 12%, transparent); color: #dc2626; }

.badge-matched { background: color-mix(in oklab, #1b61c9 12%, transparent); color: #1b61c9; }
.badge-suggested,
.badge-fuzzy { background: color-mix(in oklab, #eab308 18%, transparent); color: color-mix(in oklab, #eab308, black 40%); }
.badge-llm { background: color-mix(in oklab, #8b5cf6 14%, transparent); color: #8b5cf6; }
.badge-unmatched { background: color-mix(in oklab, #dc2626 12%, transparent); color: #dc2626; }
```

### Data table utility
```
.data-table-wrap { border: 1px solid #e0e2e6; border-radius: 16px; background: #fff; box-shadow: var(--elev-raised); overflow-x: auto; }
.data-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.data-table thead { background: color-mix(in oklab, #e0e2e6 30%, #fff); }
.data-table th { padding: 10px 14px; text-align: left; font-weight: 500; font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; color: rgba(4,14,32,0.69); border-bottom: 1px solid #e0e2e6; white-space: nowrap; }
.data-table td { padding: 10px 14px; border-bottom: 1px solid #eef0f3; vertical-align: middle; }
.data-table tbody tr:hover { background: color-mix(in oklab, #1b61c9 5%, #fff); }
.data-table .num-col { font-family: ui-monospace, monospace; font-variant-numeric: tabular-nums; text-align: right; }
```

---

## Layer 2: Component Kit

### File: `src/lib/prototype-classes.ts`
Named string exports for Tailwind class bundles:
- `badgeDraft`, `badgeActive`, `badgeReview`, `badgeApproved`, `badgeRejected`
- `badgeMatched`, `badgeSuggested`, `badgeLlm`, `badgeUnmatched`
- `filterChip`, `filterChipActive`
- `dataTableWrap`, `dataTableHead`, `dataTableHeadCell`, `dataTableCell`, `numCol`
- `paginationBtn`, `paginationBtnActive`

### File: `src/components/proto-badge.tsx`
```tsx
// Renders <span> with status dot + label matching prototype's .badge HTML
// Props: status (draft|active|review|approved|rejected), label?
// Uses class maps from prototype-classes.ts
// data-od-id propagated
```

### File: `src/components/proto-filter-chip.tsx`
```tsx
// Renders <button> matching prototype's .filter-chip 
// Props: active, label, onClick
// Pill shape, border, active = accent bg
```

### File: `src/components/proto-data-table.tsx`
```tsx
// Wraps table with prototype's .data-table-wrap + .data-table classes
// Props: headers (string[]), children (rows)
// Renders <thead> with uppercase/letter-spaced headers
```

### File: `src/components/proto-pagination.tsx`
```tsx
// Renders pagination matching prototype's .pagination
// Props: page, totalPages, onPageChange
```

---

## Layer 3: Page Updates

### BOQs page (`src/app/(authenticated)/boqs/page.tsx`)
- Replace filter bar buttons → `ProtoFilterChip` components, add separator between groups
- Replace table → `ProtoDataTable`
- Replace status badge spans → `ProtoBadge`
- Replace pagination → `ProtoPagination`
- Add `num-col` class to Items/Total columns
- Add Std header tooltip

### BOQ Detail (`src/app/(authenticated)/boqs/[id]/page.tsx`)
- Replace status badge in topbar → `ProtoBadge`
- Replace `STD_BADGE` map → use badge classes from prototype-classes.ts (matched/suggested/llm/unmatched)
- Update item table → `ProtoDataTable`
- Update collapsible section headers → match prototype's `border 25% bg` style

### Compare page (`src/app/(authenticated)/compare/page.tsx`)
- Replace shadcn Table → `ProtoDataTable`
- Add variance-colored cells (green/amber/red) matching prototype's `llm-badge` background tints
- Replace LLM badge rendering → match prototype's `llm-badge` compact pill style (below/at/above/new classes)
- Replace summary cards → match prototype's `compare-summary` grid with stat styling
- Add baseline selector styling

### Catalog page (`src/app/(authenticated)/catalog/page.tsx`)
- Replace shadcn Tabs → underline-style tabs matching `.tab-btn` from prototype
- Replace review stats → match `review-stat` styling
- Replace shadcn Table → `ProtoDataTable`
- Replace shadcn Badge status rendering → use badge classes from prototype-classes.ts

---

## Non-goals
- No changes to login, dashboard, settings, or estimator pages (unless caught incidentally by shared CSS)
- No new features or API changes
- No changes to upload/review panel functionality
- No mobile responsive fixes

---

## Files changed
- `src/app/globals.css` — add custom properties + utility classes
- `src/lib/prototype-classes.ts` — NEW: Tailwind class bundle exports
- `src/components/proto-badge.tsx` — NEW
- `src/components/proto-filter-chip.tsx` — NEW
- `src/components/proto-data-table.tsx` — NEW
- `src/components/proto-pagination.tsx` — NEW
- `src/app/(authenticated)/boqs/page.tsx` — replace components
- `src/app/(authenticated)/boqs/[id]/page.tsx` — replace badges + table
- `src/app/(authenticated)/compare/page.tsx` — replace table + badges + cards
- `src/app/(authenticated)/catalog/page.tsx` — replace tabs + badges + table
