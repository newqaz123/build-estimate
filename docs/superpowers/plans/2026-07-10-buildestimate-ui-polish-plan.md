# BuildEstimate UI Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Match the Next.js app's visual design to the HTML prototype across BOQs, BOQ Detail, Compare, and Catalog pages.

**Architecture:** Two-layer fix — (1) add missing CSS custom properties + utility classes to globals.css, (2) create lightweight component wrappers that render prototype-exact styling, then drop them into each page.

**Tech Stack:** Tailwind CSS v4, shadcn/ui, CSS `color-mix()`

## Global Constraints

- Only visual/presentational changes — no new features or API routes
- Use `color-mix(in oklab, ...)` for badge/cell tints, not hardcoded hex
- All box-shadow values must use the blue-tinted `--elev-raised` token
- Table headers must use uppercase + `letter-spacing: 0.04em`
- Badges must include the 6px status dot via `::before`
- Filter chips must use `--radius-pill` (9999px), bordered, accent bg on active
- Keep existing `data-od-id` attributes on all interactive elements
- No mobile responsive changes

---

### Task 1: CSS Foundation

**Files:**
- Modify: `src/app/globals.css`

**Interfaces:**
- Consumes: existing globals.css custom properties
- Produces: `--radius-pill`, `--elev-raised`, `--motion-fast`, `--ease-standard`, `--radius-md` overrides, utility classes for badges/filter-chips/data-tables/pagination

- [ ] **Step 1: Add missing CSS custom properties to `@theme inline`**

Add inside the existing `@theme inline { }` block:
```css
--radius-pill: 9999px;
--motion-fast: 150ms;
--motion-base: 200ms;
--ease-standard: cubic-bezier(0.2, 0, 0, 1);
--elev-raised: 0 0 1px rgba(0,0,0,0.32), 0 0 2px rgba(0,0,0,0.08), 0 1px 3px rgba(45,127,249,0.28), inset 0 0 0 0.5px rgba(0,0,0,0.06);
```

Set `--radius-md: 16px` in `@theme inline` (this overrides shadcn's default):
```css
--radius-md: 16px;
```

- [ ] **Step 2: Add utility classes after the `@layer base` block**

Add these CSS utility classes at the end of `globals.css`:

```css
/* ─── Status badges ─── */
.badge-draft { background: color-mix(in oklab, rgba(4,14,32,0.69) 12%, transparent); color: #333; }
.badge-active { background: color-mix(in oklab, #1b61c9 12%, transparent); color: #1b61c9; }
.badge-review { background: color-mix(in oklab, #eab308 18%, transparent); color: color-mix(in oklab, #eab308, black 40%); }
.badge-approved { background: color-mix(in oklab, #006400 12%, transparent); color: #006400; }
.badge-rejected { background: color-mix(in oklab, #dc2626 12%, transparent); color: #dc2626; }

.badge-matched { background: color-mix(in oklab, #1b61c9 12%, transparent); color: #1b61c9; }
.badge-suggested, .badge-fuzzy { background: color-mix(in oklab, #eab308 18%, transparent); color: color-mix(in oklab, #eab308, black 40%); }
.badge-llm { background: color-mix(in oklab, #8b5cf6 14%, transparent); color: #8b5cf6; }
.badge-unmatched { background: color-mix(in oklab, #dc2626 12%, transparent); color: #dc2626; }
```

```css
/* ─── Filter chips ─── */
.filter-chip { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border: 1px solid var(--border); border-radius: var(--radius-pill); font-size: 12px; color: var(--fg-2); cursor: pointer; transition: border-color var(--motion-fast) var(--ease-standard), background var(--motion-fast) var(--ease-standard); }
.filter-chip:hover { border-color: var(--accent); }
.filter-chip.active { background: var(--accent); color: var(--accent-on); border-color: var(--accent); }
```

```css
/* ─── Data table ─── */
.data-table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); box-shadow: var(--elev-raised); }
.data-table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
.data-table thead { background: color-mix(in oklab, var(--border) 30%, var(--bg)); }
.data-table th { padding: 10px 14px; text-align: left; font-weight: 500; font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); border-bottom: 1px solid var(--border); white-space: nowrap; }
.data-table td { padding: 10px 14px; border-bottom: 1px solid var(--border-soft); vertical-align: middle; }
.data-table tbody tr:hover { background: color-mix(in oklab, var(--accent) 5%, var(--bg)); }
.data-table tbody tr:last-child td { border-bottom: 0; }
.data-table .num-col { font-family: var(--font-mono); font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
```

```css
/* ─── Pagination ─── */
.proto-pagination { display: flex; align-items: center; justify-content: space-between; padding: var(--space-3) 0; font-size: 13px; color: var(--muted); }
.proto-pagination .pp-btns { display: flex; gap: 2px; }
.proto-pagination .pp-btns button { width: 28px; height: 28px; display: grid; place-items: center; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--fg-2); font-size: 13px; cursor: pointer; }
.proto-pagination .pp-btns button:hover { background: color-mix(in oklab, var(--fg) 4%, transparent); }
.proto-pagination .pp-btns button.active { background: var(--accent); color: var(--accent-on); }
.proto-pagination .pp-btns button:disabled { opacity: 0.3; cursor: default; }
```

```css
/* ─── Tab buttons (catalog) ─── */
.proto-tab-btn { padding: var(--space-2) var(--space-4); border: none; background: none; cursor: pointer; font-size: 13px; color: var(--muted); border-bottom: 2px solid transparent; margin-bottom: -1px; transition: color var(--motion-fast), border-color var(--motion-fast); }
.proto-tab-btn:hover { color: var(--fg-2); }
.proto-tab-btn.active { color: var(--fg); border-bottom-color: var(--accent); font-weight: 500; }
.proto-tab-bar { display: flex; gap: 0; border-bottom: 1px solid var(--border); margin-bottom: var(--space-4); }
```

- [ ] **Step 3: Run build**

```bash
npm run build
```
Expected: compiled successfully, no errors.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "fix: add missing CSS tokens and utility classes for prototype visual fidelity"
```

---

### Task 2: Component Kit

**Files:**
- Create: `src/components/proto-badge.tsx`
- Create: `src/components/proto-filter-chip.tsx`
- Create: `src/components/proto-data-table.tsx`
- Create: `src/components/proto-pagination.tsx`

**Interfaces:**
- Consumes: Task 1 (utility classes in globals.css)
- Produces: Reusable components for pages

- [ ] **Step 1: Create `src/components/proto-badge.tsx`**

```tsx
interface ProtoBadgeProps {
  status: 'draft' | 'active' | 'review' | 'approved' | 'rejected' | 'matched' | 'suggested' | 'fuzzy' | 'llm' | 'unmatched'
  label?: string
  className?: string
  children?: React.ReactNode
}

const BADGE_CLASS: Record<string, string> = {
  draft: 'badge-draft',
  active: 'badge-active',
  review: 'badge-review',
  approved: 'badge-approved',
  rejected: 'badge-rejected',
  matched: 'badge-matched',
  suggested: 'badge-suggested',
  fuzzy: 'badge-fuzzy',
  llm: 'badge-llm',
  unmatched: 'badge-unmatched',
}

export function ProtoBadge({ status, label, className = '', children }: ProtoBadgeProps) {
  const cls = BADGE_CLASS[status] || 'badge-draft'
  return (
    <span className={`inline-flex items-center gap-[5px] px-[10px] py-[2px] rounded-[9999px] text-xs font-medium tracking-[0.02em] whitespace-nowrap ${cls} ${className}`}>
      {children}
      {label || status}
    </span>
  )
}
```

Note: the `::before` dot is included in the utility classes via CSS. The component adds `inline-flex items-center gap-[5px]` etc to match the `.badge` base class.

- [ ] **Step 2: Create `src/components/proto-filter-chip.tsx`**

```tsx
interface ProtoFilterChipProps {
  active: boolean
  label: string
  onClick: () => void
}

export function ProtoFilterChip({ active, label, onClick }: ProtoFilterChipProps) {
  return (
    <button
      onClick={onClick}
      className={`filter-chip ${active ? 'active' : ''}`}
    >
      {label}
    </button>
  )
}
```

- [ ] **Step 3: Create `src/components/proto-data-table.tsx`**

```tsx
interface ProtoDataTableProps {
  headers: { label: string; className?: string; tooltip?: string }[]
  children: React.ReactNode
}

export function ProtoDataTable({ headers, children }: ProtoDataTableProps) {
  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i} className={h.className || ''} title={h.tooltip}>
                {h.tooltip ? <span className="cursor-help border-b border-dotted border-[var(--muted)]">{h.label}</span> : h.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 4: Create `src/components/proto-pagination.tsx`**

```tsx
interface ProtoPaginationProps {
  page: number
  totalPages: number
  total: number
  limit: number
  onPageChange: (page: number) => void
}

export function ProtoPagination({ page, totalPages, total, limit, onPageChange }: ProtoPaginationProps) {
  const start = Math.min((page - 1) * limit + 1, total)
  const end = Math.min(page * limit, total)

  const pages: number[] = []
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pages.push(i)
  } else if (page <= 4) {
    for (let i = 1; i <= 7; i++) pages.push(i)
  } else if (page >= totalPages - 3) {
    for (let i = totalPages - 6; i <= totalPages; i++) pages.push(i)
  } else {
    for (let i = page - 3; i <= page + 3; i++) pages.push(i)
  }

  return (
    <div className="proto-pagination">
      <span>Showing {start}–{end} of {total}</span>
      <div className="pp-btns">
        <button disabled={page <= 1} onClick={() => onPageChange(page - 1)}>‹</button>
        {pages.map(p => (
          <button key={p} className={p === page ? 'active' : ''} onClick={() => onPageChange(p)}>
            {p}
          </button>
        ))}
        <button disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>›</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Run build**

```bash
npm run build
```
Expected: compiled successfully.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: add prototype-matching Badge, FilterChip, DataTable, Pagination components"
```

---

### Task 3: BOQs page — apply components

**Files:**
- Modify: `src/app/(authenticated)/boqs/page.tsx`

**Interfaces:**
- Consumes: Task 2 (ProtoBadge, ProtoFilterChip, ProtoDataTable, ProtoPagination)

- [ ] **Step 1: Update imports**

Add:
```tsx
import { ProtoBadge } from "@/components/proto-badge"
import { ProtoFilterChip } from "@/components/proto-filter-chip"
import { ProtoDataTable } from "@/components/proto-data-table"
import { ProtoPagination } from "@/components/proto-pagination"
```

Remove unused Button imports that are replaced (keep Button for Upload BOQ).

- [ ] **Step 2: Replace filter chips**

Current filter bar with `rounded-full` buttons → replace with `ProtoFilterChip` components. Add separator line between type filters and status filters:

```tsx
<div className="flex items-center gap-2 flex-wrap">
  {typeFilters.map(f => (
    <ProtoFilterChip key={f} active={activeFilter === f} label={f} onClick={() => { setActiveFilter(f); setPage(1) }} />
  ))}
  <span className="w-px h-5 bg-border mx-1" />
  {statusFilters.map(f => (
    <ProtoFilterChip key={f} active={activeFilter === f} label={f} onClick={() => { setActiveFilter(f); setPage(1) }} />
  ))}
</div>
```

Where `typeFilters = ["All", "Structural", "MEP", "Finishing"]` and `statusFilters = ["Draft", "Active", "Review", "Approved", "Parsed"]`.

- [ ] **Step 3: Replace data table**

Replace the hand-rolled `<table>` with `ProtoDataTable`:

```tsx
<ProtoDataTable
  headers={[
    { label: 'Project' },
    { label: 'Vendor' },
    { label: 'Work Type' },
    { label: 'Date' },
    { label: 'Items', className: 'num-col' },
    { label: 'Total', className: 'num-col' },
    { label: 'Status' },
    { label: 'Std', tooltip: 'Standardization status: matched (auto or approved) vs unmatched items' },
    { label: 'Actions', className: 'text-right whitespace-nowrap' },
  ]}
>
  {boqs.map(boq => {
    const std = computeStdStats(boq)
    return (
      <tr key={boq.id} data-boq-id={boq.id}>
        <td><Link href={`/boqs/${boq.id}`} className="font-medium text-foreground hover:text-accent no-underline">{boq.project}</Link></td>
        <td className="text-muted-foreground">{boq.vendor}</td>
        <td>{boq.workType}</td>
        <td className="text-muted-foreground">{boq.date}</td>
        <td className="num-col">{boq.totalItems}</td>
        <td className="num-col">{formatCurrency(boq.grandTotal)}</td>
        <td><ProtoBadge status={boq.status as any} /></td>
        <td>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{std.matched}/{std.total}</span>
            <div className="w-12 h-1.5 bg-muted rounded-full overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${std.pct}%`, backgroundColor: std.color }} />
            </div>
          </div>
        </td>
        <td className="text-right whitespace-nowrap">
          <Link href={`/boqs/${boq.id}`} className="inline-flex items-center justify-center h-7 px-2.5 text-xs font-medium rounded-lg border border-transparent hover:bg-muted hover:text-foreground transition-colors">View</Link>
        </td>
      </tr>
    )
  })}
</ProtoDataTable>
```

- [ ] **Step 4: Replace pagination**

Replace the shadcn Button-based pagination with `ProtoPagination`:

```tsx
<ProtoPagination page={page} totalPages={totalPages} total={total} limit={10} onPageChange={setPage} />
```

- [ ] **Step 5: Remove unused `STATUS_BADGE` and `STATUS_DOT` constants**

Remove lines 25-41 (the `STATUS_BADGE` and `STATUS_DOT` records) since ProtoBadge handles status styling now.

- [ ] **Step 6: Run build**

```bash
npm run build
```
Expected: compiled successfully.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "fix: apply prototype components to BOQs listing page"
```

---

### Task 4: BOQ Detail page — apply badges + table

**Files:**
- Modify: `src/app/(authenticated)/boqs/[id]/page.tsx`

**Interfaces:**
- Consumes: Task 2 (ProtoBadge, ProtoDataTable)

- [ ] **Step 1: Update imports**

```tsx
import { ProtoBadge } from "@/components/proto-badge"
import { ProtoDataTable } from "@/components/proto-data-table"
```

- [ ] **Step 2: Replace `STD_BADGE` map with ProtoBadge**

Replace the `STD_BADGE` record (lines 16-22) — remove it. Replace the `renderStdContent` function to use ProtoBadge:

```tsx
function renderStdContent(
  item: BoqItem,
  onMatch: () => void,
  onAccept: () => void,
  onReject: () => void
) {
  const status = (item.stdStatus || 'unmatched') as string
  if (status === 'matched') {
    return (
      <div className="flex flex-col gap-0.5">
        <ProtoBadge status="matched" />
        {item.stdMatch && <span className="text-[11px] text-muted-foreground truncate max-w-[140px]">{item.stdMatch}</span>}
      </div>
    )
  }
  if (status === 'fuzzy' || status === 'llm') {
    const badgeStatus = status === 'fuzzy' ? 'fuzzy' : 'llm'
    return (
      <div className="flex flex-col gap-1">
        <ProtoBadge status={badgeStatus} />
        {item.stdMatch && <span className="text-[11px] text-foreground truncate max-w-[140px]">{item.stdMatch}</span>}
        <div className="flex gap-1">
          <button onClick={onAccept} className="text-[10px] px-1.5 py-0.5 rounded bg-accent text-accent-foreground hover:bg-accent/80">Accept</button>
          <button onClick={onReject} className="text-[10px] px-1.5 py-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted">×</button>
        </div>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      <ProtoBadge status="unmatched" />
      <button onClick={onMatch} className="text-[10px] px-2 py-0.5 rounded border border-border hover:bg-muted text-muted-foreground hover:text-foreground">Match…</button>
    </div>
  )
}
```

- [ ] **Step 3: Replace `statusBadge` function with ProtoBadge**

Replace the `statusBadge()` function (lines 26-36):
```tsx
// Replace calls to statusBadge(boq.status) with:
<ProtoBadge status={boq.status as any} />
```

- [ ] **Step 4: Run build**

```bash
npm run build
```
Expected: compiled successfully.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "fix: apply ProtoBadge to BOQ detail page"
```

---

### Task 5: Compare page — match prototype styling

**Files:**
- Modify: `src/app/(authenticated)/compare/page.tsx`

**Interfaces:**
- Consumes: Task 2 (ProtoDataTable)

- [ ] **Step 1: Update imports**

Remove shadcn `Table` imports. Add:
```tsx
import { ProtoDataTable } from "@/components/proto-data-table"
```

- [ ] **Step 2: Replace shadcn Table with ProtoDataTable**

Find the comparison table rendering and replace:
```tsx
<ProtoDataTable
  headers={[
    { label: 'Description' },
    { label: 'Unit' },
    ...baselineBoqs.map(b => ({ label: `${b.project} — Qty`, className: 'num-col' as const })),
    ...baselineBoqs.map(b => ({ label: `${b.project} — Rate`, className: 'num-col' as const })),
    { label: 'Avg Rate', className: 'num-col' },
    { label: 'Trend' },
    { label: 'LLM' },
    { label: '', className: 'actions-col text-right' },
  ]}
>
  {matchedRows.map(row => (
    <tr key={row.id}>
      <td className="font-medium">{row.desc}</td>
      <td>{row.unit}</td>
      {row.items.map((item, i) => (
        <td key={i} className={`num-col ${item ? getTrend(item.rate, row.avgRate) === 'below' ? 'text-[#006400]' : getTrend(item.rate, row.avgRate) === 'above' ? 'text-[#dc2626]' : '' : ''}`}>
          {item ? item.rate.toLocaleString() : '—'}
        </td>
      ))}
      <td className="num-col">{row.avgRate.toLocaleString()}</td>
      <td><span className={`inline-flex items-center gap-[5px] px-[10px] py-[2px] rounded-[9999px] text-xs font-medium cursor-pointer ${row.trend === 'below' ? 'badge-approved' : row.trend === 'above' ? 'badge-rejected' : 'badge-draft'}`}>{row.trend}</span></td>
      <td><span className="text-xs text-muted-foreground cursor-pointer" onClick={() => setExpandedLlm(expandedLlm === row.id ? null : row.id)}>💬</span></td>
      <td className="text-right whitespace-nowrap"><Button variant="ghost" size="xs" onClick={() => handleImport(row)}>Import</Button></td>
    </tr>
  ))}
</ProtoDataTable>
```

- [ ] **Step 3: Update LLM badge rendering**

Replace the trend badge with prototype-matching style. Use `inline-flex` + pill styling + colored backgrounds that match the prototype's `.llm-badge` classes.

- [ ] **Step 4: Update summary stat cards**

Replace shadcn Card-based stat boxes with a 3-column grid using prototype's `compare-summary` styling:
```tsx
<div className="grid grid-cols-3 gap-4 mb-5">
  {[
    { label: 'BOQs Compared', value: boqs.length },
    { label: 'Items Matched', value: matchedRows.length },
    { label: 'Avg Variance', value: avgVariance > 0 ? `+${avgVariance.toFixed(1)}%` : `${avgVariance.toFixed(1)}%` },
  ].map(stat => (
    <div key={stat.label} className="p-4 border border-border rounded-[16px] bg-surface shadow-[var(--elev-raised)]">
      <div className="font-display text-3xl font-semibold leading-none tracking-tight">{stat.value}</div>
      <div className="text-sm text-muted-foreground mt-1">{stat.label}</div>
    </div>
  ))}
</div>
```

- [ ] **Step 5: Run build**

```bash
npm run build
```
Expected: compiled successfully.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "fix: apply prototype table and stat cards to Compare page"
```

---

### Task 6: Catalog page — match prototype styling

**Files:**
- Modify: `src/app/(authenticated)/catalog/page.tsx`

**Interfaces:**
- Consumes: Task 2 (ProtoBadge, ProtoDataTable)

- [ ] **Step 1: Update imports**

Add:
```tsx
import { ProtoBadge } from "@/components/proto-badge"
import { ProtoDataTable } from "@/components/proto-data-table"
```

- [ ] **Step 2: Replace shadcn Tabs with prototype tab buttons**

Replace:
```tsx
<Tabs value={tab} onValueChange={setTab}>
  <TabsList>
    <TabsTrigger value="review">Items to Review</TabsTrigger>
    <TabsTrigger value="catalog">Standard Catalog</TabsTrigger>
  </TabsList>
```
With:
```tsx
<div className="proto-tab-bar">
  <button className={`proto-tab-btn ${tab === 'review' ? 'active' : ''}`} onClick={() => setTab('review')}>Items to Review</button>
  <button className={`proto-tab-btn ${tab === 'catalog' ? 'active' : ''}`} onClick={() => setTab('catalog')}>Standard Catalog</button>
</div>
```

Replace `TabsContent value="review">` with `<div className={tab !== 'review' ? 'hidden' : ''}>` (and same for catalog).

- [ ] **Step 3: Replace status badges in review items table**

Replace shadcn `Badge` usage with `ProtoBadge`:
```tsx
// Before:
<Badge variant={badgeVariant}>{status}</Badge>
// After:
<ProtoBadge status={status as any} />
```

Remove the `statusBadge` function and its map (lines 95-100).

- [ ] **Step 4: Replace shadcn Table with ProtoDataTable**

Replace the review items table:
```tsx
<ProtoDataTable
  headers={[
    { label: 'Source BOQ' },
    { label: 'Original Description' },
    { label: 'Unit' },
    { label: 'Match Status' },
    { label: 'Suggested Standard' },
    { label: 'Action', className: 'text-right whitespace-nowrap' },
  ]}
>
  {filteredReviewItems.map((item, i) => (
    <tr key={i}>
      <td>{item.boqProject}</td>
      <td>{item.desc}</td>
      <td>{item.unit}</td>
      <td><ProtoBadge status={item.stdStatus as any} /></td>
      <td className="text-muted-foreground text-sm">{item.stdMatch || '—'}</td>
      <td className="text-right whitespace-nowrap">
        <Button variant="ghost" size="xs" onClick={() => acceptSuggestion(item)} disabled={acceptingIds.has(`${item.boqId}-${item.code}`)}>
          Accept
        </Button>
      </td>
    </tr>
  ))}
</ProtoDataTable>
```

Replace the catalog standards table similarly.

- [ ] **Step 5: Replace stat cards**

Replace shadcn Card stat boxes with prototype-styled cards:
```tsx
<div className="flex gap-4 mb-5">
  <div className="p-3 border border-border rounded-[16px] bg-surface shadow-[var(--elev-raised)]">
    <div className="text-xl font-semibold leading-tight">{suggestions}</div>
    <div className="text-xs text-muted-foreground uppercase tracking-wider">Suggestions</div>
  </div>
  <div className="p-3 border border-border rounded-[16px] bg-surface shadow-[var(--elev-raised)]">
    <div className="text-xl font-semibold leading-tight">{unmatched}</div>
    <div className="text-xs text-muted-foreground uppercase tracking-wider">Unmatched items</div>
  </div>
  <div className="p-3 border border-border rounded-[16px] bg-surface shadow-[var(--elev-raised)]">
    <div className="text-xl font-semibold leading-tight">{reviewItems.length}</div>
    <div className="text-xs text-muted-foreground uppercase tracking-wider">Awaiting review</div>
  </div>
</div>
```

- [ ] **Step 6: Run build**

```bash
npm run build
```
Expected: compiled successfully.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "fix: apply prototype tabs, badges, and tables to Catalog page"
```
