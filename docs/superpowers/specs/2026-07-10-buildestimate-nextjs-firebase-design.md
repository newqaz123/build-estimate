# BuildEstimate — Next.js + Firebase Architecture Design

## Overview

Conversion of the static HTML/CSS/JS BuildEstimate prototype to a full-stack Next.js (App Router) application with Firebase backend. Single-user construction cost estimating tool with PDF parsing (Docling), LLM-powered standardization and comparison, and master standard catalog management.

## Stack

- **Framework:** Next.js 14+ (App Router)
- **UI:** Tailwind CSS + shadcn/ui
- **Auth:** NextAuth credentials provider (single admin password via env var)
- **Database:** Firestore
- **Storage:** Firebase Storage (PDF uploads)
- **Hosting:** Firebase Hosting + Cloud Functions
- **PDF Parsing:** Python Docling FastAPI sidecar (deployed to Cloud Run)
- **LLM:** Provider-agnostic wrapper (OpenAI + OpenRouter)
- **Deployment:** Firebase-only (Hosting, Cloud Functions, Cloud Run, Firestore, Storage)

## Auth

- NextAuth `credentials` provider
- Admin password stored as `ADMIN_PASSWORD` env var
- JWT session (no DB needed)
- Middleware protects all routes except `/` (login page)
- No registration flow

## Data Model

### Firestore: `boqs`

| Field | Type | Notes |
|-------|------|-------|
| `project` | string | Project name |
| `vendor` | string | Vendor/contractor name |
| `type` | string | Work type — "Structural", "MEP", "Finishing" |
| `date` | Timestamp | Document date |
| `status` | string | "draft", "parsed", "active", "approved", "rejected" |
| `total` | number | Grand total in THB |
| `notes` | string | Free-text notes |
| `pdfStoragePath` | string | Firebase Storage path to source PDF |
| `createdAt` | Timestamp | |
| `approvedAt` | Timestamp | Nullable |

### Firestore: `boq_items`

| Field | Type | Notes |
|-------|------|-------|
| `boqId` | ref → boqs | Parent BOQ |
| `code` | string | Item code (e.g., "B.1.1") |
| `desc` | string | Item description |
| `unit` | string | Unit of measure |
| `qty` | number | Quantity |
| `rate` | number | Unit rate (THB) |
| `total` | number | Line total (qty × rate) |
| `type` | string | "unit", "lump_sum", "job" |
| `compareAble` | boolean | false for lump_sum/job |
| `category` | string | "Structural", "MEP", "Finishing" |
| `sectionHeader` | string | Grouping header (e.g., "B.1 Concrete Works") |
| `stdStatus` | string | "unchecked", "matched", "suggested", "unmatched", "approved" |
| `stdId` | string | FK to standards collection |
| `stdMatch` | string | Canonical description text from matched standard |
| `stdConfidence` | string | "exact", "fuzzy", "llm", "manual" |
| `createdAt` | Timestamp | |

### Firestore: `standards`

| Field | Type | Notes |
|-------|------|-------|
| `stdDesc` | string | Canonical description |
| `stdUnit` | string | Canonical unit |
| `aliases` | string[] | Known raw description variants |
| `sourceItems` | array | `[{boqId, itemCode, vendorId}]` — provenance |
| `confidence` | string | "high" (auto), "reviewed" (human) |
| `createdAt` | Timestamp | |
| `updatedAt` | Timestamp | |

### Firestore: `vendors`

| Field | Type | Notes |
|-------|------|-------|
| `name` | string | Company name |
| `contact` | string | Email/phone |
| `specialty` | string | "Structural", "MEP", "Finishing", "Full Scope" |
| `lastUsed` | Timestamp | Nullable |

### Firestore: `estimates`

| Field | Type | Notes |
|-------|------|-------|
| `name` | string | Estimate name |
| `projectId` | ref → boqs | Nullable |
| `items` | array | `[{boqItemId, desc, unit, qty, rate, total}]` |
| `totalAmount` | number | |
| `createdAt` | Timestamp | |

### Firestore: `settings`

| Field | Type | Notes |
|-------|------|-------|
| `fuzzyUnitMap` | map | Canonical → variant units (JSON object) |
| `fuzzyNormalizeRules` | array | `[{pattern, replacement}]` — regex rules |
| `stdPrompt` | string | LLM standardization prompt |
| `doclingEndpoint` | string | URL to Docling sidecar |

## Page Structure

```
src/app/
├── page.tsx                            # Login page (NextAuth credentials)
├── dashboard/
│   └── page.tsx                        # Stat cards + recent activity feed
├── boqs/
│   ├── page.tsx                        # BOQ listing, upload modal, review panel
│   └── [id]/
│       └── page.tsx                    # BOQ detail, inline editing, collapsible sections
├── catalog/
│   └── page.tsx                        # Items to Review + Standard Catalog tabs
├── compare/
│   └── page.tsx                        # Quotation upload + comparison table
├── estimator/
│   └── page.tsx                        # Estimate builder with item search
├── settings/
│   └── page.tsx                        # Vendors, LLM config, fuzzy rules, prompts
└── api/
    ├── auth/
    │   └── [...nextauth]/
    │       └── route.ts                # NextAuth handler
    ├── boqs/
    │   ├── route.ts                    # GET (list), POST (create)
    │   └── [id]/
    │       └── route.ts                # GET, PUT, DELETE single BOQ
    ├── items/
    │   └── route.ts                    # POST (batch create/update items)
    ├── standards/
    │   └── route.ts                    # GET, POST, PUT (catalog CRUD)
    ├── vendors/
    │   └── route.ts                    # GET, POST, PUT, DELETE
    ├── estimates/
    │   └── route.ts                    # GET, POST
    ├── llm/
    │   ├── standardize/route.ts        # Standardization pass 3
    │   ├── verify/route.ts             # Docling parse verification
    │   └── compare/route.ts            # Quote comparison
    └── parse-pdf/route.ts              # Upload PDF → Docling → structured JSON
```

## Component Architecture

### Layout Shell

```
RootLayout
├── AuthProvider (NextAuth session)
└── AppShell
    ├── Sidebar
    │   ├── NavItem[] (Dashboard, BOQs, Compare, Catalog, Estimator, Settings)
    │   └── SidebarFooter (Sign out)
    ├── Topbar
    │   ├── Breadcrumb / BackButton
    │   └── PageActions
    └── Main (children)
```

### Shared Components

| Component | Source (prototype) | Notes |
|-----------|-------------------|-------|
| `Sidebar` | Common to all pages | Nav links with inline SVG icons, `data-od-id` for targeting |
| `DataTable` | boq-detail, catalog, compare | Sortable columns, search filter, pagination |
| `Badge` | shared.css | Status badges: draft/active/review/approved/rejected + stdStatus variants |
| `StatCard` | dashboard | Metric card with icon, label, value |
| `UploadModal` | boqs.html | Drag-drop zone, file picker, PDF preview |
| `ReviewPanel` | boqs.html | Side-by-side parsed items table with inline editing |
| `StandardizationReview` | boqs.html, boq-detail.html | Collapsible section with matched/suggested/unmatched items |
| `CatalogMatchModal` | boq-detail.html, catalog.html | Searchable catalog picker for manual matching |
| `InlineEdit` | boq-detail.html | Click-to-edit with save/cancel |
| `CollapsibleSection` | boq-detail.html | Section header with expand/collapse |
| `Toast` | shared.css | Notification toast |

## LLM Integration

### Provider-Agnostic Wrapper (`lib/llm.ts`)

```typescript
interface LLMRequest {
  messages: { role: string; content: string }[];
  model?: string;
  provider?: 'openai' | 'openrouter';
}

interface LLMResponse {
  content: string;
  provider: string;
  model: string;
}
```

- Reads `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `LLM_PROVIDER`, `LLM_MODEL` from env vars
- All LLM calls go through a single `callLLM()` function that routes to the right provider
- Settings page configures which provider/model to use (stored in Firestore `settings` collection)

### LLM Routes

| Route | Purpose | Trigger |
|-------|---------|---------|
| `POST /api/llm/standardize` | Pass 3: match unmatched items to catalog | Automatic after Docling parse |
| `POST /api/llm/verify` | Check Docling output for errors | User clicks "Verify with LLM" |
| `POST /api/llm/compare` | Compare new quotation vs historical prices | User clicks "Compare" |

### Standardization Prompt (editable in Settings)

```
You are a construction BOQ standardization assistant. Given a list of raw items
and a reference catalog, standardize each item:
1. If the item matches an existing catalog entry (by description + unit), return the catalog entry ID
2. If no match exists, suggest a standardized description and unit following these conventions:
   - Use clear format: "Material — spec/location/dimension"
   - Units: m³, m², m, ton, ea, set, kg, LS
3. Do NOT create a duplicate if a matching entry already exists
Return JSON array: [{itemIndex, matchedStdId, suggestedDesc, suggestedUnit, confidence, reason}]
```

## Data Flow

### BOQ Upload Flow

```
1. User drops PDF on upload modal
2. PDF uploaded to Firebase Storage
3. POST /api/parse-pdf → Python Docling sidecar returns structured items
4. boqs document created with status "draft"
5. Items stored in boq_items subcollection
6. Run Standardization:
   a. Pass 1: Exact match against standards catalog (same normalized desc + unit)
   b. Pass 2: Fuzzy match against catalog aliases (unit mapping + desc normalization)
   c. Pass 3: Unmatched → POST /api/llm/standardize → suggestions
7. Review modal opens: metadata fields + parsed items + standardization results
8. User reviews, edits, accepts/rejects suggestions
9. User clicks "Approve & Save":
   - boqs.status → "active"
   - Accepted standards merged into Firestore standards collection
   - Items updated with final stdStatus/stdId/stdConfidence
```

### Catalog Workflow

```
1. catalog page loads: reads standards + unapproved items from Firestore
2. "Items to Review" tab: shows unapproved items from all BOQs
3. "Standard Catalog" tab: shows all standards, searchable
4. Accept → creates/updates standard in Firestore, updates item
5. Run LLM → POST /api/llm/standardize for unmatched items
```

## Design Tokens (Ported from shared.css)

The prototype's Airtable-inspired design system ports into Tailwind config:

```javascript
// tailwind.config.js — key extensions
colors: {
  navy: { 50: '...', 900: '#0f172a' },
  accent: { DEFAULT: '#2563eb', ... },
  success: '#16a34a',
  warn: '#d97706',
  danger: '#dc2626',
}
// CSS custom properties for spacing, elevation, border-radius from shared.css
```

## Deployment Architecture (Firebase-only)

```
Firebase Hosting
  └── Static assets (Next.js output) + SSR via Cloud Functions
      ├── Cloud Functions (Node.js 20 — Next.js API routes + SSR)
      │   ├── /api/* — CRUD, LLM proxy
      │   └── /pages — Server-side rendering
      ├── Firestore — All data
      ├── Firebase Storage — PDF files
      └── Cloud Run — Python Docling sidecar (Docker container)
```

### Firebase Configuration

```json
{
  "hosting": {
    "source": ".",
    "ignore": ["firebase.json", "**/node_modules/**"],
    "frameworksBackend": { "region": "asia-southeast1" }
  }
}
```

### Docling Sidecar

- Python FastAPI app in `py-sidecar/`
- Single endpoint: `POST /parse` — accepts PDF buffer, returns structured JSON (items, sections, metadata)
- Dockerized, deployed to Cloud Run
- Cold-start acceptable (1-2s) — tooling use case

## Migration Strategy

1. Scaffold `npx create-next-app` with TypeScript + Tailwind
2. Port `shared.css` design tokens to Tailwind config
3. Install shadcn/ui components as needed
4. Build API routes first (Firestore CRUD)
5. Rebuild pages from prototype as React components:
   - Login → Dashboard → Settings (simplest first)
   - BOQs → BOQ Detail → Catalog (core flows)
   - Compare → Estimator (depends on data)
6. LLM wrapper built alongside API routes, tested with mock then real providers
7. Docling sidecar Dockerized and tested last

## Key Decisions

- **No direct Firestore SDK on client** — all DB access through API routes (future migration to VPS is swapping `lib/db.ts` only)
- **No real-time listeners** — fetch-on-navigate pattern. Volume is single-user, no need for Firestore onSnapshot
- **Prompt-first standardization** — deterministic passes (exact + fuzzy) before LLM, minimizing token cost
- **Settings in Firestore** — LLM config, fuzzy rules, prompts stored in Firestore `settings` document. Allows future multi-user without localStorage loss
- **All HTML files in project root** — Next.js App Router replaces this; pages live under `src/app/`
