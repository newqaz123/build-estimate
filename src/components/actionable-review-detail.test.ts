import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";

import {
  buildActionableAddAndMatchPayload,
  buildActionableAddToBoqPayload,
  canAddAndMatch,
  canEnableAddAndMatch,
  conversionScopeFromRuleId,
  draftFromExtracted,
  hasAuthoritativeCandidateMatch,
  isNormalizationAlignedWithCandidate,
  isNormalizationTotalAlignedWithExtracted,
  requiresCorrectionReason,
  type ActionableReviewerDraft,
} from "./actionable-review-detail";
import type { ActionableItemSuggestion } from "@/lib/actionable-review-projection";

const componentUrl = new URL("./actionable-review-detail.tsx", import.meta.url);

function baseExtracted() {
  return {
    description: "Ready mix concrete",
    unit: "m3",
    quantity: "2",
    materialRate: "50",
    labourRate: "10",
    total: "120",
  };
}

function baseCandidate(
  overrides: Partial<ActionableItemSuggestion["catalogCandidates"][number]> = {},
) {
  return {
    catalogId: "std-1",
    description: "Concrete C25",
    unit: "m3",
    matchKind: "exact" as const,
    score: 100,
    ...overrides,
  };
}

function baseNormalization(
  overrides: Partial<NonNullable<ActionableItemSuggestion["normalization"]>> = {},
) {
  return {
    catalogId: "std-1",
    catalogDescription: "Concrete C25",
    catalogUnit: "m3",
    ruleId: "identity:m3:v1",
    catalogUnitsPerSourceUnit: "1",
    normalizedQuantity: "2",
    normalizedMaterialRate: "50",
    normalizedLabourRate: "10",
    normalizedTotal: "120",
    ...overrides,
  };
}

test("actionable review detail component exists", () => {
  assert.equal(existsSync(componentUrl), true);
});

test("detail exposes the four extraction decision labels", () => {
  const source = readFileSync(componentUrl, "utf8");
  assert.match(source, /Add & match/);
  assert.match(source, /Add to BOQ/);
  assert.match(source, /Find another/);
  assert.match(source, /Do not add/);
  assert.match(source, /data-od-id="decision-detail"/);
});

test("Add & match stays disabled below add_and_match stage", () => {
  const source = readFileSync(componentUrl, "utf8");
  assert.match(source, /add_and_match|default/);
  assert.match(
    source,
    /Add & match[\s\S]{0,400}disabled|disabled=\{[^}]*addAndMatchEnabled|!addAndMatchEnabled|!canSubmitAddAndMatch/,
  );
  assert.match(source, /addAndMatchEnabled|stageReached|canAddAndMatch|canEnableAddAndMatch/);
  assert.equal(canAddAndMatch("focused"), false);
  assert.equal(canAddAndMatch("add_and_match"), true);
  assert.equal(canAddAndMatch("default"), true);
});

test("safe match and no-safe-match presentations are both available", () => {
  const source = readFileSync(componentUrl, "utf8");
  assert.match(
    source,
    /existing-match-card|No safe existing match|no-safe-match/,
  );
  assert.match(source, /Conversion rule|conversion|normalization/);
  assert.match(source, /catalogCandidates|matchKind/);
});

test("safe-match presentation uses candidate presence without match-kind policy allowlist", () => {
  const source = readFileSync(componentUrl, "utf8");
  assert.doesNotMatch(
    source,
    /matchKind\s*===\s*["']exact["'][\s\S]{0,120}alias[\s\S]{0,120}conversion/,
  );
  assert.doesNotMatch(
    source,
    /matchKind\s*===\s*["']alias["'][\s\S]{0,80}approved_history/,
  );

  assert.equal(
    hasAuthoritativeCandidateMatch({
      catalogCandidates: [
        {
          catalogId: "std-1",
          description: "Concrete",
          unit: "m3",
          matchKind: "fuzzy",
          score: 40,
        },
      ],
    }),
    true,
  );
  assert.equal(
    hasAuthoritativeCandidateMatch({ catalogCandidates: [] }),
    false,
  );
});

test("Stage 2 catalog-pending presentation preserves Exclude wording", () => {
  const source = readFileSync(componentUrl, "utf8");
  assert.match(source, /Catalog pending|catalog-pending|catalogPending/);
  assert.match(source, /Create & link/);
  assert.match(source, /Find existing/);
  assert.match(source, />\s*Exclude\s*</);
  assert.match(source, /catalog-ready-form|Stage 2|Catalog Ready/);
});

test("detail actions are capability callbacks without embedded decision routes", () => {
  const source = readFileSync(componentUrl, "utf8");
  assert.match(source, /onAddAndMatch\?:/);
  assert.match(source, /onAddToBoq\?:/);
  assert.match(source, /onFindAnother\?:/);
  assert.match(source, /onDoNotAdd\?:/);
  assert.doesNotMatch(source, /\/actionable-review\/.*\/decision/);
  assert.doesNotMatch(source, /createActionableReviewClient/);
});

test("detail labels extracted, reviewer-confirmed, and normalized evidence distinctly", () => {
  const source = readFileSync(componentUrl, "utf8");
  assert.match(source, /Extracted/i);
  assert.match(source, /Reviewer-confirmed|Reviewer confirmed|reviewer-confirmed/i);
  assert.match(source, /Normalized/i);
  assert.match(source, /data-od-id="extracted-evidence"|Extracted evidence/);
  assert.match(source, /data-od-id="reviewer-confirmed-fields"|reviewer-confirmed/);
  assert.match(source, /data-od-id="normalized-evidence"|Normalized/);
  assert.match(source, /conversion rule|Conversion rule/i);
  assert.match(source, /catalogUnitsPerSourceUnit|factor|Factor/);
  assert.match(source, /scope|Scope|conversionScopeFromRuleId/);
  assert.match(source, /Source total|source total/i);
  assert.match(source, /authoritative|Authoritative|preserved/i);
});

test("historical pricing is advisory-only and never invented", () => {
  const source = readFileSync(componentUrl, "utf8");
  assert.match(source, /advisory|Advisory/);
  // Must not hardcode fabricated medians/prices.
  assert.doesNotMatch(source, /historicalMedian\s*[:=]\s*["']\d/);
  assert.doesNotMatch(source, /median\s*[:=]\s*["']฿?\d/);
  assert.match(
    source,
    /historicalAdvisory|historicalMedian|historicalPricing/,
  );
});

test("reviewer draft fields include description unit qty rates and correction reason", () => {
  const source = readFileSync(componentUrl, "utf8");
  assert.match(source, /correction reason|correctionReason|Correction reason/i);
  assert.match(source, /name=["']desc["']|reviewer.*description|draft\.description/i);
  assert.match(source, /name=["']unit["']|draft\.unit|raw unit/i);
  assert.match(source, /name=["']qty["']|draft\.quantity|quantity/i);
  assert.match(source, /materialRate|material rate|materialCost/i);
  assert.match(source, /labourRate|labour rate|labourCost/i);
});

test("draft helpers seed from extracted evidence and detect numeric divergence", () => {
  const extracted = baseExtracted();
  const draft = draftFromExtracted(extracted);
  assert.deepEqual(draft, {
    description: "Ready mix concrete",
    unit: "m3",
    quantity: "2",
    materialRate: "50",
    labourRate: "10",
    correctionReason: "",
  });
  assert.equal(requiresCorrectionReason(extracted, draft), false);
  const edited: ActionableReviewerDraft = {
    ...draft,
    quantity: "3",
  };
  assert.equal(requiresCorrectionReason(extracted, edited), true);
  const descOnly: ActionableReviewerDraft = {
    ...draft,
    description: "Corrected label",
  };
  assert.equal(requiresCorrectionReason(extracted, descOnly), false);
});

test("normalization alignment rejects candidate or rule mismatch and missing conversion snapshots", () => {
  const candidate = baseCandidate({ conversionRuleId: "rule-global-1" });
  assert.equal(
    isNormalizationAlignedWithCandidate(undefined, candidate),
    false,
  );
  assert.equal(
    isNormalizationAlignedWithCandidate(
      baseNormalization({ catalogId: "other", ruleId: "rule-global-1" }),
      candidate,
    ),
    false,
  );
  assert.equal(
    isNormalizationAlignedWithCandidate(
      baseNormalization({
        catalogId: "std-1",
        ruleId: "rule-other",
        catalogUnitsPerSourceUnit: "2",
      }),
      candidate,
    ),
    false,
  );
  assert.equal(
    isNormalizationAlignedWithCandidate(
      baseNormalization({
        catalogId: "std-1",
        ruleId: "rule-global-1",
        catalogUnitsPerSourceUnit: "2",
      }),
      candidate,
    ),
    true,
  );
  // Same-unit candidate without conversionRuleId may omit normalization (server identity).
  assert.equal(
    isNormalizationAlignedWithCandidate(undefined, baseCandidate()),
    true,
  );
  assert.equal(
    isNormalizationAlignedWithCandidate(
      baseNormalization({ ruleId: "identity:m3:v1" }),
      baseCandidate(),
    ),
    true,
  );
});

test("normalization total alignment fails closed for mismatched totals", () => {
  const extracted = baseExtracted();
  assert.equal(
    isNormalizationTotalAlignedWithExtracted(baseNormalization(), extracted),
    true,
  );
  assert.equal(
    isNormalizationTotalAlignedWithExtracted(
      baseNormalization({ normalizedTotal: "121" }),
      extracted,
    ),
    false,
  );
});

test("canEnableAddAndMatch gates stage, authority, alignment, and correction reason", () => {
  const extracted = baseExtracted();
  const draft = draftFromExtracted(extracted);
  const candidate = baseCandidate();
  const base = {
    rolloutStage: "add_and_match" as const,
    readOnly: false,
    busy: false,
    hasCandidate: true,
    candidate,
    normalization: baseNormalization(),
    extracted,
    draft,
  };
  assert.equal(canEnableAddAndMatch(base), true);
  assert.equal(canEnableAddAndMatch({ ...base, rolloutStage: "focused" }), false);
  assert.equal(canEnableAddAndMatch({ ...base, readOnly: true }), false);
  assert.equal(canEnableAddAndMatch({ ...base, busy: true }), false);
  assert.equal(canEnableAddAndMatch({ ...base, hasCandidate: false }), false);
  assert.equal(
    canEnableAddAndMatch({
      ...base,
      candidate: baseCandidate({ conversionRuleId: "rule-x" }),
      normalization: undefined,
    }),
    false,
  );
  assert.equal(
    canEnableAddAndMatch({
      ...base,
      draft: { ...draft, quantity: "9" },
    }),
    false,
  );
  assert.equal(
    canEnableAddAndMatch({
      ...base,
      draft: { ...draft, quantity: "9", correctionReason: "site measure" },
    }),
    true,
  );
  assert.equal(
    canEnableAddAndMatch({
      ...base,
      normalization: baseNormalization({ normalizedTotal: "121" }),
    }),
    false,
  );
});

test("add_and_match payload is bounded to editable fields plus server candidate ids", () => {
  const extracted = baseExtracted();
  const draft = draftFromExtracted(extracted);
  const candidate = baseCandidate({ conversionRuleId: "rule-1" });
  const payload = buildActionableAddAndMatchPayload({
    sectionIndex: 2,
    draft: { ...draft, description: "Corrected", quantity: "3", correctionReason: "adjusted qty" },
    candidate,
    normalization: baseNormalization({
      ruleId: "rule-1",
      catalogUnitsPerSourceUnit: "1",
      normalizedQuantity: "3",
    }),
  });
  assert.ok(payload);
  assert.equal(payload!.catalogId, "std-1");
  assert.equal(payload!.conversionRuleId, "rule-1");
  assert.deepEqual(payload!.item, {
    sectionIndex: 2,
    desc: "Corrected",
    unit: "m3",
    qty: 3,
    materialCost: 50,
    labourCost: 10,
  });
  assert.equal(payload!.correctionReason, "adjusted qty");
  assert.equal("normalizedTotal" in payload!, false);
  assert.equal("factor" in payload!, false);
  assert.equal("catalogUnitsPerSourceUnit" in payload!, false);

  const sameUnit = buildActionableAddAndMatchPayload({
    sectionIndex: 0,
    draft,
    candidate: baseCandidate(),
    normalization: baseNormalization(),
  });
  assert.ok(sameUnit);
  assert.equal("conversionRuleId" in sameUnit!, false);
});

test("add to BOQ payload uses the same bounded local fields", () => {
  const draft = draftFromExtracted(baseExtracted());
  const payload = buildActionableAddToBoqPayload({
    sectionIndex: 1,
    draft: { ...draft, description: "No match item" },
  });
  assert.deepEqual(payload, {
    item: {
      sectionIndex: 1,
      desc: "No match item",
      unit: "m3",
      qty: 2,
      materialCost: 50,
      labourCost: 10,
    },
  });
});

test("conversion scope is derived from rule id when available", () => {
  assert.equal(conversionScopeFromRuleId("identity:m3:v1"), "identity");
  assert.equal(conversionScopeFromRuleId("rule-global-ft-m"), null);
  assert.equal(conversionScopeFromRuleId(undefined), null);
});

test("no-safe-match offers Add to BOQ not catalog creation", () => {
  const source = readFileSync(componentUrl, "utf8");
  assert.match(source, /no-safe-match-card/);
  assert.match(source, /Add to BOQ/);
  // Catalog creation verbs must not appear in the no-safe-match extraction path.
  const noSafeStart = source.indexOf('data-od-id="no-safe-match-card"');
  assert.ok(noSafeStart >= 0);
  const slice = source.slice(noSafeStart, noSafeStart + 1800);
  assert.doesNotMatch(slice, /Create & link|Create new catalog|Add new catalog/);
});

test("numeric edits mark the normalized preview as stale until the server recomputes it", () => {
  const source = readFileSync(componentUrl, "utf8");
  assert.match(source, /normalized preview|recompute|based on extracted/i);
});

test("failed submit path preserves local reviewer draft state", () => {
  const source = readFileSync(componentUrl, "utf8");
  // Draft state is keyed by suggestion id and only re-seeded on id change.
  assert.match(source, /draftBySuggestionId|seedDraft|useState/);
  assert.match(source, /suggestion\.id|suggestionId/);
  assert.doesNotMatch(
    source,
    /useEffect\([\s\S]{0,200}setDraft\([\s\S]{0,80}extractedItem/,
  );
});
