import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SourceQuoteSummary, sourceQuoteSummaryRows } from "./source-quote-summary";
import type { BoqSourceQuoteSummary } from "@/lib/boq-source-quote-summary";

const componentUrl = new URL("./source-quote-summary.tsx", import.meta.url);

const validSummary: BoqSourceQuoteSummary = {
	directWorkTotal: "179400",
	overheadProfitAmount: "35880",
	quotedSubtotal: "215280",
	discountAmount: "1280",
	payableTotal: "214000",
	overheadProfitSourceRef: { page: 3, table: 2, row: 8 },
	discountSourceRef: { page: 4, table: 1, row: 2 },
	subtotalSourceRef: { page: 3, table: 2, row: 9 },
};

function renderSummary(
	props: Partial<Parameters<typeof SourceQuoteSummary>[0]> = {},
): string {
	return renderToStaticMarkup(
		createElement(SourceQuoteSummary, {
			summary: validSummary,
			...props,
		}),
	);
}

test("sourceQuoteSummaryRows projects the five fixed commercial rows", () => {
	assert.deepEqual(
		sourceQuoteSummaryRows(validSummary).map(({ key, label, operation, amount }) => ({
			key,
			label,
			operation,
			amount,
		})),
		[
			{ key: "direct", label: "Direct work", operation: "base", amount: "179400" },
			{ key: "overhead", label: "Overhead & profit", operation: "add", amount: "35880" },
			{ key: "subtotal", label: "Quoted subtotal", operation: "result", amount: "215280" },
			{ key: "discount", label: "Discount", operation: "subtract", amount: "1280" },
			{ key: "payable", label: "Payable total", operation: "result", amount: "214000" },
		],
	);
});

test("sourceQuoteSummaryRows carries refs only where the summary has them and omits absent optional rows", () => {
	const rows = sourceQuoteSummaryRows(validSummary);
	assert.deepEqual(
		rows.map((row) => row.sourceRef ?? null),
		[
			null,
			{ page: 3, table: 2, row: 8 },
			{ page: 3, table: 2, row: 9 },
			{ page: 4, table: 1, row: 2 },
			null,
		],
	);
	// Overhead and the discount/payable pair are optional; absent amounts must
	// never be fabricated as zero rows.
	const withoutOptionalRows = sourceQuoteSummaryRows({
		directWorkTotal: "179400",
		quotedSubtotal: "179400",
	});
	assert.deepEqual(
		withoutOptionalRows.map((row) => row.key),
		["direct", "subtotal"],
	);
});

test("SourceQuoteSummary renders the read-only baht summary with signed add/subtract rows only", () => {
	const html = renderSummary({ onNavigateToSource: () => {} });
	assert.match(html, /Source quote summary/);
	assert.match(html, /data-od-id="source-quote-summary"/);
	// Semantic section/dl/dt/dd structure.
	assert.match(html, /<section[^>]*>/);
	assert.match(html, /<dl>/);
	assert.match(html, /<dt>/);
	assert.match(html, /<dd/);
	// Amounts format as Thai baht at render time from canonical decimal strings.
	assert.match(html, /฿179,400\.00/);
	assert.match(html, /฿35,880\.00/);
	assert.match(html, /฿215,280\.00/);
	assert.match(html, /฿1,280\.00/);
	assert.match(html, /฿214,000\.00/);
	// Prefixes only on the add and subtract rows; the stored amount stays unsigned.
	assert.match(html, /\+ ฿35,880\.00/);
	assert.match(html, /− ฿1,280\.00/);
	assert.doesNotMatch(html, /[+−] ฿179,400\.00/);
	assert.doesNotMatch(html, /[+−] ฿215,280\.00/);
	assert.doesNotMatch(html, /[+−] ฿214,000\.00/);
});

test("SourceQuoteSummary formats fractional amounts at the currency minor unit", () => {
	const html = renderToStaticMarkup(
		createElement(SourceQuoteSummary, {
			summary: {
				directWorkTotal: "179400.5",
				overheadProfitAmount: "35880.25",
				quotedSubtotal: "215280.75",
			},
		}),
	);
	assert.match(html, /฿179,400\.50/);
	assert.match(html, /\+ ฿35,880\.25/);
	assert.match(html, /฿215,280\.75/);
});

test("source buttons sit on the amount row, not under the label", () => {
	const html = renderSummary({ onNavigateToSource: () => {} });
	assert.match(html, /<dt>Overhead &amp; profit<\/dt>/);
	assert.match(
		html,
		/<dd>[^]*?฿35,880\.00[^]*?aria-label="View source: Overhead/,
	);
	assert.doesNotMatch(html, /<dt>[^<]*<button/);
});

test("SourceQuoteSummary shows source buttons only for rows with refs, with View source accessible names", () => {
	const html = renderSummary({ onNavigateToSource: () => {} });
	assert.equal(
		(html.match(/aria-label="View source: /g) ?? []).length,
		3,
		"one source button per row that carries a ref",
	);
	assert.match(html, /aria-label="View source: Overhead &amp; profit"/);
	assert.match(html, /aria-label="View source: Quoted subtotal"/);
	assert.match(html, /aria-label="View source: Discount"/);
	// The direct and payable rows carry no ref in this summary, so no button.
	assert.doesNotMatch(html, /aria-label="View source: Direct work"/);
	assert.doesNotMatch(html, /aria-label="View source: Payable total"/);
	// Without the optional callback the summary stays fully read-only.
	const htmlWithoutCallback = renderSummary();
	assert.doesNotMatch(htmlWithoutCallback, /View source/);
	assert.doesNotMatch(htmlWithoutCallback, /<button/);
});

test("SourceQuoteSummary wires the source buttons through onNavigateToSource", () => {
	const componentSource = readFileSync(componentUrl, "utf8");
	assert.match(componentSource, /onNavigateToSource\(/);
	assert.match(componentSource, /onClick=\{\(\) => onNavigateToSource\(/);
});

test("SourceQuoteSummary is strictly read-only with no editing, matching, exclusion, or Estimator transfer", () => {
	const html = renderSummary({ onNavigateToSource: () => {} });
	const componentSource = readFileSync(componentUrl, "utf8");
	for (const surface of [html, componentSource]) {
		assert.doesNotMatch(surface, /<input/);
		assert.doesNotMatch(surface, /<select/);
		assert.doesNotMatch(surface, /contenteditable/);
		assert.doesNotMatch(surface, /Match/);
		assert.doesNotMatch(surface, /Exclude/);
		assert.doesNotMatch(surface, /Estimator/);
		assert.doesNotMatch(surface, /percent/i);
		assert.doesNotMatch(surface, /20%/);
	}
	assert.ok(existsSync(componentUrl));
});
