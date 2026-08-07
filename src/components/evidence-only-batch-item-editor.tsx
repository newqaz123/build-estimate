"use client"

import { useMemo, useState } from "react"
import { Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  buildSourceBackedItemPayload,
  computeSourceBackedLiveTotal,
  deriveInitialSourceBackedForm,
  validateSourceBackedForm,
  type SourceBackedEditableFields,
  type SourceBackedFieldValues,
} from "@/components/source-backed-item-editor"
import type { Boq } from "@/lib/boq-schema"
import type { ValidatedProposal } from "@/lib/boq-extraction-proposals"

/** Source-row slice the batch editor consumes. Carries only the destination
 *  hint (section) and the immutable source coordinates (page/table/row) used to
 *  label each form. The editor never inspects raw evidence cells — the server
 *  re-derives provenance per row from immutable evidence. */
export interface EvidenceOnlyBatchSourceRow {
  sourceRowId: string
  section: string | null
  page: number
  table: number
  row: number
}

/** Request payload emitted for a multi-row evidence-only manual add. Order
 *  follows `proposal.sourceRowIds`; one complete form per row. */
export interface EvidenceOnlyBatchPayload {
  items: Array<{
    sourceRowId: string
    sectionIndex: number
    item: SourceBackedEditableFields
  }>
}

type EditableFieldKey = "desc" | "unit" | "qty" | "materialCost" | "labourCost"

const EMPTY_NUMERIC = Number.NaN

function normalizeSectionHeader(header: string): string {
  return header.trim().toLowerCase()
}

/** Picks the destination section index for an evidence-only source row. Matches
 *  the row's declared section case-insensitively against the BOQ headers;
 *  otherwise defaults to the first BOQ section (index 0). */
export function defaultEvidenceOnlyBatchSectionIndex(
  sourceRow: EvidenceOnlyBatchSourceRow,
  sections: readonly Pick<Boq["sections"][number], "header">[],
): number {
  if (typeof sourceRow.section === "string" && sourceRow.section.trim() !== "") {
    const needle = normalizeSectionHeader(sourceRow.section)
    const matched = sections.findIndex((section) => normalizeSectionHeader(section.header) === needle)
    if (matched !== -1) return matched
  }
  return 0
}

/** Initializes one blank/manual form per proposal source row, keyed in proposal
 *  order. Every priced field starts `NaN` and every text field blank — the user
 *  supplies all values manually for evidence-only review. */
export function initializeEvidenceOnlyBatchForms(
  proposal: ValidatedProposal,
): Map<string, SourceBackedFieldValues> {
  const forms = new Map<string, SourceBackedFieldValues>()
  for (const sourceRowId of proposal.sourceRowIds) {
    forms.set(sourceRowId, deriveInitialSourceBackedForm(undefined))
  }
  return forms
}

/** Emits the batch payload for a multi-row evidence-only add. Iterates
 *  `proposal.sourceRowIds` so the payload always follows proposal order, one
 *  complete form per row, regardless of the insertion order of `forms`. */
export function buildEvidenceOnlyBatchPayload(input: {
  proposal: ValidatedProposal
  forms: ReadonlyMap<string, SourceBackedEditableFields>
  sectionIndexes: ReadonlyMap<string, number>
}): EvidenceOnlyBatchPayload {
  const items = input.proposal.sourceRowIds.map((sourceRowId) => {
    const form = input.forms.get(sourceRowId)
    const sectionIndex = input.sectionIndexes.get(sourceRowId)
    if (!form || sectionIndex === undefined) {
      throw new Error(`Missing form or section index for source row ${sourceRowId}`)
    }
    return {
      sourceRowId,
      sectionIndex,
      item: buildSourceBackedItemPayload(form, sectionIndex).item,
    }
  })
  return { items }
}

/** Returns whether every form validates and every section index is in range.
 *  Reuses the shared single-row validator so financial rules stay in lockstep;
 *  the batch is only valid when every row and section is valid. */
export function validateEvidenceOnlyBatch(input: {
  proposal: ValidatedProposal
  forms: ReadonlyMap<string, SourceBackedEditableFields>
  sectionIndexes: ReadonlyMap<string, number>
  sections: readonly Pick<Boq["sections"][number], "header">[]
}): { valid: boolean } {
  for (const sourceRowId of input.proposal.sourceRowIds) {
    const form = input.forms.get(sourceRowId)
    const sectionIndex = input.sectionIndexes.get(sourceRowId)
    if (!form || sectionIndex === undefined) return { valid: false }
    if (!validateSourceBackedForm(form).valid) return { valid: false }
    if (!Number.isInteger(sectionIndex) || sectionIndex < 0 || sectionIndex >= input.sections.length) {
      return { valid: false }
    }
  }
  return { valid: true }
}

function formatSourceRef(sourceRow: EvidenceOnlyBatchSourceRow): string {
  return `p.${sourceRow.page} t.${sourceRow.table} r.${sourceRow.row}`
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return ""
  return String(value)
}

function parseNumberInput(text: string): number {
  if (text.trim() === "") return EMPTY_NUMERIC
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : EMPTY_NUMERIC
}

interface EvidenceOnlyBatchItemEditorProps {
  boq: Boq
  proposal: ValidatedProposal
  /** Source rows backing this proposal, keyed by `sourceRowId`. Used only to
   *  pick a default destination section and to label each form with its source
   *  reference. Structurally narrowed so the editor never imports the
   *  server-side AI review module. */
  sourceRows: readonly EvidenceOnlyBatchSourceRow[]
  onSubmit: (payload: EvidenceOnlyBatchPayload) => Promise<{ ok: true } | { ok: false; error: string }>
  onCancel: () => void
  busy?: boolean
  serverError?: string | null
}

export function EvidenceOnlyBatchItemEditor({
  boq,
  proposal,
  sourceRows,
  onSubmit,
  onCancel,
  busy = false,
  serverError = null,
}: EvidenceOnlyBatchItemEditorProps) {
  const sourceRowsById = useMemo(() => new Map(sourceRows.map((row) => [row.sourceRowId, row])), [sourceRows])
  const [forms, setForms] = useState<Map<string, SourceBackedFieldValues>>(() => initializeEvidenceOnlyBatchForms(proposal))
  const [sectionIndexes, setSectionIndexes] = useState<Map<string, number>>(() => {
    const initial = new Map<string, number>()
    for (const sourceRowId of proposal.sourceRowIds) {
      const sourceRow = sourceRowsById.get(sourceRowId)
      initial.set(sourceRowId, sourceRow ? defaultEvidenceOnlyBatchSectionIndex(sourceRow, boq.sections) : 0)
    }
    return initial
  })
  const [submitTouched, setSubmitTouched] = useState(false)

  const batchValid = validateEvidenceOnlyBatch({ proposal, forms, sectionIndexes, sections: boq.sections }).valid
  const showErrors = submitTouched

  const updateField = <K extends EditableFieldKey>(sourceRowId: string, key: K, value: SourceBackedFieldValues[K]): void => {
    setForms((current) => {
      const existing = current.get(sourceRowId)
      if (!existing) return current
      return new Map(current).set(sourceRowId, { ...existing, [key]: value })
    })
  }

  const updateSection = (sourceRowId: string, nextIndex: number): void => {
    setSectionIndexes((current) => new Map(current).set(sourceRowId, nextIndex))
  }

  const count = proposal.sourceRowIds.length

  const handleSubmit = async (): Promise<void> => {
    setSubmitTouched(true)
    if (!batchValid) return
    const payload = buildEvidenceOnlyBatchPayload({ proposal, forms, sectionIndexes })
    await onSubmit(payload)
  }

  return (
    <form
      className="evidence-only-batch-item-editor"
      data-od-id={`evidence-only-batch-editor-${proposal.id}`}
      aria-label={`Add ${count} BOQ items from reviewed source`}
      onSubmit={(event) => {
        event.preventDefault()
        void handleSubmit()
      }}
    >
      <div className="evidence-only-batch-heading">
        <strong>Review &amp; add {count} BOQ items</strong>
        <span>Correct editable values for each source row before adding them to the BOQ.</span>
      </div>

      {proposal.sourceRowIds.map((sourceRowId) => {
        const sourceRow = sourceRowsById.get(sourceRowId)
        if (!sourceRow) return null
        const values = forms.get(sourceRowId)
        const sectionIndex = sectionIndexes.get(sourceRowId)
        if (!values || sectionIndex === undefined) return null
        const validation = validateSourceBackedForm(values)
        const liveTotal = computeSourceBackedLiveTotal(values)
        const sourceRef = formatSourceRef(sourceRow)

        const descError = showErrors ? validation.errors.desc : undefined
        const unitError = showErrors ? validation.errors.unit : undefined
        const qtyError = showErrors ? validation.errors.qty : undefined
        const materialError = showErrors ? validation.errors.materialCost : undefined
        const labourError = showErrors ? validation.errors.labourCost : undefined

        return (
          <fieldset key={sourceRowId} className="evidence-only-batch-row">
            <legend>Source row {sourceRef}</legend>

            <div className="evidence-only-batch-field">
              <label htmlFor={`eob-desc-${sourceRowId}`}>Description ({sourceRef})</label>
              <Input
                id={`eob-desc-${sourceRowId}`}
                name={`desc-${sourceRowId}`}
                value={values.desc}
                aria-invalid={Boolean(descError) || undefined}
                onChange={(event) => updateField(sourceRowId, "desc", (event.target as HTMLInputElement).value)}
              />
              {descError ? <small className="evidence-only-batch-field-error" role="alert">{descError}</small> : null}
            </div>

            <div className="evidence-only-batch-field">
              <label htmlFor={`eob-unit-${sourceRowId}`}>Unit ({sourceRef})</label>
              <Input
                id={`eob-unit-${sourceRowId}`}
                name={`unit-${sourceRowId}`}
                value={values.unit}
                aria-invalid={Boolean(unitError) || undefined}
                onChange={(event) => updateField(sourceRowId, "unit", (event.target as HTMLInputElement).value)}
              />
              {unitError ? <small className="evidence-only-batch-field-error" role="alert">{unitError}</small> : null}
            </div>

            <div className="evidence-only-batch-field">
              <label htmlFor={`eob-qty-${sourceRowId}`}>Quantity ({sourceRef})</label>
              <Input
                id={`eob-qty-${sourceRowId}`}
                name={`qty-${sourceRowId}`}
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                value={Number.isFinite(values.qty) ? values.qty : ""}
                aria-invalid={Boolean(qtyError) || undefined}
                onChange={(event) => updateField(sourceRowId, "qty", parseNumberInput((event.target as HTMLInputElement).value))}
              />
              {qtyError ? <small className="evidence-only-batch-field-error" role="alert">{qtyError}</small> : null}
            </div>

            <div className="evidence-only-batch-field">
              <label htmlFor={`eob-material-${sourceRowId}`}>Material rate ({sourceRef})</label>
              <Input
                id={`eob-material-${sourceRowId}`}
                name={`materialCost-${sourceRowId}`}
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={formatNumber(values.materialCost)}
                aria-invalid={Boolean(materialError) || undefined}
                onChange={(event) => updateField(sourceRowId, "materialCost", parseNumberInput((event.target as HTMLInputElement).value))}
              />
              {materialError ? <small className="evidence-only-batch-field-error" role="alert">{materialError}</small> : null}
            </div>

            <div className="evidence-only-batch-field">
              <label htmlFor={`eob-labour-${sourceRowId}`}>Labour rate ({sourceRef})</label>
              <Input
                id={`eob-labour-${sourceRowId}`}
                name={`labourCost-${sourceRowId}`}
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={formatNumber(values.labourCost)}
                aria-invalid={Boolean(labourError) || undefined}
                onChange={(event) => updateField(sourceRowId, "labourCost", parseNumberInput((event.target as HTMLInputElement).value))}
              />
              {labourError ? <small className="evidence-only-batch-field-error" role="alert">{labourError}</small> : null}
            </div>

            <div className="evidence-only-batch-field">
              <label htmlFor={`eob-section-${sourceRowId}`}>Destination section ({sourceRef})</label>
              <select
                id={`eob-section-${sourceRowId}`}
                name={`sectionIndex-${sourceRowId}`}
                value={String(sectionIndex)}
                onChange={(event) => updateSection(sourceRowId, Number((event.target as HTMLSelectElement).value))}
              >
                {boq.sections.map((section, index) => (
                  <option key={`${index}-${section.header}`} value={String(index)}>{section.header}</option>
                ))}
              </select>
            </div>

            <p className="evidence-only-batch-live-total" aria-live="polite">
              {liveTotal === null
                ? "Enter valid qty and rates to see the row total."
                : `Row total: ฿${liveTotal.toLocaleString()}`}
            </p>
          </fieldset>
        )
      })}

      {serverError ? <div className="evidence-only-batch-server-error" role="alert">{serverError}</div> : null}

      <div className="evidence-only-batch-actions">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" size="sm" disabled={busy || !batchValid}>
          {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          Add {count} BOQ items
        </Button>
      </div>
    </form>
  )
}
