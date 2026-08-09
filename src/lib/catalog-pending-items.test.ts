import assert from "node:assert/strict";
import test from "node:test";

import type { Boq, BoqItem, BoqPricedItem } from "./boq-schema";
import { getBoqCatalogReadiness } from "./boq-catalog-readiness";
import { catalogPendingItems } from "./catalog-pending-items";

const now = "2026-07-17T00:00:00.000Z";

function item(overrides: Partial<BoqPricedItem> = {}): BoqPricedItem {
	return {
		id: "item-1",
		desc: "Stainless steel pipe 6 inch",
		unit: "m",
		qty: 10,
		rate: 100,
		total: 1000,
		type: "unit",
		stdStatus: "pending",
		...overrides,
	};
}

function boq(items: BoqItem[]): Boq {
	return {
		id: "boq-1",
		project: "Plant extension",
		vendor: "Vendor A",
		workType: "MEP",
		date: "2026-07-17",
		totalItems: items.length,
		grandTotal: 1000,
		status: "draft",
		stdStatus: "partial",
		sections: [{ header: "Pipework", items }],
		createdAt: now,
		updatedAt: now,
	};
}

test("returns only positive-rate priced items that are still pending or unmatched", () => {
	const rows = catalogPendingItems(
		boq([
			item({ id: "pending", desc: "Pending pipe", stdStatus: "pending" }),
			item({ id: "unmatched", desc: "Unmatched pipe", stdStatus: "unmatched" }),
		]),
	);

	assert.equal(rows.length, 2);
	assert.deepEqual(
		rows.map((row) => row.item.id),
		["pending", "unmatched"],
	);
	assert.equal(rows[0]!.sectionIndex, 0);
	assert.equal(rows[0]!.itemIndex, 0);
	assert.ok(rows[0]!.key.startsWith("section:0:"));
});

test("excludes items matched to a standard id", () => {
	const rows = catalogPendingItems(
		boq([
			item({ id: "matched", stdStatus: "matched", stdId: "std-1" }),
			item({ id: "pending", stdStatus: "pending" }),
		]),
	);

	assert.deepEqual(
		rows.map((row) => row.item.id),
		["pending"],
	);
});

test("keeps a matched status blocking when the catalog id is missing or blank", () => {
	const rows = catalogPendingItems(
		boq([
			item({ id: "broken", stdStatus: "matched", stdId: undefined }),
			item({ id: "blank", stdStatus: "matched", stdId: "   " }),
		]),
	);

	assert.deepEqual(
		rows.map((row) => row.item.id),
		["broken", "blank"],
	);
});

test("excludes items with an excluded standard status", () => {
	const rows = catalogPendingItems(
		boq([
			item({
				id: "excluded",
				stdStatus: "excluded",
				stdExclusionReason: "One-off provisional allowance",
			}),
			item({ id: "pending", stdStatus: "pending" }),
		]),
	);

	assert.deepEqual(
		rows.map((row) => row.item.id),
		["pending"],
	);
});

test("excludes zero and negative-rate rows", () => {
	const rows = catalogPendingItems(
		boq([
			item({ id: "zero", rate: 0, total: 0, stdStatus: "pending" }),
			item({ id: "negative", rate: -5, total: -50, stdStatus: "pending" }),
			item({ id: "priced", rate: 100, stdStatus: "pending" }),
		]),
	);

	assert.deepEqual(
		rows.map((row) => row.item.id),
		["priced"],
	);
});

test("excludes informational bundle children", () => {
	const rows = catalogPendingItems(
		boq([
			item({
				id: "bundle",
				pricingRole: "bundle_parent",
				stdStatus: "pending",
			}),
			{
				id: "child",
				pricingRole: "bundle_child",
				parentBundleId: "bundle",
				desc: "Bundle component",
				stdStatus: "pending",
			},
		]),
	);

	assert.deepEqual(
		rows.map((row) => row.item.id),
		["bundle"],
	);
});

test("returns unified priced rows across multiple sections preserving order", () => {
	const multi: Boq = {
		...boq([]),
		sections: [
			{ header: "First", items: [item({ id: "a", stdStatus: "pending" })] },
			{
				header: "Second",
				items: [
					item({ id: "b", stdStatus: "matched", stdId: "std-1" }),
					item({ id: "c", stdStatus: "pending" }),
				],
			},
		],
	};

	const rows = catalogPendingItems(multi);

	assert.deepEqual(
		rows.map((row) => ({ id: row.item.id, section: row.sectionIndex })),
		[
			{ id: "a", section: 0 },
			{ id: "c", section: 1 },
		],
	);
});

test("mirrors getBoqCatalogReadiness blocking count", () => {
	const ready = boq([
		item({ id: "pending", stdStatus: "pending" }),
		item({ id: "matched", stdStatus: "matched", stdId: "std-1" }),
		item({ id: "excluded", stdStatus: "excluded" }),
		item({ id: "zero", rate: 0, total: 0, stdStatus: "pending" }),
	]);

	assert.equal(
		catalogPendingItems(ready).length,
		getBoqCatalogReadiness(ready).blocking,
	);
});
