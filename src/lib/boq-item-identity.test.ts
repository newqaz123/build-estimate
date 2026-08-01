import assert from "node:assert/strict";
import test from "node:test";

import type { BoqPricedItem } from "./boq-schema";
import {
	getBoqItemIdentity,
	getBoqItemRequestIdentity,
	parseBoqItemRequestIdentity,
	resolveBoqItemIdentity,
} from "./boq-item-identity";

function item(overrides: Partial<BoqPricedItem>): BoqPricedItem {
	return {
		desc: "Item",
		unit: "ea",
		qty: 1,
		rate: 1,
		total: 1,
		type: "unit",
		stdStatus: "unmatched",
		...overrides,
	};
}

test("internal item ID is preferred over a legacy code for identity and requests", () => {
	const value = item({ id: "item-1", code: "A-1" });

	assert.deepEqual(getBoqItemIdentity(value), { kind: "id", value: "item-1" });
	assert.deepEqual(getBoqItemRequestIdentity(value), { itemId: "item-1" });
});

test("legacy code remains a fallback when an item has no internal ID", () => {
	const value = item({ code: "A-1" });

	assert.deepEqual(getBoqItemIdentity(value), { kind: "code", value: "A-1" });
	assert.deepEqual(getBoqItemRequestIdentity(value), { itemCode: "A-1" });
});

test("identity resolution supports code-less imports and rejects duplicate IDs", () => {
	const items = [
		item({ id: "item-1" }),
		item({ id: "item-2" }),
		item({ id: "item-2" }),
	];

	assert.deepEqual(resolveBoqItemIdentity(items, { itemId: "item-1" }), {
		status: "found",
		index: 0,
	});
	assert.deepEqual(resolveBoqItemIdentity(items, { itemId: "item-2" }), {
		status: "ambiguous",
	});
});

test("identity resolution prefers itemId when duplicate legacy codes exist", () => {
	const items = [
		item({ id: "item-1", code: "DUP" }),
		item({ id: "item-2", code: "DUP" }),
	];

	assert.deepEqual(
		resolveBoqItemIdentity(items, { itemId: "item-2", itemCode: "DUP" }),
		{ status: "found", index: 1 },
	);
	assert.deepEqual(resolveBoqItemIdentity(items, { itemCode: "DUP" }), {
		status: "ambiguous",
	});
});

test("identity resolution rejects missing and unknown locators safely", () => {
	const items = [item({ id: "item-1" })];

	assert.deepEqual(resolveBoqItemIdentity(items, {}), { status: "missing" });
	assert.deepEqual(resolveBoqItemIdentity(items, { itemId: "missing" }), {
		status: "not-found",
	});
});

test("request identity parsing accepts IDs and legacy codes but rejects malformed fields", () => {
	assert.deepEqual(
		parseBoqItemRequestIdentity({ itemId: " item-1 ", itemCode: " A-1 " }),
		{
			itemId: "item-1",
			itemCode: "A-1",
		},
	);
	assert.deepEqual(parseBoqItemRequestIdentity({ itemCode: " A-1 " }), {
		itemCode: "A-1",
	});
	assert.equal(parseBoqItemRequestIdentity({}), undefined);
	assert.equal(
		parseBoqItemRequestIdentity({ itemId: null, itemCode: "A-1" }),
		undefined,
	);
});
