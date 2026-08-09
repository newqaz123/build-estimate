import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";

import { hasAuthoritativeCandidateMatch } from "./actionable-review-detail";

const componentUrl = new URL("./actionable-review-detail.tsx", import.meta.url);

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
    /Add & match[\s\S]{0,400}disabled|disabled=\{[^}]*addAndMatchEnabled|!addAndMatchEnabled/,
  );
  assert.match(source, /addAndMatchEnabled|stageReached|canAddAndMatch/);
});

test("safe match and no-safe-match presentations are both available", () => {
  const source = readFileSync(componentUrl, "utf8");
  assert.match(source, /existing-match-card|No safe existing match|no-safe-match/);
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
