# BuildEstimate All-Pages Prototype Parity Design

## Objective

Bring every user-facing Next.js page into close visual and interaction parity with its corresponding root HTML prototype while preserving current application behavior, data flow, and the established BuildEstimate visual identity.

The root HTML files are the visual source of truth:

- `dashboard.html`
- `boqs.html`
- `boq-detail.html`
- `compare.html`
- `catalog.html`
- `estimator.html`
- `settings.html`
- `login.html`

## Scope

The pass covers the matching Next.js routes:

- `/dashboard`
- `/boqs`
- `/boqs/[id]`
- `/compare`
- `/catalog`
- `/estimator`
- `/settings`
- `/`

The work includes typography, text contrast, spacing, layout, controls, cards, tables, status indicators, modals, responsive behavior, hover/focus states, and empty/loading/error presentation.

## Design Direction

Retain the existing Airtable-inspired construction workspace language: deep navy navigation, crisp white working surfaces, Haas typography, blue interaction accents, compact data density, tabular numeric styling, and the blue-tinted elevation stack.

The implementation should not reinterpret the prototypes. It should reproduce their hierarchy and rhythm while adapting static prototype markup to real application state and accessible controls.

## Architecture

### 1. Shared Foundation

Audit `src/styles/globals.css` and `src/app/globals.css` before page-specific changes.

- Separate semantic text colors from surface colors to avoid token collisions such as `--muted` being used for both backgrounds and secondary text.
- Preserve prototype tokens for foreground, secondary foreground, borders, accent, status colors, spacing, radii, elevation, motion, typography, sidebar dimensions, and topbar dimensions.
- Consolidate repeated prototype primitives into shared classes or the existing `Proto*` components where reuse is real.
- Avoid introducing a second parallel design system or broad refactors unrelated to parity.
- Preserve visible keyboard focus, adequate text contrast, reduced-motion behavior, and touch-friendly controls.

### 2. Application Shell

Apply one consistent shell across authenticated pages.

- Sidebar width, collapsed state, icon opacity, labels, active state, footer, and mobile collapse follow the prototype.
- Topbar title and contextual actions remain route-aware.
- Main content width, padding, scrolling, sticky regions, and responsive breakpoints remain consistent across routes.
- Fixed estimator and BOQ summary bars must account for sidebar state and small screens.

### 3. Page-Level Parity

#### Dashboard

- Match prototype stat cards, typography, values, trend indicators, source labels, and card spacing.
- Match recent activity density, metadata hierarchy, action alignment, and empty/loading states.
- Ensure cards stack cleanly on narrow screens without truncating primary values.

#### BOQ Listing

- Match toolbar, search field, filter chips, upload action, table density, status badges, numeric columns, row actions, and pagination placement.
- Keep View and Download actions discoverable without overpowering the table.
- Preserve upload and parsing workflows while matching prototype modal and drop-zone styling.

#### BOQ Detail

- Match metadata controls, status, work-type selector, action hierarchy, collapsible sections, inline editing, standardization badges, and sticky estimate summary.
- Preserve per-row and bulk-save behavior.
- Match source review and verification states where those interfaces are available.

#### Compare

- Match quotation summary cards, baseline control, comparison grid, vendor headings, currency formatting, selection controls, variance colors, LLM attribution, and import actions.
- Variance styling must remain understandable without color alone through labels or icons already present in the prototype.
- Horizontal overflow must remain usable on smaller screens.

#### Catalog

- Match review statistics, underline tabs, search/filter controls, standard item table, source labels, matching indicators, and row actions.
- Maintain compact density while keeping secondary text readable.

#### Estimator

- Match project metadata, editable item rows, quantity/rate/total alignment, item detail modal, historical description suggestions, agent chat, and bottom summary actions.
- Preserve PDF/print output behavior and hide interactive chrome in print mode.
- Ensure floating chat and fixed summary do not overlap content on desktop or mobile.

#### Settings

- Match prototype navigation and section layout for vendors, rate books, team, and workspace settings.
- Standardize form fields, cards, tables, destructive actions, save states, and responsive stacking.
- Do not alter settings schemas or API behavior.

#### Login

- Match the prototype split brand/form composition, typography, field states, primary action, validation presentation, and responsive single-column fallback.
- Preserve the existing authentication provider and redirect behavior.

## Interaction And Data Boundaries

- Existing API routes, schemas, authentication, persistence, and business logic remain unchanged unless a visual defect exposes a concrete integration bug.
- Page changes may restructure presentational markup but must preserve event handlers, loading states, errors, disabled states, and navigation behavior.
- Reusable components receive explicit props and remain independent of route-specific data fetching.
- Prototype-only mock data must not replace live application data.

## Error Handling

- Existing request failures remain visible with actionable text.
- Buttons show disabled or loading states during mutations where supported by current behavior.
- Empty tables and lists use the prototype empty-state treatment without implying that a request succeeded when it failed.
- Long names, descriptions, currencies, and status labels must wrap or truncate intentionally.

## Verification

### Automated

- Run the production build and TypeScript checks through `npm run build`.
- Run any existing relevant tests discovered during implementation.
- Check for browser console errors on the audited routes.

### Visual

- Compare each Next.js route against its matching HTML prototype at a representative desktop viewport.
- Check authenticated shell and content at a narrow mobile viewport.
- Verify default, hover, focus, disabled, empty, loading, modal, dropdown, and sticky/fixed states where applicable.
- Confirm secondary text is readable on every surface and primary text meets strong contrast expectations.

## Implementation Order

1. Shared color, typography, spacing, elevation, and shell audit.
2. Dashboard.
3. BOQ listing and upload/review surfaces.
4. BOQ detail.
5. Compare.
6. Catalog.
7. Estimator.
8. Settings.
9. Login.
10. Cross-page responsive and regression pass.

## Non-Goals

- New product features or workflows.
- API, database, authentication, or schema redesign.
- Replacing the established prototype visual language with a new theme.
- Rebuilding correct shared components solely to change implementation style.
- Committing generated screenshots, browser logs, or unrelated worktree changes.

## Acceptance Criteria

- Every listed route clearly matches the composition, typography, color, density, and action hierarchy of its corresponding prototype.
- Secondary text remains readable and semantic surface/text tokens do not conflict.
- Existing user workflows still operate after presentational changes.
- Desktop and mobile layouts load without overlapping controls, inaccessible content, or broken fixed/sticky regions.
- The production build passes.
- Visual checks reveal no major prototype parity regressions on the audited routes.
