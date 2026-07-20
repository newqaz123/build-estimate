"use client"

import { Input } from "@/components/ui/input"
import { InlineCatalogCell } from "@/components/inline-catalog-cell"
import {
  isPricedUnifiedBoqRow,
  type UnifiedBoqPricedRow,
  type UnifiedBoqSection,
} from "@/lib/boq-unified-rows"
import type { InlineCatalogRowState } from "@/components/use-inline-catalog-matching"

type EditableBoqField = "desc" | "unit" | "qty" | "rate"

export interface UnifiedBoqItemsTableProps {
  sections: UnifiedBoqSection[]
  readOnly: boolean
  disabled: boolean
  catalogState: (row: UnifiedBoqPricedRow) => InlineCatalogRowState
  onFieldChange: (row: UnifiedBoqPricedRow, field: EditableBoqField, value: string | number | undefined) => void
  onAcceptSuggestion: (row: UnifiedBoqPricedRow) => void
  onAiSuggest: (row: UnifiedBoqPricedRow) => void
  onDismissSuggestion: (row: UnifiedBoqPricedRow) => void
  onFindMatch: (row: UnifiedBoqPricedRow) => void
  onExclude: (row: UnifiedBoqPricedRow) => void
  onIncludeOptional?: (row: UnifiedBoqPricedRow) => void
  onClearCatalogError?: (key: string) => void
}

function currency(value: number): string {
  return `฿${value.toLocaleString()}`
}

function SourceCostEvidence({
  label,
  present,
  value,
  basis,
}: {
  label: "Material" | "Labour"
  present: boolean
  value: number
  basis: "rate" | "total"
}) {
  if (!present) {
    return <span className="unified-boq-source-cost-missing" aria-label={`${label} not provided`}>—</span>
  }
  const evidenceLabel = `${label} source ${basis}`

  return (
    <span className="unified-boq-source-cost" aria-label={evidenceLabel}>
      <span className="sr-only">{evidenceLabel}</span>
      <strong>{currency(value)}</strong>
    </span>
  )
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
  onIncludeOptional = () => undefined,
  onClearCatalogError = () => undefined,
}: UnifiedBoqItemsTableProps) {
  const rowStarts: number[] = []
  sections.reduce((rowStart, section) => {
    rowStarts.push(rowStart)
    return rowStart + section.rows.length
  }, 0)

  return (
    <div className="unified-boq-table-scroll">
      <table className="unified-boq-items-table" data-od-id="review-items-table">
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
              onIncludeOptional={onIncludeOptional}
              onClearCatalogError={onClearCatalogError}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

interface FragmentSectionProps extends Omit<UnifiedBoqItemsTableProps, "sections"> {
  section: UnifiedBoqSection
  rowStart: number
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
  onIncludeOptional = () => undefined,
  onClearCatalogError = () => undefined,
}: FragmentSectionProps) {
  return (
    <>
      <tr className="unified-boq-section-row">
        <td colSpan={8}>{section.header || "Parsed Items"}</td>
      </tr>
      {section.rows.map((row, index) => {
        const rowNumber = rowStart + index + 1
        if (!isPricedUnifiedBoqRow(row)) {
          return (
            <tr key={row.key} data-row-key={row.key} className="unified-boq-informational-row">
              <td className="unified-boq-description-cell">
                <div className="boq-informational-description">{row.item.desc}</div>
                <span className="review-item-warning">Bundle component · included in the parent price</span>
                {row.item.extractionWarnings?.map((warning, warningIndex) => (
                  <span className="review-item-warning" key={`${warning.code}-${warningIndex}`}>{warning.message}</span>
                ))}
              </td>
              <td colSpan={5} className="unified-boq-informational-placeholder">—</td>
              <td className="num-col unified-boq-total">Included</td>
              <td className="unified-boq-catalog-cell"><span className="inline-catalog-status">Informational</span></td>
            </tr>
          )
        }
        const rowCatalogState = catalogState(row)
        const locked = readOnly || disabled || rowCatalogState.busy !== null
        const evidenceBasis = row.item.type === "lump_sum" ? "total" : "rate"
        const materialEvidence = row.item.sourceCosts?.material
        const labourEvidence = row.item.sourceCosts?.labour
        const isMaterialRow = row.item.costComponent === "material"
        const isLabourRow = row.item.costComponent === "labour"
        const isSeparateComponentRow = isMaterialRow || isLabourRow
        const sourceAllocation = row.item.costAllocation?.origin === "source" ? row.item.costAllocation : undefined
        const materialPresent = isMaterialRow ? sourceAllocation !== undefined : !isSeparateComponentRow && materialEvidence?.present === true
        const labourPresent = isLabourRow ? sourceAllocation !== undefined : !isSeparateComponentRow && labourEvidence?.present === true

        return (
          <tr key={row.key} data-row-key={row.key}>
            <td className="unified-boq-description-cell">
              <Input
                aria-label={`Description for ${row.item.desc}, row ${rowNumber}`}
                value={row.item.desc}
                disabled={locked}
                onChange={(event) => onFieldChange(row, "desc", event.target.value)}
              />
              {isSeparateComponentRow ? (
                <span className={`unified-boq-component-badge ${isMaterialRow ? "material" : "labour"}`}>
                  {isMaterialRow ? "Material component" : "Labour component"}
                </span>
              ) : null}
              {row.item.extractionWarnings?.map((warning, warningIndex) => (
                <span className="review-item-warning" key={`${warning.code}-${warningIndex}`}>{warning.message}</span>
              ))}
              {row.item.optional ? <span className="review-optional-state">{row.item.excludedFromTotal ? "Optional · excluded from total" : "Optional · included in total"}</span> : null}
              {row.item.optional && row.item.excludedFromTotal && !readOnly ? <button type="button" className="unified-boq-include-option" disabled={disabled} onClick={() => onIncludeOptional(row)}>Include in total</button> : null}
            </td>
            <td>
              <Input
                aria-label={`Unit for ${row.item.desc}, row ${rowNumber}`}
                value={row.item.unit}
                disabled={locked}
                onChange={(event) => onFieldChange(row, "unit", event.target.value)}
              />
            </td>
            <td className="num-col">
              <Input
                aria-label={`Quantity for ${row.item.desc}, row ${rowNumber}`}
                type="number"
                min="0"
                value={row.item.qty}
                disabled={locked}
                onChange={(event) => onFieldChange(row, "qty", Number(event.target.value))}
              />
            </td>
            <td className="num-col">
              <Input
                aria-label={`Rate for ${row.item.desc}, row ${rowNumber}`}
                type="number"
                min="0"
                value={row.item.rate}
                disabled={locked}
                onChange={(event) => onFieldChange(row, "rate", Number(event.target.value))}
              />
            </td>
            <td className="num-col unified-boq-component-cell" data-component="material">
              <SourceCostEvidence
                label="Material"
                present={materialPresent}
                value={isMaterialRow ? sourceAllocation?.material ?? 0 : evidenceBasis === "total" ? materialEvidence?.total ?? 0 : materialEvidence?.rate ?? 0}
                basis={isMaterialRow && sourceAllocation ? sourceAllocation.basis : evidenceBasis}
              />
            </td>
            <td className="num-col unified-boq-component-cell" data-component="labour">
              <SourceCostEvidence
                label="Labour"
                present={labourPresent}
                value={isLabourRow ? sourceAllocation?.labour ?? 0 : evidenceBasis === "total" ? labourEvidence?.total ?? 0 : labourEvidence?.rate ?? 0}
                basis={isLabourRow && sourceAllocation ? sourceAllocation.basis : evidenceBasis}
              />
            </td>
            <td className="num-col unified-boq-total">{currency(row.item.total)}</td>
            <td className="unified-boq-catalog-cell">
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
          </tr>
        )
      })}
    </>
  )
}
