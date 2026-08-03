import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { BoqWorkspaceTabs } from "./boq-workspace-tabs";

test("workspace tabs expose accessible review/compare tab semantics", () => {
  const html = renderToStaticMarkup(
    createElement(BoqWorkspaceTabs, {
      view: "review",
      reviewIssueCount: 3,
      unmatchedCount: 5,
      onViewChange: () => undefined,
    }),
  );

  assert.match(html, /role="tablist"/);
  assert.match(html, /role="tab"/);
  assert.match(html, /aria-selected="true"/);
  assert.match(html, /aria-controls="boq-review-panel"/);
  assert.match(html, /Review Extraction/);
  assert.match(html, /Compare Catalog/);
  assert.match(html, />3</);
  assert.match(html, />5</);
  assert.doesNotMatch(html, /Parse.*Review.*Compare.*Finalize/);
});

test("compare tab is selected when view is compare", () => {
  const html = renderToStaticMarkup(
    createElement(BoqWorkspaceTabs, {
      view: "compare",
      reviewIssueCount: 0,
      unmatchedCount: 2,
      onViewChange: () => undefined,
    }),
  );

  assert.match(html, /aria-selected="true"[^>]*id="boq-compare-tab"/);
  assert.match(html, /aria-controls="boq-compare-panel"/);
  assert.doesNotMatch(html, /aria-selected="true"[^>]*id="boq-review-tab"/);
  assert.doesNotMatch(html, />0</);
});
