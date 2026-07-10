# BuildEstimate — Next.js + Firebase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert static HTML/CSS/JS prototype to full-stack Next.js (App Router) + Firebase application with real LLM integration.

**Architecture:** Next.js App Router with API routes for all DB access (Firestore via Admin SDK). Provider-agnostic LLM wrapper supporting OpenAI + OpenRouter. Python Docling sidecar as separate Docker container. Firebase-only deployment (Hosting, Cloud Functions, Firestore, Storage, Cloud Run).

**Tech Stack:** Next.js 14+, TypeScript, Tailwind CSS, shadcn/ui, NextAuth (credentials), Firebase Admin SDK, Firebase Client SDK

## Global Constraints

- All DB access through API routes — no direct Firestore SDK on client
- No real-time listeners — fetch-on-navigate pattern
- LLM calls only on explicit user action (never automatic for verify/compare)
- Design tokens from existing `shared.css` — Airtable-inspired navy sidebar, Haas Swiss typography
- `data-od-id` attributes on interactive elements for targeting
- Single admin user, password from `ADMIN_PASSWORD` env var
- Files under `src/` — App Router in `src/app/`, shared lib in `src/lib/`, components in `src/components/`

---

### Task 1: Project scaffold + design system

**Files:**
- Create: Project root (Next.js + Tailwind + shadcn)
- Create: `src/lib/design.ts` — design token constants
- Create: `src/styles/globals.css` — ported CSS custom properties
- Modify: `tailwind.config.ts` — ported color/spacing tokens

**Interfaces:**
- Consumes: `shared.css` from project root (reference for tokens)
- Produces: Tailwind config with navy/success/warn/danger colors, spacing scale, border radius tokens; global CSS with custom properties

**Steps:**
- [ ] **Step 1: Scaffold Next.js project**

```bash
npx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*"
```

- [ ] **Step 2: Port design tokens to tailwind.config.ts**

Read `shared.css` and extract color variables (`--navy`, `--accent`, `--success`, `--warn`, `--danger`, `--muted`, `--bg`, `--fg`, `--border`), spacing (`--space-1` through `--space-10`), and border radius (`--radius-sm`, `--radius-md`, `--radius-lg`). Extend the Tailwind theme.

- [ ] **Step 3: Port global CSS**

Create `src/styles/globals.css` with custom properties from `shared.css` (the `:root` block). Configure import in `src/app/layout.tsx`.

- [ ] **Step 4: Install core dependencies**

```bash
npm install next-auth@beta firebase-admin firebase react-dropzone
npm install -D @types/react-dropzone
```

- [ ] **Step 5: Initialize shadcn/ui**

```bash
npx shadcn@latest init -d
npx shadcn@latest add button card badge table input select dialog tabs sheet toast
```

- [ ] **Step 6: Create directory structure**

```bash
mkdir -p src/components/ui src/lib src/app/api/auth/\[...nextauth\] src/app/api/boqs/\[id\] src/app/api/items src/app/api/standards src/app/api/vendors src/app/api/estimates src/app/api/llm/standardize src/app/api/llm/verify src/app/api/llm/compare src/app/api/parse-pdf src/app/dashboard src/app/boqs/\[id\] src/app/catalog src/app/compare src/app/estimator src/app/settings
```

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: scaffold Next.js project with design system"
```

---

### Task 2: Auth setup

**Files:**
- Create: `src/app/api/auth/[...nextauth]/route.ts` — NextAuth handler
- Create: `src/lib/auth.ts` — auth config + types
- Create: `src/lib/auth-context.tsx` — AuthProvider client component
- Create: `src/middleware.ts` — route protection
- Modify: `src/app/layout.tsx` — wrap with AuthProvider, add SessionProvider

**Interfaces:**
- Consumes: Task 1 (project scaffold)
- Produces: `auth()` server-side helper, `useSession()` client-side, middleware protecting all routes except `/`

```typescript
// src/lib/auth.ts
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Credentials({
      credentials: {
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (credentials?.password === process.env.ADMIN_PASSWORD) {
          return { id: "1", name: "Admin", email: "admin@buildestimate.app" };
        }
        return null;
      },
    }),
  ],
  pages: { signIn: "/" },
  session: { strategy: "jwt" },
});
```

- [ ] **Step 1: Write auth config**

Create `src/lib/auth.ts` with NextAuth credentials provider reading `ADMIN_PASSWORD` env var.

- [ ] **Step 2: Create the auth API route**

Create `src/app/api/auth/[...nextauth]/route.ts` exporting `GET` and `POST` handlers.

- [ ] **Step 3: Create AuthProvider client component**

Wrap children with NextAuth's `SessionProvider`.

- [ ] **Step 4: Create middleware**

Protect all routes except `/` (login page), `/api/auth/*`, and static files.

- [ ] **Step 5: Update root layout**

Wrap with AuthProvider and SessionProvider.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: add NextAuth credentials auth with middleware"
```

---

### Task 3: Layout + Sidebar component

**Files:**
- Create: `src/components/app-shell.tsx` — layout wrapper
- Create: `src/components/sidebar.tsx` — sidebar nav
- Create: `src/components/topbar.tsx` — top bar
- Create: `src/components/ui/nav-item.tsx` — single nav link
- Modify: `src/app/layout.tsx` — integrate AppShell

**Interfaces:**
- Consumes: Task 2 (auth session)
- Produces: `AppShell` layout with sidebar + topbar, `usePathname()` active state

**Sidebar nav items** (in order):
Dashboard (`/dashboard`), BOQs (`/boqs`), Compare (`/compare`), Catalog (`/catalog`), Estimator (`/estimator`), Settings (`/settings`)

Each uses the same inline SVG icons and `data-od-id` attributes from the prototype. Active link gets `.active` styling.

- [ ] **Step 1: Create sidebar component**

Port the sidebar HTML from the prototype into a React component. Inline SVG icons, `data-od-id` attributes, `usePathname()` for active state. Include "Sign out" button at bottom.

- [ ] **Step 2: Create topbar component**

Simple top bar with page title and optional back button. Accept `title` prop.

- [ ] **Step 3: Create AppShell**

Combines Sidebar + Topbar + `<main>{children}</main>`.

- [ ] **Step 4: Update root layout**

Apply AppShell to authenticated pages. Login page gets no shell.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add sidebar layout with nav items"
```

---

### Task 4: Firebase lib + Settings API

**Files:**
- Create: `src/lib/firebase-admin.ts` — Firebase Admin SDK init
- Create: `src/lib/db.ts` — Firestore CRUD helpers
- Create: `src/app/api/settings/route.ts` — GET/PUT settings

**Interfaces:**
- Consumes: Task 1 (project scaffold with Firebase packages)
- Produces: `adminDb` Firestore instance, `getSettings()`, `updateSettings()` helpers

**Firestore collections:**
- `boqs`, `boq_items`, `standards`, `vendors`, `estimates`, `settings`

**DB helpers (`src/lib/db.ts`):**
```typescript
import { adminDb } from "./firebase-admin";

export async function getCollection<T>(collection: string): Promise<T[]> { ... }
export async function getDocument<T>(collection: string, id: string): Promise<T | null> { ... }
export async function createDocument(collection: string, data: any): Promise<string> { ... }
export async function updateDocument(collection: string, id: string, data: any): Promise<void> { ... }
export async function deleteDocument(collection: string, id: string): Promise<void> { ... }
```

- [ ] **Step 1: Create Firebase Admin SDK init**

Read `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` from env vars. Initialize `admin.firestore()`.

- [ ] **Step 2: Create DB helpers**

Generic Firestore CRUD functions used by all API routes.

- [ ] **Step 3: Create settings API route**

`GET /api/settings` — return the single settings document (create default if not exists).
`PUT /api/settings` — update settings fields.

Default settings: fuzzy unit map, normalize rules, std prompt, docling endpoint.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add Firebase Admin SDK and settings API"
```

---

### Task 5: BOQ + Item API routes

**Files:**
- Create: `src/app/api/boqs/route.ts` — GET (list), POST (create)
- Create: `src/app/api/boqs/[id]/route.ts` — GET, PUT, DELETE
- Create: `src/app/api/items/route.ts` — POST (batch create/update items)

**Interfaces:**
- Consumes: Task 4 (db helpers)
- Produces: Full CRUD for BOQs and line items

- [ ] **Step 1: Write BOQ list API**

`GET /api/boqs` — returns all boqs ordered by createdAt desc.
`POST /api/boqs` — creates boq with status "draft", returns id.

- [ ] **Step 2: Write single BOQ API**

`GET /api/boqs/[id]` — returns boq + its items.
`PUT /api/boqs/[id]` — updates boq fields.
`DELETE /api/boqs/[id]` — deletes boq and its items.

- [ ] **Step 3: Write items batch API**

`POST /api/items` — accepts `{boqId, items[]}`, batch-creates/updates items in boq_items subcollection.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add BOQ and item CRUD API routes"
```

---

### Task 6: Vendors + Estimates API

**Files:**
- Create: `src/app/api/vendors/route.ts` — GET, POST, PUT, DELETE
- Create: `src/app/api/estimates/route.ts` — GET, POST

**Interfaces:**
- Consumes: Task 4 (db helpers)
- Produces: Vendor and estimate CRUD

- [ ] **Step 1: Write vendors API**

Standard CRUD with fields: name, contact, specialty, lastUsed.

- [ ] **Step 2: Write estimates API**

`GET /api/estimates` — list all estimates.
`POST /api/estimates` — create estimate with items array + computed totalAmount.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: add vendor and estimate API routes"
```

---

### Task 7: Standards API

**Files:**
- Create: `src/app/api/standards/route.ts` — GET, POST, PUT

**Interfaces:**
- Consumes: Task 4 (db helpers)
- Produces: Standard catalog CRUD

- [ ] **Step 1: Write standards API**

`GET /api/standards` — list all catalog entries.
`POST /api/standards` — create new standard.
`PUT /api/standards` — batch update (accept suggestions, merge aliases).

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "feat: add standards catalog API"
```

---

### Task 8: LLM wrapper + API routes

**Files:**
- Create: `src/lib/llm.ts` — provider-agnostic LLM client
- Create: `src/app/api/llm/standardize/route.ts` — standardization pass 3
- Create: `src/app/api/llm/verify/route.ts` — Docling verify
- Create: `src/app/api/llm/compare/route.ts` — quote comparison

**Interfaces:**
- Consumes: Task 4 (settings for prompt)
- Produces: `callLLM(messages, provider?, model?)` — returns `{content, provider, model}`

**LLM client:**
```typescript
export async function callLLM(
  messages: { role: string; content: string }[],
  provider?: string,
  model?: string
): Promise<{ content: string; provider: string; model: string }> {
  const activeProvider = provider || process.env.LLM_PROVIDER || "openai";
  const activeModel = model || process.env.LLM_MODEL || (activeProvider === "openrouter" ? "openai/gpt-4o" : "gpt-4o");

  if (activeProvider === "openrouter") {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({ model: activeModel, messages }),
    });
    const data = await res.json();
    return { content: data.choices[0].message.content, provider: "openrouter", model: activeModel };
  }

  // Default: OpenAI
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: activeModel, messages }),
  });
  const data = await res.json();
  return { content: data.choices[0].message.content, provider: "openai", model: activeModel };
}
```

**LLM routes** accept `{messages, provider?, model?}` and return `{content, provider, model}`.

- [ ] **Step 1: Write LLM client**

`src/lib/llm.ts` — OpenAI + OpenRouter support, reads API keys from env vars.

- [ ] **Step 2: Write LLM API routes**

Three routes, each calling `callLLM()` with appropriate system prompts.

Standardize route includes the standardization prompt + catalog context in the system message.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: add LLM wrapper with OpenAI and OpenRouter support"
```

---

### Task 9: Login + Dashboard pages

**Files:**
- Create: `src/app/page.tsx` — login page
- Create: `src/app/dashboard/page.tsx` — dashboard with stat cards + activity feed

**Interfaces:**
- Consumes: Task 2 (auth), Task 3 (layout), Tasks 5-6 (API data)
- Produces: Login form with password, Dashboard with real BOQ/vendor/estimate counts

- [ ] **Step 1: Write login page**

Simple form with password field, calls `signIn("credentials")`. Shows error on wrong password. Sidebar brand layout matching prototype's `login.html`.

- [ ] **Step 2: Write dashboard page**

Fetch counts from `/api/boqs`, `/api/vendors`, `/api/estimates`. Display stat cards (total BOQs, active BOQs, vendors, estimates). Recent activity feed shows last 5 BOQs with dates/status.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: add login and dashboard pages"
```

---

### Task 10: BOQs list + upload page

**Files:**
- Create: `src/app/boqs/page.tsx` — BOQ listing, upload modal, review panel
- Create: `src/components/upload-modal.tsx` — drag-drop upload
- Create: `src/components/review-panel.tsx` — side-by-side review
- Create: `src/components/standardization-review.tsx` — collapsible standardization section

**Interfaces:**
- Consumes: Task 5 (BOQ API), Task 7 (standards API), Task 8 (LLM API)
- Produces: Full BOQ listing with filter/search, upload modal with Docling parse + standardization 3-pass

**Features:**
- BOQ list: search by project/vendor, filter by status/type, pagination
- Upload: drag-drop PDF (or file picker) → POST to parse-pdf API → review modal
- Review modal: metadata fields (vendor, project, work type, date), parsed items table (inline editable), collapsible standardization section
- Standardization: runs 3 passes, shows matched/suggested/unmatched, "Accept All" + "Run LLM" buttons
- Approve: saves BOQ + items + accepted standards to Firestore

- [ ] **Step 1: Create UploadModal component**

Drag-drop zone, file picker, progress indicator.

- [ ] **Step 2: Create ReviewPanel component**

Side-by-side layout: PDF preview (left) + editable items table (right). Inline editing for code/desc/unit/qty/rate.

- [ ] **Step 3: Create StandardizationReview component**

Collapsible section showing per-item status badges. Accept/AcceptAll/RunLLM buttons.

- [ ] **Step 4: Write BOQ listing page**

Fetch BOQs from `/api/boqs`, display in data table with search/filter/pagination. Upload button opens modal.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add BOQ listing page with upload and standardization review"
```

---

### Task 11: BOQ Detail page

**Files:**
- Create: `src/app/boqs/[id]/page.tsx` — BOQ detail with inline editing
- Create: `src/components/collapsible-section.tsx` — expand/collapse section
- Create: `src/components/catalog-match-modal.tsx` — searchable catalog picker

**Interfaces:**
- Consumes: Task 5 (BOQ API), Task 7 (standards API)
- Produces: BOQ detail with collapsible sections, inline editable items, Std column with badges

**Features:**
- Collapsible sections (Concrete, Rebar, Formwork, etc.)
- Inline editing on every field (click-to-edit, inline input replaces text)
- Std column with status badges (matched/suggested/unmatched/approved)
- Accept/Reject suggestion buttons per item
- Catalog match modal for manual matching
- Sticky total bar at bottom
- Estimate builder: select items, adjust quantities, add to estimate

- [ ] **Step 1: Create CollapsibleSection component**

Header with expand/collapse toggle, arrow rotation animation.

- [ ] **Step 2: Create CatalogMatchModal component**

Dialog/modal with searchable list of catalog entries. Select applies standard to item.

- [ ] **Step 3: Write BOQ detail page**

Fetch BOQ + items from `/api/boqs/[id]`. Group items by sectionHeader into CollapsibleSections. Inline editing with save/cancel. Std badge rendering. Accept/reject/match buttons.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add BOQ detail page with inline editing and standardization"
```

---

### Task 12: Catalog page

**Files:**
- Create: `src/app/catalog/page.tsx` — Items to Review + Standard Catalog tabs

**Interfaces:**
- Consumes: Task 7 (standards API), Task 5 (BOQ API)
- Produces: Full catalog management page

**Features:**
- Two tabs: "Items to Review" and "Standard Catalog"
- Review tab: shows unapproved items across all BOQs, table with source/code/desc/unit/suggested/status/actions
- Accept/Suggest batch buttons
- Standard Catalog tab: searchable table of all standards, alias count, source BOQ count, last updated
- Stats bar: X standards · Y items to review

- [ ] **Step 1: Write catalog page**

Fetch standards from `/api/standards` and unapproved items from `/api/boqs`. Render two tabs with data tables. Accept functionality creates/updates standard in Firestore.

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "feat: add catalog page with review and standard tabs"
```

---

### Task 13: Compare page

**Files:**
- Create: `src/app/compare/page.tsx` — quotation comparison
- Create: `src/components/compare-table.tsx` — comparison grid

**Interfaces:**
- Consumes: Task 5 (BOQ API), Task 8 (LLM compare API)
- Produces: Quotation comparison with LLM analysis

**Features:**
- Upload quotation PDF → parse → match items to historical BOQ items by description
- Comparison table: description, new qty/rate, historical avg, variance (green/amber/red delta), LLM comment
- Expandable rows showing historical prices used
- "Import item" button to add to historical database
- Max 3 BOQs side-by-side

- [ ] **Step 1: Create CompareTable component**

Table with variance indicators, expandable LLM rows, import buttons.

- [ ] **Step 2: Write compare page**

Upload quotation, call parse-pdf API, fuzzy-match items against historical BOQ items, call LLM compare API for each match. Render comparison table.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: add compare page with LLM quotation analysis"
```

---

### Task 14: Estimator page

**Files:**
- Create: `src/app/estimator/page.tsx` — estimate builder
- Create: `src/components/item-detail-modal.tsx` — item properties panel
- Create: `src/components/estimate-tree.tsx` — item tree view

**Interfaces:**
- Consumes: Task 6 (estimates API), Task 5 (BOQ API)
- Produces: Full estimate builder

**Features:**
- Item tree: imported items, manual items, adjustments (collapsible groups)
- Search historical items by category/description
- Add items with quantity/rate adjustment
- Right panel: item details (description, qty, rate, unit)
- Sticky totals bar
- Save estimate to Firestore
- Export PDF (window.print)

- [ ] **Step 1: Create ItemDetailModal component**

Form with desc, qty, rate, unit fields. Autocomplete from historical items.

- [ ] **Step 2: Create EstimateTree component**

Collapsible tree groups showing item hierarchy with totals per group.

- [ ] **Step 3: Write estimator page**

Fetch historical items from `/api/boqs`. Build estimate with add/edit/remove items. Save via `/api/estimates`.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add estimator page with item builder"
```

---

### Task 15: Settings page

**Files:**
- Create: `src/app/settings/page.tsx` — all settings panels

**Interfaces:**
- Consumes: Task 4 (settings API), Task 6 (vendors API)
- Produces: Full settings management

**Sections:**
- Vendor list: table with name/contact/specialty/lastUsed, add/edit/delete
- Rate books: list of rate book entries (description, unit, rate)
- Team members: display only (single-user)
- Workspace settings: project name, default currency
- LLM config: provider select, API key input, model name, endpoint URL
- Fuzzy match rules: unit map textarea, description normalize rules textarea, test button
- Prompts: LLM verification prompt, standardization prompt, save/reset buttons
- Docling endpoint: URL input

- [ ] **Step 1: Write settings page**

Three cards: Vendors, LLM Config, Fuzzy Rules + Prompts. Each with its own form and save action.

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "feat: add settings page with vendors, LLM config, fuzzy rules"
```

---

### Task 16: Docling Python sidecar

**Files:**
- Create: `py-sidecar/main.py` — FastAPI app
- Create: `py-sidecar/requirements.txt` — Python dependencies
- Create: `py-sidecar/Dockerfile` — container setup

**Interfaces:**
- Produces: `POST /parse` endpoint accepting PDF bytes, returning structured JSON

**Dependencies:** fastapi, uvicorn, docling, python-multipart

**API:**
```python
@app.post("/parse")
async def parse_pdf(file: UploadFile = File(...)):
    contents = await file.read()
    result = docling_process(contents)  # returns items, sections, metadata
    return result
```

- [ ] **Step 1: Write FastAPI app**

Basic FastAPI server with `/parse` endpoint. Uses Docling to extract table data from PDF bytes.

- [ ] **Step 2: Write requirements.txt**

```
fastapi==0.115.0
uvicorn==0.30.0
docling==2.0.0
python-multipart==0.0.12
```

- [ ] **Step 3: Write Dockerfile**

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY main.py .
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add Docling PDF parsing sidecar"
```

---

### Task 17: Firebase deployment configuration

**Files:**
- Create: `firebase.json` — Firebase Hosting + Cloud Functions config
- Create: `.env.example` — env vars reference
- Create: `firebase-deploy.sh` — deployment script

**Interfaces:**
- Consumes: All previous tasks (full app)
- Produces: Firebase-ready deployment config

**firebase.json:**
```json
{
  "hosting": {
    "source": ".",
    "ignore": ["firebase.json", "**/node_modules/**", ".git", ".env*", "py-sidecar/"],
    "frameworksBackend": { "region": "asia-southeast1" }
  },
  "firestore": {
    "rules": "firestore.rules",
    "indexes": "firestore.indexes.json"
  },
  "storage": {
    "rules": "storage.rules"
  }
}
```

**Required env vars:**
```
ADMIN_PASSWORD=<choose-a-strong-password>
OPENAI_API_KEY=<optional>
OPENROUTER_API_KEY=<optional>
LLM_PROVIDER=openai
LLM_MODEL=gpt-4o
FIREBASE_PROJECT_ID=<your-project>
FIREBASE_CLIENT_EMAIL=<your-service-account-email>
FIREBASE_PRIVATE_KEY=<your-private-key>
DOCLING_ENDPOINT=http://localhost:8000
```

- [ ] **Step 1: Create firebase.json with Hosting + Functions config**

- [ ] **Step 2: Create firestore.rules and storage.rules**

Firestore rules: allow read/write if request.auth != null (authenticated users only).
Storage rules: allow read/write if request.auth != null.

- [ ] **Step 3: Create .env.example**

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add Firebase deployment configuration"
```

---

## Spec Coverage Check

| Spec Requirement | Task |
|---|---|
| Next.js App Router scaffold | Task 1 |
| Tailwind + shadcn/ui + ported design tokens | Task 1 |
| NextAuth credentials with single admin | Task 2 |
| Route protection middleware | Task 2 |
| Sidebar layout with nav + topbar | Task 3 |
| Firebase Admin SDK + Firestore helpers | Task 4 |
| Settings API (fuzzy rules, prompts, LLM config) | Task 4 |
| BOQ CRUD API | Task 5 |
| Line item batch API | Task 5 |
| Vendor CRUD API | Task 6 |
| Estimate CRUD API | Task 6 |
| Standards catalog API | Task 7 |
| LLM wrapper (OpenAI + OpenRouter) | Task 8 |
| LLM standardize/verify/compare API routes | Task 8 |
| Login page | Task 9 |
| Dashboard with stat cards | Task 9 |
| BOQ listing with search/filter/pagination | Task 10 |
| Upload modal (drag-drop PDF) | Task 10 |
| Review panel (side-by-side + inline editing) | Task 10 |
| Standardization 3-pass (exact→fuzzy→LLM) | Task 10 |
| Standardization review panel | Task 10 |
| BOQ detail with collapsible sections | Task 11 |
| Inline editing on all item fields | Task 11 |
| Std column with status badges | Task 11 |
| Catalog match modal | Task 11 |
| Catalog page (review + standard tabs) | Task 12 |
| Compare page (upload + LLM analysis) | Task 13 |
| Estimator page (item tree + save) | Task 14 |
| Settings page (all sections) | Task 15 |
| Docling Python sidecar | Task 16 |
| Firebase deployment config | Task 17 |
