# Standardization Catalog — Design Spec

## Overview

Add a catalog-first standardization feature to BuildEstimate. A persistent Master Standard Catalog stores every approved standardized item (description + unit). New BOQ items are matched against the catalog (exact → fuzzy → LLM → human), reducing drift and token cost over time.

## Data Model

### Master Standard Catalog (`buildEstimate_standards` in localStorage)

```ts
interface StandardEntry {
  id: string;                    // "std_001"
  stdUnit: string;               // canonical unit — "m³", "m²", "ton", "m", "ea", "set", "kg"
  stdDesc: string;               // canonical description
  category: string;              // optional grouping — "Structural", "MEP", "Finishing"
  aliases: string[];             // known raw variants — ["Concrete C32/40 col.", "Struct conc C32/40"]
  sourceItems: {                 // provenance
    boqId: string;
    itemCode: string;
    vendorId: string;
  }[];
  confidence: "high" | "reviewed"; // high=auto-matched, reviewed=human-approved
  createdAt: string;             // ISO date
  updatedAt: string;
}
```

Key rules:
- One entry per unique `(stdDesc, stdUnit)` pair
- Each approved standardization creates or merges into an existing catalog entry
- Raw description becomes an alias on the matched entry
- Source BOQ item is added to `sourceItems`

### BOQ Item Extension

Each BOQ item gains standardization metadata:

```ts
{
  // ... existing fields (code, desc, unit, qty, rate, total, type)
  stdStatus: "unchecked" | "matched" | "suggested" | "unmatched" | "approved";
  stdId?: string;               // FK to catalog entry
  stdConfidence?: "exact" | "fuzzy" | "llm" | "manual";
  stdSuggestedDesc?: string;    // LLM suggestion (not yet approved)
  stdSuggestedUnit?: string;
  stdSuggestedStdId?: string;   // LLM-suggested catalog match
}
```

## Upload Flow (BOQ parse → standardize)

After Docling parses a BOQ PDF, run three passes:

### Pass 1 — Exact match
- For each item, check `(desc, unit)` directly against all catalog `stdDesc + stdUnit` pairs
- Check item unit against catalog `stdUnit` (via unit mapping table)
- If exact match exists, set `stdStatus = "matched"`, `stdConfidence = "exact"`, link `stdId`
- **No LLM cost**

### Pass 2 — Fuzzy match (deterministic)
Hard-coded mapping tables:

**Unit mapping** — editable in Settings as a textarea (JSON format). Default:
```json
{
  "m²": ["sq.m", "SQM", "m2", "sqm", "M2", "ตร.ม."],
  "m³": ["cum", "CUM", "m3", "cu.m", "m³", "M3"],
  "ton": ["ton", "tonne", "TON", "MT"],
  "m": ["m", "M", "meter"],
  "ea": ["ea", "each", "EA"],
  "set": ["set", "SET"],
  "kg": ["kg", "KG", "kilogram"],
  "LS": ["LS", "ls", "lump sum"]
}
```

**Description normalization rules** — editable in Settings as a textarea with regex-based JS rules. App runs rules in order to normalize before catalog comparison. Default rules:
- Strip case (lowercase)
- Strip extra whitespace
- Strip punctuation except hyphens and slashes
- Replace common abbreviations ("reinforcement" → "rebar", "concrete" → "conc", "electrical" → "elec")
- Extract dimensions (e.g. "0.80m × 18m" normalized to structural form)

Compare normalized version against catalog `aliases` array.

If fuzzy match found, set `stdStatus = "suggested"`, `stdConfidence = "fuzzy"`, pre-fill suggestion.

### Pass 3 — LLM suggestion (only unmatched items)
- Collect all items where `stdStatus = "unchecked"` after pass 2
- Send to LLM with full catalog as context
- LLM prompt: "For each item, either match it to an existing catalog entry (by ID) or suggest a new standardized description and unit. Do NOT create a duplicate if one already exists."
- Return: `[{ itemIndex, matchedStdId, suggestedDesc, suggestedUnit, confidence: "high"|"medium"|"low", reason }]`
- Set `stdStatus = "suggested"`, `stdConfidence = "llm"`, populate `stdSuggested*` fields

### Review Panel (in BOQ upload flow)
After parsing, a collapsible "Standardization Review" section shows items grouped:
- ✅ **Auto-matched** (pass 1) — accepted silently, badge shows "Matched to [stdDesc]"
- 🔍 **Catalog suggested** (pass 2) — pre-checked, user can Accept or Reject
- 🤔 **LLM suggested** (pass 3) — shows confidence bar, Accept / Edit / Reject
- ❓ **Unmatched** — manual entry, user types or triggers LLM re-suggest

Batch "Accept All" button for each group. Individual Accept/Reject per item.

On Accept: create/update catalog entry (merge aliases, add sourceItems), set item `stdStatus = "approved"`.

## Catalog Page (`catalog.html`)

New nav item after Compare. Two tabs:

### Tab 1: Items to Review
- Shows ALL items from ALL approved BOQs that are not yet `stdStatus = "approved"`
- Table columns: Source BOQ | Item Code | Original Desc | Original Unit | Suggested Std | Confidence | Actions
- Filterable by BOQ (simple dropdown, not required — default "All")
- Grouped by status: Matched / Suggested / Unmatched
- Click row → expand suggestion card with Accept / Suggest Alternative / Skip buttons
- "Run LLM on Unmatched" button to batch-suggest for remaining items

### Tab 2: Standard Catalog
- Searchable table of all catalog entries
- Columns: Standard Description | Standard Unit | Aliases (count badge) | Source BOQs (count badge) | Confidence | Last Updated | Actions
- Click entry → expand detail: full alias list, source BOQ items table, Edit (desc/unit/aliases), Merge (combine two entries), Delete
- Stats bar: X standards total · Y from auto-match · Z reviewed

## LLM Prompt (editable in Settings)
The LLM standardization prompt is added to the LLM Prompt section in Settings, alongside the existing verification prompt. Default:

```
You are a construction BOQ standardization assistant. Given a list of raw items and a reference catalog, standardize each item:
1. If the item matches an existing catalog entry (by description + unit), return the catalog entry ID
2. If no match exists, suggest a standardized description and unit following these conventions:
   - Use clear format: "Material — spec/location/dimension"
   - Units: m³, m², m, ton, ea, set, kg, LS
   - Group similar items (e.g. "Reinforcement bar SD40 — 12mm")
3. Do NOT create a duplicate if a matching entry already exists

Return JSON array: [{itemIndex, matchedStdId, suggestedDesc, suggestedUnit, confidence: "high"|"medium"|"low", reason}]
```

## Files Changed

| File | Change |
|------|--------|
| `catalog.html` | **New page** — Items to Review + Standard Catalog tabs |
| `boqs.html` | Add standardization review panel after parse step |
| `boq-detail.html` | Show `stdStatus` badge per item |
| `settings.html` | Add "Standardization Prompt" to LLM Prompt section |
| `shared.css` | Add status/confidence badge styles |

## Implementation Order

1. Create `catalog.html` (standalone page with mock data)
2. Add fuzzy matching logic to `shared.js` (unit map + description normalizer)
3. Add standardization review panel to `boqs.html` upload flow
4. Wire LLM call for pass 3 (reuse existing `verifyWithLLM` pattern)
5. Add stdStatus badges to `boq-detail.html`
6. Add standardization prompt to `settings.html`
