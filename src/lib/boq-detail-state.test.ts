import assert from "node:assert/strict";
import test from "node:test";
import {
	documentTotalMismatchMessage,
	reconcileBoqMutation,
	selectTotalMismatchMessage,
} from "./boq-detail-state";
import { isPricedBoqItem } from "./boq-pricing";
import type { Boq, BoqPricedItem } from "./boq-schema";

function item(overrides: Partial<BoqPricedItem> = {}): BoqPricedItem {
	return {
		code: "DUP",
		desc: "Source item",
		unit: "m",
		qty: 1,
		rate: 10,
		total: 10,
		type: "unit",
		stdStatus: "unmatched",
		...overrides,
	};
}

function boq(
	itemsBySection: BoqPricedItem[][],
	overrides: Partial<Boq> = {},
): Boq {
	const sections = itemsBySection.map((items, index) => ({
		header: `Section ${index + 1}`,
		items,
	}));
	return {
		id: "boq-1",
		project: "Project",
		vendor: "Vendor",
		workType: "MEP",
		date: "2026-07-19",
		totalItems: sections.reduce(
			(total, section) => total + section.items.length,
			0,
		),
		grandTotal: sections.reduce(
			(total, section) =>
				total + section.items.reduce((sum, row) => sum + row.total, 0),
			0,
		),
		status: "review",
		stdStatus: "partial",
		sections,
		sourceFileName: "legacy.pdf",
		sourceAvailable: false,
		createdAt: "2026-07-19T00:00:00.000Z",
		updatedAt: "2026-07-19T00:00:00.000Z",
		...overrides,
	};
}

test("BOQ detail exposes one mutation reconciliation boundary", () => {
	assert.equal(typeof reconcileBoqMutation, "function");
});

test("mutation responses retain an explicit no-source state when the raw BOQ omits it", () => {
	const previous = boq([[item()]]);
	const incoming = { ...previous };
	delete incoming.sourceAvailable;

	const result = reconcileBoqMutation(previous, incoming, {});

	assert.equal(result.boq.sourceAvailable, false);
	assert.equal(result.boq.sourceFileName, "legacy.pdf");
});

test("an explicit source availability response remains authoritative", () => {
	const previous = boq([[item()]]);
	const incoming = { ...previous, sourceAvailable: true };

	assert.equal(
		reconcileBoqMutation(previous, incoming, {}).boq.sourceAvailable,
		true,
	);
});

test("matching clears only that section-scoped row's stale description and unit edits", () => {
	const previous = boq([
		[item({ desc: "Source A" })],
		[item({ desc: "Source B" })],
	]);
	const incoming = boq([
		[
			item({
				desc: "Canonical A",
				unit: "pcs",
				stdStatus: "matched",
				stdId: "std-a",
				stdMatch: "Canonical A",
				stdConfidence: "manual",
			}),
		],
		[item({ desc: "Source B" })],
	]);
	delete incoming.sourceAvailable;
	const edits = {
		"0-0": { desc: "Stale A", unit: "stale-unit", qty: 12, materialCost: 15 },
		"1-0": { desc: "Keep B", unit: "kg", qty: 7 },
	};

	const result = reconcileBoqMutation(previous, incoming, edits);

	assert.equal(result.boq.sections[0]?.items[0]?.desc, "Canonical A");
	const matched = result.boq.sections[0]?.items[0];
	assert.ok(matched && isPricedBoqItem(matched));
	assert.equal(matched.unit, "pcs");
	assert.deepEqual(result.edits["0-0"], { qty: 12, materialCost: 15 });
	assert.deepEqual(result.edits["1-0"], edits["1-0"]);
	assert.equal(result.boq.sourceAvailable, false);
});

test("changing an existing manual match clears stale canonical edits but retains costs", () => {
	const previous = boq([
		[
			item({
				desc: "Canonical Old",
				stdStatus: "matched",
				stdId: "std-old",
				stdMatch: "Canonical Old",
				stdConfidence: "manual",
			}),
		],
	]);
	const incoming = boq([
		[
			item({
				desc: "Canonical New",
				unit: "kg",
				stdStatus: "matched",
				stdId: "std-new",
				stdMatch: "Canonical New",
				stdConfidence: "manual",
			}),
		],
	]);

	const result = reconcileBoqMutation(previous, incoming, {
		"0-0": { desc: "Stale manual name", unit: "stale-unit", labourCost: 25 },
	});

	assert.deepEqual(result.edits["0-0"], { labourCost: 25 });
});

test("documentTotalMismatchMessage reports source, BOQ, and absolute difference", () => {
	assert.equal(
		documentTotalMismatchMessage(478000, 80584),
		"Source total ฿478,000.00; BOQ items ฿80,584.00; difference ฿397,416.00.",
	);
});

test("documentTotalMismatchMessage returns null without a meaningful mismatch", () => {
	assert.equal(documentTotalMismatchMessage(undefined, 80584), null);
	assert.equal(documentTotalMismatchMessage(100, 100.009), null);
	assert.equal(
		documentTotalMismatchMessage(80, 100),
		"Source total ฿80.00; BOQ items ฿100.00; difference ฿20.00.",
	);
});

test("selectTotalMismatchMessage surfaces the exact quote-summary layer message", () => {
	const exact =
		"Source quote subtotal ฿215,280.00 does not equal direct work ฿179,400.00 plus overhead and profit ฿35,881.00.";
	const issues = [
		{ code: "quote_subtotal_mismatch", severity: "blocking", message: exact },
		{
			code: "quote_direct_total_mismatch",
			severity: "warning",
			message: "ignored warning copy",
		},
	] as const;

	assert.equal(selectTotalMismatchMessage(215_280, 179_400, issues), exact);
	assert.equal(
		selectTotalMismatchMessage(215_280, 179_401, [
			{
				code: "quote_direct_total_mismatch",
				severity: "blocking",
				message:
					"BOQ direct items total ฿179,401.00 and do not match the source quote direct work total ฿179,400.00.",
			},
		] as const),
		"BOQ direct items total ฿179,401.00 and do not match the source quote direct work total ฿179,400.00.",
	);
});

test("selectTotalMismatchMessage keeps the legacy formatted message for legacy BOQs", () => {
	assert.equal(
		selectTotalMismatchMessage(478_000, 80_584, [
			{
				code: "document_total_mismatch",
				severity: "blocking",
				message:
					"Normalized item total does not match the source document total",
			},
		] as const),
		"Source total ฿478,000.00; BOQ items ฿80,584.00; difference ฿397,416.00.",
	);
	assert.equal(selectTotalMismatchMessage(100, 100, [] as const), null);
	assert.equal(
		selectTotalMismatchMessage(100, 100, [
			{
				code: "line_total_mismatch",
				severity: "blocking",
				message: "unrelated blocker",
			},
		] as const),
		null,
	);
});
