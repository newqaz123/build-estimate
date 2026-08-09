import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";

import {
  buildDismissedSuggestionIdBySourceRowId,
  resolveDismissedRestoreSuggestionId,
} from "./actionable-review-audit-drawer";

const componentUrl = new URL(
  "./actionable-review-audit-drawer.tsx",
  import.meta.url,
);

test("audit drawer component exists", () => {
  assert.equal(existsSync(componentUrl), true);
});

test("audit drawer surfaces dismissed and represented evidence only", () => {
  const source = readFileSync(componentUrl, "utf8");
  assert.match(source, /data-od-id="audit-drawer"/);
  assert.match(source, /Audit history/);
  assert.match(source, /dismissedEvidence/);
  assert.match(source, /representedRows/);
  assert.match(source, /Dismissed/);
  assert.match(source, /Represented/);
  assert.doesNotMatch(source, /actionableItemSuggestions\.map/);
});

test("restore is hidden in approved or read-only mode", () => {
  const source = readFileSync(componentUrl, "utf8");
  assert.match(source, /readOnly/);
  assert.match(source, /Restore/);
  assert.match(
    source,
    /!readOnly[\s\S]{0,120}onRestore|onRestore[\s\S]{0,120}!readOnly|readOnly\s*\?\s*null[\s\S]{0,80}Restore|!readOnly\s*&&[\s\S]{0,200}Restore/,
  );
  assert.match(source, /disabled=\{[^}]*readOnly|readOnly\s*\|\|/);
});

test("audit drawer accepts restore as a capability callback", () => {
  const source = readFileSync(componentUrl, "utf8");
  assert.match(source, /onRestore\?:/);
  assert.match(source, /onClose/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
});

test("restore resolves opaque suggestion ids from source-row mapping", () => {
  const source = readFileSync(componentUrl, "utf8");
  assert.match(
    source,
    /restorableSuggestionIdBySourceRowId|suggestionIdBySourceRowId|sourceRowToSuggestion/,
  );
  assert.doesNotMatch(
    source,
    /const restoreId = entry\.sourceRowId/,
  );

  const mapping = buildDismissedSuggestionIdBySourceRowId([
    {
      id: "sug-digest-1",
      sourceRowIds: ["row-a", "row-b"],
      status: "dismissed",
    },
    {
      id: "sug-pending",
      sourceRowIds: ["row-c"],
      status: "pending",
    },
  ]);

  assert.equal(mapping.get("row-a"), "sug-digest-1");
  assert.equal(mapping.get("row-b"), "sug-digest-1");
  assert.equal(mapping.has("row-c"), false);
  assert.equal(
    resolveDismissedRestoreSuggestionId("row-a", mapping),
    "sug-digest-1",
  );
  assert.equal(resolveDismissedRestoreSuggestionId("row-c", mapping), null);
});
