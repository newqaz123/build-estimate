# Docling BOQ Ingestion Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make BOQ imports preserve and display the uploaded PDF, normalize real quotation layouts correctly, remove Code and Type from review, and provide actionable local verification when AI is unavailable.

**Architecture:** A pure Python normalization layer converts Docling tables/text into a versioned ingestion contract. A Next.js import service atomically stores the PDF and draft BOQ, while an authenticated source route serves the original file. The client reviews only normalized fields; deterministic verification always runs and optional LLM verification augments it.

**Tech Stack:** Next.js 16.2 Route Handlers, React 19 Client Components, TypeScript, Node test runner via `tsx --test`, FastAPI/Pydantic, Docling 2.x, Python `unittest`, Firebase Firestore and Storage.

---

## File Map

- Create `src/lib/boq-ingestion.ts`: validate the sidecar contract, build draft BOQs, and run deterministic verification.
- Create `src/lib/boq-ingestion.test.ts`: TypeScript contract, draft, and verification regression tests.
- Create `src/lib/docling-client.ts`: configured sidecar URL, multipart call, timeout, and categorized errors.
- Create `src/lib/boq-source-storage.ts`: BOQ-scoped PDF save/download/delete operations.
- Create `src/app/api/boqs/import/route.ts`: authenticated atomic import endpoint.
- Create `src/app/api/boqs/[id]/source/route.ts`: authenticated inline PDF response.
- Create `src/app/api/boqs/import/import-api.test.ts`: source-level route boundary assertions plus pure orchestration tests.
- Modify `py-sidecar/boq_parser.py`: table-shape detection, metadata extraction, cost normalization, warnings, and totals.
- Modify `py-sidecar/test_boq_parser.py`: real-quotation-derived fixture tests.
- Modify `py-sidecar/main.py`: versioned response contract with page text/table provenance.
- Modify `py-sidecar/Dockerfile`: include the parser module in the image.
- Modify `src/lib/boq-schema.ts`: backward-compatible source, confidence, internal ID, cost-component, and unclassified draft fields.
- Modify `src/components/upload-modal.tsx`: call the unified import endpoint.
- Modify `src/components/review-panel.tsx`: embed the real PDF, remove Code/Type, render warnings, and enforce local validity.
- Modify `src/components/standardization-review.tsx`: stop displaying item codes.
- Modify `src/components/boq-ingestion-flow.test.ts`: assert real preview and removed controls.
- Modify `src/app/api/llm/verify/route.ts`: workspace settings, structured findings, and categorized fallback response.
- Create `src/lib/boq-verification.ts` and `src/lib/boq-verification.test.ts`: request validation, prompt construction, AI response normalization, and failure categorization.
- Modify `src/app/api/boqs/[id]/route.ts`: approval validation and source cleanup on deletion.
- Modify `src/app/(authenticated)/boqs/page.tsx`: preserve optional legacy codes only in CSV export.
- Modify `src/app/globals.css`: PDF embed, warning, confidence, and grouped-row styles.

### Task 1: Normalize Real Quotation Cost Shapes

**Files:**
- Modify: `py-sidecar/test_boq_parser.py`
- Modify: `py-sidecar/boq_parser.py`

- [ ] **Step 1: Add failing Eastern Group and N.P. Civil tests**

Add fixtures with two header rows and assert the exact source values:

```python
def test_splits_distinct_material_and_labour_components(self):
    rows = [
        ["NO.", "DESCRIPTION", "MATERIAL COST", "", "", "LABOUR COST", "", "", "AMOUNT"],
        ["", "", "Q'TY", "UNIT", "TOTAL", "Q'TY", "UNIT", "TOTAL", ""],
        ["2", "90 ELBOW 1B BS1", "36 Pcs.", "41.00", "1,476.00", "72 Db.", "260.00", "18,720.00", "20,196.00"],
    ]
    result = extract_boq_document([{"page": 1, "rows": rows}], "")
    items = result["sections"][0]["items"]
    self.assertEqual([(i["costComponent"], i["unit"], i["qty"], i["rate"], i["total"]) for i in items], [
        ("material", "Pcs.", 36.0, 41.0, 1476.0),
        ("labour", "Db.", 72.0, 260.0, 18720.0),
    ])

def test_combines_shared_quantity_material_and_labour_rates(self):
    rows = [
        ["ITEM", "DESCRIPTION", "UNIT", "Q'TY", "MATERIAL", "TOTAL", "LABOUR", "TOTAL", "AMOUNT"],
        ["", "Slab concrete T =150 mm", "m2", "61.00", "1,080.00", "65,880.00", "520.00", "31,720.00", "97,600.00"],
    ]
    item = extract_boq_document([{"page": 2, "rows": rows}], "")["sections"][0]["items"][0]
    self.assertEqual((item["unit"], item["qty"], item["rate"], item["total"], item["costComponent"]),
                     ("m2", 61.0, 1600.0, 97600.0, "combined"))
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `python3 -m unittest py-sidecar/test_boq_parser.py -v`

Expected: FAIL because `extract_boq_document` and `costComponent` do not exist.

- [ ] **Step 3: Implement header flattening and cost-shape conversion**

Add `flatten_headers(rows)`, `classify_row(row)`, `parse_qty_unit(text)`, and `normalize_cost_row(row, columns)` to `boq_parser.py`. `normalize_cost_row` must return zero, one, or two item dictionaries and follow these exact branches:

```python
if material.present and labour.present and material.qty_unit == labour.qty_unit:
    return [make_item(row, "combined", material.qty, material.unit,
                      material.rate + labour.rate, source_amount)]
if material.present and labour.present:
    return [make_component(row, "material", material), make_component(row, "labour", labour)]
if material.present or labour.present:
    component = material if material.present else labour
    return [make_component(row, "material" if material.present else "labour", component)]
if source_amount:
    return [make_item(row, "lump_sum", 1.0, "L/S", source_amount, source_amount)]
return []
```

Every new item receives `id = uuid.uuid4().hex`, `type = "lump_sum"` only for lump sums and `"unit"` otherwise, its source page/table/row, and no synthetic code.

- [ ] **Step 4: Add and pass row-filtering tests**

Assert that section headings label sections while `Detail`, `SUB TOTAL`, `VAT 7%`, `DISCOUNT`, `GRAND TOTAL`, and `BAHT: ... only` never become items. Run the same unittest command and expect all parser tests to pass.

- [ ] **Step 5: Commit**

```bash
git add py-sidecar/boq_parser.py py-sidecar/test_boq_parser.py
git commit -m "fix: normalize multi-cost BOQ tables"
```

### Task 2: Extract Metadata and Version the Sidecar Contract

**Files:**
- Modify: `py-sidecar/test_boq_parser.py`
- Modify: `py-sidecar/boq_parser.py`
- Modify: `py-sidecar/main.py`
- Modify: `py-sidecar/Dockerfile`

- [ ] **Step 1: Add failing metadata and lump-sum tests**

Use text derived from the supplied documents and assert:

```python
def test_extracts_eastern_group_metadata(self):
    text = """EASTERN GROUP E.T.G. CO., LTD\nQUOTATION NO.: ETG.2026/AYT074
DATE: 4 June 2026\nON-OFF VALVE INSTALLATION WORK FOR BDN PROCESS"""
    metadata = extract_metadata(text, ["ON-OFF VALVE INSTALLATION WORK FOR BDN PROCESS"])
    self.assertEqual(metadata["vendor"]["value"], "EASTERN GROUP E.T.G. CO., LTD")
    self.assertEqual(metadata["project"]["value"], "ON-OFF VALVE INSTALLATION WORK FOR BDN PROCESS")
    self.assertEqual(metadata["date"]["value"], "2026-06-04")
    self.assertEqual(metadata["workType"]["value"], "MEP")

def test_amount_only_quote_becomes_lump_sum(self):
    rows = [["No.", "Description", "Amount"], ["1", "Install submersible pump at sugar dissolving building.", "258,000.00"]]
    item = extract_boq_document([{"page": 1, "rows": rows}], "")["sections"][0]["items"][0]
    self.assertEqual((item["unit"], item["qty"], item["rate"], item["total"]), ("L/S", 1.0, 258000.0, 258000.0))
```

- [ ] **Step 2: Run and verify RED**

Run: `python3 -m unittest py-sidecar/test_boq_parser.py -v`

Expected: FAIL because labeled metadata extraction and amount-only normalization are missing.

- [ ] **Step 3: Implement deterministic metadata extraction**

Implement `extract_metadata(document_text, section_headers)` with label-first patterns for `CONTRACTOR`, seller header, `Project`, `Subject`, `Doc. Date`, and `DATE`. Return `{value, confidence, source}` for each field. Classify MEP keywords (`pump|pipe|valve|mechanical|electrical`), Structural keywords (`concrete|civil|steel|earthwork|slab|grating`), and Finishing keywords (`paint|tile|ceiling|finish`); otherwise return `Unclassified` with low confidence.

- [ ] **Step 4: Extend the FastAPI response and fix the image build**

In `main.py`, use official Docling v2 exports:

```python
document_text = result.document.export_to_text(page_break_placeholder="\n\f\n")
for index, table in enumerate(result.document.tables, start=1):
    frame = table.export_to_dataframe(doc=result.document).fillna("")
    page = table.prov[0].page_no if table.prov else 1
    tables.append({"page": page, "table": index, "rows": [list(frame.columns), *frame.values.tolist()]})
normalized = extract_boq_document(tables, document_text)
return {"contractVersion": 2, "documentName": filename,
        "pageCount": len(result.document.pages), "documentText": document_text,
        "tables": tables, **normalized}
```

Update Pydantic models to match. Add `COPY boq_parser.py .` to `py-sidecar/Dockerfile` before `COPY main.py .`.

- [ ] **Step 5: Run tests and a real sidecar smoke test**

Run: `python3 -m unittest py-sidecar/test_boq_parser.py -v`

Run: `curl -sS -X POST -F file=@/Users/red-copperpot/Downloads/AYT248/ayt001.pdf http://127.0.0.1:5001/parse`

Expected: metadata names Eastern Group, date `2026-06-11`, work type `MEP`; the pipe row is `3 Pcs. @ 1781`; the elbow row has separate material and labour items; no BAHT row.

- [ ] **Step 6: Commit**

```bash
git add py-sidecar/boq_parser.py py-sidecar/test_boq_parser.py py-sidecar/main.py py-sidecar/Dockerfile
git commit -m "feat: return versioned Docling extraction metadata"
```

### Task 3: Add TypeScript Contract and Local Verification

**Files:**
- Create: `src/lib/boq-ingestion.ts`
- Create: `src/lib/boq-ingestion.test.ts`
- Modify: `src/lib/boq-schema.ts`

- [ ] **Step 1: Write failing contract tests**

Test that `parseDoclingResult` rejects contract versions other than `2`, rejects non-finite numeric fields, accepts `Unclassified` only on drafts, preserves `costComponent`, and that `verifyBoqLocally` returns issue codes `metadata_missing`, `invalid_number`, `line_total_mismatch`, and `document_total_mismatch`.

```ts
test('local verification reports arithmetic mismatch', () => {
  const result = verifyBoqLocally(makeDraft({ qty: 3, rate: 100, total: 250 }))
  assert.deepEqual(result.issues.map((issue) => issue.code), ['line_total_mismatch'])
})
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test src/lib/boq-ingestion.test.ts`

Expected: FAIL with module-not-found for `boq-ingestion`.

- [ ] **Step 3: Implement schema and pure functions**

Add `WorkType = 'Structural' | 'MEP' | 'Finishing' | 'Unclassified'`, optional `sourceFileName`, `sourceStoragePath`, `sourcePageCount`, `sourceTotal`, `extractionWarnings`, and `metadataConfidence` fields on `Boq`, and optional `id`, `costComponent`, `sourceRef`, `sourceCosts`, and `extractionWarnings` on `BoqItem`. Make legacy `code?: string` and keep legacy `type` internal.

Implement:

```ts
export function parseDoclingResult(value: unknown): DoclingResultV2
export function buildDraftBoq(id: string, sourcePath: string, parsed: DoclingResultV2): Omit<Boq, 'createdAt' | 'updatedAt'>
export function verifyBoqLocally(boq: Pick<Boq, 'vendor' | 'project' | 'workType' | 'date' | 'sections' | 'grandTotal' | 'sourceTotal'>): VerificationResult
```

Use runtime record/array/string/finite-number guards. Local verification uses a `0.01` currency tolerance and never throws on malformed rows; it returns structured issues.

- [ ] **Step 4: Run tests and typecheck through build**

Run: `npm test src/lib/boq-ingestion.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/boq-schema.ts src/lib/boq-ingestion.ts src/lib/boq-ingestion.test.ts
git commit -m "feat: validate BOQ ingestion contracts"
```

### Task 4: Implement Atomic Import and Source Storage

**Files:**
- Create: `src/lib/docling-client.ts`
- Create: `src/lib/boq-source-storage.ts`
- Create: `src/app/api/boqs/import/route.ts`
- Create: `src/app/api/boqs/import/import-api.test.ts`
- Modify: `src/app/api/docling/parse/route.ts`

- [ ] **Step 1: Write failing helper and route-boundary tests**

Assert URL normalization, timeout/network/status error categories, storage path `boqs/<uuid>/source.pdf`, and that the import route contains authentication, `saveSourcePdf`, `parsePdfWithDocling`, `createDocumentWithId`, and rollback via `deleteSourcePdf`.

- [ ] **Step 2: Run and verify RED**

Run: `npm test src/app/api/boqs/import/import-api.test.ts`

Expected: FAIL because the files do not exist.

- [ ] **Step 3: Implement focused helpers**

`docling-client.ts` exports `buildDoclingParseUrl`, `parsePdfWithDocling(file, endpoint, signal?)`, and `DoclingClientError` with `kind: 'timeout' | 'unreachable' | 'rejected' | 'invalid_response'`. `boq-source-storage.ts` exports:

```ts
export async function saveSourcePdf(path: string, bytes: Uint8Array): Promise<void>
export async function loadSourcePdf(path: string): Promise<Buffer>
export async function deleteSourcePdf(path: string): Promise<void>
```

Use `getStorageBucket().file(path).save(bytes, { resumable: false, contentType: 'application/pdf', metadata: { cacheControl: 'private, max-age=0' } })` and ignore only storage 404 during cleanup.

- [ ] **Step 4: Implement the import transaction**

The POST route authenticates, validates one PDF up to 20 MB, allocates `crypto.randomUUID()`, saves bytes, loads workspace Docling settings, calls the client, validates/builds the draft, and persists it. In `catch`, delete the saved source before returning categorized JSON. Never return `Unknown Vendor`, today's date, or default Structural metadata.

- [ ] **Step 5: Reuse the client in `/api/docling/parse` and run tests**

Replace duplicate endpoint/timeout logic with `parsePdfWithDocling`. Run `npm test src/app/api/boqs/import/import-api.test.ts src/components/boq-ingestion-flow.test.ts` and expect PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/docling-client.ts src/lib/boq-source-storage.ts src/app/api/boqs/import src/app/api/docling/parse/route.ts
git commit -m "feat: atomically import and retain BOQ PDFs"
```

### Task 5: Serve Sources and Enforce Approval Validity

**Files:**
- Create: `src/app/api/boqs/[id]/source/route.ts`
- Modify: `src/app/api/boqs/[id]/route.ts`
- Modify: `src/app/api/boqs/[id]/items/items-api.test.ts`

- [ ] **Step 1: Add failing source and approval tests**

Assert the source route authenticates, returns 404 for missing BOQ/path/object, responds with `application/pdf` and `inline; filename="..."`, and never exposes a public Firebase URL. Assert approval rejects `Unclassified`, blank vendor/project/date, and local verification errors.

- [ ] **Step 2: Run and verify RED**

Run: `npm test 'src/app/api/boqs/[id]/items/items-api.test.ts'`

Expected: FAIL on missing source route and approval guards.

- [ ] **Step 3: Implement source GET and deletion cleanup**

Use awaited Next 16 route params, `getDocument`, and `loadSourcePdf`; return `new Response(bytes, { headers })`. On BOQ DELETE, delete the source object before deleting the document and return a specific 500 if source cleanup fails.

- [ ] **Step 4: Enforce approval validity**

In PUT, build the candidate BOQ, call `verifyBoqLocally`, and when status is `approved` return 400 with `{ error: 'Resolve required BOQ fields before approval', verification }` if work type is unclassified or any blocking issue exists.

- [ ] **Step 5: Run tests and commit**

Run the Task 5 test command; expect PASS.

```bash
git add 'src/app/api/boqs/[id]/source/route.ts' 'src/app/api/boqs/[id]/route.ts' 'src/app/api/boqs/[id]/items/items-api.test.ts'
git commit -m "feat: securely serve BOQ source PDFs"
```

### Task 6: Replace the Generated Preview and Remove Code/Type

**Files:**
- Modify: `src/components/boq-ingestion-flow.test.ts`
- Modify: `src/components/upload-modal.tsx`
- Modify: `src/components/review-panel.tsx`
- Modify: `src/components/standardization-review.tsx`
- Modify: `src/app/(authenticated)/boqs/page.tsx`
- Modify: `src/app/globals.css`

- [ ] **Step 1: Write failing UI source tests**

Assert upload calls `/api/boqs/import`; review uses `/api/boqs/${boq.id}/source`; generated company/sample markup is absent; headings/labels `Code`, `Type`, `Code for item`, and `Type for item` are absent; standardization does not render `item.code`; and the table retains Description, Unit, Qty, Rate, Total, and Std.

- [ ] **Step 2: Run and verify RED**

Run: `npm test src/components/boq-ingestion-flow.test.ts`

Expected: FAIL on the old parse/create flow, generated preview, and visible Code/Type controls.

- [ ] **Step 3: Wire upload to one endpoint**

Send the selected File to `/api/boqs/import`, use `readError` for categorized server messages, and pass the returned draft to `onUploadComplete`. Remove the client-created metadata defaults and second `/api/boqs` request.

- [ ] **Step 4: Render the real PDF and simplified item table**

Replace the mock page with:

```tsx
<object data={`/api/boqs/${encodeURIComponent(boq.id)}/source`} type="application/pdf" className="review-pdf-object">
  <div role="alert">The original PDF could not be displayed. <a href={`/api/boqs/${encodeURIComponent(boq.id)}/source`}>Open PDF</a></div>
</object>
```

Remove PDF zoom state (the browser viewer owns zoom), Code cells, and Type select cells. Use `item.id ?? `${boq.id}-${idx}`` as the row key. Show cost-component badges only when material/labour siblings share a source row; these are informational, not editable Type controls.

- [ ] **Step 5: Add metadata warnings and approval feedback**

Render confidence/warning text beside extracted metadata. Run local verification after every edit; show blocking issues above actions, disable Approve for blocking issues, and display the server's exact save error without closing or clearing state.

- [ ] **Step 6: Remove code from standardization and preserve legacy CSV**

Remove visible code in `StandardizationReview`. Update CSV export to omit Code when every item lacks it, while keeping the legacy Code header only for older BOQs that contain codes.

- [ ] **Step 7: Run tests, lint, and commit**

Run: `npm test src/components/boq-ingestion-flow.test.ts`

Run: `npm run lint`

Expected: PASS with no warnings.

```bash
git add src/components/upload-modal.tsx src/components/review-panel.tsx src/components/standardization-review.tsx src/components/boq-ingestion-flow.test.ts 'src/app/(authenticated)/boqs/page.tsx' src/app/globals.css
git commit -m "fix: review uploaded BOQ sources and parsed fields"
```

### Task 7: Add Structured AI Verification With Local Fallback

**Files:**
- Create: `src/lib/boq-verification.ts`
- Create: `src/lib/boq-verification.test.ts`
- Modify: `src/app/api/llm/verify/route.ts`
- Modify: `src/components/review-panel.tsx`

- [ ] **Step 1: Write failing verification tests**

Test malformed requests, workspace provider/model precedence, missing API key, 401/429/timeout categories, malformed AI JSON, and fallback shape:

```ts
assert.deepEqual(buildAiFallback(local, 'provider_not_configured'), {
  mode: 'local', aiStatus: 'provider_not_configured',
  message: 'AI verification unavailable. Local checks completed: 2 issues found.',
  issues: local.issues,
})
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test src/lib/boq-verification.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement prompt and response normalization**

Validate `{ boqId, vendor, project, workType, date, items, extractionWarnings }`. Build a system prompt that treats document text as untrusted data and requires JSON `{ issues: [{ code, severity, itemId?, message }] }`. Reject unknown severities/codes and merge valid AI findings with local findings without duplicates.

- [ ] **Step 4: Update the route to use workspace settings**

Load `settings/workspace`; choose request override, then saved provider/model, then environment defaults. Run local verification first. If provider/key is unsupported/missing or `callLLM` fails, return the categorized fallback JSON with HTTP 200 so the UI can present completed local checks. Log only the category, never document content or credentials.

- [ ] **Step 5: Render distinct AI/local states**

The button sends structured review data, reads the response even on errors, and shows `Verified with AI` only for `mode: 'ai'`. For fallback show the message, issue count, and Retry; never set `llmVerified = true` for `mode: 'local'`.

- [ ] **Step 6: Run tests and commit**

Run: `npm test src/lib/boq-verification.test.ts src/components/boq-ingestion-flow.test.ts`

Expected: PASS.

```bash
git add src/lib/boq-verification.ts src/lib/boq-verification.test.ts src/app/api/llm/verify/route.ts src/components/review-panel.tsx
git commit -m "fix: provide local fallback for BOQ verification"
```

### Task 8: End-to-End Regression and Knowledge Graph Update

**Files:**
- Modify only files required by failures found in this task.
- Update: `graphify-out/`

- [ ] **Step 1: Run focused suites**

Run: `python3 -m unittest py-sidecar/test_boq_parser.py -v`

Run: `npm test src/lib/boq-ingestion.test.ts src/lib/boq-verification.test.ts src/components/boq-ingestion-flow.test.ts src/app/api/boqs/import/import-api.test.ts 'src/app/api/boqs/[id]/items/items-api.test.ts'`

Expected: all PASS.

- [ ] **Step 2: Run full project verification**

Run: `npm test`

Run: `npm run lint`

Run: `npm run build`

Expected: all exit 0 with no new warnings.

- [ ] **Step 3: Browser-test three quotation families**

Start the Next.js app and Docling sidecar. Upload `ayt001.pdf`, the Surasak submersible-pump quotation, and the N.P. Civil slab-concrete quotation. For each, confirm the embedded PDF visually matches the selected file; metadata/date/work type match the source; Code and Type are absent; line values and totals reconcile; drawings/photo pages produce no items; and forced AI unavailability reports completed local checks with Retry. Repeat the review at 1440px and 768px viewport widths and confirm both panes remain usable without clipped actions.

- [ ] **Step 4: Test failure paths**

Use an invalid Docling endpoint and confirm the import names the endpoint problem and points to Settings. Restore the endpoint, force an invalid AI key, and confirm parsed edits remain intact and approval is available when local checks have no blocking findings.

- [ ] **Step 5: Update the project graph**

Run: `graphify update .`

Expected: successful AST-only refresh; `graphify-out/GRAPH_REPORT.md` references the new import, source-preview, and fallback-verification flow.

- [ ] **Step 6: Final commit**

```bash
git add graphify-out
git commit -m "chore: refresh ingestion knowledge graph"
```
