import assert from "node:assert/strict";
import test from "node:test";
import {
	canonicalUnit,
	normalizeCatalogText,
	unitMatchKey,
	rankCatalogMatches,
	scoreCatalogTextMatch,
	unitsCompatible,
} from "./standard-matching";

const catalog = [
	{
		id: "std-conc",
		description: "Structural concrete C32/40 columns",
		unit: "m³",
		aliases: ["conc C32/40 col", "  CONC. C32/40 — columns  "],
	},
	{
		id: "std-rebar",
		description: "Reinforcement bar SD40 16mm",
		unit: "ton",
		aliases: ["rebar SD40 16 mm", "steel rebar 16mm"],
	},
	{
		id: "std-formwork",
		description: "Formwork slab",
		unit: "m²",
		aliases: ["slab formwork"],
	},
];

test("normalizes punctuation, dashes, case, and whitespace", () => {
	assert.equal(
		normalizeCatalogText("  Conc. C32/40 — COL  "),
		"conc c32/40 col",
	);
	assert.equal(
		normalizeCatalogText("Steel—beam\tMain\nFrame"),
		"steel beam main frame",
	);
});

test("treats configured unit equivalents as compatible and mismatched units as incompatible", () => {
	assert.equal(unitsCompatible("m2", "m²", { m2: "m²" }), true);
	assert.equal(unitsCompatible("m²", "m2", { m2: "m²" }), true);
	assert.equal(unitsCompatible("ton", "m³", {}), false);
});

test("ranks exact canonical matches above alias and fuzzy matches", () => {
	const result = rankCatalogMatches(
		"Reinforcement bar SD40 16mm",
		"tonne",
		catalog,
		{ tonne: "ton" },
	);

	assert.equal(result[0].id, "std-rebar");
	assert.equal(result[0].matchReason, "exact");
	assert.equal(result[0].unitCompatible, true);
	assert.ok(result[0].score > result[1].score);
});

test("treats normalized aliases as alias matches", () => {
	const result = rankCatalogMatches("Rebar SD40 16 mm", "tonne", catalog, {
		tonne: "ton",
	});

	assert.equal(result[0].id, "std-rebar");
	assert.equal(result[0].matchReason, "alias");
	assert.equal(result[0].unitCompatible, true);
	assert.ok(result[0].score > result[1].score);
});

test("keeps compatible results ahead of incompatible ones when both exist", () => {
	const result = rankCatalogMatches("Slab formwork", "m2", catalog, {
		m2: "m²",
	});

	const compatible = result.filter((entry) => entry.unitCompatible);
	const incompatible = result.filter((entry) => !entry.unitCompatible);

	assert.ok(compatible.length > 0);
	assert.ok(incompatible.length > 0);
	assert.ok(
		result.indexOf(incompatible[0]) >
			result.indexOf(compatible[compatible.length - 1]),
	);
});

test("keeps meaningful fuzzy matches ahead of unrelated same-unit candidates", () => {
	const result = rankCatalogMatches(
		"Slab formwork",
		"m2",
		[
			{
				id: "std-related",
				description: "Slab formwork installation",
				unit: "ton",
				aliases: [],
			},
			{
				id: "std-unrelated",
				description: "Office cleaning",
				unit: "m²",
				aliases: [],
			},
		],
		{ m2: "m²" },
	);

	assert.equal(result[0].id, "std-related");
	assert.equal(result[0].unitCompatible, false);
	assert.ok(result[0].score > result[1].score);
	assert.equal(result[1].id, "std-unrelated");
});

test("sorts deterministically by score then description when scores tie", () => {
	const tieCatalog = [
		{
			id: "std-b",
			description: "Beta item",
			unit: "ton",
			aliases: ["beta variant"],
		},
		{
			id: "std-a",
			description: "Alpha item",
			unit: "ton",
			aliases: ["alpha variant"],
		},
	];

	const result = rankCatalogMatches("item", "ton", tieCatalog, {});

	assert.equal(result[0].description, "Alpha item");
	assert.equal(result[1].description, "Beta item");
});

test("returns an empty list when there are no catalog entries", () => {
	assert.deepEqual(rankCatalogMatches("Anything", "ton", [], {}), []);
});

test("canonicalizes component units through the same unitMap used by matching", () => {
	const unitMap = {
		pcs: "piece",
		pc: "piece",
		db: "joint",
	};

	assert.equal(canonicalUnit(" Pcs. ", unitMap), "piece");
	assert.equal(canonicalUnit("PC", unitMap), "piece");
	assert.equal(canonicalUnit("Db", unitMap), "joint");
	assert.equal(canonicalUnit("Lot", unitMap), "lot");
});

test("exposes pure text match scores without changing rank acceptance", () => {
	assert.deepEqual(
		scoreCatalogTextMatch("Reinforcement bar SD40 16mm", "Reinforcement bar SD40 16mm", []),
		{ score: 300, reason: "exact" },
	);
	assert.deepEqual(
		scoreCatalogTextMatch("Rebar SD40 16 mm", "Reinforcement bar SD40 16mm", [
			"rebar SD40 16 mm",
		]),
		{ score: 200, reason: "alias" },
	);

	const fuzzy = scoreCatalogTextMatch(
		"Slab formwork",
		"Slab formwork installation",
		[],
	);
	assert.equal(fuzzy.reason, "fuzzy");
	assert.ok(fuzzy.score > 100);

	// Existing rankCatalogMatches acceptance remains exact > alias and unit-boosted.
	const ranked = rankCatalogMatches(
		"Reinforcement bar SD40 16mm",
		"tonne",
		catalog,
		{ tonne: "ton" },
	);
	assert.equal(ranked[0].id, "std-rebar");
	assert.equal(ranked[0].matchReason, "exact");
	assert.equal(ranked[0].unitCompatible, true);
	assert.ok(ranked[0].score >= 1300);
});

test("normalizes Thai with marks kept, NFC sara am and decimals intact", () => {
	assert.equal(normalizeCatalogText("ท่อ  สแตนเลส"), "ท่อ สแตนเลส");
	assert.equal(normalizeCatalogText("น\u0e4d\u0e32"), "นำ");
	assert.equal(normalizeCatalogText("Sheet 0.47mm"), "sheet 0.47mm");
	assert.equal(normalizeCatalogText('Pipe 2"'), "pipe 2 in");
	assert.equal(normalizeCatalogText(normalizeCatalogText('Pipe 2" x 0.5')), normalizeCatalogText('Pipe 2" x 0.5'));
});

test("unit compatibility folds built-in synonyms after the workspace unitMap", () => {
	assert.equal(unitMatchKey("ตร.ม.", {}), "m2");
	assert.equal(unitMatchKey("L/S", { LS: "L/S" }), "lot");
	assert.equal(unitMatchKey("No.", {}), "ea");
	assert.equal(unitMatchKey("pcs", { pcs: "piece" }), "piece");
	assert.equal(unitMatchKey("ton", {}), "ton");
	assert.equal(unitsCompatible("เหมา", "L/S", { LS: "L/S" }), true);
	assert.equal(unitsCompatible("ชุด", "Sets", {}), true);
	assert.equal(unitsCompatible("ลบ.ม.", "m³", { m3: "m³" }), true);
	assert.equal(unitsCompatible("m", "m2", {}), false);
	// canonicalUnit keeps the workspace spelling for display and grouping.
	assert.equal(canonicalUnit("pcs", {}), "pcs");
	assert.equal(canonicalUnit("m3", { m3: "m³" }), "m³");
});

test("rejects size/spec conflicts and ranks the agreeing sibling first", () => {
	const catalog = [
		{ id: "a", description: "Elbow 90 SUS304 Sch10S 1B", unit: "ea", aliases: [] },
		{ id: "b", description: "Elbow 90 SUS304 Sch10S 2B", unit: "ea", aliases: [] },
		{ id: "c", description: "Elbow 90 SUS304 Sch40 2B", unit: "ea", aliases: [] },
		{ id: "d", description: "Elbow 90 fitting", unit: "ea", aliases: [] },
	];
	const ranked = rankCatalogMatches("90 deg elbow SUS304 Sch10S 2 inch", "pcs", catalog, {});
	assert.equal(ranked[0].id, "b");
	assert.deepEqual(ranked[0].specAgreements?.sort(), ["material", "schedule", "size"]);
	for (const id of ["a", "c"]) {
		const candidate = ranked.find((entry) => entry.id === id);
		assert.equal(candidate?.score, 0, id);
		assert.equal(candidate?.specConflict, true, id);
	}
	// An unsized entry is not a conflict, but the agreeing sibling outranks it.
	assert.ok((ranked.find((entry) => entry.id === "d")?.score ?? 0) > 0);
	assert.equal(
		scoreCatalogTextMatch("Elbow 90 SUS304 Sch10S 4B", "Elbow 90 SUS304 Sch10S 2B").score,
		0,
	);
});
