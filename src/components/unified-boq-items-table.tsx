"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { InlineCatalogCell } from "@/components/inline-catalog-cell"
import {
  componentCostView,
  isPricedUnifiedBoqRow,
  type UnifiedBoqPricedRow,
  type UnifiedBoqSection,
} from "@/lib/boq-unified-rows"
import type { InlineCatalogRowState } from "@/components/use-inline-catalog-matching"
import type { BoqPricedItem } from "@/lib/boq-schema"

type EditableBoqField = "code" | "desc" | "unit" | "qty" | "rate" | "type"

export interface UnifiedBoqItemsTableProps {
  sections: UnifiedBoqSection[]
  readOnly: boolean
  disabled: boolean
  catalogState: (row: UnifiedBoqPricedRow) => InlineCatalogRowState
  onFieldChange: (row: UnifiedBoqPricedRow, field: EditableBoqField, value: string | number | undefined) => void
  onComponentChange: (row: UnifiedBoqPricedRow, component: "material" | "labour", value: number) => void
  onAllocate: (row: UnifiedBoqPricedRow, material: number, labour: number) => void
  onAcceptSuggestion: (row: UnifiedBoqPricedRow) => void
  onAiSuggest: (row: UnifiedBoqPricedRow) => void
  onDismissSuggestion: (row: UnifiedBoqPricedRow) => void
  onFindMatch: (row: UnifiedBoqPricedRow) => void
  onExclude: (row: UnifiedBoqPricedRow) => void
  onClearCatalogError?: (key: string) => void
}

function currency(value: number): string {
  return `฿${value.toLocaleString()}`
}

export function UnifiedBoqItemsTable({
  sections,
  readOnly,
  disabled,
  catalogState,
  onFieldChange,
  onComponentChange,
  onAllocate,
  onAcceptSuggestion,
  onAiSuggest,
  onDismissSuggestion,
  onFindMatch,
  onExclude,
  onClearCatalogError = () => undefined,
}: UnifiedBoqItemsTableProps) {
  const [allocationKey, setAllocationKey] = useState<string | null>(null)
  const [materialAllocation, setMaterialAllocation] = useState("0")
  const [labourAllocation, setLabourAllocation] = useState("0")
  const rowStarts: number[] = []
  sections.reduce((rowStart, section) => {
    rowStarts.push(rowStart)
    return rowStart + section.rows.length
  }, 0)

  const beginAllocation = (row: UnifiedBoqPricedRow) => {
    setAllocationKey(row.key)
    setMaterialAllocation("0")
    setLabourAllocation("0")
  }

  const applyAllocation = (row: UnifiedBoqPricedRow) => {
    const material = Number(materialAllocation)
    const labour = Number(labourAllocation)
    if (!Number.isFinite(material) || !Number.isFinite(labour) || material < 0 || labour < 0) return
    onAllocate(row, material, labour)
    setAllocationKey(null)
  }

  return (
    <div className="unified-boq-table-scroll">
      <table className="unified-boq-items-table" data-od-id="review-items-table">
        <thead>
          <tr>
            <th>Description</th>
            <th>Unit</th>
            <th className="num-col">Qty</th>
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
              allocationKey={allocationKey}
              materialAllocation={materialAllocation}
              labourAllocation={labourAllocation}
              catalogState={catalogState}
              onFieldChange={onFieldChange}
              onComponentChange={onComponentChange}
              onBeginAllocation={beginAllocation}
              onMaterialAllocationChange={setMaterialAllocation}
              onLabourAllocationChange={setLabourAllocation}
              onApplyAllocation={applyAllocation}
              onCancelAllocation={() => setAllocationKey(null)}
              onAcceptSuggestion={onAcceptSuggestion}
              onAiSuggest={onAiSuggest}
              onDismissSuggestion={onDismissSuggestion}
              onFindMatch={onFindMatch}
              onExclude={onExclude}
              onClearCatalogError={onClearCatalogError}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

interface FragmentSectionProps extends Omit<UnifiedBoqItemsTableProps, "sections" | "onAllocate"> {
  section: UnifiedBoqSection
  rowStart: number
  allocationKey: string | null
  materialAllocation: string
  labourAllocation: string
  onBeginAllocation: (row: UnifiedBoqPricedRow) => void
  onMaterialAllocationChange: (value: string) => void
  onLabourAllocationChange: (value: string) => void
  onApplyAllocation: (row: UnifiedBoqPricedRow) => void
  onCancelAllocation: () => void
}

function FragmentSection({
  section,
  rowStart,
  readOnly,
  disabled,
  allocationKey,
  materialAllocation,
  labourAllocation,
  catalogState,
  onFieldChange,
  onComponentChange,
  onBeginAllocation,
  onMaterialAllocationChange,
  onLabourAllocationChange,
  onApplyAllocation,
  onCancelAllocation,
  onAcceptSuggestion,
  onAiSuggest,
  onDismissSuggestion,
  onFindMatch,
  onExclude,
  onClearCatalogError = () => undefined,
}: FragmentSectionProps) {
  return (
    <>
      <tr className="unified-boq-section-row">
        <td colSpan={7}>{section.header || "Parsed Items"}</td>
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
              <td colSpan={4} className="unified-boq-informational-placeholder">—</td>
              <td className="num-col unified-boq-total">Included</td>
              <td className="unified-boq-catalog-cell"><span className="inline-catalog-status">Informational</span></td>
            </tr>
          )
        }
        const cost = componentCostView(row.item)
        const rowCatalogState = catalogState(row)
        const allocationOpen = allocationKey === row.key
        const locked = readOnly || disabled || rowCatalogState.busy !== null
        const basisLabel = cost.basis === "total" ? "total" : "rate"
        const component = row.item.costComponent
        const showMaterial = component !== "labour"
        const showLabour = component !== "material"

        return (
          <tr key={row.key} data-row-key={row.key}>
            <td className="unified-boq-description-cell">
              <Input
                aria-label={`Description for ${row.item.desc}, row ${rowNumber}`}
                value={row.item.desc}
                disabled={locked}
                onChange={(event) => onFieldChange(row, "desc", event.target.value)}
              />
              <details className="unified-boq-row-details">
                <summary>Row details</summary>
                <div className="unified-boq-row-details-grid">
                  {row.item.code !== undefined ? (
                    <label>
                      <span>Code</span>
                      <Input
                        aria-label={`Code for ${row.item.desc}, row ${rowNumber}`}
                        value={row.item.code}
                        disabled={locked}
                        onChange={(event) => onFieldChange(row, "code", event.target.value || undefined)}
                      />
                    </label>
                  ) : null}
                  <label>
                    <span>Type</span>
                    <select
                      aria-label={`Type for ${row.item.desc}, row ${rowNumber}`}
                      value={row.item.type}
                      disabled={locked}
                      onChange={(event) => onFieldChange(row, "type", event.target.value as BoqPricedItem["type"])}
                    >
                      <option value="unit">Unit</option>
                      <option value="lump_sum">Lump Sum</option>
                      <option value="job">Job</option>
                    </select>
                  </label>
                  {cost.allocationRequired ? (
                    <label>
                      <span>Aggregate rate</span>
                      <Input
                        aria-label={`Aggregate rate for ${row.item.desc}, row ${rowNumber}`}
                        type="number"
                        min="0"
                        value={row.item.rate}
                        disabled={locked}
                        onChange={(event) => onFieldChange(row, "rate", Number(event.target.value))}
                      />
                    </label>
                  ) : null}
                </div>
              </details>
              {row.item.extractionWarnings?.map((warning, warningIndex) => (
                <span className="review-item-warning" key={`${warning.code}-${warningIndex}`}>{warning.message}</span>
              ))}
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
            {cost.allocationRequired ? (
              <td colSpan={2} className="unified-boq-allocation-cell">
                {allocationOpen && !locked ? (
                  <div className="unified-boq-allocation-editor">
                    <label>
                      <span>Material</span>
                      <Input aria-label={`Material allocation for ${row.item.desc}`} type="number" min="0" value={materialAllocation} disabled={locked} onChange={(event) => onMaterialAllocationChange(event.target.value)} />
                    </label>
                    <label>
                      <span>Labour</span>
                      <Input aria-label={`Labour allocation for ${row.item.desc}`} type="number" min="0" value={labourAllocation} disabled={locked} onChange={(event) => onLabourAllocationChange(event.target.value)} />
                    </label>
                    <Button type="button" size="sm" disabled={locked} onClick={() => onApplyAllocation(row)}>Apply</Button>
                    <Button type="button" size="sm" variant="ghost" disabled={locked} onClick={onCancelAllocation}>Cancel</Button>
                  </div>
                ) : readOnly ? (
                  <span className="unified-boq-not-split">Not split</span>
                ) : (
                  <Button type="button" size="sm" variant="outline" disabled={locked} onClick={() => onBeginAllocation(row)}>Allocate</Button>
                )}
              </td>
            ) : (
              <>
                <td className="num-col unified-boq-component-cell" data-component="material">
                  {showMaterial ? (
                    <Input aria-label={`Material ${basisLabel} for ${row.item.desc}`} type="number" min="0" value={cost.material ?? 0} disabled={locked} onChange={(event) => onComponentChange(row, "material", Number(event.target.value))} />
                  ) : "—"}
                </td>
                <td className="num-col unified-boq-component-cell" data-component="labour">
                  {showLabour ? (
                    <Input aria-label={`Labour ${basisLabel} for ${row.item.desc}`} type="number" min="0" value={cost.labour ?? 0} disabled={locked} onChange={(event) => onComponentChange(row, "labour", Number(event.target.value))} />
                  ) : "—"}
                </td>
              </>
            )}
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
