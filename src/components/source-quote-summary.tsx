"use client";

import type { BoqSourceRef } from "@/lib/boq-schema";
import type { BoqSourceQuoteSummary } from "@/lib/boq-source-quote-summary";
import { divideDecimalExact, type DecimalString } from "@/lib/decimal-string";

/**
 * Read-only projection of the persisted source quote summary. Amounts stay
 * canonical nonnegative decimal strings; the +/- prefixes are presentation
 * only and never mutate the stored summary.
 */
export interface SourceQuoteSummaryProps {
	summary: BoqSourceQuoteSummary;
	onNavigateToSource?: (sourceRef: BoqSourceRef) => void;
}

export interface SourceQuoteSummaryRow {
	key: "direct" | "overhead" | "subtotal" | "discount" | "payable";
	label: string;
	operation: "base" | "add" | "subtract" | "result";
	amount: DecimalString;
	sourceRef?: BoqSourceRef;
}

export function sourceQuoteSummaryRows(
	summary: BoqSourceQuoteSummary,
): SourceQuoteSummaryRow[] {
	return [
		{
			key: "direct",
			label: "Direct work",
			operation: "base",
			amount: summary.directWorkTotal,
		},
		...(summary.overheadProfitAmount === undefined
			? []
			: [
					{
						key: "overhead" as const,
						label: "Overhead & profit",
						operation: "add" as const,
						amount: summary.overheadProfitAmount,
						sourceRef: summary.overheadProfitSourceRef,
					},
				]),
		{
			key: "subtotal",
			label: "Quoted subtotal",
			operation: "result",
			amount: summary.quotedSubtotal,
			sourceRef: summary.subtotalSourceRef,
		},
		...(summary.discountAmount === undefined ||
		summary.payableTotal === undefined
			? []
			: [
					{
						key: "discount" as const,
						label: "Discount",
						operation: "subtract" as const,
						amount: summary.discountAmount,
						sourceRef: summary.discountSourceRef,
					},
					{
						key: "payable" as const,
						label: "Payable total",
						operation: "result" as const,
						amount: summary.payableTotal,
						sourceRef: summary.payableTotalSourceRef,
					},
				]),
	];
}

const OPERATION_PREFIX: Record<SourceQuoteSummaryRow["operation"], string> = {
	base: "",
	add: "+ ",
	subtract: "− ",
	result: "",
};

/** Format a canonical amount as Thai baht for display only, rounding to the
 *  currency minor unit exactly like the verification layer's display copy. */
function formatBaht(value: DecimalString): string {
	const rounded = divideDecimalExact(value, "1", 2);
	const point = rounded.indexOf(".");
	const whole = point === -1 ? rounded : rounded.slice(0, point);
	const fraction = (point === -1 ? "" : rounded.slice(point + 1)).padEnd(
		2,
		"0",
	);
	const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	return `฿${grouped}.${fraction}`;
}

export function SourceQuoteSummary({
	summary,
	onNavigateToSource,
}: SourceQuoteSummaryProps) {
	const rows = sourceQuoteSummaryRows(summary);
	return (
		<section
			className="source-quote-summary"
			data-od-id="source-quote-summary"
			aria-labelledby="source-quote-summary-heading"
		>
			<h3
				className="source-quote-summary-heading"
				id="source-quote-summary-heading"
			>
				Source quote summary
			</h3>
			<dl>
				{rows.map((row) => {
					const { sourceRef } = row;
					return (
					<div
						key={row.key}
						className={`source-quote-summary-row source-quote-summary-row-${row.key} source-quote-summary-operation-${row.operation}`}
					>
						<dt>
							{row.label}
							{onNavigateToSource && sourceRef ? (
								<button
									type="button"
									className="source-quote-summary-source"
									aria-label={`View source: ${row.label}`}
									onClick={() => onNavigateToSource(sourceRef)}
								>
									View source
								</button>
							) : null}
						</dt>
						<dd>
							{OPERATION_PREFIX[row.operation]}
							{formatBaht(row.amount)}
						</dd>
					</div>
				);
				})}
			</dl>
		</section>
	);
}
