"use client";

import type { ReactNode } from "react";

import type { ActionableItemSuggestion } from "@/lib/actionable-review-projection";
import type { ActionableReviewStage } from "@/lib/settings-schema";

export type ActionableReviewDetailStage = "extract" | "catalog";

const STAGE_RANK: Record<ActionableReviewStage, number> = {
  off: 0,
  shadow: 1,
  focused: 2,
  add_and_match: 3,
  default: 4,
};

export function canAddAndMatch(stage: ActionableReviewStage): boolean {
  return STAGE_RANK[stage] >= STAGE_RANK.add_and_match;
}

export interface ActionableReviewDetailProps {
  suggestion: ActionableItemSuggestion | null;
  detailStage: ActionableReviewDetailStage;
  rolloutStage: ActionableReviewStage;
  readOnly?: boolean;
  sectionLabel?: string;
  busy?: boolean;
  onAddAndMatch?: (suggestionId: string) => void;
  onAddToBoq?: (suggestionId: string) => void;
  onFindAnother?: (suggestionId: string) => void;
  onDoNotAdd?: (suggestionId: string) => void;
  onCreateAndLink?: (suggestionId: string) => void;
  onFindExisting?: (suggestionId: string) => void;
  onExclude?: (suggestionId: string) => void;
  onOpenAudit?: () => void;
  onGoCatalog?: () => void;
  onGoExtract?: () => void;
}

function money(value: string): string {
  return `฿${value}`;
}

function topCandidate(suggestion: ActionableItemSuggestion) {
  return suggestion.catalogCandidates[0] ?? null;
}

/**
 * Presentation-only: trust the normalized snapshot's candidate list.
 * Do not re-encode match-kind policy in React.
 */
export function hasAuthoritativeCandidateMatch(
  suggestion: Pick<ActionableItemSuggestion, "catalogCandidates">,
): boolean {
  return suggestion.catalogCandidates.length > 0;
}

export function ActionableReviewDetail({
  suggestion,
  detailStage,
  rolloutStage,
  readOnly = false,
  sectionLabel,
  busy = false,
  onAddAndMatch,
  onAddToBoq,
  onFindAnother,
  onDoNotAdd,
  onCreateAndLink,
  onFindExisting,
  onExclude,
  onOpenAudit,
  onGoCatalog,
  onGoExtract,
}: ActionableReviewDetailProps) {
  const addAndMatchEnabled = canAddAndMatch(rolloutStage);
  const actionsDisabled = readOnly || busy;

  if (detailStage === "catalog") {
    if (!suggestion) {
      return (
        <article
          className="actionable-detail"
          id="detail-panel"
          tabIndex={-1}
          data-od-id="decision-detail"
        >
          <section
            className="actionable-empty-state"
            data-od-id="catalog-ready-empty"
          >
            <p className="actionable-eyebrow">2 · Catalog Ready</p>
            <h2>No catalog-pending items</h2>
            <p>
              Items appear here only after Add to BOQ when no safe existing match
              was available. Catalog creation never occurs during extraction
              review or approval.
            </p>
            {onGoExtract ? (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={onGoExtract}
              >
                Return to Extract & Verify
              </button>
            ) : null}
          </section>
        </article>
      );
    }

    const item = suggestion.extractedItem;
    const proposal = suggestion.aiAdvice?.proposedCatalogMetadata;
    return (
      <article
        className="actionable-detail"
        id="detail-panel"
        tabIndex={-1}
        data-od-id="decision-detail"
      >
        <div className="actionable-detail-top">
          <span className="actionable-mini-badge is-blocked">
            Catalog pending
          </span>
          <span className="actionable-mono">
            Source row{" "}
            {suggestion.sourceRefs[0]
              ? `${suggestion.sourceRefs[0].page}.${suggestion.sourceRefs[0].row}`
              : "—"}
          </span>
        </div>
        <h2 className="actionable-detail-title">{item.description || "Untitled"}</h2>
        <p className="actionable-detail-sub">
          The BOQ line already exists. Resolve only its catalog relationship
          here before approval.
        </p>
        <section className="actionable-evidence-snippet">
          <p className="actionable-eyebrow">Preserved BOQ evidence</p>
          <blockquote>
            {item.quantity} {item.unit} · material {money(item.materialRate)} ·
            labour {money(item.labourRate)} · source total{" "}
            <strong>{money(item.total)}</strong>
          </blockquote>
        </section>
        <form
          className="actionable-catalog-form"
          data-od-id="catalog-ready-form"
          onSubmit={(event) => event.preventDefault()}
        >
          <p className="actionable-eyebrow">Cached proposal · reviewer editable</p>
          <div className="actionable-form-grid">
            <label className="actionable-field full">
              <span>Proposed name</span>
              <input
                name="name"
                defaultValue={proposal?.description ?? item.description}
                disabled={actionsDisabled}
                readOnly
              />
            </label>
            <label className="actionable-field">
              <span>Unit</span>
              <input
                name="unit"
                defaultValue={proposal?.unit ?? item.unit}
                disabled={actionsDisabled}
                readOnly
              />
            </label>
            <label className="actionable-field">
              <span>Category</span>
              <input
                name="category"
                defaultValue={proposal?.category ?? sectionLabel ?? ""}
                disabled={actionsDisabled}
                readOnly
              />
            </label>
            <label className="actionable-field full">
              <span>Aliases</span>
              <textarea
                name="aliases"
                defaultValue={(proposal?.aliases ?? []).join(", ")}
                disabled={actionsDisabled}
                readOnly
              />
            </label>
          </div>
          <div className="actionable-card-actions">
            <button
              type="button"
              className="btn btn-ghost text-destructive"
              disabled={actionsDisabled || !onExclude}
              onClick={() => onExclude?.(suggestion.id)}
            >
              Exclude
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={actionsDisabled || !onFindExisting}
              onClick={() => onFindExisting?.(suggestion.id)}
            >
              Find existing
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={actionsDisabled || !onCreateAndLink}
              onClick={() => onCreateAndLink?.(suggestion.id)}
            >
              Create & link
            </button>
          </div>
        </form>
      </article>
    );
  }

  if (!suggestion) {
    return (
      <article
        className="actionable-detail"
        id="detail-panel"
        tabIndex={-1}
        data-od-id="decision-detail"
      >
        <section className="actionable-empty-state">
          <p className="actionable-eyebrow">1 · Extract & Verify</p>
          <h2>Select a suggestion</h2>
          <p>Choose an actionable item from the review queue.</p>
        </section>
      </article>
    );
  }

  const item = suggestion.extractedItem;
  const candidate = topCandidate(suggestion);
  const safeMatch = hasAuthoritativeCandidateMatch(suggestion);
  const pending = suggestion.status === "pending";
  const catalogPending = suggestion.status === "added_pending_catalog";
  const ref = suggestion.sourceRefs[0];
  const conversionLabel = suggestion.normalization
    ? `${suggestion.normalization.catalogUnit} · rule ${suggestion.normalization.ruleId} · ${suggestion.normalization.catalogUnitsPerSourceUnit}:1`
    : candidate?.conversionRuleId
      ? `Conversion rule ${candidate.conversionRuleId}`
      : "No conversion required";

  let outcome: ReactNode;
  if (!pending) {
    const decisionText =
      suggestion.status === "dismissed"
        ? "Not added to this BOQ. Source evidence remains in the audit trail."
        : catalogPending
          ? "Added to BOQ · Catalog pending for Stage 2"
          : candidate
            ? `${candidate.catalogId} · ${candidate.description} · source total ${money(item.total)} preserved`
            : `Decision recorded · source total ${money(item.total)} preserved`;
    outcome = (
      <section className="actionable-decision-card" data-od-id="resolved-decision">
        <h3>{catalogPending ? "Catalog pending" : "Decision recorded"}</h3>
        <p>{decisionText}</p>
        <div className="actionable-card-actions">
          {onOpenAudit ? (
            <button type="button" className="btn btn-secondary" onClick={onOpenAudit}>
              Open audit history
            </button>
          ) : null}
          {catalogPending && onGoCatalog ? (
            <button type="button" className="btn btn-primary" onClick={onGoCatalog}>
              Go to Stage 2
            </button>
          ) : null}
        </div>
      </section>
    );
  } else if (safeMatch && candidate) {
    outcome = (
      <section
        className="actionable-match-card"
        data-od-id="existing-match-card"
      >
        <div className="actionable-match-header">
          <div>
            <p className="actionable-eyebrow">Existing safe match</p>
            <h3>
              {candidate.catalogId} · {candidate.description}
            </h3>
          </div>
          <span className="actionable-confidence">{Math.round(candidate.score)}</span>
        </div>
        <p className="actionable-detail-sub">
          <strong>Match reason:</strong> {candidate.matchKind}
        </p>
        <div className="actionable-definition-grid">
          <div>
            <span>Source description</span>
            <strong>{item.description}</strong>
          </div>
          <div>
            <span>Source values</span>
            <strong>
              {item.quantity} {item.unit} · material {money(item.materialRate)} ·
              labour {money(item.labourRate)}
            </strong>
          </div>
          <div>
            <span>Existing catalog name / unit</span>
            <strong>
              {candidate.description} · {candidate.unit}
            </strong>
          </div>
          <div>
            <span>Conversion rule</span>
            <strong>{conversionLabel}</strong>
          </div>
          <div>
            <span>Source total preserved</span>
            <strong>{money(item.total)}</strong>
          </div>
          {suggestion.normalization ? (
            <div>
              <span>Normalized total</span>
              <strong>{money(suggestion.normalization.normalizedTotal)}</strong>
            </div>
          ) : null}
        </div>
        <div className="actionable-card-actions">
          <button
            type="button"
            className="btn btn-ghost text-destructive"
            disabled={actionsDisabled || !onDoNotAdd}
            onClick={() => onDoNotAdd?.(suggestion.id)}
          >
            Do not add
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={actionsDisabled || !onFindAnother}
            onClick={() => onFindAnother?.(suggestion.id)}
          >
            Find another
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={
              actionsDisabled || !addAndMatchEnabled || !onAddAndMatch
            }
            onClick={() => onAddAndMatch?.(suggestion.id)}
          >
            Add & match
          </button>
        </div>
      </section>
    );
  } else {
    outcome = (
      <section className="actionable-risk-card" data-od-id="no-safe-match-card">
        <div className="actionable-risk-head">
          <span>No safe existing match</span>
        </div>
        <p>
          {suggestion.deterministicReasons.join("; ") ||
            "No catalog candidate met the safe-match threshold."}{" "}
          Catalog linking is handled separately in Stage 2.
        </p>
        <div className="actionable-definition-grid">
          <div>
            <span>Section</span>
            <strong>{sectionLabel ?? `Section ${suggestion.suggestedSectionIndex + 1}`}</strong>
          </div>
          <div>
            <span>Description</span>
            <strong>{item.description}</strong>
          </div>
          <div>
            <span>Unit / quantity</span>
            <strong>
              {item.unit} · {item.quantity}
            </strong>
          </div>
          <div>
            <span>Rates</span>
            <strong>
              Material {money(item.materialRate)} · labour {money(item.labourRate)}
            </strong>
          </div>
        </div>
        <div className="actionable-card-actions">
          <button
            type="button"
            className="btn btn-ghost text-destructive"
            disabled={actionsDisabled || !onDoNotAdd}
            onClick={() => onDoNotAdd?.(suggestion.id)}
          >
            Do not add
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={actionsDisabled || !onAddToBoq}
            onClick={() => onAddToBoq?.(suggestion.id)}
          >
            Add to BOQ
          </button>
        </div>
      </section>
    );
  }

  return (
    <article
      className="actionable-detail"
      id="detail-panel"
      tabIndex={-1}
      data-od-id="decision-detail"
    >
      <div className="actionable-detail-top">
        <span
          className={`actionable-mini-badge ${pending ? "is-blocked" : "is-ready"}`}
        >
          {pending
            ? safeMatch
              ? "Review match"
              : "No safe match"
            : catalogPending
              ? "Catalog pending"
              : suggestion.status === "dismissed"
                ? "Dismissed"
                : "Resolved"}
        </span>
        <span className="actionable-mono">
          Source row {ref ? `${ref.page}.${ref.row}` : "—"}
        </span>
      </div>
      <h2 className="actionable-detail-title" data-od-id="selected-item-title">
        {item.description || "Untitled item"}
      </h2>
      <p className="actionable-detail-sub">
        {item.quantity} {item.unit} · contractor quote
      </p>
      <section className="actionable-evidence-snippet">
        <p className="actionable-eyebrow">Extracted evidence</p>
        <blockquote>
          “<mark>{item.description}</mark>”
        </blockquote>
      </section>
      {outcome}
    </article>
  );
}
