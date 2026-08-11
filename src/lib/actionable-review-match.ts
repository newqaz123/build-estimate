import {
  CatalogConversionError,
  identityConversionRule,
  normalizePricingWithRule,
  type CatalogConversionRule,
  type HumanApprovedCatalogConversionRule,
} from "./catalog-conversion";
import {
  addSourceBackedBoqItem,
  type SourceBackedItemRequest,
  type ValidatedSourceMapping,
} from "./boq-user-entry";
import {
  buildReviewerPricingFromSourceBackedItem,
} from "./boq-extraction-acceptance";
import type { ActionableItemSuggestion } from "./actionable-review-projection";
import type { StandardEntry, StandardSourceItem } from "./standard-schema";
import type {
  ExtractedPricingSnapshot,
  PricingNormalization,
  ReviewerPricingSnapshot,
} from "./actionable-review-types";
import type { Boq, BoqPricedItem, BoqSection } from "./boq-schema";

/** Server-resolved source evidence backing the reviewer decision. */
export interface ResolvedActionableSource {
  sourceMapping: ValidatedSourceMapping;
  extractedPricing: ExtractedPricingSnapshot;
}

/** Fully reconstructed Add & match result with no persistence performed. */
export interface PreparedActionableMatch {
  item: BoqPricedItem;
  extractedPricing: ExtractedPricingSnapshot;
  reviewerPricing: ReviewerPricingSnapshot;
  pricingNormalization: PricingNormalization;
  catalogSourceItem: StandardSourceItem;
  catalog: StandardEntry;
  decision: {
    action: "add_and_match";
    catalogId: string;
    conversionRuleId?: string;
  };
}

/** Minimal shell BOQ so {@link addSourceBackedBoqItem} can perform its
 *  cost-allocation validation without touching a real persisted document.
 *  The resulting BOQ is discarded — only the built item is retained. */
function buildShellBoq(sectionIndex: number): Boq {
  const sections: BoqSection[] = [];
  for (let index = 0; index <= sectionIndex; index += 1) {
    sections.push({ header: "", items: [] });
  }
  return {
    id: "",
    project: "",
    vendor: "",
    workType: "Unclassified",
    date: "",
    totalItems: 0,
    grandTotal: 0,
    status: "draft",
    stdStatus: "none",
    sections,
    createdAt: "",
    updatedAt: "",
  };
}

/** Resolve the conversion rule to apply for normalization.
 *
 *  - A supplied human-approved rule is used directly.
 *  - When no rule is supplied and the reviewer unit is canonically equal to
 *    the catalog unit, the system identity rule is used.
 *  - Otherwise the units are incompatible and normalization cannot proceed. */
function resolveConversionRule(
  reviewerUnit: string,
  catalogUnit: string,
  conversion: HumanApprovedCatalogConversionRule | undefined,
): CatalogConversionRule {
  if (conversion !== undefined) {
    return conversion;
  }
  if (reviewerUnit === catalogUnit) {
    return identityConversionRule(catalogUnit);
  }
  throw new CatalogConversionError(
    "Missing conversion for incompatible units.",
  );
}

/**
 * Reconstruct the full Add & match (priced BOQ item + three pricing snapshots
 * + catalog link) without performing any write. Persistence is deferred to the
 * transaction layer.
 *
 * The extracted pricing snapshot is kept immutable; reviewer pricing is built
 * with a trusted actor and timestamp; the pricing normalization uses exact
 * decimal arithmetic through the resolved conversion rule.
 */
export function prepareActionableAddAndMatch(input: {
  suggestion: ActionableItemSuggestion;
  immutableSource: ResolvedActionableSource;
  catalog: StandardEntry;
  conversion?: HumanApprovedCatalogConversionRule;
  userValues: SourceBackedItemRequest;
  correctionReason?: string;
  actorId: string;
  confirmedAt: string;
  currencyScale: number;
}): PreparedActionableMatch {
  const { catalog, suggestion, immutableSource, userValues } = input;

  if (catalog.archivedAt !== undefined) {
    throw new CatalogConversionError(
      "Archived catalog entries cannot be matched.",
    );
  }

  // 1. Keep the extracted pricing snapshot immutable.
  const extractedPricing = immutableSource.extractedPricing;

  // 2. Build reviewer-confirmed pricing with a trusted actor and timestamp.
  const reviewerPricing = buildReviewerPricingFromSourceBackedItem({
    item: userValues,
    extracted: extractedPricing,
    actorId: input.actorId,
    now: input.confirmedAt,
    ...(input.correctionReason
      ? { correctionReason: input.correctionReason }
      : {}),
  });

  // 3. Resolve the conversion rule.
  const rule = resolveConversionRule(
    reviewerPricing.unit,
    catalog.unit,
    input.conversion,
  );

  // 4. Compute the pricing normalization via exact decimal arithmetic.
  const pricingNormalization = normalizePricingWithRule({
    source: reviewerPricing,
    catalogId: catalog.id,
    catalogDescription: catalog.description,
    catalogUnit: catalog.unit,
    rule,
    currencyScale: input.currencyScale,
  });

  // 5. Build the base BoqPricedItem through the shared cost-allocation path.
  const itemId = `user-ar-${suggestion.id.replace(/^sha256:/, "").slice(0, 32)}`;
  const { item: baseItem } = addSourceBackedBoqItem({
    boq: buildShellBoq(userValues.sectionIndex),
    validatedSourceMapping: immutableSource.sourceMapping,
    userValues,
    itemId,
  });

  // 6. Attach the three pricing snapshots and catalog match metadata.
  const item: BoqPricedItem = {
    ...baseItem,
    stdStatus: "matched",
    stdId: catalog.id,
    stdMatch: catalog.description,
    stdConfidence: "manual",
    extractedPricing,
    reviewerPricing,
    pricingNormalization,
  };

  // 7. Build the catalog source-item link (boqId placeholder from suggestion
  //    context, sectionIndex from user values, description from extracted).
  const catalogSourceItem: StandardSourceItem = {
    boqId: suggestion.extractionRunId,
    sectionIndex: userValues.sectionIndex,
    sourceDescription: extractedPricing.description,
  };

  // 8. Record the resolved decision.
  const decision: PreparedActionableMatch["decision"] = input.conversion
    ? {
        action: "add_and_match",
        catalogId: catalog.id,
        conversionRuleId: input.conversion.id,
      }
    : { action: "add_and_match", catalogId: catalog.id };

  return {
    item,
    extractedPricing,
    reviewerPricing,
    pricingNormalization,
    catalogSourceItem,
    catalog,
    decision,
  };
}
