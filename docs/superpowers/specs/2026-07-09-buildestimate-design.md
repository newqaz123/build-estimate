# BuildEstimate — BOQ Management & Price Comparison App

## Overview

Single-user Next.js app for a construction consultant managing multiple projects. Uploads Bill of Quantities (BOQ) PDFs from contractors/vendors, extracts line items via Docling, stores structured data in Firebase, and enables price comparison, LLM-powered quotation analysis, and budget estimation.

## Architecture

```
Browser → Next.js (App Router)
            ├── API Route /api/parse-pdf → Python Docling Sidecar (PDF → JSON)
            ├── Firebase Firestore (projects, vendors, boqs, boq_items, estimates)
            ├── Firebase Storage (raw PDF files)
            └── NextAuth (credentials provider, single password user)
```

**PDF Parsing:** Python FastAPI microservice running Docling (MIT license). Called by Next.js API route after PDF upload to Firebase Storage. Returns structured JSON of extracted tables.

**LLM:** Provider-agnostic wrapper supporting OpenAI, Claude, Gemini, OpenRouter. Configured via environment variables. Used for:
1. **BOQ metadata extraction** — When a PDF is uploaded, the LLM extracts vendor name, project name, work type, and document date from the PDF's text content (headings, letterhead, document title). The user reviews and corrects these before the BOQ is saved.
2. **Quotation comparison comments** — Comparing a new quotation against historical unit prices.

## Data Model

### Firestore Collections

**`projects`**
- `name`: string
- `description`: string
- `createdAt`: timestamp

**`vendors`**
- `name`: string
- `contactInfo`: string (optional)

**`boqs`**
- `projectId`: ref → projects (nullable — set on approval)
- `vendorId`: ref → vendors (nullable — set on approval)
- `date`: timestamp
- `workType`: string (e.g., "Structural", "MEP", "Finishing")
- `status`: "draft" | "parsed" | "active" | "approved"
- `llmMeta`: { parsingFlags: string[], metadataSuggestions: { field: string, value: string }[], corrections: { itemIdx: number, field: string, old: any, suggested: any }[] } (optional — only set when user clicks "Verify with LLM")
- `notes`: string
- `pdfStoragePath`: string (Firebase Storage path)
- `createdAt`: timestamp
- `approvedAt`: timestamp (nullable)

**`boq_items`**
- `boqId`: ref → boqs
- `itemCode`: string (nullable)
- `description`: string
- `unit`: string (nullable)
- `quantity`: number (nullable float)
- `unitPrice`: number (nullable float)
- `totalPrice`: number (nullable float)
- `itemType`: "unit" | "lump_sum" | "job"
- `compareAble`: boolean (default: true; false for lump_sum/job)
- `category`: string (e.g., "Structural", "MEP", "Finishing")
- `sectionHeader`: string (nullable; e.g., "B.1 Concrete Works")
- `createdAt`: timestamp

**`estimates`**
- `name`: string
- `projectId`: ref → projects (nullable)
- `items`: array of { boqItemId, description, unit, unitPrice, quantity, total }
- `totalAmount`: number
- `createdAt`: timestamp

## User Flow

### 1. Upload BOQ (Docling-first, LLM optional verification)
1. User uploads a PDF via the BOQ list page — **simple file picker, no upfront metadata.**
2. PDF uploaded to Firebase Storage → `boqs` record created with `status: "draft"`
3. Next.js API route calls **Python Docling service** (free, local) → extracts table rows:
   - Item code, description, unit, quantity, unit price, total
   - Category/section grouping from table structure
4. Parsed items stored temporarily (not yet committed to `boq_items`)
5. **Review & Approve step** opens — user sees:
   - **Metadata fields** (vendor, project, work type, date) — empty, user fills them in manually. Smart autocomplete from existing vendors/projects list.
   - **Parsed items table** — all rows editable (code, desc, unit, qty, rate, type, category)
   - **Optional "Verify with LLM" button** — user can click this to:
     - Flag parsing issues (e.g., merged columns, wrong unit parsing)
     - Suggest vendor/project from existing DB if text in PDF header matches
     - Suggest corrections on items with unusual values
     - Classify work type from item descriptions if user is unsure
     - LLM output shown as inline suggestions, NOT auto-applied
   - User corrects any field → clicks **"Approve & Save"**
6. On approval: `boq.status` → `"active"`, metadata finalized, `approvedAt` set
7. Lump-sum/job items tagged `compareAble: false`
8. BOQ appears in the main list

**Key principle:** Docling is the primary data source (free). LLM is only used when the user clicks "Verify" — saving tokens and keeping the core flow LLM-independent.

### 2. Compare Quotation
1. User navigates to Compare page
2. Uploads a new vendor quotation PDF (does NOT go into historical DB yet)
3. PDF parsed via Docling
4. Each parsed item matched to historical `boq_items` by description similarity (fuzzy match + category)
5. LLM receives: { item description, historical unit prices, quantities } → generates comment
6. Display: table with item → LLM comment → "Show data" click → expands historical prices used
7. User can "Import" individual items into the historical database

### 3. Estimator
1. User searches historical `boq_items` by category, description, vendor
2. Selects items and assigns quantities
3. System calculates estimated cost as `average unit price × quantity`
4. User saves the estimate (stored in `estimates` collection)

## Pages / Routes

| Route | Purpose |
|-------|---------|
| `/` | Login (NextAuth credentials) |
| `/dashboard` | Summary cards: total BOQs, vendors, projects, recent estimates |
| `/boqs` | BOQ list with filter/sort: vendor, date range, work type, status. Smart Upload button |
| `/boqs/[id]` | BOQ detail: all items in editable table. Inline editing on description, unit, qty, rate. Meta fields (vendor, project, work type) editable. Lump-sum/job items shown with visual indicator |
| `/boqs/[id]/review` | Review & Approve step after parsing. Editable LLM metadata + editable items table. Approve button saves to DB |
| `/compare` | Upload quotation → LLM comparison results per item. "Show data" expandable rows. "Import" buttons |
| `/estimator` | Search items → set quantities → see estimated total. Save export |
| `/settings` | LLM provider config (API key, model, endpoint), vendor management |

## UI / Design

- **Framework:** Tailwind CSS + shadcn/ui
- **Layout:** Sidebar navigation (dashboard, BOQs, compare, estimator, settings)
- **Data tables:** tanstack/react-table for sort/filter on BOQ items and compare results
- **PDF upload:** Drag-and-drop zone (react-dropzone)

## Key Technical Decisions

- **Docling over Marker:** MIT license vs GPL, 0.887 vs 0.808 table accuracy, lighter GPU requirements
- **Python sidecar over Node.js PDF parsing:** BOQ tables are freeform; Docling's layout-aware extraction produces better results than pdfjs-dist
- **Python sidecar deployment:** Runs as a separate FastAPI process, deployed via Docker or as a Vercel serverless function. For development, started alongside Next.js via `docker-compose` or `concurrently`
- **Firebase Firestore:** User preference, free tier, good enough for single-user volume
- **Description-based matching:** Item codes vary wildly between vendors; fuzzy match on description text via `fuzzyset.js` or `string-similarity` library, minimum 0.8 similarity threshold within same category
- **`compareAble` flag:** Simple toggle to exclude lump-sum/job items from comparison without losing reference visibility
- **NextAuth credentials provider:** Single password stored as env var `AUTH_SECRET` + `ADMIN_PASSWORD`. No registration flow.
- **Docling-first, LLM-optional:** Docling is always the primary data source (free, no token cost). LLM is only invoked on user click ("Verify with LLM" button). The core flow (upload → parse → review → approve) works with zero LLM calls. This keeps the app usable without any API keys and minimizes token spend.
- **Inline editing on BOQ detail:** Every item row and meta field is editable after save. Edit state is local (click-to-edit, inline input replaces text, save icon appears). No separate "edit mode" toggle.

## LLM Integration

- **Provider-agnostic:** Reads config from `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, or `OPENROUTER_API_KEY` env vars + `LLM_PROVIDER` / `LLM_MODEL`
- **Verification prompt (on-demand, per BOQ):** Given the parsed items from Docling, check for parsing issues (merged columns, unit errors, totals that don't match qty×rate). If PDF header text is provided, suggest vendor/project/worktype. Flag any item whose rate deviates >30% from the rest. Return structured JSON with suggestions per field.
- **Quote comparison prompt per item:** "Given these historical unit prices for [description]: [prices]. The new quotation has: [new price]. Provide a brief comparison comment noting if it's high/low/average relative to historical data."
- **UI:** "Verify with LLM" button in the review modal. Results shown as inline suggestion badges, not auto-filled. User accepts/rejects each suggestion. Quote comparison comments shown inline on compare page.
- **Cost management:** LLM is NEVER called automatically on upload. Only on user click. One call per BOQ verify (~$0.01). Quote comparison costs one call per matched item (~$0.01–0.05 per quotation). User controls both triggers.

## Deployment

- **Next.js:** Vercel (free tier) or any Node.js host
- **Python sidecar:** Docker container or Railway/render.com for hobby tier
- **Firebase:** Free Spark plan (1GB storage, 10GB/month Firestore bandwidth)
- **LLM cost:** ~$0.01–0.05 per quotation comparison depending on model and item count

## Export

- Estimates exportable as PDF or CSV
- BOQ item tables printable-friendly
