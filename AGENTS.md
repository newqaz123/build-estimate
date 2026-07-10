<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# BuildEstimate — anchored context

## Project spine
Construction cost estimating prototype (Southeast Asia focus). Airtable-inspired design with deep navy sidebar, Haas Swiss typography, blue-tinted shadow stack. Stakeholder: construction consultant with 500+ subs.

## Pages built
- `dashboard.html` — overview with stat cards (BOQs, estimates, subs, vendors), recent activity feed
- `boqs.html` — BOQ listing with status badges, search, filter chips, pagination; upload modal with drag-drop PDF → Docling parsing flow; side-by-side review panel (PDF preview left, editable items right) with LLM verify support
- `boq-detail.html` — single BOQ view with collapsible sections (concrete, rebar, formwork), line items editable inline, estimate builder with add-to-estimate and quantity-adjust panel, sticky summary bar
- `compare.html` — vendor comparison grid (3 BOQs shown), individual row selection for estimate building, color-coded variance indicators (green/amber/red price deltas), multiple baseline options
- `estimator.html` — estimate builder with item tree (imported, manual, adjustments), right panel for item details, quantity takeoff/rate adjust, sticky totals bar
- `settings.html` — vendor list, rate books, team members, workspace settings
- `login.html` — auth page with sidebar brand + login form layout

## Design system (`shared.css`)
- CSS custom properties for colors, spacing, typography, elevation, border-radius
- Components: buttons (primary/secondary/ghost/danger/outline-danger), cards, data tables, badges (draft/active/review/approved/rejected), form fields, modals, toolbars, pagination, drop zone, loading/empty states, toasts, collapsible sections
- Side-by-side review panel: full-height overlay, split 50/50, mock PDF page with realistic styling (serif headers, ruled tables, page numbers, signatures)

## Key UX patterns
- Upload PDF → Docling auto-parses → side-by-side review (source PDF vs parsed items) → LLM verify → approve & save
- Compare: up to 3 BOQs side-by-side with variance highlight
- Estimate builder: import items from BOQs → adjust quantities/rates → sticky totals
- Status badges: draft (grey), parsed (grey), active (blue), review (amber), approved (green), rejected (red)
- Inline editing throughout: items, metadata, quantities, rates
- LLM hint badge: "Apply?" toggle → "Applied" for one-click accept

## Naming conventions
- `data-od-id` attributes on interactive elements for targeting
- IDs prefixed: `rev*` for review fields, `ri-*` for review items, `.num` + `.num-col` for numeric styling
- Parser: mock items via `mockParsedItems` array with code/desc/unit/qty/rate/total/type

## Abbreviations
- BOQ = Bill of Quantities
- L/S = Lump Sum
- MEP = Mechanical/Electrical/Plumbing
