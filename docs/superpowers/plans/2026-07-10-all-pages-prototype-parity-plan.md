# BuildEstimate All-Pages Prototype Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring all eight user-facing Next.js pages into close visual and interaction parity with their matching root HTML prototypes without changing application behavior or data contracts.

**Architecture:** Fix semantic design tokens and the authenticated shell first, then audit each route against its root HTML source of truth. Reuse the existing `Proto*` components and prototype CSS classes where they already express the correct design; add page-specific classes only for genuinely page-specific layouts. Verify each independently testable page group with build/lint and browser comparisons before moving on.

**Tech Stack:** Next.js 16.2.10 App Router, React 19.2.4, TypeScript, Tailwind CSS 4, prototype CSS, Base UI/shadcn components, Lucide React, Playwright/agent-browser for visual verification.

## Global Constraints

- Root HTML files are the visual source of truth: `dashboard.html`, `boqs.html`, `boq-detail.html`, `compare.html`, `catalog.html`, `estimator.html`, `settings.html`, and `login.html`.
- Preserve API routes, schemas, authentication, persistence, business logic, event handlers, and live data.
- Do not replace live data with prototype mock data.
- Preserve BuildEstimate's deep navy navigation, white work surfaces, Haas typography, blue accent, compact data density, tabular numeric styling, and blue-tinted elevation.
- Keep secondary text readable; do not reuse a surface token as a text token.
- Preserve visible keyboard focus, reduced motion, responsive access, loading, error, empty, disabled, and mutation states.
- Avoid unrelated refactors and do not introduce another component library.
- Do not commit changes unless the user explicitly requests a commit.
- Do not modify or delete unrelated `.playwright-mcp` logs, screenshots, or worktree changes.

## File Structure

- `src/styles/globals.css`: canonical prototype design tokens.
- `src/app/globals.css`: Tailwind/shadcn bridge plus prototype component and page styles.
- `src/components/app-shell.tsx`: authenticated viewport, topbar, content scroll region.
- `src/components/sidebar.tsx`: navigation, collapse behavior, sign-out action.
- `src/components/topbar.tsx`: route-aware page title, back navigation, account affordance.
- `src/components/proto-*.tsx`: shared buttons, badges, tables, filters, and pagination.
- `src/components/upload-modal.tsx`, `review-panel.tsx`: BOQ ingestion/review UI.
- `src/components/collapsible-section.tsx`, `standardization-review.tsx`: BOQ detail UI.
- `src/components/catalog-match-modal.tsx`: catalog review UI.
- `src/app/(authenticated)/*/page.tsx`: route-specific composition and state.
- `src/app/(public)/page.tsx`: login composition and authentication form.
- Root `*.html`: read-only visual references.

---

### Task 0: Clean Existing Lint Baseline

**Files:**
- Modify only files reported by `npm run lint`

**Interfaces:**
- Consumes: current application behavior and ESLint configuration.
- Produces: a clean lint baseline for subsequent visual tasks.

- [ ] **Step 1: Reproduce the baseline**

Run `npm run lint` and retain the full list of errors and warnings.

- [ ] **Step 2: Fix React hook and purity findings**

Replace derived-state effects with render-time derivation where possible, invoke asynchronous loading without synchronous effect-state patterns, avoid ref reads during render, and generate IDs only inside event-driven code. Preserve request timing, state transitions, and rendered data.

- [ ] **Step 3: Fix TypeScript and module findings**

Replace explicit `any` with existing domain types or narrow local types, remove unused imports/types, and replace forbidden CommonJS `require()` calls with typed imports without changing Firebase initialization behavior.

- [ ] **Step 4: Verify lint and build**

Run:

```bash
npm run lint
npm run build
```

Expected: ESLint passes with zero errors and zero warnings; the production build passes. The pre-existing Next.js middleware convention deprecation warning is tracked separately and is outside this lint cleanup.

---

### Task 1: Semantic Tokens And Authenticated Shell

**Files:**
- Modify: `src/styles/globals.css`
- Modify: `src/app/globals.css`
- Modify: `src/components/app-shell.tsx`
- Modify: `src/components/sidebar.tsx`
- Modify: `src/components/topbar.tsx`

**Interfaces:**
- Consumes: existing CSS variables and `AppShell({ title?, backHref?, children })`.
- Produces: stable semantic tokens including `--muted-text`, and shell classes used by every authenticated route.

- [ ] **Step 1: Record the current shell and token failures**

Run:

```bash
npm run lint
npm run build
```

Expected: commands complete or expose pre-existing errors that must be recorded before edits. Open `/dashboard` at desktop and narrow widths and record unreadable text, shell overflow, sidebar, and topbar differences against `dashboard.html`.

- [ ] **Step 2: Separate semantic text and surface tokens**

Keep the canonical token distinction explicit:

```css
:root {
  --bg: #ffffff;
  --surface: #ffffff;
  --fg: #181d26;
  --fg-2: #333333;
  --muted-text: rgba(4, 14, 32, 0.69);
  --muted: #eef0f3;
  --border: #e0e2e6;
  --border-soft: #eef0f3;
  --accent: #1b61c9;
  --accent-on: #ffffff;
}
```

Change prototype selectors that communicate secondary information to `color: var(--muted-text)`. Keep `var(--muted)` only for muted surfaces.

- [ ] **Step 3: Normalize the shell markup**

Replace utility-only shell structure with named classes while preserving props:

```tsx
<div className="app-shell">
  <Sidebar />
  <div className="main-area">
    <Topbar title={title} backHref={backHref} />
    <main className="main-content">{children}</main>
  </div>
</div>
```

Add matching CSS for full-height layout, minimum content width, scrolling, desktop padding, and mobile padding. Keep `data-od-id` attributes.

- [ ] **Step 4: Remove inline sidebar presentation**

Give the sign-out button a class instead of inline styles:

```tsx
<button type="submit" data-od-id="nav-signout" className="sidebar-signout">
  {signOutIcon}
  <span>Sign out</span>
</button>
```

Style `.sidebar-signout` consistently with `.sidebar-nav a`, including hover, focus-visible, collapsed, and mobile behavior.

- [ ] **Step 5: Match the topbar prototype**

Use named `.topbar`, `.topbar-left`, and `.topbar-right` classes, preserve `deriveTitle()`, and ensure the back control, title, role text, and avatar remain readable at narrow widths.

- [ ] **Step 6: Verify the shared shell**

Run:

```bash
npm run lint
npm run build
```

Expected: both pass. Browser-check `/dashboard`, `/boqs`, `/boqs/fixture`, `/compare`, `/catalog`, `/estimator`, and `/settings` at approximately 1440x900 and 390x844. Expected: no horizontal shell overflow; sidebar/topbar remain usable; secondary text is dark enough on white surfaces.

---

### Task 2: Dashboard Parity

**Files:**
- Modify: `src/app/(authenticated)/dashboard/page.tsx`
- Modify: `src/app/globals.css`
- Reference: `dashboard.html`

**Interfaces:**
- Consumes: `.proto-card`, `.stat-card`, `.meta`, `.btn`, and shell classes from Task 1.
- Produces: responsive dashboard stat grid and prototype-matched activity/quick-stat cards.

- [ ] **Step 1: Capture baseline states**

Compare `/dashboard` with `dashboard.html` for loaded, loading, and empty states. Record differences in card padding, heading weight, value scale, trend iconography, activity row density, metadata, and responsive stacking.

- [ ] **Step 2: Match dashboard composition**

Use semantic page classes rather than repeated utility bundles:

```tsx
<section className="dashboard-stats" data-od-id="dashboard-stats">
  <div className="proto-card stat-card">...</div>
</section>
<section className="dashboard-grid">
  <article className="proto-card dashboard-panel">...</article>
  <article className="proto-card dashboard-panel">...</article>
</section>
```

Keep all fetched values and links unchanged.

- [ ] **Step 3: Match state presentation**

Use `.proto-spinner` for loading and `.proto-empty-state` for no data. Preserve the upload/get-started link and ensure status chips use existing semantic status classes.

- [ ] **Step 4: Add responsive rules**

At medium widths, use two stat columns; at phone widths, one column. Allow activity names to truncate while actions and status remain visible.

- [ ] **Step 5: Verify dashboard**

Run `npm run build`. Expected: pass. Compare desktop and mobile screenshots to `dashboard.html`; verify the View all link, empty-state link, and status presentation.

---

### Task 3: BOQ Listing, Upload, And Review Parity

**Files:**
- Modify: `src/app/(authenticated)/boqs/page.tsx`
- Modify: `src/components/upload-modal.tsx`
- Modify: `src/components/review-panel.tsx`
- Modify: `src/components/proto-filter-chip.tsx`
- Modify: `src/components/proto-data-table.tsx`
- Modify: `src/components/proto-pagination.tsx`
- Modify: `src/app/globals.css`
- Reference: `boqs.html`

**Interfaces:**
- Consumes: existing BOQ fetch, filtering, pagination, upload, parsing, review, download, and navigation handlers.
- Produces: reusable table/filter/pagination presentation and prototype-matched ingestion surfaces.

- [ ] **Step 1: Audit all BOQ listing states**

Compare toolbar, filters, loaded table, loading, empty, error, upload modal, drag-active state, parsing progress, review panel, and pagination against `boqs.html`.

- [ ] **Step 2: Normalize toolbar and filters**

Keep existing state callbacks and render the prototype structure:

```tsx
<div className="proto-toolbar">
  <div className="proto-toolbar-left">
    <div className="search-wrap">...</div>
    <div className="filter-group">...</div>
  </div>
  <div className="proto-toolbar-right">...</div>
</div>
```

Ensure each filter chip has `aria-pressed={active}` and visible focus.

- [ ] **Step 3: Match table and row actions**

Keep `ProtoDataTable` generic. Ensure BOQ name/vendor cells can truncate, Items and Total use `.num-col`, statuses use `ProtoBadge`, and View/Download remain keyboard-accessible.

- [ ] **Step 4: Match upload and parsing states**

Use `.modal-overlay`, `.modal`, `.drop-zone`, `.proto-spinner`, and `.proto-empty-state` classes without changing `react-dropzone` handlers or parsing requests. Keep progress/status copy tied to actual state.

- [ ] **Step 5: Match side-by-side review**

Preserve the source/parsed split, editable fields, verification controls, approval action, and close behavior. Add responsive behavior that stacks panels at narrow widths rather than shrinking both below readable size.

- [ ] **Step 6: Verify BOQ listing workflow**

Run `npm run lint` and `npm run build`. Expected: pass. Browser-check search, filters, pagination, View, Download, modal open/close, drag affordance, review panel, and mobile table scrolling.

---

### Task 4: BOQ Detail Parity

**Files:**
- Modify: `src/app/(authenticated)/boqs/[id]/page.tsx`
- Modify: `src/components/collapsible-section.tsx`
- Modify: `src/components/standardization-review.tsx`
- Modify: `src/app/globals.css`
- Reference: `boq-detail.html`

**Interfaces:**
- Consumes: existing BOQ fetch/update/delete/export/approve handlers, inline item editing, section state, and standardization workflow.
- Produces: prototype-matched metadata header, item sections, review states, and sticky summary.

- [ ] **Step 1: Audit detail states**

Compare loading, error, metadata, approved/unapproved states, collapsed/expanded sections, row editing, unsaved indicator, standardization badges, delete confirmation, and sticky summary against `boq-detail.html`.

- [ ] **Step 2: Match metadata and action hierarchy**

Group status, dates, vendor, work type, and actions using named detail-header classes. Preserve Download PDF, Export CSV, Approve, Save All, and Delete handlers and disabled states.

- [ ] **Step 3: Match collapsible sections**

Keep the component API and render section code/title, item count, section total, and chevron in the prototype order. Ensure the header is a real button with `aria-expanded` and `aria-controls`.

- [ ] **Step 4: Match editable rows and save feedback**

Use prototype inputs, numeric alignment, work-item badges, row actions, and visible dirty/saving/saved states. Do not change row update payloads.

- [ ] **Step 5: Match standardization review and summary bar**

Preserve matched/suggested/LLM/unmatched meanings and approval controls. Ensure the sticky summary does not obscure the last item and responds to collapsed sidebar/mobile layout.

- [ ] **Step 6: Verify BOQ detail**

Run `npm run build`. Expected: pass. Browser-check section toggles, inline edit/save, work-type change, date edit, approve, export buttons, delete confirmation, and narrow-width summary behavior.

---

### Task 5: Compare Parity

**Files:**
- Modify: `src/app/(authenticated)/compare/page.tsx`
- Modify: `src/app/globals.css`
- Reference: `compare.html`

**Interfaces:**
- Consumes: existing BOQ comparison rows, baseline selection, variance calculation, LLM commentary, row selection, and estimate import.
- Produces: prototype-matched summary cards and horizontally usable comparison grid.

- [ ] **Step 1: Audit compare states**

Compare empty, loading, summary, baseline selection, table, commentary expanded state, imported state, and narrow-width overflow against `compare.html`.

- [ ] **Step 2: Match summary and baseline controls**

Keep calculated values unchanged. Render summary cards with `.proto-card.stat-card` and place the baseline select and matched-row metadata in a prototype toolbar.

- [ ] **Step 3: Match the comparison grid**

Preserve dynamic vendor columns and use `.num-col` for currency. Retain `฿`, tabular numerals, row selection, average rate, and variance classification.

- [ ] **Step 4: Make variance understandable**

Apply green/amber/red tint classes and retain textual labels/icons such as Below, At average, Above, or New so meaning is not color-only. Keep LLM attribution in `.llm-comment`.

- [ ] **Step 5: Verify compare interactions**

Run `npm run build`. Expected: pass. Browser-check baseline changes, row selection, commentary toggle, Import, imported feedback, empty state, and horizontal scrolling on mobile.

---

### Task 6: Catalog Parity

**Files:**
- Modify: `src/app/(authenticated)/catalog/page.tsx`
- Modify: `src/components/catalog-match-modal.tsx`
- Modify: `src/app/globals.css`
- Reference: `catalog.html`

**Interfaces:**
- Consumes: standards/vendors APIs, tab state, search, standardization/matching actions, modal state, and row actions.
- Produces: prototype review statistics, underline tabs, catalog tables, and matching modal.

- [ ] **Step 1: Audit catalog states**

Compare loading, standards tab, vendor tab, review statistics, search, source metadata, matched indicators, modal, empty states, and errors against `catalog.html`.

- [ ] **Step 2: Match review statistics and tabs**

Use `.review-stats`, `.review-stat`, `.catalog-tabs`, and `.tab-btn`; preserve counts and `aria-selected`/keyboard semantics.

- [ ] **Step 3: Match tables and actions**

Use compact table styles, readable source labels, semantic match badges, numeric columns, and prototype button hierarchy. Preserve all fetch/mutation callbacks.

- [ ] **Step 4: Match the catalog match modal**

Use prototype modal/form classes, preserve search and selection behavior, and ensure long descriptions and source metadata remain readable.

- [ ] **Step 5: Verify catalog**

Run `npm run lint` and `npm run build`. Expected: pass. Browser-check both tabs, search, matching modal, row actions, empty/error states, and mobile overflow.

---

### Task 7: Estimator Parity And Fixed-Layer Safety

**Files:**
- Modify: `src/app/(authenticated)/estimator/page.tsx`
- Modify: `src/app/globals.css`
- Reference: `estimator.html`

**Interfaces:**
- Consumes: existing estimate fetch/save/clear, item modal, autocomplete, chat, import, totals, and print/PDF behavior.
- Produces: prototype-matched estimate workspace with non-overlapping fixed summary/chat layers.

- [ ] **Step 1: Audit estimator states**

Compare loading, empty, populated, item hover/edit, add/edit modal, autocomplete, chat closed/open/typing/suggestion, save, clear, and print states against `estimator.html`.

- [ ] **Step 2: Match project metadata and item list**

Keep the `.est-page`, `.project-meta`, `.est-header`, `.est-list`, and `.est-row` structure. Ensure description, quantity, rate, total, and row action align at desktop and transform into a readable mobile layout.

- [ ] **Step 3: Match item modal and suggestions**

Preserve modal state and historical autocomplete logic. Ensure fields have labels, suggestions are keyboard/click accessible, and numeric inputs retain correct payload types.

- [ ] **Step 4: Match agent chat**

Preserve chat requests and suggestions. Match header, user/bot messages, suggestion cards, typing indicator, close/send actions, and readable secondary text.

- [ ] **Step 5: Resolve fixed layer collisions**

Reserve bottom space for `.est-summary`, position `.chat-bubble-btn` above it, and constrain `.chat-overlay` within the viewport. At phone widths, use viewport-relative width and height without covering the summary actions.

- [ ] **Step 6: Verify estimator and print**

Run `npm run build`. Expected: pass. Browser-check add/edit/delete item, autocomplete, chat, Clear, Save Estimate, PDF/print preview, desktop/mobile layers, and empty state.

---

### Task 8: Settings Parity

**Files:**
- Modify: `src/app/(authenticated)/settings/page.tsx`
- Modify: `src/app/globals.css`
- Reference: `settings.html`

**Interfaces:**
- Consumes: existing workspace settings, LLM, Docling, fuzzy matching, prompts, and vendor state/API handlers.
- Produces: prototype settings navigation, section cards, forms, tables, modal, and save/test feedback.

- [ ] **Step 1: Map current settings sections to the prototype**

Identify the exact rendered blocks for vendors, LLM, Docling, fuzzy/unit rules, and prompts. Preserve every state variable and request function; only reorganize presentational markup.

- [ ] **Step 2: Add settings page structure**

Render prototype-aligned navigation and content:

```tsx
<div className="settings-grid">
  <nav className="settings-nav" aria-label="Settings sections">...</nav>
  <div className="settings-content">...</div>
</div>
```

Use buttons or anchor links with an explicit active state; do not hide unsaved state when switching sections.

- [ ] **Step 3: Replace shadcn presentation with prototype classes**

Keep Base UI/shadcn controls where they provide behavior, but apply `.proto-card`, `.proto-input`, `.proto-select`, `.proto-textarea`, `.btn`, `.data-table`, and `.modal` presentation consistently. Do not rewrite working select/dialog internals without a visual or accessibility reason.

- [ ] **Step 4: Match vendors and destructive actions**

Preserve create/edit/delete handlers and confirmation behavior. Match table density, specialty labels, modal fields, loading states, and outline-danger hierarchy.

- [ ] **Step 5: Match configuration forms**

Ensure provider/model/endpoint/API key fields, Docling test state, JSON textareas, prompt token estimate, and Save actions have readable labels, help text, errors, and responsive form rows.

- [ ] **Step 6: Verify settings workflows**

Run `npm run lint` and `npm run build`. Expected: pass. Browser-check navigation, provider select, masked key field, save buttons, Docling test, vendor add/edit/delete modal, prompt editing, and phone-width stacking.

---

### Task 9: Login Parity

**Files:**
- Modify: `src/app/(public)/page.tsx`
- Modify: `src/app/globals.css`
- Reference: `login.html`

**Interfaces:**
- Consumes: `signIn("credentials", { password, redirect: false })` and router redirect to `/dashboard`.
- Produces: prototype split login composition and responsive single-column form.

- [ ] **Step 1: Audit login states**

Compare default, focus, loading, authentication error, desktop split, and mobile layout against `login.html`.

- [ ] **Step 2: Replace utility-only composition with prototype classes**

Keep authentication logic unchanged and render:

```tsx
<main className="login-page">
  <section className="login-brand" data-od-id="login-brand">...</section>
  <section className="login-form-wrap" data-od-id="login-form-wrap">
    <form className="login-form" onSubmit={handleSubmit}>...</form>
  </section>
</main>
```

- [ ] **Step 3: Match form and feedback states**

Use visible labels, `.proto-input`, `.btn.btn-primary`, disabled/loading styling, and a dedicated `.form-error` with `role="alert"`. Preserve email display, password autocomplete, required validation, and redirect behavior.

- [ ] **Step 4: Add responsive login behavior**

At phone widths, stack brand and form, reduce padding, retain enough brand context, and keep the form usable without scrolling horizontally.

- [ ] **Step 5: Verify login**

Run `npm run build`. Expected: pass. Browser-check focus, empty submit, invalid password error, loading state, successful redirect when credentials are available, and desktop/mobile layouts.

---

### Task 10: Cross-Page Visual And Interaction Regression

**Files:**
- Modify only files with defects found during this pass.
- Do not modify root prototype HTML files.

**Interfaces:**
- Consumes: completed Tasks 1-9.
- Produces: final verified all-pages parity state.

- [ ] **Step 1: Run static verification**

Run:

```bash
npm run lint
npm run build
git diff --check
git status --short
```

Expected: lint/build pass, no whitespace errors, and status contains only intended source/spec changes plus pre-existing unrelated artifacts.

- [ ] **Step 2: Capture desktop comparisons**

At approximately 1440x900, compare each app route with its matching root HTML file. Check composition, font size/weight/color, spacing, borders, radius, elevation, control hierarchy, table density, and fixed/sticky elements.

- [ ] **Step 3: Capture mobile comparisons**

At approximately 390x844, check login plus every authenticated route. Expected: no inaccessible controls, clipped dialogs, content hidden behind summaries/chat, or shell-level horizontal overflow. Data grids may scroll within their own containers.

- [ ] **Step 4: Exercise interaction states**

Check keyboard focus and representative hover, disabled, loading, empty, error, dropdown, modal, collapsible, autocomplete, chat, save, delete confirmation, and print states. Review browser console output after each route.

- [ ] **Step 5: Fix only observed regressions**

Apply minimal targeted CSS or markup corrections. Do not add speculative abstractions or change data behavior.

- [ ] **Step 6: Run final verification**

Run:

```bash
npm run lint
npm run build
git diff --check
```

Expected: all commands pass. Recheck any page changed during Step 5 and report remaining visual limitations, if any, with exact routes and states.
