"use client";

import type { RepresentedRowFinding } from "@/lib/boq-represented-row-reconciliation";
import type { RowRoleFinding } from "@/lib/boq-row-role-classifier";

export interface DismissedRestoreSuggestionRef {
  id: string;
  sourceRowIds: readonly string[];
  status: string;
}

export interface ActionableReviewAuditDrawerProps {
  open: boolean;
  readOnly?: boolean;
  dismissedEvidence: readonly RowRoleFinding[];
  representedRows: readonly RepresentedRowFinding[];
  onClose: () => void;
  onRestore?: (suggestionId: string) => void;
  /**
   * Maps dismissed evidence source-row ids to opaque suggestion ids.
   * Restore must call the suggestion digest id, not the source row id.
   */
  restorableSuggestionIdBySourceRowId?: ReadonlyMap<string, string>;
}

export function buildDismissedSuggestionIdBySourceRowId(
  suggestions: readonly DismissedRestoreSuggestionRef[],
): ReadonlyMap<string, string> {
  const mapping = new Map<string, string>();
  for (const suggestion of suggestions) {
    if (suggestion.status !== "dismissed") continue;
    for (const sourceRowId of suggestion.sourceRowIds) {
      if (!mapping.has(sourceRowId)) {
        mapping.set(sourceRowId, suggestion.id);
      }
    }
  }
  return mapping;
}

export function resolveDismissedRestoreSuggestionId(
  sourceRowId: string,
  restorableSuggestionIdBySourceRowId: ReadonlyMap<string, string>,
): string | null {
  return restorableSuggestionIdBySourceRowId.get(sourceRowId) ?? null;
}

function sourceRefLabel(ref: { page: number; table: number; row: number }): string {
  return `p.${ref.page} · t${ref.table} · r${ref.row}`;
}

export function ActionableReviewAuditDrawer({
  open,
  readOnly = false,
  dismissedEvidence,
  representedRows,
  onClose,
  onRestore,
  restorableSuggestionIdBySourceRowId = new Map(),
}: ActionableReviewAuditDrawerProps) {
  if (!open) return null;

  const canRestore = !readOnly && typeof onRestore === "function";

  return (
    <div
      className="actionable-audit-backdrop"
      role="presentation"
      onClick={onClose}
      data-od-id="audit-backdrop"
    >
      <aside
        className="actionable-audit-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="actionable-audit-title"
        data-od-id="audit-drawer"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="actionable-audit-head">
          <div>
            <p className="actionable-eyebrow">Reversible decisions</p>
            <h2 id="actionable-audit-title">Audit history</h2>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            aria-label="Close audit history"
          >
            Close
          </button>
        </div>

        <div className="actionable-audit-list" data-od-id="audit-list">
          {dismissedEvidence.length === 0 && representedRows.length === 0 ? (
            <p className="actionable-evidence-caption">
              No dismissed or represented evidence yet.
            </p>
          ) : null}

          {dismissedEvidence.map((entry) => {
            const restoreId = resolveDismissedRestoreSuggestionId(
              entry.sourceRowId,
              restorableSuggestionIdBySourceRowId,
            );
            const showRestore = canRestore && restoreId !== null;
            return (
              <article
                key={`dismissed-${entry.sourceRowId}`}
                className="actionable-audit-entry"
                data-od-id={`audit-dismissed-${entry.sourceRowId}`}
              >
                {showRestore ? (
                  <button
                    type="button"
                    className="actionable-restore-btn"
                    disabled={readOnly}
                    onClick={() => {
                      if (restoreId) onRestore?.(restoreId);
                    }}
                  >
                    Restore
                  </button>
                ) : null}
                <strong>Dismissed · {entry.role}</strong>
                <p>
                  {entry.reasonCodes.join(", ") || "Non-actionable source row"} ·{" "}
                  {sourceRefLabel(entry.sourceRef)}
                </p>
              </article>
            );
          })}

          {representedRows.map((entry) => (
            <article
              key={`represented-${entry.boqItemId}-${entry.sourceRowIds.join("-")}`}
              className="actionable-audit-entry"
              data-od-id={`audit-represented-${entry.boqItemId}`}
            >
              <strong>Represented · {entry.reason}</strong>
              <p>
                Already on BOQ item {entry.boqItemId}
                {entry.sourceRefs[0]
                  ? ` · ${sourceRefLabel(entry.sourceRefs[0])}`
                  : ""}
              </p>
            </article>
          ))}
        </div>
      </aside>
    </div>
  );
}
