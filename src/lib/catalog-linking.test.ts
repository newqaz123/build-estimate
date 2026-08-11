import assert from "node:assert/strict";
import test from "node:test";
import {
	buildCatalogLinkUpdate,
	CatalogLinkError,
	mergeStandardSourceItems,
} from "./catalog-linking";
import { parseCanonicalBoqSections } from "./boq-canonical";
import type { BoqPricedItem } from "./boq-schema";
import type { PricingNormalization } from "./actionable-review-types";
import type { StandardEntry, StandardSourceItem } from "./standard-schema";

function pricedItem(overrides: Partial<BoqPricedItem> = {}): BoqPricedItem {
	return {
		id: "item-1",
		desc: "Site mixed concrete",
		unit: "m3",
		qty: 2,
		rate: 100,
		total: 200,
		type: "unit",
		stdStatus: "unmatched",
		costAllocation: {
			basis: "rate",
			material: 60,
			labour: 40,
			origin: "manual",
		},
		...overrides,
	};
}

function standard(overrides: Partial<StandardEntry> = {}): StandardEntry {
	return {
		id: "std-1",
		description: "Ready-mix concrete",
		unit: "m3",
		aliases: [],
		sourceItems: [],
		sourceBoqCount: 0,
		createdAt: "2026-08-01T00:00:00.000Z",
		updatedAt: "2026-08-01T00:00:00.000Z",
		...overrides,
	};
}

function sourceItem(
	overrides: Partial<StandardSourceItem> = {},
): StandardSourceItem {
	return {
		boqId: "boq-1",
		sectionIndex: 0,
		itemId: "item-1",
		sourceDescription: "Site mixed concrete",
		...overrides,
	};
}

function conversionNormalization(
	overrides: Partial<PricingNormalization> = {},
): PricingNormalization {
	return {
		catalogId: "std-1",
		catalogDescription: "Hex bolts",
		catalogUnit: "10ea",
		ruleId: "rule-1",
		catalogUnitsPerSourceUnit: "10",
		normalizedQuantity: "100",
		normalizedMaterialRate: "0.5",
		normalizedLabourRate: "0.3",
		normalizedTotal: "80",
		...overrides,
	};
}

test("same-unit link preserves source fields and numeric values", () => {
	const item = pricedItem();
	const result = buildCatalogLinkUpdate({
		item,
		standard: standard(),
		confidence: "manual",
		sourceItem: sourceItem(),
		matchedAt: "2026-08-08T12:00:00.000Z",
	});

	assert.equal(result.item.desc, "Ready-mix concrete");
	assert.equal(result.item.unit, "m3");
	assert.equal(result.item.stdId, "std-1");
	assert.equal(result.item.stdMatch, "Ready-mix concrete");
	assert.equal(result.item.stdStatus, "matched");
	assert.equal(result.item.stdConfidence, "manual");
	assert.equal(result.item.sourceDesc, "Site mixed concrete");
	assert.equal(result.item.sourceUnit, "m3");
	assert.equal(result.item.qty, 2);
	assert.equal(result.item.rate, 100);
	assert.equal(result.item.total, 200);
	assert.deepEqual(result.item.costAllocation, {
		basis: "rate",
		material: 60,
		labour: 40,
		origin: "manual",
	});
});

test("source history is deduplicated and count/lastMatched update once", () => {
	const base = standard({
		sourceItems: [sourceItem()],
		sourceBoqCount: 1,
	});
	const first = buildCatalogLinkUpdate({
		item: pricedItem(),
		standard: base,
		confidence: "manual",
		sourceItem: sourceItem({
			boqId: "boq-2",
			itemId: "item-2",
			sourceDescription: "Other concrete",
		}),
		matchedAt: "2026-08-08T12:00:00.000Z",
	});
	assert.equal(first.standard.sourceItems?.length, 2);
	assert.equal(first.standard.sourceBoqCount, 2);
	assert.equal(first.standard.lastMatched, "2026-08-08T12:00:00.000Z");

	const second = buildCatalogLinkUpdate({
		item: pricedItem({ id: "item-2" }),
		standard: first.standard,
		confidence: "manual",
		sourceItem: sourceItem({
			boqId: "boq-2",
			itemId: "item-2",
			sourceDescription: "Other concrete",
		}),
		matchedAt: "2026-08-08T13:00:00.000Z",
	});
	assert.equal(second.standard.sourceItems?.length, 2);
	assert.equal(second.standard.sourceBoqCount, 2);
	assert.equal(second.standard.lastMatched, "2026-08-08T13:00:00.000Z");
});

test("archived standard rejects", () => {
	assert.throws(
		() =>
			buildCatalogLinkUpdate({
				item: pricedItem(),
				standard: standard({ archivedAt: "2026-08-01T00:00:00.000Z" }),
				confidence: "manual",
				sourceItem: sourceItem(),
				matchedAt: "2026-08-08T12:00:00.000Z",
			}),
		CatalogLinkError,
	);
});

test("real unit change without normalization rejects", () => {
	assert.throws(
		() =>
			buildCatalogLinkUpdate({
				item: pricedItem({ unit: "ea", qty: 10, rate: 8, total: 80 }),
				standard: standard({ unit: "10ea", description: "Hex bolts" }),
				confidence: "manual",
				sourceItem: sourceItem({ sourceDescription: "Bolts" }),
				matchedAt: "2026-08-08T12:00:00.000Z",
			}),
		/normalization/i,
	);
});

test("normalized conversion updates operational fields and satisfies canonical invariants", () => {
	const extracted = {
		description: "Bolts",
		unit: "ea",
		quantity: "10",
		materialRate: "5",
		labourRate: "3",
		total: "80",
	};
	const reviewer = {
		...extracted,
		confirmedAt: "2026-08-08T12:00:00.000Z",
		confirmedBy: "user-1",
	};
	const normalization = conversionNormalization();
	const item = pricedItem({
		id: "item-bolts",
		desc: "Bolts",
		unit: "ea",
		qty: 10,
		rate: 8,
		total: 80,
		stdId: undefined,
		extractedPricing: extracted,
		reviewerPricing: reviewer,
		costAllocation: {
			basis: "rate",
			material: 5,
			labour: 3,
			origin: "manual",
		},
	});
	const result = buildCatalogLinkUpdate({
		item,
		standard: standard({
			id: "std-1",
			description: "Hex bolts",
			unit: "10ea",
		}),
		confidence: "manual",
		sourceItem: sourceItem({
			itemId: "item-bolts",
			sourceDescription: "Bolts",
		}),
		matchedAt: "2026-08-08T12:00:00.000Z",
		normalization,
	});

	assert.equal(result.item.unit, "10ea");
	assert.equal(result.item.qty, 100);
	assert.equal(result.item.rate, 0.8);
	assert.equal(result.item.total, 80);
	assert.deepEqual(result.item.costAllocation, {
		basis: "rate",
		material: 0.5,
		labour: 0.3,
		origin: "manual",
	});
	assert.equal(result.item.stdId, "std-1");
	assert.deepEqual(result.item.pricingNormalization, normalization);
	assert.deepEqual(result.item.extractedPricing, extracted);
	assert.deepEqual(result.item.reviewerPricing, reviewer);

	// Canonical sections parser must accept the three-snapshot converted item.
	const [section] = parseCanonicalBoqSections([
		{ header: "Fasteners", items: [result.item] },
	]);
	const canonical = section!.items[0]! as BoqPricedItem;
	assert.equal(canonical.unit, "10ea");
	assert.equal(canonical.total, 80);
	assert.equal(canonical.stdId, "std-1");
});

test("catalog ID mismatch on normalization rejects", () => {
	assert.throws(
		() =>
			buildCatalogLinkUpdate({
				item: pricedItem({
					unit: "ea",
					qty: 10,
					rate: 8,
					total: 80,
					extractedPricing: {
						description: "Bolts",
						unit: "ea",
						quantity: "10",
						materialRate: "5",
						labourRate: "3",
						total: "80",
					},
					reviewerPricing: {
						description: "Bolts",
						unit: "ea",
						quantity: "10",
						materialRate: "5",
						labourRate: "3",
						total: "80",
						confirmedAt: "2026-08-08T12:00:00.000Z",
						confirmedBy: "user-1",
					},
				}),
				standard: standard({ unit: "10ea", description: "Hex bolts" }),
				confidence: "manual",
				sourceItem: sourceItem(),
				matchedAt: "2026-08-08T12:00:00.000Z",
				normalization: conversionNormalization({ catalogId: "other-std" }),
			}),
		/catalogId/i,
	);
});

test("canonical alias normalization may differ from raw standard unit", () => {
	const extracted = {
		description: "Door handle",
		unit: "Pcs",
		quantity: "100",
		materialRate: "5",
		labourRate: "3",
		total: "800",
	};
	const reviewer = {
		...extracted,
		confirmedAt: "2026-08-08T12:00:00.000Z",
		confirmedBy: "user-1",
	};
	// Standard stores the raw alias unit; identity normalization uses canonical.
	const normalization = conversionNormalization({
		catalogDescription: "Door handle",
		catalogUnit: "piece",
		ruleId: "identity:piece:v1",
		catalogUnitsPerSourceUnit: "1",
		normalizedQuantity: "100",
		normalizedMaterialRate: "5",
		normalizedLabourRate: "3",
		normalizedTotal: "800",
	});
	const result = buildCatalogLinkUpdate({
		item: pricedItem({
			id: "item-handle",
			desc: "Door handle",
			unit: "Pcs",
			qty: 100,
			rate: 8,
			total: 800,
			extractedPricing: extracted,
			reviewerPricing: reviewer,
			costAllocation: {
				basis: "rate",
				material: 5,
				labour: 3,
				origin: "manual",
			},
		}),
		standard: standard({
			description: "Door handle",
			unit: "Pcs",
		}),
		confidence: "manual",
		sourceItem: sourceItem({
			itemId: "item-handle",
			sourceDescription: "Door handle",
		}),
		matchedAt: "2026-08-08T12:00:00.000Z",
		normalization,
	});

	assert.equal(result.item.unit, "piece");
	assert.equal(result.item.stdId, "std-1");
	assert.equal(result.item.qty, 100);
	assert.equal(result.item.rate, 8);
	assert.equal(result.item.total, 800);
	assert.deepEqual(result.item.pricingNormalization, normalization);

	const [section] = parseCanonicalBoqSections([
		{ header: "Hardware", items: [result.item] },
	]);
	const canonical = section!.items[0]! as BoqPricedItem;
	assert.equal(canonical.unit, "piece");
	assert.equal(canonical.stdId, "std-1");
});

test("unit change without normalization still rejects", () => {
	assert.throws(
		() =>
			buildCatalogLinkUpdate({
				item: pricedItem({ unit: "Pcs" }),
				standard: standard({ unit: "piece", description: "Door handle" }),
				confidence: "manual",
				sourceItem: sourceItem({ sourceDescription: "Door handle" }),
				matchedAt: "2026-08-08T12:00:00.000Z",
			}),
		/normalization/i,
	);
});

test("buildCatalogLinkUpdate does not mutate inputs", () => {
	const item = pricedItem();
	const std = standard({
		sourceItems: [sourceItem({ boqId: "boq-other", itemId: "x" })],
		sourceBoqCount: 1,
	});
	const src = sourceItem();
	const itemBefore = structuredClone(item);
	const stdBefore = structuredClone(std);
	const srcBefore = structuredClone(src);

	buildCatalogLinkUpdate({
		item,
		standard: std,
		confidence: "manual",
		sourceItem: src,
		matchedAt: "2026-08-08T12:00:00.000Z",
	});

	assert.deepEqual(item, itemBefore);
	assert.deepEqual(std, stdBefore);
	assert.deepEqual(src, srcBefore);
});

test("mergeStandardSourceItems remains available and pure", () => {
	const merged = mergeStandardSourceItems(
		standard(),
		sourceItem(),
		"2026-08-08T12:00:00.000Z",
	);
	assert.equal(merged.sourceItems?.length, 1);
	assert.equal(merged.lastMatched, "2026-08-08T12:00:00.000Z");
});
