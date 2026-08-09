"use client";

import { useMemo, useState } from "react";

import {
  ActionableReviewDetail,
  type ActionableReviewDetailStage,
} from "@/components/actionable-review-detail";
import { ActionableReviewAuditDrawer } from "@/components/actionable-review-audit-drawer";
import type {
  ActionableItemSuggestion,
  ActionableReview,
} from "@/lib/actionable-review-projection";
import { normalizeActionableReviewResponse } from "@/lib/actionable-review-state";
import type { ActionableReviewStage } from "@/lib/settings-schema";

/** Re-export for callers that normalize before passing snapshot props. */
export { normalizeActionableReviewResponse };

export type ActionableMobilePane = "queue" | "evidence" | "detail";

export interface ActionableExtractionReviewCallbacks {
  onAddAndMatch?: (suggestionId: string) => void;
  onAddToBoq?: (suggestionId: string) => void;
  onFindAnother?: (suggestionId: string) => void;
  onDoNotAdd?: (suggestionId: string) => void;
  onCreateAndLink?: (suggestionId: string) => void;
  onFindExisting?: (suggestionId: string) => void;
  onExclude?: (suggestionId: string) => void;
  onRestore?: (suggestionId: string) => void;
}

export interface ActionableExtractionReviewProps {
  snapshot: ActionableReview | null;
  rolloutStage: ActionableReviewStage;
  readOnly?: boolean;
  loading?: boolean;
  error?: string | null;
  selectedSuggestionId?: string | null;
  auditOpen?: boolean;
  sectionLabels?: readonly string[];
  onSelectSuggestion?: (suggestionId: string | null) => void;
  onToggleAudit?: () => void;
  onNavigateToEvidence?: (focus: {
    page: number;
    table: number;
    row: number;
  }) => void;
  callbacks?: ActionableExtractionReviewCallbacks;
}

function statusLabel(
  suggestion: ActionableItemSuggestion,
  detailStage: ActionableReviewDetailStage,
): string {
  if (detailStage === "catalog") return "Catalog pending";
  if (suggestion.status === "dismissed") return "Dismissed";
  if (suggestion.status === "pending") {
    return suggestion.catalogCandidates.length > 0
      ? "Review match"
      : "No safe match";
  }
  if (suggestion.status === "added_pending_catalog") return "Catalog pending";
  if (suggestion.status === "added_matched") return "Existing match";
  return "Resolved";
}

export function ActionableExtractionReview({
  snapshot,
  rolloutStage,
  readOnly = false,
  loading = false,
  error = null,
  selectedSuggestionId: selectedSuggestionIdProp = null,
  auditOpen: auditOpenProp,
  sectionLabels = [],
  onSelectSuggestion,
  onToggleAudit,
  onNavigateToEvidence,
  callbacks = {},
}: ActionableExtractionReviewProps) {
  const [detailStage, setDetailStage] =
    useState<ActionableReviewDetailStage>("extract");
  const [mobilePane, setMobilePane] = useState<ActionableMobilePane>("queue");
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(
    selectedSuggestionIdProp,
  );
  const [internalAuditOpen, setInternalAuditOpen] = useState(false);

  const selectedSuggestionId =
    selectedSuggestionIdProp !== undefined && onSelectSuggestion
      ? selectedSuggestionIdProp
      : internalSelectedId;
  const auditOpen =
    typeof auditOpenProp === "boolean" && onToggleAudit
      ? auditOpenProp
      : internalAuditOpen;

  const suggestions = useMemo(
    () => snapshot?.actionableItemSuggestions ?? [],
    [snapshot],
  );
  const validation = snapshot?.validationSummary;

  const actionableQueue = useMemo(
    () => suggestions.filter((suggestion) => suggestion.status === "pending"),
    [suggestions],
  );

  const catalogPending = useMemo(
    () =>
      suggestions.filter(
        (suggestion) => suggestion.status === "added_pending_catalog",
      ),
    [suggestions],
  );

  const verifiedCount = useMemo(
    () =>
      suggestions.filter((suggestion) => suggestion.status === "added_matched")
        .length,
    [suggestions],
  );
  const preparedCount =
    validation?.locallyPreparedCatalogCount ?? catalogPending.length;
  const actionableCount = validation?.actionableCount ?? actionableQueue.length;
  const dismissedCount =
    validation?.dismissedCount ??
    suggestions.filter((suggestion) => suggestion.status === "dismissed")
      .length;
  const sourceDifference = validation?.sourceTotalDifference ?? "—";

  const queueItems =
    detailStage === "catalog" ? catalogPending : actionableQueue;

  const selected =
    queueItems.find((item) => item.id === selectedSuggestionId) ??
    queueItems[0] ??
    null;

  const blockingCount = actionableQueue.length + catalogPending.length;
  const extractionBlocking = actionableQueue.length;

  const selectSuggestion = (id: string) => {
    if (onSelectSuggestion) onSelectSuggestion(id);
    else setInternalSelectedId(id);
    const next = queueItems.find((item) => item.id === id) ?? null;
    const ref = next?.sourceRefs[0];
    if (ref) {
      onNavigateToEvidence?.({
        page: ref.page,
        table: ref.table,
        row: ref.row,
      });
    }
    setMobilePane("detail");
  };

  const toggleAudit = () => {
    if (onToggleAudit) onToggleAudit();
    else setInternalAuditOpen((open) => !open);
  };

  const evidenceRows = selected?.sourceRefs ?? [];

  return (
    <div
      className="actionable-review-workspace"
      data-od-id="actionable-extraction-review"
      aria-labelledby="actionable-review-heading"
    >
      <section
        className="actionable-status-strip"
        data-od-id="boq-status"
        aria-live="polite"
      >
        <span className="actionable-status-copy">
          {loading
            ? "Loading actionable review…"
            : `${verifiedCount + dismissedCount} of ${suggestions.length} extraction decisions resolved`}
        </span>
        <div
          className="actionable-progress-track"
          role="progressbar"
          aria-label="Extraction review completion"
          aria-valuemin={0}
          aria-valuemax={Math.max(suggestions.length, 1)}
          aria-valuenow={verifiedCount + dismissedCount}
        >
          <div
            className="actionable-progress-fill"
            style={{
              width: `${
                suggestions.length
                  ? ((verifiedCount + dismissedCount) / suggestions.length) *
                    100
                  : 0
              }%`,
            }}
          />
        </div>
        <span
          className={
            blockingCount > 0
              ? "actionable-blocked-badge"
              : "actionable-ready-badge"
          }
        >
          {blockingCount > 0
            ? `${blockingCount} blocking approval`
            : "Ready to approve"}
        </span>
        <span className="actionable-status-note">
          Resolve extraction first, then catalog readiness.
        </span>
      </section>

      <section
        className="actionable-review-summary"
        data-od-id="review-status-summary"
        aria-label="Review status summary"
      >
        <div className="actionable-summary-item">
          <span>Verified</span>
          <strong data-od-id="summary-verified">{verifiedCount}</strong>
        </div>
        <div className="actionable-summary-item">
          <span>Prepared</span>
          <strong data-od-id="summary-prepared">{preparedCount}</strong>
        </div>
        <div className="actionable-summary-item">
          <span>Actionable</span>
          <strong data-od-id="summary-actionable">{actionableCount}</strong>
        </div>
        <div className="actionable-summary-item">
          <span>Dismissed</span>
          <strong data-od-id="summary-dismissed">{dismissedCount}</strong>
        </div>
        <div className="actionable-summary-item">
          <span>Source difference</span>
          <strong data-od-id="summary-difference">
            {sourceDifference === "—" ? "—" : `฿${sourceDifference}`}
          </strong>
        </div>
      </section>

      <div className="actionable-toolbar">
        <button
          type="button"
          className="btn btn-secondary btn-sm actionable-audit-btn"
          onClick={toggleAudit}
          aria-haspopup="dialog"
          data-od-id="audit-open"
        >
          Audit
          <span className="actionable-audit-count">
            {(snapshot?.dismissedEvidence.length ?? 0) +
              (snapshot?.representedRows.length ?? 0)}
          </span>
        </button>
      </div>

      {error ? (
        <div className="actionable-error" role="alert">
          {error}
        </div>
      ) : null}

      <div
        className="actionable-stage-tabs"
        role="tablist"
        aria-label="BOQ review stages"
        data-od-id="review-stage-tabs"
      >
        <button
          type="button"
          className="actionable-stage-tab"
          role="tab"
          aria-selected={detailStage === "extract"}
          data-stage="extract"
          onClick={() => {
            setDetailStage("extract");
            setMobilePane("queue");
          }}
        >
          1 · Extract & Verify
          <span className="actionable-stage-count">{extractionBlocking}</span>
        </button>
        <button
          type="button"
          className="actionable-stage-tab"
          role="tab"
          aria-selected={detailStage === "catalog"}
          data-stage="catalog"
          onClick={() => {
            setDetailStage("catalog");
            setMobilePane("queue");
          }}
        >
          2 · Catalog Ready
          <span className="actionable-stage-count">
            {catalogPending.length}
          </span>
        </button>
      </div>

      <div
        className="actionable-mobile-nav"
        data-od-id="mobile-drill-nav"
        aria-label="Mobile review drill-down"
      >
        <button
          type="button"
          className={mobilePane === "queue" ? "is-active" : undefined}
          aria-pressed={mobilePane === "queue"}
          onClick={() => setMobilePane("queue")}
        >
          Queue
        </button>
        <button
          type="button"
          className={mobilePane === "evidence" ? "is-active" : undefined}
          aria-pressed={mobilePane === "evidence"}
          onClick={() => setMobilePane("evidence")}
        >
          Evidence
        </button>
        <button
          type="button"
          className={mobilePane === "detail" ? "is-active" : undefined}
          aria-pressed={mobilePane === "detail"}
          onClick={() => setMobilePane("detail")}
        >
          Detail
        </button>
      </div>

      <div
        className={`actionable-split-workspace mobile-pane-${mobilePane}`}
        data-od-id="split-workspace"
      >
        <section
          className="actionable-evidence-panel"
          data-od-id="source-evidence"
          aria-labelledby="actionable-evidence-heading"
        >
          <div className="actionable-panel-header">
            <div>
              <p className="actionable-eyebrow">Source of truth</p>
              <h2 id="actionable-evidence-heading">Quotation evidence</h2>
            </div>
          </div>
          <div className="actionable-evidence-body" id="evidence-body">
            {evidenceRows.length === 0 ? (
              <p className="actionable-evidence-caption">
                Select a queue item to highlight its source page, table, and
                row.
              </p>
            ) : (
              <div className="actionable-source-card">
                <table className="actionable-source-table">
                  <thead>
                    <tr>
                      <th>Page</th>
                      <th>Table</th>
                      <th>Row</th>
                      <th>Highlight</th>
                    </tr>
                  </thead>
                  <tbody>
                    {evidenceRows.map((ref, index) => {
                      const isSelected = index === 0;
                      return (
                        <tr
                          key={`${ref.page}-${ref.table}-${ref.row}-${index}`}
                          className={
                            isSelected
                              ? "actionable-source-row is-active"
                              : "actionable-source-row"
                          }
                          data-source-page={ref.page}
                          data-source-table={ref.table}
                          data-source-row={ref.row}
                          data-od-id={`evidence-row-${ref.page}-${ref.table}-${ref.row}`}
                        >
                          <td className="actionable-mono">{ref.page}</td>
                          <td className="actionable-mono">{ref.table}</td>
                          <td className="actionable-mono">{ref.row}</td>
                          <td>
                            <button
                              type="button"
                              className="actionable-row-select"
                              aria-pressed={isSelected}
                              onClick={() => {
                                onNavigateToEvidence?.({
                                  page: ref.page,
                                  table: ref.table,
                                  row: ref.row,
                                });
                                setMobilePane("detail");
                              }}
                            >
                              {isSelected ? "Selected" : "Show"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="actionable-evidence-caption">
                  The highlighted source row follows your queue selection.
                  Values shown here are preserved from the contractor quotation.
                </p>
              </div>
            )}
          </div>
        </section>

        <section
          className="actionable-decision-workspace"
          data-od-id="decision-workspace"
          aria-labelledby="actionable-review-heading"
        >
          <aside className="actionable-queue" data-od-id="review-queue">
            <div className="actionable-queue-head">
              <h2 id="actionable-review-heading">Review queue</h2>
              <p>
                {detailStage === "catalog"
                  ? "Only Catalog pending items appear here"
                  : "Resolve extraction suggestions first"}
              </p>
            </div>
            <div className="actionable-queue-list">
              {queueItems.length === 0 ? (
                <p className="actionable-evidence-caption">
                  {detailStage === "catalog"
                    ? "No Catalog pending items."
                    : "No actionable suggestions."}
                </p>
              ) : (
                queueItems.map((item) => {
                  const isSelected = item.id === selected?.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={
                        isSelected
                          ? "actionable-queue-item selected"
                          : "actionable-queue-item"
                      }
                      aria-pressed={isSelected}
                      data-od-id={`queue-item-${item.id}`}
                      onClick={() => selectSuggestion(item.id)}
                    >
                      <span className="actionable-queue-state" aria-hidden="true" />
                      <span>
                        <strong>
                          {item.extractedItem.description || "Untitled item"}
                        </strong>
                        <span className="actionable-queue-meta">
                          <span>
                            row{" "}
                            {item.sourceRefs[0]
                              ? `${item.sourceRefs[0].page}.${item.sourceRefs[0].row}`
                              : "—"}
                          </span>
                          <span>{statusLabel(item, detailStage)}</span>
                        </span>
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          <ActionableReviewDetail
            suggestion={selected}
            detailStage={detailStage}
            rolloutStage={rolloutStage}
            readOnly={readOnly}
            sectionLabel={
              selected
                ? sectionLabels[selected.suggestedSectionIndex]
                : undefined
            }
            onAddAndMatch={callbacks.onAddAndMatch}
            onAddToBoq={callbacks.onAddToBoq}
            onFindAnother={callbacks.onFindAnother}
            onDoNotAdd={callbacks.onDoNotAdd}
            onCreateAndLink={callbacks.onCreateAndLink}
            onFindExisting={callbacks.onFindExisting}
            onExclude={callbacks.onExclude}
            onOpenAudit={toggleAudit}
            onGoCatalog={() => {
              setDetailStage("catalog");
              setMobilePane("detail");
            }}
            onGoExtract={() => {
              setDetailStage("extract");
              setMobilePane("queue");
            }}
          />
        </section>
      </div>

      <ActionableReviewAuditDrawer
        open={auditOpen}
        readOnly={readOnly}
        dismissedEvidence={snapshot?.dismissedEvidence ?? []}
        representedRows={snapshot?.representedRows ?? []}
        onClose={toggleAudit}
        onRestore={callbacks.onRestore}
        restorableSuggestionIds={suggestions
          .filter((item) => item.status === "dismissed")
          .map((item) => item.id)}
      />
    </div>
  );
}
