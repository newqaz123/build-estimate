import type { BoqWorkspaceView } from "@/lib/boq-review-route";

export function BoqWorkspaceTabs({
  view,
  reviewIssueCount,
  unmatchedCount,
  onViewChange,
}: {
  view: BoqWorkspaceView;
  reviewIssueCount: number;
  unmatchedCount: number;
  onViewChange: (view: BoqWorkspaceView) => void;
}) {
  return (
    <div
      className="boq-workspace-tabs"
      role="tablist"
      aria-label="BOQ workspace view"
      data-od-id="boq-workspace-tabs"
    >
      <button
        type="button"
        role="tab"
        aria-selected={view === "review"}
        aria-controls="boq-review-panel"
        id="boq-review-tab"
        className={
          view === "review"
            ? "boq-workspace-tab boq-workspace-tab-active"
            : "boq-workspace-tab"
        }
        onClick={() => onViewChange("review")}
      >
        Review Extraction
        {reviewIssueCount > 0 ? <span>{reviewIssueCount}</span> : null}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={view === "compare"}
        aria-controls="boq-compare-panel"
        id="boq-compare-tab"
        className={
          view === "compare"
            ? "boq-workspace-tab boq-workspace-tab-active"
            : "boq-workspace-tab"
        }
        onClick={() => onViewChange("compare")}
      >
        Compare Catalog
        {unmatchedCount > 0 ? <span>{unmatchedCount}</span> : null}
      </button>
    </div>
  );
}
