import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Boq } from "@/lib/boq-schema";
import type {
  BoqCatalogComparisonRow,
  ComponentComparison,
} from "@/lib/boq-catalog-comparison";

import {
  BoqCatalogComparisonPanel,
  type BoqComparisonPanelState,
} from "./boq-catalog-comparison-panel";

function component(
  overrides: Partial<ComponentComparison> = {},
): ComponentComparison {
  return {
    present: true,
    unit: "Pcs",
    qty: 8,
    rate: 2808,
    total: 22464,
    basis: "native",
    benchmark: {
      unit: "pcs",
      count: 14,
      min: 2600,
      average: 2750,
      max: 2950,
    },
    variancePct: ((2808 - 2750) / 2750) * 100,
    ...overrides,
  };
}

function row(
  overrides: Partial<BoqCatalogComparisonRow> = {},
): BoqCatalogComparisonRow {
  return {
    key: "0-item",
    sectionIndex: 0,
    section: "E&M",
    item: {
      id: "item",
      desc: "STUB-END 6B BS4",
      unit: "Lot",
      qty: 1,
      rate: 36864,
      total: 36864,
      type: "unit",
      stdStatus: "matched",
      stdId: "std-1",
    },
    identity: { itemId: "item" },
    candidate: {
      standardId: "std-1",
      description: "STUB-END 6B BS4",
      unit: "Lot",
      score: 2000,
      matchReason: "linked",
    },
    benchmark: null,
    variancePct: null,
    components: {
      material: component(),
      labour: component({
        unit: "Db",
        qty: 48,
        rate: 300,
        total: 14400,
        benchmark: {
          unit: "db",
          count: 11,
          min: 270,
          average: 285,
          max: 310,
        },
        variancePct: ((300 - 285) / 285) * 100,
      }),
    },
    ...overrides,
  };
}

function boq(overrides: Partial<Boq> = {}): Boq {
  return {
    id: "boq-1",
    project: "ON-OFF VALVE INSTALLATION WORK (BDN)",
    vendor: "EASTERN GROUP (E.T.G.)",
    workType: "MEP",
    date: "2026-08-03",
    totalItems: 1,
    grandTotal: 36864,
    status: "draft",
    stdStatus: "partial",
    sections: [],
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
    ...overrides,
  };
}

function renderPanel(props: {
  boq?: Boq;
  state: BoqComparisonPanelState;
  hasUnsavedChanges?: boolean;
}): string {
  return renderToStaticMarkup(
    createElement(BoqCatalogComparisonPanel, {
      boq: props.boq ?? boq(),
      state: props.state,
      hasUnsavedChanges: props.hasUnsavedChanges ?? false,
      onRetry: () => undefined,
      onOpenReview: () => undefined,
    }),
  );
}

test("comparison panel presents provisional, finalized, stale, and error states", () => {
  const loaded: BoqComparisonPanelState = {
    status: "loaded",
    rows: [row()],
  };

  const draftHtml = renderPanel({ state: loaded, boq: boq({ status: "draft" }) });
  const approvedHtml = renderPanel({
    state: loaded,
    boq: boq({ status: "approved" }),
  });
  const staleHtml = renderPanel({
    state: loaded,
    boq: boq({ status: "draft" }),
    hasUnsavedChanges: true,
  });
  const errorHtml = renderPanel({
    state: {
      status: "error",
      rows: [],
      message: "Network failed",
    },
  });
  const loadingHtml = renderPanel({
    state: { status: "loading", rows: [] },
  });

  assert.match(draftHtml, /Provisional/);
  assert.match(draftHtml, /read-only/);
  assert.match(approvedHtml, /Finalized/);
  assert.match(approvedHtml, /read-only/);
  assert.match(staleHtml, /Save draft to refresh this comparison/);
  assert.match(errorHtml, /Retry comparison/);
  assert.match(errorHtml, /Network failed/);
  assert.match(loadingHtml, /Loading comparison/);
  assert.match(draftHtml, /Open Review Extraction/);
  assert.match(draftHtml, /STUB-END 6B BS4/);
  assert.match(draftHtml, /Material vs catalog/);
  assert.doesNotMatch(draftHtml, /Match|Create|Exclude|Dismiss|AI/);
  assert.doesNotMatch(draftHtml, /Parse.*Review.*Compare.*Finalize/);
});

test("comparison panel does not own workspace tabpanel id or role", () => {
  const html = renderPanel({
    state: { status: "loaded", rows: [row()] },
  });

  assert.match(html, /class="boq-catalog-comparison-panel"/);
  assert.match(html, /data-od-id="boq-catalog-comparison-panel"/);
  assert.doesNotMatch(html, /\sid="boq-compare-panel"/);
  assert.doesNotMatch(html, /\srole="tabpanel"/);
  assert.doesNotMatch(html, /aria-labelledby="boq-compare-tab"/);
});

test("loaded empty comparison shows actionable guidance instead of zero metrics", () => {
  const html = renderPanel({
    state: { status: "loaded", rows: [] },
  });

  assert.match(html, /data-od-id="boq-compare-empty"/);
  assert.match(html, /saved parsed priced items/i);
  assert.match(html, /Open Review Extraction/);
  assert.doesNotMatch(html, /data-od-id="boq-compare-summary"/);
  assert.doesNotMatch(html, /data-od-id="compare-component-table"/);
  assert.doesNotMatch(html, /0 \/ 0/);
});

test("error state with retained rows keeps retry alert plus previous summary and table", () => {
  const html = renderPanel({
    state: {
      status: "error",
      rows: [row()],
      message: "Network failed",
    },
  });

  assert.match(html, /data-od-id="boq-compare-error"/);
  assert.match(html, /Retry comparison/);
  assert.match(html, /Network failed/);
  assert.match(html, /data-od-id="boq-compare-summary"/);
  assert.match(html, /Material vs catalog/);
  assert.match(html, /STUB-END 6B BS4/);
});
