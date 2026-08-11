import assert from "node:assert/strict";
import test from "node:test";
import { prepareActionableAddAndMatch } from "./actionable-review-match";
import { buildActionablePricingFieldDeltas } from "./boq-extraction-acceptance";
import {
	CatalogConversionError,
	type HumanApprovedCatalogConversionRule,
} from "./catalog-conversion";
import type { ActionableItemSuggestion } from "./actionable-review-projection";
import type { StandardEntry } from "./standard-schema";
import type {
	SourceBackedItemRequest,
	ValidatedSourceMapping,
} from "./boq-user-entry";

const ACTOR = "reviewer-1";
const NOW = "2026-08-11T00:00:00Z";

function makeSuggestion(
	overrides?: Partial<ActionableItemSuggestion>,
): ActionableItemSuggestion {
	return {
		id: "sug-1",
		extractionRunId: "run-1",
		sourceRowIds: ["row-1"],
		sourceRefs: [{ sourceRowId: "row-1", page: 1, table: 0, row: 0 }],
		rowRole: "priced_item",
		deterministicReasons: [],
		suggestedSectionIndex: 0,
		extractedItem: {
			description: "Concrete slab",
			unit: "m2",
			quantity: "100",
			materialRate: "5",
			labourRate: "3",
			total: "800",
		},
		catalogCandidates: [],
		status: "pending",
		versions: {
			extractionFingerprint: "sha256:" + "a".repeat(64),
			boqSectionsFingerprint: "sha256:" + "b".repeat(64),
			catalogFingerprint: "sha256:" + "c".repeat(64),
			conversionFingerprint: "sha256:" + "d".repeat(64),
			promptVersion: "v1",
		},
		...overrides,
	} as ActionableItemSuggestion;
}

function makeSourceMapping(): ValidatedSourceMapping {
	return {
		sourceRowId: "row-1",
		sourceRowIds: ["row-1"],
	};
}

function makeExtractedPricing(
	overrides?: Partial<{
		description: string;
		unit: string;
		quantity: string;
		materialRate: string;
		labourRate: string;
		total: string;
	}>,
) {
	return {
		description: "Concrete slab",
		unit: "m2",
		quantity: "100",
		materialRate: "5",
		labourRate: "3",
		total: "800",
		...overrides,
	};
}

function makeCatalog(overrides?: Partial<StandardEntry>): StandardEntry {
	return {
		id: "std-1",
		description: "Reinforced concrete slab",
		unit: "m2",
		aliases: [],
		sourceBoqCount: 0,
		createdAt: "",
		updatedAt: "",
		...overrides,
	};
}

function makeUserValues(
	overrides?: Partial<SourceBackedItemRequest>,
): SourceBackedItemRequest {
	return {
		sectionIndex: 0,
		desc: "Concrete slab",
		unit: "m2",
		qty: 100,
		materialCost: 5,
		labourCost: 3,
		...overrides,
	};
}

function makeRule(
	overrides?: Partial<HumanApprovedCatalogConversionRule>,
): HumanApprovedCatalogConversionRule {
	return {
		id: "rule-1",
		sourceUnit: "ea",
		catalogUnit: "10ea",
		catalogUnitsPerSourceUnit: "10",
		scope: "global",
		version: 1,
		approvedBy: "admin",
		approvedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Success cases
// ---------------------------------------------------------------------------

test("same-unit identity match resolves identity rule when conversionRuleId omitted", () => {
	const result = prepareActionableAddAndMatch({
		suggestion: makeSuggestion(),
		immutableSource: {
			sourceMapping: makeSourceMapping(),
			extractedPricing: makeExtractedPricing(),
		},
		catalog: makeCatalog(),
		userValues: makeUserValues(),
		actorId: ACTOR,
		confirmedAt: NOW,
		unitMap: {},
		currencyScale: 2,
	});

	assert.equal(result.pricingNormalization.ruleId, "identity:m2:v1");
	assert.equal(result.pricingNormalization.catalogUnitsPerSourceUnit, "1");
	assert.equal(result.reviewerPricing.correctionReason, undefined);
	assert.equal(result.decision.action, "add_and_match");
	assert.equal(result.decision.catalogId, "std-1");
	assert.equal("conversionRuleId" in result.decision, false);
});

test("canonically equal alias units resolve to identity while keeping reviewer unit raw", () => {
	// Reviewer confirmed "Pcs"; catalog uses "piece". The unitMap bridges the
	// alias, so units are canonically equal even though the raw strings differ.
	const aliasPricing = makeExtractedPricing({
		description: "Door handle",
		unit: "Pcs",
		quantity: "100",
		materialRate: "5",
		labourRate: "3",
		total: "800",
	});
	const result = prepareActionableAddAndMatch({
		suggestion: makeSuggestion({ extractedItem: aliasPricing }),
		immutableSource: {
			sourceMapping: makeSourceMapping(),
			extractedPricing: aliasPricing,
		},
		catalog: makeCatalog({ description: "Door handle", unit: "piece" }),
		userValues: makeUserValues({
			desc: "Door handle",
			unit: "Pcs",
			qty: 100,
			materialCost: 5,
			labourCost: 3,
		}),
		unitMap: { pcs: "piece" },
		actorId: ACTOR,
		confirmedAt: NOW,
		currencyScale: 2,
	});

	// Identity rule is minted from the CANONICAL unit ("piece"), not the raw
	// "Pcs", matching actionable-review-projection.ts.
	assert.equal(result.pricingNormalization.ruleId, "identity:piece:v1");
	assert.equal(result.pricingNormalization.catalogUnit, "piece");
	assert.equal(result.pricingNormalization.catalogUnitsPerSourceUnit, "1");
	// reviewerPricing.unit is kept raw as the reviewer confirmed it.
	assert.equal(result.reviewerPricing.unit, "Pcs");
	assert.equal(result.decision.action, "add_and_match");
	assert.equal("conversionRuleId" in result.decision, false);
});

test("global conversion rule normalizes reviewer pricing to catalog units", () => {
	const result = prepareActionableAddAndMatch({
		suggestion: makeSuggestion({
			extractedItem: makeExtractedPricing({
				description: "Bolts",
				unit: "ea",
				quantity: "10",
				materialRate: "5",
				labourRate: "3",
				total: "80",
			}),
		}),
		immutableSource: {
			sourceMapping: makeSourceMapping(),
			extractedPricing: makeExtractedPricing({
				description: "Bolts",
				unit: "ea",
				quantity: "10",
				materialRate: "5",
				labourRate: "3",
				total: "80",
			}),
		},
		catalog: makeCatalog({ description: "Hex bolts", unit: "10ea" }),
		conversion: makeRule(),
		userValues: makeUserValues({
			desc: "Bolts",
			unit: "ea",
			qty: 10,
			materialCost: 5,
			labourCost: 3,
		}),
		actorId: ACTOR,
		confirmedAt: NOW,
		unitMap: {},
		currencyScale: 2,
	});

	assert.equal(result.pricingNormalization.ruleId, "rule-1");
	assert.equal(result.pricingNormalization.normalizedQuantity, "100");
	assert.equal(result.pricingNormalization.catalogUnit, "10ea");
	assert.equal(result.decision.conversionRuleId, "rule-1");
});

test("catalog-item conversion rule matches when catalogId aligns", () => {
	const result = prepareActionableAddAndMatch({
		suggestion: makeSuggestion({
			extractedItem: makeExtractedPricing({
				description: "Bolts",
				unit: "ea",
				quantity: "10",
				materialRate: "5",
				labourRate: "3",
				total: "80",
			}),
		}),
		immutableSource: {
			sourceMapping: makeSourceMapping(),
			extractedPricing: makeExtractedPricing({
				description: "Bolts",
				unit: "ea",
				quantity: "10",
				materialRate: "5",
				labourRate: "3",
				total: "80",
			}),
		},
		catalog: makeCatalog({ description: "Hex bolts", unit: "10ea" }),
		conversion: makeRule({
			id: "rule-item-1",
			scope: "catalog_item",
			catalogId: "std-1",
		}),
		userValues: makeUserValues({
			desc: "Bolts",
			unit: "ea",
			qty: 10,
			materialCost: 5,
			labourCost: 3,
		}),
		actorId: ACTOR,
		confirmedAt: NOW,
		unitMap: {},
		currencyScale: 2,
	});

	assert.equal(result.pricingNormalization.ruleId, "rule-item-1");
	assert.equal(result.decision.conversionRuleId, "rule-item-1");
});

test("material and labour rates are normalized independently", () => {
	const result = prepareActionableAddAndMatch({
		suggestion: makeSuggestion({
			extractedItem: makeExtractedPricing({
				description: "Bolts",
				unit: "ea",
				quantity: "10",
				materialRate: "5",
				labourRate: "3",
				total: "80",
			}),
		}),
		immutableSource: {
			sourceMapping: makeSourceMapping(),
			extractedPricing: makeExtractedPricing({
				description: "Bolts",
				unit: "ea",
				quantity: "10",
				materialRate: "5",
				labourRate: "3",
				total: "80",
			}),
		},
		catalog: makeCatalog({ description: "Hex bolts", unit: "10ea" }),
		conversion: makeRule(),
		userValues: makeUserValues({
			desc: "Bolts",
			unit: "ea",
			qty: 10,
			materialCost: 5,
			labourCost: 3,
		}),
		actorId: ACTOR,
		confirmedAt: NOW,
		unitMap: {},
		currencyScale: 2,
	});

	assert.equal(result.pricingNormalization.normalizedMaterialRate, "0.5");
	assert.equal(result.pricingNormalization.normalizedLabourRate, "0.3");
});

test("reviewer-confirmed and normalized totals are preserved", () => {
	const result = prepareActionableAddAndMatch({
		suggestion: makeSuggestion({
			extractedItem: makeExtractedPricing({
				description: "Bolts",
				unit: "ea",
				quantity: "10",
				materialRate: "5",
				labourRate: "3",
				total: "80",
			}),
		}),
		immutableSource: {
			sourceMapping: makeSourceMapping(),
			extractedPricing: makeExtractedPricing({
				description: "Bolts",
				unit: "ea",
				quantity: "10",
				materialRate: "5",
				labourRate: "3",
				total: "80",
			}),
		},
		catalog: makeCatalog({ description: "Hex bolts", unit: "10ea" }),
		conversion: makeRule(),
		userValues: makeUserValues({
			desc: "Bolts",
			unit: "ea",
			qty: 10,
			materialCost: 5,
			labourCost: 3,
		}),
		actorId: ACTOR,
		confirmedAt: NOW,
		unitMap: {},
		currencyScale: 2,
	});

	assert.equal(result.reviewerPricing.total, "80");
	assert.equal(result.pricingNormalization.normalizedTotal, "80");
});

test("unchanged extracted and reviewer values require no correction reason", () => {
	const result = prepareActionableAddAndMatch({
		suggestion: makeSuggestion(),
		immutableSource: {
			sourceMapping: makeSourceMapping(),
			extractedPricing: makeExtractedPricing(),
		},
		catalog: makeCatalog(),
		userValues: makeUserValues(),
		actorId: ACTOR,
		confirmedAt: NOW,
		unitMap: {},
		currencyScale: 2,
	});

	assert.equal(result.reviewerPricing.correctionReason, undefined);
	const deltas = buildActionablePricingFieldDeltas(
		result.extractedPricing,
		result.reviewerPricing,
	);
	assert.equal(deltas.length, 0);
});

test("numeric divergence requires a correction reason", () => {
	assert.throws(
		() =>
			prepareActionableAddAndMatch({
				suggestion: makeSuggestion(),
				immutableSource: {
					sourceMapping: makeSourceMapping(),
					extractedPricing: makeExtractedPricing(),
				},
				catalog: makeCatalog(),
				userValues: makeUserValues({ qty: 110 }),
				actorId: ACTOR,
				confirmedAt: NOW,
				unitMap: {},
				currencyScale: 2,
			}),
		Error,
	);
});

test("numeric divergence with correction reason produces field-level deltas", () => {
	const result = prepareActionableAddAndMatch({
		suggestion: makeSuggestion(),
		immutableSource: {
			sourceMapping: makeSourceMapping(),
			extractedPricing: makeExtractedPricing(),
		},
		catalog: makeCatalog(),
		userValues: makeUserValues({ qty: 110 }),
		correctionReason: "Quantity adjusted after site review",
		actorId: ACTOR,
		confirmedAt: NOW,
		unitMap: {},
		currencyScale: 2,
	});

	assert.equal(
		result.reviewerPricing.correctionReason,
		"Quantity adjusted after site review",
	);
	const deltas = buildActionablePricingFieldDeltas(
		result.extractedPricing,
		result.reviewerPricing,
	);
	assert.ok(deltas.length > 0);
	const fields = deltas.map((d) => d.field);
	assert.ok(fields.includes("quantity"));
	assert.ok(fields.includes("total"));
});

test("prepared item carries all three pricing snapshots and catalog match metadata", () => {
	const result = prepareActionableAddAndMatch({
		suggestion: makeSuggestion(),
		immutableSource: {
			sourceMapping: makeSourceMapping(),
			extractedPricing: makeExtractedPricing(),
		},
		catalog: makeCatalog(),
		userValues: makeUserValues(),
		actorId: ACTOR,
		confirmedAt: NOW,
		unitMap: {},
		currencyScale: 2,
	});

	assert.equal(result.item.stdStatus, "matched");
	assert.equal(result.item.stdId, "std-1");
	assert.equal(result.item.stdMatch, "Reinforced concrete slab");
	assert.equal(result.item.stdConfidence, "manual");
	assert.deepEqual(result.item.extractedPricing, makeExtractedPricing());
	assert.ok(result.item.reviewerPricing !== undefined);
	assert.ok(result.item.pricingNormalization !== undefined);
});

test("catalogSourceItem carries boqId, sectionIndex, and source description", () => {
	const result = prepareActionableAddAndMatch({
		suggestion: makeSuggestion(),
		immutableSource: {
			sourceMapping: makeSourceMapping(),
			extractedPricing: makeExtractedPricing(),
		},
		catalog: makeCatalog(),
		userValues: makeUserValues({ sectionIndex: 2 }),
		actorId: ACTOR,
		confirmedAt: NOW,
		unitMap: {},
		currencyScale: 2,
	});

	assert.equal(result.catalogSourceItem.boqId, "run-1");
	assert.equal(result.catalogSourceItem.sectionIndex, 2);
	assert.equal(result.catalogSourceItem.sourceDescription, "Concrete slab");
});

test("extractedPricing is kept immutable from the resolved source", () => {
	const original = makeExtractedPricing();
	const result = prepareActionableAddAndMatch({
		suggestion: makeSuggestion(),
		immutableSource: {
			sourceMapping: makeSourceMapping(),
			extractedPricing: original,
		},
		catalog: makeCatalog(),
		userValues: makeUserValues(),
		actorId: ACTOR,
		confirmedAt: NOW,
		unitMap: {},
		currencyScale: 2,
	});

	assert.equal(result.extractedPricing, original);
});

// ---------------------------------------------------------------------------
// Failure cases
// ---------------------------------------------------------------------------

test("unknown conversion rule (units do not bridge) fails", () => {
	assert.throws(
		() =>
			prepareActionableAddAndMatch({
				suggestion: makeSuggestion(),
				immutableSource: {
					sourceMapping: makeSourceMapping(),
					extractedPricing: makeExtractedPricing(),
				},
				catalog: makeCatalog(),
				conversion: makeRule({
					sourceUnit: "kg",
					catalogUnit: "g",
				}),
				userValues: makeUserValues(),
				actorId: ACTOR,
				confirmedAt: NOW,
				unitMap: {},
				currencyScale: 2,
			}),
		CatalogConversionError,
	);
});

test("missing conversion for incompatible units fails", () => {
	assert.throws(
		() =>
			prepareActionableAddAndMatch({
				suggestion: makeSuggestion(),
				immutableSource: {
					sourceMapping: makeSourceMapping(),
					extractedPricing: makeExtractedPricing(),
				},
				catalog: makeCatalog({ unit: "kg" }),
				userValues: makeUserValues({ unit: "m2" }),
				actorId: ACTOR,
				confirmedAt: NOW,
				unitMap: {},
				currencyScale: 2,
			}),
		CatalogConversionError,
	);
});

test("canonically unequal units with no rule still fail closed", () => {
	// "Pcs" maps to "piece" but the catalog unit "kg" does not bridge to it,
	// so the units remain canonically unequal and normalization fails closed.
	const aliasPricing = makeExtractedPricing({ unit: "Pcs" });
	assert.throws(
		() =>
			prepareActionableAddAndMatch({
				suggestion: makeSuggestion({ extractedItem: aliasPricing }),
				immutableSource: {
					sourceMapping: makeSourceMapping(),
					extractedPricing: aliasPricing,
				},
				catalog: makeCatalog({ unit: "kg" }),
				userValues: makeUserValues({ unit: "Pcs" }),
				unitMap: { pcs: "piece" },
				actorId: ACTOR,
				confirmedAt: NOW,
				currencyScale: 2,
			}),
		CatalogConversionError,
	);
});

test("archived catalog fails", () => {
	assert.throws(
		() =>
			prepareActionableAddAndMatch({
				suggestion: makeSuggestion(),
				immutableSource: {
					sourceMapping: makeSourceMapping(),
					extractedPricing: makeExtractedPricing(),
				},
				catalog: makeCatalog({ archivedAt: "2026-01-01T00:00:00Z" }),
				userValues: makeUserValues(),
				actorId: ACTOR,
				confirmedAt: NOW,
				unitMap: {},
				currencyScale: 2,
			}),
		CatalogConversionError,
	);
});

test("archived conversion rule fails", () => {
	assert.throws(
		() =>
			prepareActionableAddAndMatch({
				suggestion: makeSuggestion({
					extractedItem: makeExtractedPricing({
						description: "Bolts",
						unit: "ea",
						quantity: "10",
						materialRate: "5",
						labourRate: "3",
						total: "80",
					}),
				}),
				immutableSource: {
					sourceMapping: makeSourceMapping(),
					extractedPricing: makeExtractedPricing({
						description: "Bolts",
						unit: "ea",
						quantity: "10",
						materialRate: "5",
						labourRate: "3",
						total: "80",
					}),
				},
				catalog: makeCatalog({ description: "Hex bolts", unit: "10ea" }),
				conversion: makeRule({ archivedAt: "2026-01-01T00:00:00Z" }),
				userValues: makeUserValues({
					desc: "Bolts",
					unit: "ea",
					qty: 10,
					materialCost: 5,
					labourCost: 3,
				}),
				actorId: ACTOR,
				confirmedAt: NOW,
				unitMap: {},
				currencyScale: 2,
			}),
		CatalogConversionError,
	);
});

test("wrong-scope conversion rule fails", () => {
	assert.throws(
		() =>
			prepareActionableAddAndMatch({
				suggestion: makeSuggestion({
					extractedItem: makeExtractedPricing({
						description: "Bolts",
						unit: "ea",
						quantity: "10",
						materialRate: "5",
						labourRate: "3",
						total: "80",
					}),
				}),
				immutableSource: {
					sourceMapping: makeSourceMapping(),
					extractedPricing: makeExtractedPricing({
						description: "Bolts",
						unit: "ea",
						quantity: "10",
						materialRate: "5",
						labourRate: "3",
						total: "80",
					}),
				},
				catalog: makeCatalog({ description: "Hex bolts", unit: "10ea" }),
				conversion: makeRule({
					scope: "catalog_item",
					catalogId: "std-other",
				}),
				userValues: makeUserValues({
					desc: "Bolts",
					unit: "ea",
					qty: 10,
					materialCost: 5,
					labourCost: 3,
				}),
				actorId: ACTOR,
				confirmedAt: NOW,
				unitMap: {},
				currencyScale: 2,
			}),
		CatalogConversionError,
	);
});

test("exact arithmetic failure (mismatched totals) fails", () => {
	assert.throws(
		() =>
			prepareActionableAddAndMatch({
				suggestion: makeSuggestion({
					extractedItem: makeExtractedPricing({
						description: "Widget",
						unit: "ea",
						quantity: "1",
						materialRate: "1",
						labourRate: "0",
						total: "1",
					}),
				}),
				immutableSource: {
					sourceMapping: makeSourceMapping(),
					extractedPricing: makeExtractedPricing({
						description: "Widget",
						unit: "ea",
						quantity: "1",
						materialRate: "1",
						labourRate: "0",
						total: "1",
					}),
				},
				catalog: makeCatalog({ description: "Widget", unit: "3ea" }),
				conversion: makeRule({
					sourceUnit: "ea",
					catalogUnit: "3ea",
					catalogUnitsPerSourceUnit: "3",
				}),
				userValues: makeUserValues({
					desc: "Widget",
					unit: "ea",
					qty: 1,
					materialCost: 1,
					labourCost: 0,
				}),
				actorId: ACTOR,
				confirmedAt: NOW,
				unitMap: {},
				currencyScale: 6,
			}),
		CatalogConversionError,
	);
});
