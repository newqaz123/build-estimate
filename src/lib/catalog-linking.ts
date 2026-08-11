import { applyManualCostAllocation } from "./boq-cost-allocation";
import { decimalStringFromFiniteNumber } from "./boq-extraction-acceptance";
import type { BoqItem, BoqPricedItem } from "./boq-schema";
import { isPricedBoqItem } from "./boq-pricing";
import { parseDecimalString } from "./decimal-string";
import type { PricingNormalization } from "./actionable-review-types";
import type { StandardEntry, StandardSourceItem } from "./standard-schema";

export class CatalogLinkError extends TypeError {
	constructor(message: string) {
		super(message);
		this.name = "CatalogLinkError";
	}
}

export function normalizeStandardEntry(entry: StandardEntry): StandardEntry {
	return {
		...entry,
		aliases: entry.aliases ?? [],
		sourceItems: entry.sourceItems ? [...entry.sourceItems] : [],
	};
}

/**
 * Merge one source-history entry, deduplicating on boq/section/item identity.
 * Updates sourceBoqCount and lastMatched once for the call.
 */
export function mergeStandardSourceItems(
	standard: StandardEntry,
	sourceItem: StandardSourceItem,
	matchedAt: string,
): StandardEntry {
	const existingItems = standard.sourceItems ?? [];
	const alreadyPresent = existingItems.some(
		(entry) =>
			entry.boqId === sourceItem.boqId &&
			entry.sectionIndex === sourceItem.sectionIndex &&
			(sourceItem.itemId
				? entry.itemId === sourceItem.itemId
				: !entry.itemId && entry.itemCode === sourceItem.itemCode) &&
			entry.sourceDescription === sourceItem.sourceDescription,
	);

	const nextSourceItems = alreadyPresent
		? existingItems.map((entry) => ({ ...entry }))
		: [...existingItems.map((entry) => ({ ...entry })), { ...sourceItem }];
	const uniqueBoqIds = new Set(nextSourceItems.map((entry) => entry.boqId));

	return {
		...normalizeStandardEntry(standard),
		sourceItems: nextSourceItems,
		sourceBoqCount: uniqueBoqIds.size,
		lastMatched: matchedAt,
	};
}

/** Convert a canonical decimal string into a finite non-negative JS number that
 *  round-trips through {@link decimalStringFromFiniteNumber}. */
export function finiteCompatibilityNumber(
	value: string,
	label: string,
): number {
	let canonical: string;
	try {
		canonical = parseDecimalString(value);
	} catch {
		throw new CatalogLinkError(`${label} must be a canonical decimal string.`);
	}
	const num = Number(canonical);
	if (!Number.isFinite(num) || num < 0) {
		throw new CatalogLinkError(
			`${label} must be a finite non-negative compatibility number.`,
		);
	}
	let roundTrip: string;
	try {
		roundTrip = decimalStringFromFiniteNumber(num);
	} catch {
		throw new CatalogLinkError(
			`${label} is not representable as a finite compatibility number.`,
		);
	}
	if (parseDecimalString(roundTrip) !== canonical) {
		throw new CatalogLinkError(
			`${label} is not representable as a finite compatibility number.`,
		);
	}
	return num;
}

/**
 * Build a matched BOQ item + updated standard source history without mutating inputs.
 *
 * - Ordinary same-unit match (no normalization): preserves qty/rate/total/allocation
 *   and requires item.unit === standard.unit.
 * - Conversion-aware match: requires normalization; reconstructs operational fields
 *   from normalized decimal strings so canonical snapshot invariants hold.
 */
export function buildCatalogLinkUpdate(input: {
	item: BoqPricedItem;
	standard: StandardEntry;
	confidence: NonNullable<BoqItem["stdConfidence"]>;
	sourceItem: StandardSourceItem;
	matchedAt: string;
	normalization?: PricingNormalization;
}): { item: BoqPricedItem; standard: StandardEntry } {
	const standard = normalizeStandardEntry(structuredClone(input.standard));
	if (standard.archivedAt !== undefined) {
		throw new CatalogLinkError("Archived catalog entries cannot be matched.");
	}
	if (!isPricedBoqItem(input.item)) {
		throw new CatalogLinkError("Only priced BOQ items can be catalog-linked.");
	}

	const itemClone = structuredClone(input.item);
	const sourceItem = { ...input.sourceItem };
	const normalization = input.normalization
		? structuredClone(input.normalization)
		: undefined;

	if (normalization) {
		if (normalization.catalogId !== standard.id) {
			throw new CatalogLinkError(
				"pricingNormalization.catalogId must equal standard.id.",
			);
		}
		// Canonical alias identity may normalize to a unit that differs from the
		// raw stored standard.unit (e.g. Pcs → piece). Persist the normalized unit.
	} else if (itemClone.unit !== standard.unit) {
		throw new CatalogLinkError(
			"Unit change requires validated pricing normalization.",
		);
	}

	const sourceDesc = itemClone.sourceDesc ?? itemClone.desc;
	const sourceUnit = itemClone.sourceUnit ?? itemClone.unit;

	let nextItem: BoqPricedItem = {
		...itemClone,
		desc: standard.description,
		stdId: standard.id,
		stdMatch: standard.description,
		stdStatus: "matched",
		stdConfidence: input.confidence,
		sourceDesc,
		sourceUnit,
	};
	delete nextItem.stdExclusionReason;

	if (normalization) {
		const qty = finiteCompatibilityNumber(
			normalization.normalizedQuantity,
			"normalizedQuantity",
		);
		const materialRate = finiteCompatibilityNumber(
			normalization.normalizedMaterialRate,
			"normalizedMaterialRate",
		);
		const labourRate = finiteCompatibilityNumber(
			normalization.normalizedLabourRate,
			"normalizedLabourRate",
		);
		nextItem = {
			...nextItem,
			unit: normalization.catalogUnit,
			qty,
			pricingNormalization: normalization,
		};
		nextItem = applyManualCostAllocation(nextItem, materialRate, labourRate);
		// Re-attach snapshots that applyManualCostAllocation does not carry through
		// when spreading — it preserves item fields, but be explicit for invariants.
		if (itemClone.extractedPricing) {
			nextItem.extractedPricing = structuredClone(itemClone.extractedPricing);
		}
		if (itemClone.reviewerPricing) {
			nextItem.reviewerPricing = structuredClone(itemClone.reviewerPricing);
		}
		nextItem.pricingNormalization = normalization;
	}

	const nextStandard = mergeStandardSourceItems(
		standard,
		sourceItem,
		input.matchedAt,
	);

	return { item: nextItem, standard: nextStandard };
}
