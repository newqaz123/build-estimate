"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InlineCatalogCell } from "@/components/inline-catalog-cell";
import { UnitCombobox } from "@/components/unit-combobox";
import { deriveSourceCostAllocation } from "@/lib/boq-cost-allocation";
import { STANDARD_UNITS } from "@/lib/units";
import type { BoqSourceCost } from "@/lib/boq-schema";
import {
	isPricedUnifiedBoqRow,
	type UnifiedBoqPricedRow,
	type UnifiedBoqSection,
} from "@/lib/boq-unified-rows";
import type { InlineCatalogRowState } from "@/components/use-inline-catalog-matching";

type EditableBoqField =
	| "desc"
	| "unit"
	| "qty"
	| "rate"
	| "materialCost"
	| "labourCost";

export interface UnifiedBoqItemsTableProps {
	sections: UnifiedBoqSection[];
	readOnly: boolean;
	disabled: boolean;
	catalogState: (row: UnifiedBoqPricedRow) => InlineCatalogRowState;
	onFieldChange: (
		row: UnifiedBoqPricedRow,
		field: EditableBoqField,
		value: string | number | undefined,
	) => void;
	onAcceptSuggestion: (row: UnifiedBoqPricedRow) => void;
	onAiSuggest: (row: UnifiedBoqPricedRow) => void;
	onDismissSuggestion: (row: UnifiedBoqPricedRow) => void;
	onFindMatch: (row: UnifiedBoqPricedRow) => void;
	onExclude: (row: UnifiedBoqPricedRow) => void;
	onDelete?: (row: UnifiedBoqPricedRow) => void;
	onIncludeOptional?: (row: UnifiedBoqPricedRow) => void;
	onClearCatalogError?: (key: string) => void;
	onComponentDraftValidityChange?: (key: string, isInvalid: boolean) => void;
	units?: string[];
	workspaceUnitsError?: string | null;
	onAddUnit?: (unit: string) => Promise<string> | string | void;
}

function currency(value: number): string {
	return `฿${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatNumber2(value: number): string {
	return value.toFixed(2);
}

function formatRateValue(value: number): string {
	return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function parseCentDraft(
	raw: string,
): { valid: true; value: number } | { valid: false; error: string } {
	const trimmed = raw.trim();
	if (trimmed === "") return { valid: false, error: "Required" };
	const parsed = Number(trimmed);
	if (!Number.isFinite(parsed))
		return { valid: false, error: "Must be a number" };
	if (parsed < 0) return { valid: false, error: "Must be non-negative" };
	const scaled = Math.round(parsed * 100);
	if (Math.abs(scaled / 100 - parsed) > 1e-9)
		return { valid: false, error: "Maximum 2 decimal places" };
	return { valid: true, value: scaled / 100 };
}

function sourceEvidenceText(
	label: "Material" | "Labour",
	basis: "rate" | "total" | null,
	evidence?: BoqSourceCost,
): string | undefined {
	if (!evidence?.present) return undefined;
	return `${label} source ${basis ?? "rate"}: ${currency(basis === "total" ? evidence.total : evidence.rate)}`;
}

function ComponentCostCell({
	label,
	value,
	basis,
	evidence,
	origin,
}: {
	label: "Material" | "Labour";
	value: number;
	basis: "rate" | "total" | null;
	evidence?: BoqSourceCost;
	origin?: "source" | "manual";
}) {
	const evidenceText = sourceEvidenceText(label, basis, evidence);
	return (
		<span className="unified-boq-source-cost">
			<span className="sr-only">
				{evidenceText ?? `${label} ${basis ?? "rate"}`}
			</span>
			<strong>{currency(value)}</strong>
			{origin ? (
				<span className={`unified-boq-component-origin ${origin}`}>
					{origin === "source" ? "Source" : "Manual"}
				</span>
			) : null}
			{evidenceText ? (
				<span className="unified-boq-component-evidence" title={evidenceText}>
					{evidenceText}
				</span>
			) : null}
		</span>
	);
}

function ComponentCostInput({
	row,
	rowNumber,
	component,
	label,
	value,
	basis,
	evidence,
	origin,
	disabled,
	onFieldChange,
	onValidityChange,
}: {
	row: UnifiedBoqPricedRow;
	rowNumber: number;
	component: "material" | "labour";
	label: "Material" | "Labour";
	value: number;
	basis: "rate" | "total" | null;
	evidence?: BoqSourceCost;
	origin?: "source" | "manual";
	disabled: boolean;
	onFieldChange: (
		row: UnifiedBoqPricedRow,
		field: EditableBoqField,
		value: number | undefined,
	) => void;
	onValidityChange?: (key: string, isInvalid: boolean) => void;
}) {
	const key = `${row.key}:${component}`;
	const [draft, setDraft] = useState<string>(formatNumber2(value));
	const [focused, setFocused] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const previousValueRef = useRef(value);
	const fieldName = component === "material" ? "materialCost" : "labourCost";

	const reportValidity = useCallback(
		(isInvalid: boolean) => {
			onValidityChange?.(key, isInvalid);
		},
		[key, onValidityChange],
	);

	useEffect(() => {
		reportValidity(false);
		return () => {
			reportValidity(false);
		};
	}, [reportValidity]);

	useEffect(() => {
		if (focused) return;
		if (previousValueRef.current !== value) {
			setDraft(formatNumber2(value));
			setError(null);
			reportValidity(false);
			previousValueRef.current = value;
		}
	}, [value, focused, reportValidity]);

	const evidenceText = sourceEvidenceText(label, basis, evidence);

	const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
		const raw = event.target.value;
		setDraft(raw);
		const result = parseCentDraft(raw);
		if (result.valid) {
			setError(null);
			reportValidity(false);
			onFieldChange(row, fieldName, result.value);
		}
	};

	const handleBlur = () => {
		setFocused(false);
		const result = parseCentDraft(draft);
		if (!result.valid) {
			setError(result.error);
			reportValidity(true);
			return;
		}
		setError(null);
		reportValidity(false);
		setDraft(formatNumber2(result.value));
		onFieldChange(row, fieldName, result.value);
	};

	const handleFocus = (event: React.FocusEvent<HTMLInputElement>) => {
		setFocused(true);
		event.currentTarget.select();
	};

	return (
		<div className="unified-boq-component-input-wrap">
			<Input
				className="unified-boq-component-input"
				aria-label={`${label} for ${row.item.desc}, row ${rowNumber}`}
				aria-describedby={evidenceText ? `${key}-evidence` : undefined}
				type="number"
				min="0"
				step="0.01"
				value={draft}
				disabled={disabled}
				aria-invalid={error ? "true" : undefined}
				onChange={handleChange}
				onFocus={handleFocus}
				onBlur={handleBlur}
			/>
			{error ? (
				<span className="unified-boq-component-error">{error}</span>
			) : null}
			{origin ? (
				<span className={`unified-boq-component-origin ${origin}`}>
					{origin === "source" ? "Source" : "Manual"}
				</span>
			) : null}
			{evidenceText ? (
				<span
					id={`${key}-evidence`}
					className="unified-boq-component-evidence"
					title={evidenceText}
				>
					{evidenceText}
				</span>
			) : null}
		</div>
	);
}

export function UnifiedBoqItemsTable({
	sections,
	readOnly,
	disabled,
	catalogState,
	onFieldChange,
	onAcceptSuggestion,
	onAiSuggest,
	onDismissSuggestion,
	onFindMatch,
	onExclude,
	onDelete = () => undefined,
	onIncludeOptional = () => undefined,
	onClearCatalogError = () => undefined,
	onComponentDraftValidityChange,
	units = [...STANDARD_UNITS],
	workspaceUnitsError,
	onAddUnit = () => undefined,
}: UnifiedBoqItemsTableProps) {
	const rowStarts: number[] = [];
	sections.reduce((rowStart, section) => {
		rowStarts.push(rowStart);
		return rowStart + section.rows.length;
	}, 0);

	return (
		<div className="unified-boq-table-scroll">
			<table
				className="unified-boq-items-table"
				data-od-id="review-items-table"
			>
				<thead>
					<tr>
						<th>Description</th>
						<th>Unit</th>
						<th className="num-col">Qty</th>
						<th className="num-col">Rate</th>
						<th className="num-col">Material</th>
						<th className="num-col">Labour</th>
						<th className="num-col">Total</th>
						<th>Catalog</th>
						<th aria-label="Actions" />
					</tr>
				</thead>
				<tbody>
					{sections.map((section, sectionIndex) => (
						<FragmentSection
							key={`section-${section.sectionIndex}`}
							section={section}
							rowStart={rowStarts[sectionIndex] ?? 0}
							readOnly={readOnly}
							disabled={disabled}
							catalogState={catalogState}
							onFieldChange={onFieldChange}
							onAcceptSuggestion={onAcceptSuggestion}
							onAiSuggest={onAiSuggest}
							onDismissSuggestion={onDismissSuggestion}
							onFindMatch={onFindMatch}
							onExclude={onExclude}
							onDelete={onDelete}
							onIncludeOptional={onIncludeOptional}
							onClearCatalogError={onClearCatalogError}
							onComponentDraftValidityChange={onComponentDraftValidityChange}
							units={units}
							workspaceUnitsError={workspaceUnitsError}
							onAddUnit={onAddUnit}
						/>
					))}
				</tbody>
			</table>
		</div>
	);
}

interface FragmentSectionProps
	extends Omit<UnifiedBoqItemsTableProps, "sections"> {
	section: UnifiedBoqSection;
	rowStart: number;
}

function FragmentSection({
	section,
	rowStart,
	readOnly,
	disabled,
	catalogState,
	onFieldChange,
	onAcceptSuggestion,
	onAiSuggest,
	onDismissSuggestion,
	onFindMatch,
	onExclude,
	onDelete = () => undefined,
	onIncludeOptional = () => undefined,
	onClearCatalogError = () => undefined,
	onComponentDraftValidityChange,
	units = [...STANDARD_UNITS],
	workspaceUnitsError,
	onAddUnit = () => undefined,
}: FragmentSectionProps) {
	return (
		<>
			<tr className="unified-boq-section-row">
				<td colSpan={9}>{section.header || "Parsed Items"}</td>
			</tr>
			{section.rows.map((row, index) => {
				const rowNumber = rowStart + index + 1;
				if (!isPricedUnifiedBoqRow(row)) {
					return (
						<tr
							key={row.key}
							data-row-key={row.key}
							className="unified-boq-informational-row"
						>
							<td
								className="unified-boq-description-cell"
								data-label="Description"
							>
								<div className="boq-informational-description">
									{row.item.desc}
								</div>
								<span className="review-item-warning">
									Bundle component · included in the parent price
								</span>
								{row.item.extractionWarnings?.map((warning, warningIndex) => (
									<span
										className="review-item-warning"
										key={`${warning.code}-${warningIndex}`}
									>
										{warning.message}
									</span>
								))}
							</td>
							<td
								colSpan={5}
								className="unified-boq-informational-placeholder"
								data-label="Pricing"
							>
								—
							</td>
							<td className="num-col unified-boq-total" data-label="Total">
								Included
							</td>
							<td className="unified-boq-catalog-cell" data-label="Catalog">
								<span className="inline-catalog-status">Informational</span>
							</td>
							<td
								className="unified-boq-row-actions"
								data-label="Actions"
								aria-hidden="true"
							/>
						</tr>
					);
				}
				const rowCatalogState = catalogState(row);
				const locked = readOnly || disabled || rowCatalogState.busy !== null;
				const isMaterialRow = row.item.costComponent === "material";
				const isLabourRow = row.item.costComponent === "labour";
				const isLumpSumRow =
					row.item.costComponent === "lump_sum" || row.item.type === "lump_sum";
				const isSeparateComponentRow = isMaterialRow || isLabourRow;
				const evidenceBasis = isLumpSumRow ? "total" : "rate";
				const allocation = deriveSourceCostAllocation(row.item);
				const materialValue = isLabourRow ? 0 : (allocation?.material ?? 0);
				const labourValue = isMaterialRow ? 0 : (allocation?.labour ?? 0);
				const origin = allocation?.origin;
				const materialEvidence = row.item.sourceCosts?.material;
				const labourEvidence = row.item.sourceCosts?.labour;

				const handleComponentChange = (
					targetRow: UnifiedBoqPricedRow,
					field: EditableBoqField,
					value: number | undefined,
				) => {
					onFieldChange(targetRow, field, value);
				};

				return (
					<tr key={row.key} data-row-key={row.key}>
						<td
							className="unified-boq-description-cell"
							data-label="Description"
						>
							<Input
								aria-label={`Description for ${row.item.desc}, row ${rowNumber}`}
								value={row.item.desc}
								disabled={locked}
								onChange={(event) =>
									onFieldChange(row, "desc", event.target.value)
								}
							/>
							{isSeparateComponentRow ? (
								<span
									className={`unified-boq-component-badge ${isMaterialRow ? "material" : "labour"}`}
								>
									{isMaterialRow ? "Material component" : "Labour component"}
								</span>
							) : null}
							{row.item.extractionWarnings?.map((warning, warningIndex) => (
								<span
									className="review-item-warning"
									key={`${warning.code}-${warningIndex}`}
								>
									{warning.message}
								</span>
							))}
							{row.item.optional ? (
								<span className="review-optional-state">
									{row.item.excludedFromTotal
										? "Optional · excluded from total"
										: "Optional · included in total"}
								</span>
							) : null}
							{row.item.optional && row.item.excludedFromTotal && !readOnly ? (
								<button
									type="button"
									className="unified-boq-include-option"
									disabled={disabled}
									onClick={() => onIncludeOptional(row)}
								>
									Include in total
								</button>
							) : null}
						</td>
						<td data-label="Unit">
							<UnitCombobox
								value={row.item.unit}
								units={units}
								onAddUnit={onAddUnit}
								workspaceLoadError={workspaceUnitsError}
								onChange={(unit) => onFieldChange(row, "unit", unit)}
								disabled={locked}
								readOnly={readOnly}
								ariaLabel={`Unit for ${row.item.desc}, row ${rowNumber}`}
							/>
						</td>
						<td className="num-col" data-label="Quantity">
							<Input
								aria-label={`Quantity for ${row.item.desc}, row ${rowNumber}`}
								type="text"
								inputMode="decimal"
								value={row.item.qty}
								disabled={locked}
								onChange={(event) =>
									onFieldChange(row, "qty", Number(event.target.value))
								}
							/>
						</td>
						<td className="num-col unified-boq-rate" data-label="Rate">
							<span
								className="unified-boq-rate-value"
								aria-label={`Rate for ${row.item.desc}, row ${rowNumber}`}
							>
								{Number.isFinite(row.item.rate)
									? formatRateValue(row.item.rate)
									: "—"}
							</span>
						</td>
						<td
							className="num-col unified-boq-component-cell"
							data-component="material"
							data-label="Material"
						>
							{isLabourRow ? (
								<span
									className="unified-boq-component-missing"
									aria-label="Material not applicable"
								>
									—
								</span>
							) : readOnly ? (
								<ComponentCostCell
									label="Material"
									value={materialValue}
									basis={evidenceBasis}
									evidence={materialEvidence}
									origin={origin}
								/>
							) : (
								<ComponentCostInput
									row={row}
									rowNumber={rowNumber}
									component="material"
									label="Material"
									value={materialValue}
									basis={evidenceBasis}
									evidence={materialEvidence}
									origin={origin}
									disabled={locked}
									onFieldChange={handleComponentChange}
									onValidityChange={onComponentDraftValidityChange}
								/>
							)}
						</td>
						<td
							className="num-col unified-boq-component-cell"
							data-component="labour"
							data-label="Labour"
						>
							{isMaterialRow ? (
								<span
									className="unified-boq-component-missing"
									aria-label="Labour not applicable"
								>
									—
								</span>
							) : readOnly ? (
								<ComponentCostCell
									label="Labour"
									value={labourValue}
									basis={evidenceBasis}
									evidence={labourEvidence}
									origin={origin}
								/>
							) : (
								<ComponentCostInput
									row={row}
									rowNumber={rowNumber}
									component="labour"
									label="Labour"
									value={labourValue}
									basis={evidenceBasis}
									evidence={labourEvidence}
									origin={origin}
									disabled={locked}
									onFieldChange={handleComponentChange}
									onValidityChange={onComponentDraftValidityChange}
								/>
							)}
						</td>
						<td className="num-col unified-boq-total" data-label="Total">
							{currency(row.item.total)}
						</td>
						<td className="unified-boq-catalog-cell" data-label="Catalog">
							<InlineCatalogCell
								locator={row}
								state={rowCatalogState}
								readOnly={readOnly}
								disabled={disabled}
								onAccept={onAcceptSuggestion}
								onAiSuggest={onAiSuggest}
								onDismiss={onDismissSuggestion}
								onFindMatch={onFindMatch}
								onExclude={onExclude}
								onClearError={onClearCatalogError}
							/>
						</td>
						<td className="unified-boq-row-actions" data-label="Actions">
							{!readOnly ? (
								<Button
									type="button"
									variant="ghost"
									size="icon"
									aria-label={`Delete row ${rowNumber}`}
									disabled={disabled}
									onClick={() => onDelete?.(row)}
								>
									<Trash2 className="size-4" aria-hidden="true" />
								</Button>
							) : null}
						</td>
					</tr>
				);
			})}
		</>
	);
}
