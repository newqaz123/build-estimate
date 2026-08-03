import type { ReactNode } from "react";

import type { BoqCatalogComparisonRow } from "@/lib/boq-catalog-comparison";
import type { Boq } from "@/lib/boq-schema";

import {
  BoqCatalogComponentTable,
  summarizeComponentComparison,
} from "./boq-catalog-component-table";

export type BoqComparisonPanelState =
  | { status: "idle" | "loading"; rows: BoqCatalogComparisonRow[] }
  | { status: "loaded"; rows: BoqCatalogComparisonRow[] }
  | { status: "error"; rows: BoqCatalogComparisonRow[]; message: string };

export interface BoqCatalogComparisonPanelProps {
  boq: Boq;
  state: BoqComparisonPanelState;
  hasUnsavedChanges: boolean;
  onRetry: () => void;
  onOpenReview: () => void;
}

function formatVariance(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (Math.abs(value) < 0.05) return "At average";
  const sign = value > 0 ? "+" : "−";
  return `${sign}${Math.abs(value).toFixed(1)}%`;
}

function currency(value: number): string {
  return `฿${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function statusBanner(boq: Boq): ReactNode {
  if (boq.status === "approved") {
    return (
      <div
        className="boq-compare-banner boq-compare-banner-finalized"
        data-od-id="boq-compare-finalized-banner"
      >
        <span className="badge badge-approved">Finalized · read-only</span>
        <span>Approved comparison rates are locked for this BOQ.</span>
      </div>
    );
  }

  return (
    <div
      className="boq-compare-banner boq-compare-banner-provisional"
      data-od-id="boq-compare-provisional-banner"
    >
      <span className="badge badge-review">Provisional · read-only</span>
      <span>
        Available immediately after parsing. Save draft to refresh rates after
        review edits.
      </span>
    </div>
  );
}

export function BoqCatalogComparisonPanel({
  boq,
  state,
  hasUnsavedChanges,
  onRetry,
  onOpenReview,
}: BoqCatalogComparisonPanelProps): ReactNode {
  const rows = state.rows;
  const summary = summarizeComponentComparison(rows, boq.grandTotal);
  const isLoading = state.status === "loading" || state.status === "idle";
  const isError = state.status === "error";
  const showTable = state.status === "loaded" || rows.length > 0;

  return (
    <section
      className="boq-catalog-comparison-panel"
      data-od-id="boq-catalog-comparison-panel"
      id="boq-compare-panel"
      role="tabpanel"
      aria-labelledby="boq-compare-tab"
    >
      <div className="boq-compare-panel-head">
        <div className="boq-compare-panel-title">
          <h2>Catalog comparison</h2>
          <p className="boq-compare-panel-subtitle">
            Read-only material and labour rates against the catalog baseline.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={onOpenReview}
          data-od-id="boq-compare-open-review"
        >
          Open Review Extraction
        </button>
      </div>

      {statusBanner(boq)}

      {hasUnsavedChanges ? (
        <div
          className="boq-compare-banner boq-compare-banner-stale"
          role="status"
          data-od-id="boq-compare-stale-banner"
        >
          Save draft to refresh this comparison
        </div>
      ) : null}

      {isLoading ? (
        <div
          className="proto-loading-state boq-compare-state"
          role="status"
          data-od-id="boq-compare-loading"
        >
          <span className="proto-spinner" aria-hidden="true" /> Loading
          comparison…
        </div>
      ) : null}

      {isError ? (
        <div
          className="proto-empty-state proto-error-state boq-compare-state"
          role="alert"
          data-od-id="boq-compare-error"
        >
          <h3>Couldn&apos;t load this comparison</h3>
          <p>{state.message}</p>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onRetry}
            data-od-id="boq-compare-retry"
          >
            Retry comparison
          </button>
        </div>
      ) : null}

      {state.status === "loaded" || (showTable && !isLoading && !isError) ? (
        <div
          className="boq-compare-summary"
          data-od-id="boq-compare-summary"
        >
          <div className="boq-compare-stat">
            <b className="num">{formatVariance(summary.materialVariancePct)}</b>
            <small>Material vs catalog</small>
          </div>
          <div className="boq-compare-stat">
            <b className="num">{formatVariance(summary.labourVariancePct)}</b>
            <small>Labour vs catalog</small>
          </div>
          <div className="boq-compare-stat">
            <b className="num">
              {summary.componentLines} / {summary.totalLines}
            </b>
            <small>Component split</small>
          </div>
          <div className="boq-compare-stat">
            <b className="num">{currency(summary.boqTotal)}</b>
            <small>BOQ total</small>
          </div>
        </div>
      ) : null}

      {showTable && !isLoading ? (
        <BoqCatalogComponentTable rows={rows} />
      ) : null}
    </section>
  );
}
