import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
	BoqInformationalItem,
	BoqPricedItem,
	BoqSection,
} from "@/lib/boq-schema";
import { buildUnifiedBoqSections } from "@/lib/boq-unified-rows";
import type { InlineCatalogRowState } from "./use-inline-catalog-matching";
import { UnifiedBoqItemsTable } from "./unified-boq-items-table";

const tableSource = readFileSync(
	new URL("./unified-boq-items-table.tsx", import.meta.url),
	"utf8",
);
const globalsSource = readFileSync(
	new URL("../app/globals.css", import.meta.url),
	"utf8",
);

function item(overrides: Partial<BoqPricedItem> = {}): BoqPricedItem {
	return {
		id: "item-1",
		desc: "Valve installation",
		unit: "Pcs",
		qty: 8,
		rate: 100,
		total: 800,
		type: "unit",
		costComponent: "combined",
		stdStatus: "unmatched",
		...overrides,
	};
}

function bundleChild(
	overrides: Partial<BoqInformationalItem> = {},
): BoqInformationalItem {
	return {
		id: "bundle-child-1",
		desc: "Informational bundle component",
		pricingRole: "bundle_child",
		parentBundleId: "bundle-parent-1",
		stdStatus: "excluded",
		...overrides,
	};
}

function renderTable(
	sections: BoqSection[],
	{
		catalogState = () => ({ suggestion: null, busy: null, error: null }),
		onIncludeOptional = () => undefined,
		onDelete = () => undefined,
		readOnly = false,
		disabled = false,
		onComponentDraftValidityChange = () => undefined,
		units = ["m³", "m²", "Pcs"],
		onAddUnit = () => undefined,
	}: {
		catalogState?: (row: { item: BoqPricedItem }) => InlineCatalogRowState;
		onIncludeOptional?: (row: unknown) => void;
		onDelete?: (row: unknown) => void;
		readOnly?: boolean;
		disabled?: boolean;
		onComponentDraftValidityChange?: (key: string, isInvalid: boolean) => void;
		units?: string[];
		onAddUnit?: (unit: string) => void;
	} = {},
): string {
	const noopRow = () => undefined;
	return renderToStaticMarkup(
		createElement(UnifiedBoqItemsTable, {
			sections: buildUnifiedBoqSections(sections),
			readOnly,
			disabled,
			catalogState,
			onFieldChange: () => undefined,
			onAcceptSuggestion: noopRow,
			onAiSuggest: noopRow,
			onDismissSuggestion: noopRow,
			onFindMatch: noopRow,
			onExclude: noopRow,
			onIncludeOptional,
			onDelete,
			onComponentDraftValidityChange,
			units,
			onAddUnit,
		}),
	);
}

test("keeps rate visible in the canonical BOQ columns and removes legacy row details", () => {
	const html = renderTable([{ header: "Valves", items: [item()] }]);
	const headers = [...html.matchAll(/<th[^>]*>(.*?)<\/th>/g)].map((match) =>
		match[1].replace(/<[^>]+>/g, ""),
	);

	assert.deepEqual(headers, [
		"Description",
		"Unit",
		"Qty",
		"Rate",
		"Material",
		"Labour",
		"Total",
		"Catalog",
		"",
	]);
	assert.equal(headers.includes("Type"), false);
	assert.equal(headers.includes("Code"), false);
	assert.match(html, /aria-label="Rate for Valve installation, row 1"/);
	assert.match(html, /unified-boq-rate-value/);
	assert.match(html, />100</);
	assert.doesNotMatch(
		html,
		/Row details|Aggregate rate|aria-label="Code|aria-label="Type/,
	);
	const qtyInput =
		html.match(
			/<input[^>]*aria-label="Quantity for Valve installation, row 1"[^>]*>/,
		)?.[0] ?? "";
	assert.match(qtyInput, /type="text"/);
	assert.match(qtyInput, /inputmode="decimal"/i);
	assert.doesNotMatch(qtyInput, /type="number"/);
});

test("renders the unit combobox trigger instead of a bare unit input", () => {
	const html = renderTable([
		{ header: "Valves", items: [item({ unit: "Pcs" })] },
	]);
	assert.match(html, /unit-combobox-trigger/);
	assert.match(html, /aria-label="Unit for Valve installation, row 1"/);
	assert.doesNotMatch(
		html,
		/<input[^>]*aria-label="Unit for Valve installation, row 1"/,
	);
});

test("excluded optional rows expose an explicit include-in-total action while read-only rows do not", () => {
	const html = renderTable([
		{
			header: "Options",
			items: [item({ optional: true, excludedFromTotal: true })],
		},
	]);
	assert.match(html, /Optional · excluded from total/);
	assert.match(html, />Include in total</);
});

test("shows non-priced bundle children without matching or counting them twice", () => {
	let catalogLookups = 0;
	const html = renderTable(
		[
			{
				header: "Bundle",
				items: [
					item({
						id: "bundle-parent-1",
						pricingRole: "bundle_parent",
						desc: "Priced bundle",
						total: 800,
					}),
					bundleChild(),
				],
			},
		],
		{
			catalogState: () => {
				catalogLookups += 1;
				return { suggestion: null, busy: null, error: null };
			},
		},
	);

	assert.match(html, /Informational bundle component/);
	assert.match(html, /Bundle component · included in the parent price/);
	assert.match(html, />Included</);
	assert.match(html, />Informational</);
	assert.equal(catalogLookups, 1);
});

test("keeps separate material and labour rows with independent quantity and unit inputs", () => {
	const html = renderTable([
		{
			header: "Valve work",
			items: [
				item({
					id: "material",
					desc: "Stub-end 6B",
					unit: "Pcs",
					qty: 8,
					rate: 2808,
					total: 22464,
					costComponent: "material",
				}),
				item({
					id: "labour",
					desc: "Stub-end 6B",
					unit: "Db",
					qty: 48,
					rate: 300,
					total: 14400,
					costComponent: "labour",
				}),
			],
		},
	]);

	assert.match(
		html,
		/aria-label="Quantity for Stub-end 6B, row 1"[^>]*value="8"/,
	);
	assert.match(
		html,
		/aria-label="Unit for Stub-end 6B, row 1"[\s\S]*?unit-combobox-value">Pcs</,
	);
	assert.match(
		html,
		/aria-label="Quantity for Stub-end 6B, row 2"[^>]*value="48"/,
	);
	assert.match(
		html,
		/aria-label="Unit for Stub-end 6B, row 2"[\s\S]*?unit-combobox-value">Db</,
	);
});

test("separate component rows render only the applicable component input and lock the rate", () => {
	const html = renderTable([
		{
			header: "Valve work",
			items: [
				item({
					id: "material",
					desc: "Valve component",
					rate: 999,
					total: 7992,
					costComponent: "material",
					costAllocation: {
						basis: "rate",
						material: 2808,
						labour: 0,
						origin: "source",
					},
				}),
				item({
					id: "labour",
					desc: "Valve component",
					rate: 777,
					total: 6216,
					costComponent: "labour",
					costAllocation: {
						basis: "rate",
						material: 0,
						labour: 300,
						origin: "source",
					},
				}),
			],
		},
	]);

	assert.match(
		html,
		/aria-label="Material for Valve component, row 1"[^>]*value="2808.00"/,
	);
	assert.match(
		html,
		/aria-label="Labour for Valve component, row 2"[^>]*value="300.00"/,
	);
	const materialRow =
		html.match(/<tr[^>]*data-row-key="[^"]*id:material"[\s\S]*?<\/tr>/)?.[0] ??
		"";
	const labourRow =
		html.match(/<tr[^>]*data-row-key="[^"]*id:labour"[\s\S]*?<\/tr>/)?.[0] ??
		"";
	assert.match(materialRow, /unified-boq-rate-value[^>]*>999</);
	assert.match(labourRow, /unified-boq-rate-value[^>]*>777</);
	assert.match(materialRow, /Material component/);
	assert.match(labourRow, /Labour component/);
	assert.match(materialRow, /Labour not applicable/);
	assert.doesNotMatch(materialRow, /aria-label="Labour for/);
	assert.match(labourRow, /Material not applicable/);
	assert.doesNotMatch(labourRow, /aria-label="Material for/);
	assert.match(
		materialRow,
		/class="unified-boq-component-origin source"[^>]*>Source</,
	);
	assert.match(
		labourRow,
		/class="unified-boq-component-origin source"[^>]*>Source</,
	);
});

test("does not relabel an editable separate-component rate as source evidence", () => {
	const html = renderTable([
		{
			header: "No preserved allocation",
			items: [
				item({
					desc: "Editable material row",
					rate: 999,
					total: 7992,
					costComponent: "material",
					costAllocation: undefined,
				}),
			],
		},
	]);

	assert.match(html, /unified-boq-rate-value[^>]*>999</);
	assert.match(html, /Material component/);
	assert.match(
		html,
		/aria-label="Material for Editable material row, row 1"[^>]*value="999.00"/,
	);
	assert.match(html, /Labour not applicable/);
	assert.doesNotMatch(html, /Material source/);
});

test("combined source-derived rows expose editable material and labour inputs with rate-basis values", () => {
	const html = renderTable([
		{
			header: "Combined work",
			items: [
				item({
					desc: "Combined valve",
					rate: 3108,
					total: 24864,
					sourceCosts: {
						material: {
							present: true,
							qty: 8,
							unit: "Pcs",
							rate: 2808,
							total: 22464,
						},
						labour: {
							present: true,
							qty: 8,
							unit: "Pcs",
							rate: 300,
							total: 2400,
						},
					},
				}),
			],
		},
	]);

	assert.match(
		html,
		/aria-label="Material for Combined valve, row 1"[^>]*value="2808.00"/,
	);
	assert.match(
		html,
		/aria-label="Labour for Combined valve, row 1"[^>]*value="300.00"/,
	);
	assert.match(html, /Material source rate:[^<]*2,808\.00/);
	assert.match(html, /Labour source rate:[^<]*300\.00/);
	assert.match(
		html,
		/class="unified-boq-component-origin source"[^>]*>Source</,
	);
	assert.match(html, /unified-boq-rate-value[^>]*>3,108</);
});

test("lump-sum rows expose editable total-basis material and labour inputs", () => {
	const html = renderTable([
		{
			header: "Lump sum",
			items: [
				item({
					desc: "Provisional sum",
					type: "lump_sum",
					qty: 1,
					rate: 5000,
					total: 5000,
					sourceCosts: {
						material: {
							present: true,
							qty: 1,
							unit: "Ls",
							rate: 3000,
							total: 3000,
						},
						labour: {
							present: true,
							qty: 1,
							unit: "Ls",
							rate: 2000,
							total: 2000,
						},
					},
				}),
			],
		},
	]);

	assert.match(
		html,
		/aria-label="Material for Provisional sum, row 1"[^>]*value="3000.00"/,
	);
	assert.match(
		html,
		/aria-label="Labour for Provisional sum, row 1"[^>]*value="2000.00"/,
	);
	assert.match(html, /Material source total:[^<]*3,000\.00/);
	assert.match(html, /Labour source total:[^<]*2,000\.00/);
	assert.match(
		html,
		/class="unified-boq-component-origin source"[^>]*>Source</,
	);
});

test("an unsplit combined row renders editable zeroed component controls until the first edit", () => {
	const html = renderTable([
		{
			header: "Unknown split",
			items: [item({ desc: "Allowance", sourceCosts: undefined })],
		},
	]);

	assert.match(
		html,
		/aria-label="Material for Allowance, row 1"[^>]*value="0.00"/,
	);
	assert.match(
		html,
		/aria-label="Labour for Allowance, row 1"[^>]*value="0.00"/,
	);
	assert.match(html, /unified-boq-rate-value[^>]*>100</);
	assert.doesNotMatch(
		html,
		/aria-label="Rate for Allowance, row 1"[^>]*disabled=""/,
	);
	assert.doesNotMatch(html, />Allocate<|allocation editor|onAllocate\(/i);
	assert.doesNotMatch(
		tableSource,
		/onComponentChange|onAllocate|materialAllocation|labourAllocation/,
	);
});

test("manual allocations show the manual indicator while preserving immutable source evidence", () => {
	const html = renderTable([
		{
			header: "Manual split",
			items: [
				item({
					desc: "Manual valve",
					rate: 3200,
					total: 25600,
					costAllocation: {
						basis: "rate",
						material: 2900,
						labour: 300,
						origin: "manual",
					},
					sourceCosts: {
						material: {
							present: true,
							qty: 8,
							unit: "Pcs",
							rate: 2808,
							total: 22464,
						},
						labour: {
							present: true,
							qty: 8,
							unit: "Pcs",
							rate: 300,
							total: 2400,
						},
					},
				}),
			],
		},
	]);

	assert.match(
		html,
		/aria-label="Material for Manual valve, row 1"[^>]*value="2900.00"/,
	);
	assert.match(
		html,
		/aria-label="Labour for Manual valve, row 1"[^>]*value="300.00"/,
	);
	assert.match(html, /Manual/);
	assert.match(html, /Material source rate:[^<]*2,808\.00/);
	assert.match(html, /Labour source rate:[^<]*300\.00/);
	assert.match(
		html,
		/class="unified-boq-component-origin manual"[^>]*>Manual</,
	);
});

test("renders each section as one full-width row and catalog controls inline with every item", () => {
	const html = renderTable([
		{
			header: "ON-OFF VALVE INSTALLATION",
			items: [item({ desc: "Loose flange" })],
		},
	]);

	assert.match(
		html,
		/class="unified-boq-section-row"[\s\S]*?<td colSpan="9">ON-OFF VALVE INSTALLATION<\/td>/,
	);
	assert.match(html, /data-od-id="inline-catalog-section:0:id:item-1"/);
	assert.match(html, />Unmatched</);
});

test("keeps the eight-column table scrollable on desktop and releases its fixed width for mobile cards", () => {
	assert.match(
		globalsSource,
		/\.unified-boq-table-scroll\s*\{[^}]*overflow-x:\s*auto;/,
	);
	assert.match(
		globalsSource,
		/\.unified-boq-items-table\s*\{[^}]*min-width:\s*900px;/,
	);
	assert.match(
		globalsSource,
		/@media \(max-width: 920px\)[\s\S]*?\.unified-boq-items-table\s*\{[^}]*min-width:\s*0;/,
	);
	assert.doesNotMatch(
		globalsSource,
		/@media \(max-width:\s*768px\)[\s\S]*?\.unified-boq-items-table\s*\{\s*min-width:\s*760px;/,
	);
});

test("converts BOQ rows to labelled two-column cards at 920px and one-column cards at 520px", () => {
	assert.match(tableSource, /data-label="Description"/);
	assert.match(tableSource, /data-label="Material"/);
	assert.match(tableSource, /data-label="Catalog"/);
	assert.match(
		globalsSource,
		/@media \(max-width: 920px\)[\s\S]*?\.unified-boq-items-table tbody tr:not\(\.unified-boq-section-row\)[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/,
	);
	assert.match(
		globalsSource,
		/@media \(max-width: 920px\)[\s\S]*?td \{[^}]*grid-template-columns:\s*88px minmax\(0, 1fr\)/,
	);
	assert.match(
		globalsSource,
		/@media \(max-width: 520px\)[\s\S]*?\.unified-boq-items-table tbody tr:not\(\.unified-boq-section-row\)[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/,
	);
	assert.match(
		globalsSource,
		/@media \(max-width: 920px\)[\s\S]*?\.pdf-review-viewer[^{]*\{[^}]*min-width:\s*0;[^}]*min-height:\s*320px/,
	);
	assert.match(
		globalsSource,
		/@media \(max-width: 520px\)[\s\S]*?\.pdf-review-viewer[^{]*\{[^}]*min-width:\s*280px/,
	);
});

test("disables only an active catalog row while its suggestion request is in flight", () => {
	const html = renderTable(
		[
			{
				header: "Valves",
				items: [
					item({ desc: "Busy row", costComponent: "material" }),
					item({ id: "other", desc: "Other row", costComponent: "material" }),
				],
			},
		],
		{
			catalogState: (row) => ({
				suggestion: null,
				busy: row.item.desc === "Busy row" ? "ai" : null,
				error: null,
			}),
		},
	);
	const busyDescription =
		html.match(
			/<input[^>]*aria-label="Description for Busy row, row 1"/,
		)?.[0] ?? "";
	const busyMaterial =
		html.match(/<input[^>]*aria-label="Material for Busy row, row 1"/)?.[0] ??
		"";
	const otherDescription =
		html.match(
			/<input[^>]*aria-label="Description for Other row, row 2"/,
		)?.[0] ?? "";

	assert.match(busyDescription, /\sdisabled=""/);
	assert.match(busyMaterial, /\sdisabled=""/);
	assert.doesNotMatch(otherDescription, /\sdisabled=""/);
});

test("approved rows render component evidence as read-only values without inputs", () => {
	const sections = [
		{
			header: "Approved",
			items: [
				item({
					desc: "Approved valve",
					rate: 3108,
					total: 24864,
					costAllocation: {
						basis: "rate",
						material: 2808,
						labour: 300,
						origin: "manual",
					},
					sourceCosts: {
						material: {
							present: true,
							qty: 8,
							unit: "Pcs",
							rate: 2808,
							total: 22464,
						},
						labour: {
							present: true,
							qty: 8,
							unit: "Pcs",
							rate: 300,
							total: 2400,
						},
					},
				}),
			],
		},
	];
	const html = renderTable(sections, { readOnly: true });

	assert.equal(
		html.includes('aria-label="Material for Approved valve, row 1"'),
		false,
	);
	assert.equal(
		html.includes('aria-label="Labour for Approved valve, row 1"'),
		false,
	);
	assert.equal(html.includes("2,808.00"), true);
	assert.equal(html.includes("300.00"), true);
	assert.equal(html.includes(">Manual<"), true);
});

test("informational bundle children remain on the non-editable placeholder path", () => {
	const html = renderTable([
		{
			header: "Bundle",
			items: [
				item({
					id: "bundle-parent-1",
					pricingRole: "bundle_parent",
					desc: "Priced bundle",
					total: 800,
				}),
				bundleChild(),
			],
		},
	]);

	assert.doesNotMatch(
		html,
		/aria-label="Material for Informational bundle component, row 2"/,
	);
	assert.doesNotMatch(
		html,
		/aria-label="Labour for Informational bundle component, row 2"/,
	);
	assert.match(html, />Included</);
});

test("renders a hover-revealed delete action on each priced row when editable", () => {
	const html = renderTable([{ header: "Valves", items: [item()] }]);
	assert.match(html, /unified-boq-row-actions/);
	assert.match(html, /aria-label="Delete row 1"/);
});

test("omits the delete action when readOnly", () => {
	const html = renderTable([{ header: "Valves", items: [item()] }], {
		readOnly: true,
	});
	assert.doesNotMatch(html, /Delete row/);
});
