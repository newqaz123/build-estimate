# Standardization Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add catalog-first standardization to BuildEstimate — persistent Master Standard Catalog, 3-pass matching during BOQ upload, and a Catalog page for review.

**Architecture:** Data lives in localStorage (`buildEstimate_standards` array). Fuzzy matching rules are user-editable in Settings. Each BOQ item gets `stdStatus`/`stdId` metadata. The upload flow runs 3 passes: exact catalog match → fuzzy (with user-defined rules) → LLM (with catalog context).

**Tech Stack:** Vanilla JS + localStorage, Airtable design tokens, no dependencies.

## Global Constraints

- All data persisted to `localStorage` — no backend
- Fuzzy unit mapping and description normalization rules are editable in Settings, not hard-coded
- Do NOT create a catalog duplicate if one already exists
- Airtable design system tokens from `shared.css`
- Follow existing sidebar nav pattern (inline SVG icons, `data-od-id` attributes)
- All HTML files in project root (no subdirectories)
- `stdStatus` values: `"unchecked"`, `"matched"`, `"suggested"`, `"unmatched"`, `"approved"`
- `stdConfidence` values: `"exact"`, `"fuzzy"`, `"llm"`, `"manual"`

---

### Task 1: Add Catalog nav link + shared CSS

**Files:**
- Modify: `boq-detail.html:42` — add Catalog nav link
- Modify: `boqs.html:40` — add Catalog nav link
- Modify: `compare.html:39` — add Catalog nav link
- Modify: `estimator.html:39` — add Catalog nav link
- Modify: `dashboard.html:39` — add Catalog nav link
- Modify: `settings.html:39` — add Catalog nav link
- Modify: `index.html:92-108` — add Catalog launcher card
- Modify: `shared.css` (end) — add stdStatus badge styles

**Interfaces:**
- Consumes: existing sidebar pattern, existing badge CSS classes
- Produces: `shared.css` gets `.badge-matched`, `.badge-suggested`, `.badge-unmatched` styles; all pages get nav link to `catalog.html`

- [ ] **Step 1: Add nav link to all pages**

Add after the Compare link (before Estimator) in every page's sidebar nav. Use the book-open SVG icon:

```html
<a href="catalog.html" data-od-id="nav-catalog"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/><line x1="8" y1="7" x2="16" y2="7"/><line x1="8" y1="11" x2="14" y2="11"/></svg><span>Catalog</span></a>
```

Place after the Compare link in each sidebar. Add `class="active"` only on `catalog.html`.

- [ ] **Step 2: Add launcher card to index.html**

Add after the Compare card:

```html
<a href="catalog.html" class="screen-card" data-od-id="launcher-catalog">
  <div class="card-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/><line x1="8" y1="7" x2="16" y2="7"/><line x1="8" y1="11" x2="14" y2="11"/></svg></div>
  <div class="card-label">Catalog</div>
  <div class="card-desc">Standardize items & manage master catalog</div>
</a>
```

- [ ] **Step 3: Add stdStatus badge CSS to shared.css**

Append before the closing `</style>` equivalent (end of file):

```css
.badge-matched { background: color-mix(in oklab, var(--accent) 12%, transparent); color: var(--accent); }
.badge-matched::before { background: var(--accent); }
.badge-suggested { background: color-mix(in oklab, var(--warn) 18%, transparent); color: color-mix(in oklab, var(--warn), black 40%); }
.badge-suggested::before { background: var(--warn); }
.badge-unmatched { background: color-mix(in oklab, var(--danger) 12%, transparent); color: var(--danger); }
.badge-unmatched::before { background: var(--danger); }
.badge-approved { background: color-mix(in oklab, var(--success) 12%, transparent); color: var(--success); }
.badge-approved::before { background: var(--success); }

.status-dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; }
.status-dot-matched { background: var(--accent); }
.status-dot-suggested { background: var(--warn); }
.status-dot-unmatched { background: var(--danger); }
.status-dot-approved { background: var(--success); }
```

---

### Task 2: Add fuzzy match rules + standardization prompt to Settings

**Files:**
- Modify: `settings.html:187-218` — add "Fuzzy Match Rules" card before the LLM Prompt card

**Interfaces:**
- Consumes: existing Settings page structure and `savePrompt`/`resetPrompt` pattern
- Produces: `localStorage` keys `be_fuzzyUnitMap` (JSON), `be_fuzzyNormalizeRules` (JSON array of {pattern, replacement}), and `be_stdPrompt` (string)

- [ ] **Step 1: Add Fuzzy Match Rules card to settings.html**

Insert before the LLM Prompt card (before line 187):

```html
<div class="card section-card" data-od-id="fuzzy-rules-settings" style="margin-top:var(--space-5);">
  <div class="card-header">
    <div>
      <h3>Fuzzy Match Rules</h3>
      <span style="font-size:12px;color:var(--muted);">Unit mapping and description normalization for BOQ standardization</span>
    </div>
    <span class="meta" id="fuzzyRuleCount">8 rules</span>
  </div>
  <div class="card-body">
    <div class="form-group">
      <div class="field">
        <label for="fuzzyUnitMap">Unit mapping (JSON — key = canonical unit, value = array of variants)</label>
        <textarea class="textarea" id="fuzzyUnitMap" style="min-height:120px;font-size:13px;font-family:var(--font-mono);line-height:1.6;">{
  "m\u00b2": ["sq.m", "SQM", "m2", "sqm", "M2", "\u0e15\u0e23.\u0e21."],
  "m\u00b3": ["cum", "CUM", "m3", "cu.m"],
  "ton": ["tonne", "TON", "MT"],
  "m": ["meter", "M"],
  "ea": ["each", "EA"],
  "set": ["SET"],
  "kg": ["KG", "kilogram"],
  "LS": ["ls", "lump sum"]
}</textarea>
      </div>
      <div class="field" style="margin-top:var(--space-3);">
        <label for="fuzzyNormalizeRules">Description normalization rules (JSON array — {pattern, replacement})</label>
        <textarea class="textarea" id="fuzzyNormalizeRules" style="min-height:80px;font-size:13px;font-family:var(--font-mono);line-height:1.6;">[
  {"pattern": "reinforcement bar", "replacement": "rebar"},
  {"pattern": "structural concrete", "replacement": "conc"},
  {"pattern": "\\u00d7", "replacement": "x"},
  {"pattern": "\\u2014|\\u2013", "replacement": " - "}
]</textarea>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:var(--space-2);">
        <div style="display:flex;gap:var(--space-2);">
          <button class="btn btn-primary btn-sm" onclick="saveFuzzyRules()">Save Rules</button>
          <button class="btn btn-ghost btn-sm" onclick="resetFuzzyRules()">Reset to Default</button>
        </div>
        <span style="font-size:11px;color:var(--muted);">Applies to: BOQ standardization · Catalog fuzzy matching</span>
      </div>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Add save/reset JS for fuzzy rules**

Insert into the existing `<script>` block in settings.html. Add before the `savePrompt` function:

```js
function loadFuzzyRules() {
  const map = localStorage.getItem('be_fuzzyUnitMap');
  const rules = localStorage.getItem('be_fuzzyNormalizeRules');
  document.getElementById('fuzzyUnitMap').value = map || JSON.stringify({
    "m²": ["sq.m", "SQM", "m2", "sqm", "M2", "ตร.ม."],
    "m³": ["cum", "CUM", "m3", "cu.m"],
    "ton": ["tonne", "TON", "MT"],
    "m": ["meter", "M"],
    "ea": ["each", "EA"],
    "set": ["SET"],
    "kg": ["KG", "kilogram"],
    "LS": ["ls", "lump sum"]
  }, null, 2);
  document.getElementById('fuzzyNormalizeRules').value = rules || JSON.stringify([
    {"pattern": "reinforcement bar", "replacement": "rebar"},
    {"pattern": "structural concrete", "replacement": "conc"},
    {"pattern": "×", "replacement": "x"},
    {"pattern": "—|–", "replacement": " - "}
  ], null, 2);
  updateFuzzyRuleCount();
}

function saveFuzzyRules() {
  try {
    JSON.parse(document.getElementById('fuzzyUnitMap').value);
    JSON.parse(document.getElementById('fuzzyNormalizeRules').value);
    localStorage.setItem('be_fuzzyUnitMap', document.getElementById('fuzzyUnitMap').value);
    localStorage.setItem('be_fuzzyNormalizeRules', document.getElementById('fuzzyNormalizeRules').value);
    updateFuzzyRuleCount();
    showToast('Fuzzy match rules saved', 'success');
  } catch (e) {
    showToast('Invalid JSON — please check your syntax', 'error');
  }
}

function resetFuzzyRules() {
  localStorage.removeItem('be_fuzzyUnitMap');
  localStorage.removeItem('be_fuzzyNormalizeRules');
  loadFuzzyRules();
  showToast('Fuzzy match rules reset to default', 'success');
}

function updateFuzzyRuleCount() {
  try {
    const map = JSON.parse(document.getElementById('fuzzyUnitMap').value);
    const count = Object.keys(map).length;
    document.getElementById('fuzzyRuleCount').textContent = count + ' rules';
  } catch (e) {}
}
```

Add `loadFuzzyRules()` call in the existing initialization block.

- [ ] **Step 3: Add standardization prompt to LLM Prompt card**

Add an additional textarea inside the LLM Prompt card body for the standardization prompt. Add after the existing `llmPrompt` textarea's sibling div:

```html
<div class="field" style="margin-top:var(--space-3);">
  <label for="stdPrompt">Standardization prompt</label>
  <textarea class="textarea" id="stdPrompt" style="min-height:100px;font-size:13px;font-family:var(--font-mono);line-height:1.6;">You are a construction BOQ standardization assistant. Given a list of raw items and a reference catalog, standardize each item:
1. If the item matches an existing catalog entry (by description + unit), return the catalog entry ID
2. If no match exists, suggest a standardized description and unit following these conventions:
   - Use clear format: "Material — spec/location/dimension"
   - Units: m³, m², m, ton, ea, set, kg, LS
   - Group similar items (e.g. "Reinforcement bar SD40 — 12mm")
3. Do NOT create a duplicate if a matching entry already exists
Return JSON array: [{itemIndex, matchedStdId, suggestedDesc, suggestedUnit, confidence: "high"|"medium"|"low", reason}]</textarea>
</div>
```

Add save/reset/load logic matching the existing prompt pattern:

```js
function saveStdPrompt() {
  localStorage.setItem('be_stdPrompt', document.getElementById('stdPrompt').value);
  showToast('Standardization prompt saved', 'success');
}

function resetStdPrompt() {
  const defaultStdPrompt = document.getElementById('stdPrompt').placeholder || `You are a construction BOQ standardization assistant...`;
  document.getElementById('stdPrompt').value = defaultStdPrompt;
  localStorage.removeItem('be_stdPrompt');
  showToast('Standardization prompt reset to default', 'success');
}
```

Update the "Applies to" text on the prompt card to include "· Standardization".

---

### Task 3: Add standardization review to BOQ upload flow

**Files:**
- Modify: `boqs.html:539-585` — add `runStandardization()` function and review panel UI
- Modify: `boqs.html:587-601` — hook standardization into `submitUpload()`

**Interfaces:**
- Consumes: `mockParsedItems`, `localStorage` keys `buildEstimate_standards`, `be_fuzzyUnitMap`, `be_fuzzyNormalizeRules`, `be_stdPrompt`
- Produces: items annotated with `stdStatus`, `stdId`, `stdConfidence`, `stdSuggested*` fields; catalog entries updated/created

- [ ] **Step 1: Add standardization helper functions**

Add before the `verifyWithLLM` function. Include the fuzzy matching logic:

```js
// ─── Standardization ───
function getStandards() {
  try { return JSON.parse(localStorage.getItem('buildEstimate_standards')) || []; } catch(e) { return []; }
}

function saveStandards(standards) {
  localStorage.setItem('buildEstimate_standards', JSON.stringify(standards));
}

function getFuzzyUnitMap() {
  try { return JSON.parse(localStorage.getItem('be_fuzzyUnitMap')); } catch(e) { return null; }
}

function getFuzzyNormalizeRules() {
  try { return JSON.parse(localStorage.getItem('be_fuzzyNormalizeRules')); } catch(e) { return null; }
}

function normalizeDesc(desc) {
  let s = desc.toLowerCase().trim().replace(/\s+/g, ' ');
  s = s.replace(/[^\w\s\/\-\dx]/g, '');
  const rules = getFuzzyNormalizeRules();
  if (rules) {
    rules.forEach(r => {
      try { s = s.replace(new RegExp(r.pattern, 'gi'), r.replacement); } catch(e) {}
    });
  }
  return s;
}

function matchUnit(unit) {
  if (!unit) return null;
  const u = unit.trim().toLowerCase();
  const map = getFuzzyUnitMap();
  if (!map) return null;
  for (const [canonical, variants] of Object.entries(map)) {
    if (u === canonical.toLowerCase() || variants.some(v => v.toLowerCase() === u)) {
      return canonical;
    }
  }
  return null;
}

function runStandardization(items) {
  const standards = getStandards();
  // Pass 1: Exact match (desc + unit against catalog)
  // Pass 2: Fuzzy match (normalized desc + mapped unit against catalog aliases)
  // Pass 3: Collect unmatched for LLM
  const pass3Items = [];

  items.forEach((item, idx) => {
    item.stdStatus = item.stdStatus || 'unchecked';
    if (item.stdStatus === 'approved') return;

    const itemUnit = matchUnit(item.unit) || item.unit;
    const itemDesc = normalizeDesc(item.desc);

    // Pass 1: Exact match
    let match = standards.find(s =>
      normalizeDesc(s.stdDesc) === itemDesc &&
      (matchUnit(s.stdUnit) || s.stdUnit).toLowerCase() === (itemUnit || '').toLowerCase()
    );
    if (match) {
      item.stdStatus = 'matched';
      item.stdId = match.id;
      item.stdConfidence = 'exact';
      return;
    }

    // Pass 2: Fuzzy match via aliases
    match = standards.find(s =>
      s.aliases.some(a => {
        const aliasNorm = normalizeDesc(a);
        const aliasUnit = matchUnit(s.stdUnit) || (s.stdUnit || '').toLowerCase();
        return aliasNorm === itemDesc && aliasUnit === (itemUnit || '').toLowerCase();
      })
    );
    if (match) {
      item.stdStatus = 'suggested';
      item.stdId = match.id;
      item.stdConfidence = 'fuzzy';
      item.stdSuggestedDesc = match.stdDesc;
      item.stdSuggestedUnit = match.stdUnit;
      return;
    }

    // Pass 3: LLM needed
    pass3Items.push(idx);
    item.stdStatus = 'unmatched';
  });

  return pass3Items;
}
```

- [ ] **Step 2: Add LLM suggestion pass 3 function**

```js
function suggestWithLLM(items) {
  return new Promise((resolve) => {
    const standards = getStandards();
    const prompt = localStorage.getItem('be_stdPrompt') || document.getElementById('stdPrompt')?.value || '';
    const unmatched = items.filter(i => i.stdStatus === 'unmatched');

    if (unmatched.length === 0) { resolve([]); return; }

    // Simulated LLM call (replace with real API)
    setTimeout(() => {
      const suggestions = unmatched.map((item, i) => {
        // Try to find closest fuzzy match as fallback
        let best = null, bestScore = 0;
        standards.forEach(s => {
          s.aliases.forEach(a => {
            const score = similarity(normalizeDesc(item.desc), normalizeDesc(a));
            if (score > bestScore) { bestScore = score; best = s; }
          });
        });
        if (best && bestScore > 0.6) {
          return {
            itemIndex: items.indexOf(item),
            matchedStdId: best.id,
            suggestedDesc: best.stdDesc,
            suggestedUnit: best.stdUnit,
            confidence: bestScore > 0.8 ? 'high' : 'medium',
            reason: 'Similar to catalog entry "' + best.stdDesc + '"'
          };
        }
        return {
          itemIndex: items.indexOf(item),
          matchedStdId: null,
          suggestedDesc: item.desc,
          suggestedUnit: matchUnit(item.unit) || item.unit || LS,
          confidence: 'low',
          reason: 'No close match found in catalog'
        };
      });
      resolve(suggestions);
    }, 1500);
  });
}

// Simple string similarity (Dice coefficient)
function similarity(a, b) {
  if (!a || !b) return 0;
  const bigrams = new Set();
  for (let i = 0; i < a.length - 1; i++) bigrams.add(a.substring(i, i + 2));
  let matches = 0;
  for (let i = 0; i < b.length - 1; i++) {
    if (bigrams.has(b.substring(i, i + 2))) matches++;
  }
  return (2 * matches) / (a.length + b.length);
}
```

- [ ] **Step 3: Add standardization review panel UI to the review modal**

In the review modal HTML (after the LLM suggestions area), add a collapsible section:

```html
<div class="review-section" data-od-id="standardization-review" style="margin-top:var(--space-4);border-top:1px solid var(--border-soft);padding-top:var(--space-3);">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-2);">
    <span style="font-weight:500;font-size:13px;display:flex;align-items:center;gap:6px;cursor:pointer;" onclick="toggleStdReview()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" style="width:14px;height:14px;" id="stdReviewArrow"><polyline points="9 18 15 12 9 6"/></svg>
      Standardization
    </span>
    <span style="font-size:11px;color:var(--muted);" id="stdStatusSummary">3 items need review</span>
  </div>
  <div id="stdReviewContent" style="display:none;">
    <div id="stdReviewItems" style="display:grid;gap:6px;max-height:300px;overflow-y:auto;"></div>
    <div style="display:flex;gap:var(--space-2);margin-top:var(--space-2);">
      <button class="btn btn-primary btn-sm" onclick="acceptAllStdSuggestions()">Accept All Suggested</button>
      <button class="btn btn-ghost btn-sm" onclick="runStdLLM()">Run LLM on Unmatched</button>
    </div>
  </div>
</div>
```

- [ ] **Step 4: Add JS for the standardization review panel**

```js
let currentStdItems = [];

function toggleStdReview() {
  const content = document.getElementById('stdReviewContent');
  const arrow = document.getElementById('stdReviewArrow');
  content.style.display = content.style.display === 'none' ? 'block' : 'none';
  arrow.style.transform = content.style.display === 'block' ? 'rotate(90deg)' : '';
}

function renderStandardization(items) {
  currentStdItems = items;
  const unmatched = items.filter(i => i.stdStatus === 'unmatched').length;
  const suggested = items.filter(i => i.stdStatus === 'suggested').length;
  const matched = items.filter(i => i.stdStatus === 'matched').length;
  document.getElementById('stdStatusSummary').textContent =
    matched + ' matched · ' + suggested + ' suggested · ' + unmatched + ' need review';

  const container = document.getElementById('stdReviewItems');
  container.innerHTML = items.map((item, idx) => {
    let badge, suggestion = '';
    if (item.stdStatus === 'matched') {
      badge = '<span class="badge badge-matched" style="font-size:10px;">Matched</span>';
    } else if (item.stdStatus === 'suggested') {
      badge = '<span class="badge badge-suggested" style="font-size:10px;cursor:pointer;" onclick="acceptStdSuggestion(' + idx + ')">Accept?</span>';
      suggestion = ' → <span style="color:var(--accent);">' + (item.stdSuggestedDesc || '') + ' · ' + (item.stdSuggestedUnit || '') + '</span>';
    } else if (item.stdStatus === 'unmatched') {
      badge = '<span class="badge badge-unmatched" style="font-size:10px;">Unmatched</span>';
    } else {
      badge = '<span class="badge badge-approved" style="font-size:10px;">Approved</span>';
    }
    return '<div style="display:flex;align-items:center;gap:6px;padding:6px 8px;background:var(--bg);border-radius:6px;font-size:13px;">' +
      badge +
      '<span><strong>' + (item.code || '#') + '</strong> ' + item.desc + ' · ' + (item.unit || '—') + '</span>' +
      suggestion +
      '</div>';
  }).join('');
}

function acceptStdSuggestion(idx) {
  const item = currentStdItems[idx];
  if (!item || !item.stdSuggestedDesc) return;
  const standards = getStandards();
  let std = item.stdId ? standards.find(s => s.id === item.stdId) : null;
  if (!std) {
    std = { id: 'std_' + Date.now(), stdDesc: item.stdSuggestedDesc, stdUnit: item.stdSuggestedUnit, aliases: [item.desc], sourceItems: [], confidence: 'reviewed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    standards.push(std);
  }
  if (!std.aliases.includes(item.desc)) std.aliases.push(item.desc);
  std.sourceItems.push({ boqId: 'BOQ-NEW', itemCode: item.code || '', vendorId: document.getElementById('revVendor').value });
  std.updatedAt = new Date().toISOString();
  saveStandards(standards);
  item.stdStatus = 'approved';
  item.stdId = std.id;
  item.stdConfidence = 'manual';
  renderStandardization(currentStdItems);
  showToast('Standard approved — catalog updated', 'success');
}

function acceptAllStdSuggestions() {
  currentStdItems.forEach((item, idx) => {
    if (item.stdStatus === 'suggested') acceptStdSuggestion(idx);
  });
}

async function runStdLLM() {
  const btn = document.querySelector('#stdReviewContent .btn-primary');
  if (btn) { btn.classList.add('loading'); btn.disabled = true; }
  const suggestions = await suggestWithLLM(currentStdItems);
  suggestions.forEach(s => {
    if (s.matchedStdId) {
      const item = currentStdItems[s.itemIndex];
      item.stdStatus = 'suggested';
      item.stdId = s.matchedStdId;
      const std = getStandards().find(st => st.id === s.matchedStdId);
      item.stdSuggestedDesc = std ? std.stdDesc : s.suggestedDesc;
      item.stdSuggestedUnit = std ? std.stdUnit : s.suggestedUnit;
      item.stdConfidence = s.confidence;
    }
  });
  if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
  renderStandardization(currentStdItems);
  showToast('LLM suggestions applied', 'success');
}
```

- [ ] **Step 5: Hook standardization into submitUpload**

Modify the `submitUpload` success timeout callback (around line 596) to call `runStandardization`:

```js
setTimeout(() => {
  document.getElementById('revDate').value = new Date().toISOString().split('T')[0];
  renderReviewItems(mockParsedItems);
  const unmapped = runStandardization(mockParsedItems);
  renderStandardization(mockParsedItems);
  document.getElementById('reviewModal').classList.add('open');
  btn.classList.remove('loading');
  btn.disabled = false;
}, 2500);
```

---

### Task 4: Create Catalog page

**Files:**
- Create: `catalog.html` — new standalone page

**Interfaces:**
- Consumes: `localStorage` keys `buildEstimate_standards`, item data from approved BOQs in localStorage
- Produces: catalog.html with Items to Review + Standard Catalog tabs

- [ ] **Step 1: Create catalog.html skeleton**

Copy the HTML structure from `boq-detail.html` (sidebar, topbar, main-area pattern). Replace page title with "Catalog — BuildEstimate". Set `class="active"` on the Catalog nav link. Remove the back button from topbar. Title: "Standard Catalog".

- [ ] **Step 2: Add page structure — two tabs**

```html
<div class="main-area">
  <header class="topbar">
    <div class="topbar-left">
      <h1>Catalog</h1>
    </div>
    <div class="topbar-right">
      <span style="font-size:12px;color:var(--muted);" id="catalogStats">0 standards · 0 items to review</span>
    </div>
  </header>
  <div class="content">
    <!-- Tabs -->
    <div style="display:flex;gap:var(--space-1);margin-bottom:var(--space-4);border-bottom:1px solid var(--border-soft);">
      <button class="tab-btn active" data-tab="review" onclick="switchTab('review')">Items to Review</button>
      <button class="tab-btn" data-tab="catalog" onclick="switchTab('catalog')">Standard Catalog</button>
    </div>
    <div id="tab-review" class="tab-content"></div>
    <div id="tab-catalog" class="tab-content" style="display:none;"></div>
  </div>
</div>

<style>
  .tab-btn { padding: var(--space-2) var(--space-4); border: none; background: none; cursor: pointer; font-size: 13px; color: var(--muted); border-bottom: 2px solid transparent; margin-bottom: -1px; }
  .tab-btn.active { color: var(--fg); border-bottom-color: var(--accent); font-weight: 500; }
</style>
```

- [ ] **Step 3: Add JS — load data, render tabs**

```js
let currentBOQData = [];

function loadData() {
  const standards = getStandards();
  // Load approved BOQs from localStorage
  try {
    const boqs = JSON.parse(localStorage.getItem('buildEstimate_boqs')) || [];
    // Flatten all items from all approved BOQs
    currentBOQData = [];
    boqs.forEach(boq => {
      if (boq.items && Array.isArray(boq.items)) {
        boq.items.forEach(item => {
          currentBOQData.push({ ...item, _boqId: boq.id, _boqName: boq.project + ' — ' + boq.vendor });
        });
      }
    });
  } catch(e) { currentBOQData = mockCatalogData(); }

  updateStats(standards);
  renderReviewTab();
  renderCatalogTab();
}

function updateStats(standards) {
  const toReview = currentBOQData.filter(i => i.stdStatus && i.stdStatus !== 'approved' && i.stdStatus !== 'matched').length;
  document.getElementById('catalogStats').textContent = standards.length + ' standards · ' + toReview + ' items to review';
}

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('tab-review').style.display = tab === 'review' ? 'block' : 'none';
  document.getElementById('tab-catalog').style.display = tab === 'catalog' ? 'block' : 'none';
}

function renderReviewTab() {
  const items = currentBOQData.filter(i => i.stdStatus && i.stdStatus !== 'approved' && i.stdStatus !== 'matched');
  const container = document.getElementById('tab-review');
  if (items.length === 0) {
    container.innerHTML = '<div style="padding:var(--space-8);text-align:center;color:var(--muted);font-size:14px;">All items standardized. Catalog is up to date.</div>';
    return;
  }
  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-3);">
      <span style="font-size:13px;color:var(--muted);">${items.length} items need review</span>
      <div style="display:flex;gap:var(--space-2);">
        <button class="btn btn-primary btn-sm" onclick="acceptAllReviewItems()">Accept All Suggested</button>
        <button class="btn btn-ghost btn-sm" onclick="runLLMOnAll()">Run LLM</button>
      </div>
    </div>
    <div class="data-table"><table><thead><tr>
      <th>Source BOQ</th><th>Code</th><th>Description</th><th>Unit</th><th>Suggested</th><th>Status</th><th></th>
    </tr></thead><tbody id="reviewTableBody"></tbody></table></div>
  `;
  const tbody = document.getElementById('reviewTableBody');
  tbody.innerHTML = items.map((item, idx) => {
    const statusDot = 'status-dot-' + (item.stdStatus === 'suggested' ? 'suggested' : 'unmatched');
    const statusLabel = item.stdStatus === 'suggested' ? 'Suggested' : 'Unmatched';
    const suggText = item.stdSuggestedDesc ? item.stdSuggestedDesc + ' · ' + item.stdSuggestedUnit : '—';
    const canAccept = item.stdStatus === 'suggested' && item.stdSuggestedDesc;
    return `<tr>
      <td><span style="font-size:12px;color:var(--muted);">${item._boqName || '—'}</span></td>
      <td><span style="font-family:var(--font-mono);font-size:12px;">${item.code || '—'}</span></td>
      <td>${item.desc}</td>
      <td>${item.unit || '—'}</td>
      <td>${canAccept ? '<span style="color:var(--accent);font-size:13px;">' + suggText + '</span>' : '<span style="color:var(--muted);font-size:12px;">' + suggText + '</span>'}</td>
      <td><span class="status-dot ${statusDot}"></span>${statusLabel}</td>
      <td>${canAccept ? '<button class="btn btn-sm" style="font-size:11px;padding:3px 8px;" onclick="acceptReviewItem(' + idx + ')">Accept</button>' : '<button class="btn btn-ghost btn-sm" style="font-size:11px;padding:3px 8px;" onclick="triggerLLM(' + idx + ')">Suggest</button>'}</td>
    </tr>`;
  }).join('');
}

function acceptReviewItem(idx) {
  // Similar to acceptStdSuggestion but works with the full BOQ data
  const item = currentBOQData[idx];
  if (!item || !item.stdSuggestedDesc) return;
  const standards = getStandards();
  let std = item.stdId ? standards.find(s => s.id === item.stdId) : null;
  if (!std) {
    std = { id: 'std_' + Date.now(), stdDesc: item.stdSuggestedDesc, stdUnit: item.stdSuggestedUnit, aliases: [item.desc], sourceItems: [], confidence: 'reviewed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    standards.push(std);
  }
  if (!std.aliases.includes(item.desc)) std.aliases.push(item.desc);
  std.sourceItems.push({ boqId: item._boqId || '', itemCode: item.code || '', vendorId: '' });
  std.updatedAt = new Date().toISOString();
  saveStandards(standards);
  item.stdStatus = 'approved';
  renderReviewTab();
  renderCatalogTab();
  updateStats(standards);
  showToast('Item standardized — catalog updated', 'success');
}

function renderCatalogTab() {
  const standards = getStandards();
  const container = document.getElementById('tab-catalog');
  if (standards.length === 0) {
    container.innerHTML = '<div style="padding:var(--space-8);text-align:center;color:var(--muted);font-size:14px;">Catalog is empty. Standards will appear here after BOQs are processed.</div>';
    return;
  }
  container.innerHTML = `
    <div style="margin-bottom:var(--space-3);">
      <input class="input" type="text" id="catalogSearch" placeholder="Search catalog…" oninput="filterCatalog()" style="width:100%;" />
    </div>
    <div class="data-table"><table><thead><tr>
      <th>Standard Description</th><th>Unit</th><th>Aliases</th><th>Source BOQs</th><th>Confidence</th><th>Last Updated</th>
    </tr></thead><tbody id="catalogTableBody"></tbody></table></div>
  `;
  renderCatalogRows(standards);
}

function renderCatalogRows(standards) {
  const tbody = document.getElementById('catalogTableBody');
  const q = (document.getElementById('catalogSearch')?.value || '').toLowerCase();
  const filtered = standards.filter(s => !q || s.stdDesc.toLowerCase().includes(q) || s.stdUnit.toLowerCase().includes(q));
  tbody.innerHTML = filtered.map(s => {
    const confDot = s.confidence === 'high' ? 'status-dot-matched' : 'status-dot-approved';
    const confLabel = s.confidence === 'high' ? 'Auto' : 'Reviewed';
    return `<tr>
      <td><span style="font-weight:500;">${s.stdDesc}</span></td>
      <td><code style="background:var(--border-soft);padding:2px 6px;border-radius:4px;font-size:12px;">${s.stdUnit}</code></td>
      <td><span style="font-size:12px;color:var(--muted);">${s.aliases.length} variants</span></td>
      <td><span style="font-size:12px;color:var(--muted);">${s.sourceItems.length} items</span></td>
      <td><span class="status-dot ${confDot}"></span>${confLabel}</td>
      <td><span style="font-size:12px;color:var(--muted);">${new Date(s.updatedAt).toLocaleDateString()}</span></td>
    </tr>`;
  }).join('');
}

function filterCatalog() { renderCatalogRows(getStandards()); }
```

- [ ] **Step 4: Add mock data for demo state**

```js
function mockCatalogData() {
  return [
    { code: 'B.1.1', desc: 'Structural concrete C32/40 (columns)', unit: 'm³', stdStatus: 'suggested', stdId: null, stdSuggestedDesc: 'Structural concrete C32/40 (columns)', stdSuggestedUnit: 'm³', stdConfidence: 'llm', _boqName: 'Ratchaphruek Tower — ITH Technology' },
    { code: 'B.1.2', desc: 'Reinforcement bar SD40 — 16mm', unit: 'ton', stdStatus: 'unmatched', stdId: null, stdSuggestedDesc: null, stdSuggestedUnit: null, _boqName: 'Ratchaphruek Tower — ITH Technology' },
    { code: 'B.1.3', desc: 'Bored pile — 0.80m × 18m', unit: 'm', stdStatus: 'suggested', stdId: null, stdSuggestedDesc: 'Bored pile — 0.80m × 18m', stdSuggestedUnit: 'm', stdConfidence: 'fuzzy', _boqName: 'Suvarnabhumi Phase 2 — PCS Engineering' },
    { code: 'M.2.1', desc: 'HVAC ductwork supply', unit: 'm²', stdStatus: 'unmatched', stdId: null, stdSuggestedDesc: null, stdSuggestedUnit: null, _boqName: 'Suvarnabhumi Phase 2 — PCS Engineering' },
  ];
}
```

- [ ] **Step 5: Init on page load**

```js
document.addEventListener('DOMContentLoaded', loadData);
```

Include the standardization helper functions (`getStandards`, `saveStandards`, `getFuzzyUnitMap`, `matchUnit`, `normalizeDesc`, `similarity`) at the top of the script block.

---

### Task 5: Add stdStatus badges to BOQ detail page

**Files:**
- Modify: `boq-detail.html:273-301` — add stdStatus column to item rows

- [ ] **Step 1: Add "Std" column header to the table**

Find the `<thead>` in boq-detail.html and add a "Std" column:

```html
<th style="width:50px;">Std</th>
```

Add after the existing Unit column header.

- [ ] **Step 2: Add stdStatus badge cell to each item row**

In the table row rendering (around line 273), add after the Unit cell:

```html
<td>${renderStdBadge(item)}</td>
```

- [ ] **Step 3: Add renderStdBadge function**

```js
function renderStdBadge(item) {
  if (!item.stdStatus || item.stdStatus === 'unchecked') return '<span style="color:var(--muted);font-size:11px;">—</span>';
  const labels = { matched: '✅', suggested: '🔍', unmatched: '❓', approved: '✓' };
  const classes = { matched: 'badge-matched', suggested: 'badge-suggested', unmatched: 'badge-unmatched', approved: 'badge-approved' };
  const label = labels[item.stdStatus] || '—';
  const cls = classes[item.stdStatus] || '';
  return `<span class="badge ${cls}" style="font-size:10px;" title="${item.stdConfidence ? 'Confidence: ' + item.stdConfidence : ''}">${label}</span>`;
}
```



---

## Spec Coverage Check

| Spec Requirement | Task |
|---|---|
| Master Standard Catalog data model | Task 3 (getStandards/saveStandards), Task 4 (Catalog tab) |
| Pass 1 — Exact match | Task 3 Step 1 (runStandardization) |
| Pass 2 — Fuzzy match with user-editable rules | Task 2 (Settings), Task 3 Step 1 (matchUnit/normalizeDesc) |
| Pass 3 — LLM suggestion with catalog context | Task 3 Step 2 (suggestWithLLM) |
| Standardization review panel in upload flow | Task 3 Steps 3-4 |
| Catalog page with two tabs | Task 4 |
| Fuzzy rules editable in Settings | Task 2 Steps 1-2 |
| Standardization prompt in Settings | Task 2 Step 3 |
| Catalog nav link everywhere | Task 1 Step 1 |
| BOQ detail stdStatus badges | Task 5 |
