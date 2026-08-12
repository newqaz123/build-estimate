"use client";

import { useMemo, useState, type ReactNode } from "react";

import type { ActionableItemSuggestion } from "@/lib/actionable-review-projection";
import type { ExtractedPricingSnapshot, PricingNormalization } from "@/lib/actionable-review-types";
import type { CatalogCandidateSnapshot } from "@/lib/catalog-candidate-shortlist";
import type { SourceBackedItemRequest } from "@/lib/boq-user-entry";
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

export interface ActionableReviewerDraft {
  description: string;
  unit: string;
  quantity: string;
  materialRate: string;
  labourRate: string;
  correctionReason: string;
}

export interface ActionableAddAndMatchPayload {
  catalogId: string;
  conversionRuleId?: string;
  item: SourceBackedItemRequest;
  correctionReason?: string;
}

export interface ActionableAddToBoqPayload {
  item: SourceBackedItemRequest;
  correctionReason?: string;
}

/** Optional advisory historical pricing — never invented by the UI. */
export interface ActionableHistoricalAdvisory {
  median: string;
  label?: string;
}

export interface ActionableReviewDetailProps {
  suggestion: ActionableItemSuggestion | null;
  detailStage: ActionableReviewDetailStage;
  rolloutStage: ActionableReviewStage;
  readOnly?: boolean;
  sectionLabel?: string;
  busy?: boolean;
  /** Server-provided only; when absent the UI shows nothing historical. */
  historicalAdvisory?: ActionableHistoricalAdvisory | null;
  onAddAndMatch?: (
    suggestionId: string,
    payload: ActionableAddAndMatchPayload,
  ) => void;
  onAddToBoq?: (suggestionId: string, payload: ActionableAddToBoqPayload) => void;
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

export function draftFromExtracted(
  extracted: ExtractedPricingSnapshot,
): ActionableReviewerDraft {
  return {
    description: extracted.description,
    unit: extracted.unit,
    quantity: extracted.quantity,
    materialRate: extracted.materialRate,
    labourRate: extracted.labourRate,
    correctionReason: "",
  };
}

export function requiresCorrectionReason(
  extracted: ExtractedPricingSnapshot,
  draft: ActionableReviewerDraft,
): boolean {
  return (
    draft.unit.trim() !== extracted.unit ||
    draft.quantity.trim() !== extracted.quantity ||
    draft.materialRate.trim() !== extracted.materialRate ||
    draft.labourRate.trim() !== extracted.labourRate
  );
}

export function conversionScopeFromRuleId(
  ruleId: string | undefined,
): "identity" | null {
  if (typeof ruleId !== "string" || ruleId.trim() === "") return null;
  return ruleId.startsWith("identity:") ? "identity" : null;
}

export function isNormalizationAlignedWithCandidate(
  normalization: PricingNormalization | undefined,
  candidate: CatalogCandidateSnapshot | null | undefined,
): boolean {
  if (!candidate) return false;
  if (candidate.conversionRuleId) {
    if (!normalization) return false;
    if (normalization.catalogId !== candidate.catalogId) return false;
    if (normalization.ruleId !== candidate.conversionRuleId) return false;
    return true;
  }
  if (!normalization) return true;
  if (normalization.catalogId !== candidate.catalogId) return false;
  if (
    conversionScopeFromRuleId(normalization.ruleId) === "identity" ||
    normalization.catalogUnitsPerSourceUnit === "1"
  ) {
    return true;
  }
  // Same-unit candidate must not carry a foreign conversion rule snapshot.
  return false;
}

function parseDraftNumber(raw: string): number | null {
  const trimmed = raw.trim().replace(/,/g, "");
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

export function buildBoundedItemFromDraft(input: {
  sectionIndex: number;
  draft: ActionableReviewerDraft;
}): SourceBackedItemRequest | null {
  const desc = input.draft.description.trim();
  const unit = input.draft.unit.trim();
  const qty = parseDraftNumber(input.draft.quantity);
  const materialCost = parseDraftNumber(input.draft.materialRate);
  const labourCost = parseDraftNumber(input.draft.labourRate);
  if (!desc || !unit || qty === null || materialCost === null || labourCost === null) {
    return null;
  }
  return {
    sectionIndex: input.sectionIndex,
    desc,
    unit,
    qty,
    materialCost,
    labourCost,
  };
}

export function isNormalizationTotalAlignedWithExtracted(
  normalization: PricingNormalization | undefined,
  extracted: ExtractedPricingSnapshot,
): boolean {
  return !normalization || normalization.normalizedTotal === extracted.total;
}

export function canEnableAddAndMatch(input: {
  rolloutStage: ActionableReviewStage;
  readOnly: boolean;
  busy: boolean;
  hasCandidate: boolean;
  candidate: CatalogCandidateSnapshot | null | undefined;
  normalization: PricingNormalization | undefined;
  extracted: ExtractedPricingSnapshot;
  draft: ActionableReviewerDraft;
}): boolean {
  if (!canAddAndMatch(input.rolloutStage)) return false;
  if (input.readOnly || input.busy) return false;
  if (!input.hasCandidate || !input.candidate) return false;
  if (!isNormalizationAlignedWithCandidate(input.normalization, input.candidate)) {
    return false;
  }
  if (!isNormalizationTotalAlignedWithExtracted(input.normalization, input.extracted)) {
    return false;
  }
  if (
    requiresCorrectionReason(input.extracted, input.draft) &&
    input.draft.correctionReason.trim() === ""
  ) {
    return false;
  }
  return buildBoundedItemFromDraft({
    sectionIndex: 0,
    draft: input.draft,
  }) !== null;
}

export function buildActionableAddAndMatchPayload(input: {
  sectionIndex: number;
  draft: ActionableReviewerDraft;
  candidate: CatalogCandidateSnapshot;
  normalization?: PricingNormalization;
}): ActionableAddAndMatchPayload | null {
  if (!isNormalizationAlignedWithCandidate(input.normalization, input.candidate)) {
    return null;
  }
  const item = buildBoundedItemFromDraft({
    sectionIndex: input.sectionIndex,
    draft: input.draft,
  });
  if (!item) return null;
  const correction = input.draft.correctionReason.trim();
  const payload: ActionableAddAndMatchPayload = {
    catalogId: input.candidate.catalogId,
    item,
  };
  if (input.candidate.conversionRuleId) {
    payload.conversionRuleId = input.candidate.conversionRuleId;
  }
  if (correction) {
    payload.correctionReason = correction.slice(0, 500);
  }
  return payload;
}

export function buildActionableAddToBoqPayload(input: {
  sectionIndex: number;
  draft: ActionableReviewerDraft;
}): ActionableAddToBoqPayload | null {
  const item = buildBoundedItemFromDraft(input);
  if (!item) return null;
  const correction = input.draft.correctionReason.trim();
  return correction
    ? { item, correctionReason: correction.slice(0, 500) }
    : { item };
}

function ReviewerDraftFields({
  draft,
  disabled,
  onChange,
  requireReason,
}: {
  draft: ActionableReviewerDraft;
  disabled: boolean;
  onChange: (next: ActionableReviewerDraft) => void;
  requireReason: boolean;
}) {
  return (
    <div
      className="actionable-form-grid"
      data-od-id="reviewer-confirmed-fields"
    >
      <p className="actionable-eyebrow" style={{ gridColumn: "1 / -1" }}>
        Reviewer-confirmed BOQ fields
      </p>
      <label className="actionable-field full">
        <span>Description</span>
        <input
          name="desc"
          value={draft.description}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...draft, description: event.target.value })
          }
        />
      </label>
      <label className="actionable-field">
        <span>Raw unit</span>
        <input
          name="unit"
          value={draft.unit}
          disabled={disabled}
          onChange={(event) => onChange({ ...draft, unit: event.target.value })}
        />
      </label>
      <label className="actionable-field">
        <span>Quantity</span>
        <input
          name="qty"
          inputMode="decimal"
          value={draft.quantity}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...draft, quantity: event.target.value })
          }
        />
      </label>
      <label className="actionable-field">
        <span>Material rate</span>
        <input
          name="materialRate"
          inputMode="decimal"
          value={draft.materialRate}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...draft, materialRate: event.target.value })
          }
        />
      </label>
      <label className="actionable-field">
        <span>Labour rate</span>
        <input
          name="labourRate"
          inputMode="decimal"
          value={draft.labourRate}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...draft, labourRate: event.target.value })
          }
        />
      </label>
      <label className="actionable-field full">
        <span>
          Correction reason
          {requireReason ? " (required for numeric edits)" : " (optional)"}
        </span>
        <textarea
          name="correctionReason"
          value={draft.correctionReason}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...draft, correctionReason: event.target.value })
          }
          rows={2}
        />
      </label>
    </div>
  );
}

export function ActionableReviewDetail({
  suggestion,
  detailStage,
  rolloutStage,
  readOnly = false,
  sectionLabel,
  busy = false,
  historicalAdvisory = null,
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

  // Preserve reviewer edits across failed submits; only seed when suggestion id is new.
  const [draftBySuggestionId, setDraftBySuggestionId] = useState<
    Record<string, ActionableReviewerDraft>
  >({});

  const activeDraft = useMemo(() => {
    if (!suggestion) return null;
    return (
      draftBySuggestionId[suggestion.id] ??
      draftFromExtracted(suggestion.extractedItem)
    );
  }, [draftBySuggestionId, suggestion]);

  const updateDraft = (next: ActionableReviewerDraft) => {
    if (!suggestion) return;
    setDraftBySuggestionId((current) => ({
      ...current,
      [suggestion.id]: next,
    }));
  };

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
        <h2 className="actionable-detail-title">
          {item.description || "Untitled"}
        </h2>
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
          <p className="actionable-eyebrow">
            Cached proposal · reviewer editable
          </p>
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

  if (!suggestion || !activeDraft) {
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
  const draft = activeDraft;
  const candidate = topCandidate(suggestion);
  const safeMatch = hasAuthoritativeCandidateMatch(suggestion);
  const pending = suggestion.status === "pending";
  const catalogPending = suggestion.status === "added_pending_catalog";
  const ref = suggestion.sourceRefs[0];
  const normalization = suggestion.normalization;
  const ruleId = normalization?.ruleId ?? candidate?.conversionRuleId;
  const scopeLabel = conversionScopeFromRuleId(ruleId);
  const reasonNeeded = requiresCorrectionReason(item, draft);
  const canSubmitAddAndMatch =
    pending &&
    canEnableAddAndMatch({
      rolloutStage,
      readOnly,
      busy,
      hasCandidate: safeMatch,
      candidate,
      normalization,
      extracted: item,
      draft,
    }) &&
    Boolean(onAddAndMatch);

  const conversionLabel = normalization
    ? `${normalization.catalogUnit} · rule ${normalization.ruleId}${
        scopeLabel ? ` · scope ${scopeLabel}` : ""
      } · factor ${normalization.catalogUnitsPerSourceUnit}`
    : candidate?.conversionRuleId
      ? `Conversion rule ${candidate.conversionRuleId}${
          scopeLabel ? ` · scope ${scopeLabel}` : ""
        }`
      : "No conversion required · identity";

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
      <section
        className="actionable-decision-card"
        data-od-id="resolved-decision"
      >
        <h3>{catalogPending ? "Catalog pending" : "Decision recorded"}</h3>
        <p>{decisionText}</p>
        <div className="actionable-card-actions">
          {onOpenAudit ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onOpenAudit}
            >
              Open audit history
            </button>
          ) : null}
          {catalogPending && onGoCatalog ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={onGoCatalog}
            >
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
          <span className="actionable-confidence">
            {Math.round(candidate.score)}
          </span>
        </div>
        <p className="actionable-detail-sub">
          <strong>Match reason:</strong> {candidate.matchKind}
        </p>

        <section
          className="actionable-evidence-snippet"
          data-od-id="extracted-evidence"
        >
          <p className="actionable-eyebrow">Extracted evidence (immutable)</p>
          <div className="actionable-definition-grid">
            <div>
              <span>Extracted description</span>
              <strong>{item.description}</strong>
            </div>
            <div>
              <span>Extracted unit / quantity</span>
              <strong>
                {item.unit} · {item.quantity}
              </strong>
            </div>
            <div>
              <span>Extracted rates</span>
              <strong>
                Material {money(item.materialRate)} · labour{" "}
                {money(item.labourRate)}
              </strong>
            </div>
            <div>
              <span>Source total (authoritative)</span>
              <strong>{money(item.total)}</strong>
            </div>
          </div>
        </section>

        <ReviewerDraftFields
          draft={draft}
          disabled={actionsDisabled}
          onChange={updateDraft}
          requireReason={reasonNeeded}
        />

        <section
          className="actionable-evidence-snippet"
          data-od-id="normalized-evidence"
        >
          <p className="actionable-eyebrow">Normalized catalog values</p>
          <div className="actionable-definition-grid">
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
            {scopeLabel ? (
              <div>
                <span>Conversion scope</span>
                <strong>{scopeLabel}</strong>
              </div>
            ) : null}
            {normalization ? (
              <>
                <div>
                  <span>Factor (catalog units per source unit)</span>
                  <strong>{normalization.catalogUnitsPerSourceUnit}</strong>
                </div>
                <div>
                  <span>Normalized quantity</span>
                  <strong>{normalization.normalizedQuantity}</strong>
                </div>
                <div>
                  <span>Normalized rates</span>
                  <strong>
                    Material {money(normalization.normalizedMaterialRate)} ·
                    labour {money(normalization.normalizedLabourRate)}
                  </strong>
                </div>
                <div>
                  <span>Normalized total</span>
                  <strong>{money(normalization.normalizedTotal)}</strong>
                </div>
              </>
            ) : (
              <div>
                <span>Normalization</span>
                <strong>
                  Same-unit identity will be applied on the server
                </strong>
              </div>
            )}
            <div>
              <span>Source total preserved (authoritative)</span>
              <strong>{money(item.total)}</strong>
            </div>
            {historicalAdvisory ? (
              <div data-od-id="historical-advisory">
                <span>Historical median (advisory only)</span>
                <strong>
                  {money(historicalAdvisory.median)}
                  {historicalAdvisory.label
                    ? ` · ${historicalAdvisory.label}`
                    : ""}
                </strong>
              </div>
            ) : null}
          </div>
        </section>
        {reasonNeeded ? (
          <p className="actionable-detail-sub" role="status">
            Normalized preview is based on extracted values; the server will
            recompute it for reviewer-confirmed edits.
          </p>
        ) : null}

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
            disabled={!canSubmitAddAndMatch}
            aria-disabled={!canSubmitAddAndMatch}
            onClick={() => {
              if (!onAddAndMatch || !candidate) return;
              const payload = buildActionableAddAndMatchPayload({
                sectionIndex: suggestion.suggestedSectionIndex,
                draft,
                candidate,
                normalization,
              });
              if (!payload) return;
              onAddAndMatch(suggestion.id, payload);
            }}
          >
            {busy ? "Working…" : "Add & match"}
          </button>
        </div>
        {!addAndMatchEnabled ? (
          <p className="actionable-detail-sub" role="status">
            Add & match is available at the add_and_match rollout stage.
          </p>
        ) : null}
        {reasonNeeded && draft.correctionReason.trim() === "" ? (
          <p className="actionable-detail-sub" role="status">
            Enter a correction reason before submitting numeric edits.
          </p>
        ) : null}
      </section>
    );
  } else {
    const canSubmitAddToBoq =
      !actionsDisabled &&
      Boolean(onAddToBoq) &&
      (!reasonNeeded || draft.correctionReason.trim() !== "") &&
      buildBoundedItemFromDraft({
        sectionIndex: suggestion.suggestedSectionIndex,
        draft,
      }) !== null;

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

        <section
          className="actionable-evidence-snippet"
          data-od-id="extracted-evidence"
        >
          <p className="actionable-eyebrow">Extracted evidence (immutable)</p>
          <div className="actionable-definition-grid">
            <div>
              <span>Section</span>
              <strong>
                {sectionLabel ??
                  `Section ${suggestion.suggestedSectionIndex + 1}`}
              </strong>
            </div>
            <div>
              <span>Extracted description</span>
              <strong>{item.description}</strong>
            </div>
            <div>
              <span>Extracted unit / quantity</span>
              <strong>
                {item.unit} · {item.quantity}
              </strong>
            </div>
            <div>
              <span>Extracted rates</span>
              <strong>
                Material {money(item.materialRate)} · labour{" "}
                {money(item.labourRate)}
              </strong>
            </div>
            <div>
              <span>Source total (authoritative)</span>
              <strong>{money(item.total)}</strong>
            </div>
          </div>
        </section>

        <ReviewerDraftFields
          draft={draft}
          disabled={actionsDisabled}
          onChange={updateDraft}
          requireReason={reasonNeeded}
        />

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
            disabled={!canSubmitAddToBoq}
            aria-disabled={!canSubmitAddToBoq}
            onClick={() => {
              if (!onAddToBoq) return;
              const payload = buildActionableAddToBoqPayload({
                sectionIndex: suggestion.suggestedSectionIndex,
                draft,
              });
              if (!payload) return;
              onAddToBoq(suggestion.id, payload);
            }}
          >
            {busy ? "Working…" : "Add to BOQ"}
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
