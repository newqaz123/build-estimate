"use client"

import { useMemo, useState } from "react"
import { Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { ValidatedProposal } from "@/lib/boq-extraction-proposals"
import type { Boq } from "@/lib/boq-schema"

/** The editor must not import server-side mapping resolution logic. We derive
 *  every type purely from `ValidatedProposal.reviewDraft` so only the
 *  server-resolved values cross the prop boundary. */
type SourceBackedReviewDraft = NonNullable<ValidatedProposal["reviewDraft"]>
type SourceReviewMissingField = SourceBackedReviewDraft["missingFields"][number]

/** Shape of the editable fields the user can change. Validation and payload
 *  builders accept just this surface so they can be unit-tested with minimal
 *  fixtures. */
export interface SourceBackedEditableFields {
  desc: string
  unit: string
  qty: number
  materialCost: number
  labourCost: number
}

/** Editable field values derived from a source-backed review draft. The editor
 *  owns only these values; provenance (sourceRowIds/sourceRef/sourceCosts/
 *  mapping) is never reconstructed on the client — the server derives it from
 *  the immutable reviewDraft inside the add-source-item transaction. */
export interface SourceBackedFieldValues extends SourceBackedEditableFields {
  /** True when the source resolved a single generic rate/total rather than
   *  separate material + labour components. The UI collapses to one rate
   *  input but still emits materialCost/labourCost in the request shape. */
  isSingleRate: boolean
  /** Original generic rate from the draft, when `isSingleRate` is true. */
  singleRate: number | null
  /** Fields the source did not resolve; rendered blank with a visible label. */
  missingFields: SourceReviewMissingField[]
}

export interface SourceBackedItemPayload {
  sectionIndex: number
  item: {
    desc: string
    unit: string
    qty: number
    materialCost: number
    labourCost: number
  }
}

export interface SourceBackedFormValidation {
  valid: boolean
  errors: { desc?: string; unit?: string; qty?: string; materialCost?: string; labourCost?: string }
}

const EMPTY_NUMERIC = Number.NaN
const MISSING_LABEL: Record<SourceReviewMissingField, string> = {
  description: "Description missing from source",
  unit: "Unit missing from source",
  quantity: "Quantity missing from source",
  rate: "Rate missing from source",
  total: "Total missing from source",
  materialRate: "Material rate missing from source",
  materialTotal: "Material total missing from source",
  labourRate: "Labour rate missing from source",
  labourTotal: "Labour total missing from source",
  amount: "Amount missing from source",
  destinationSection: "Destination section missing from source",
  targetItemState: "Target item state missing from source",
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function hasCentsPrecision(value: number): boolean {
  return Math.round(value * 100) / 100 === value
}

/** Pre-fills editable values from server-resolved source cells. Component
 *  prices (materialRate/labourRate) win when present; otherwise we collapse to
 *  a single-rate path so the request shape stays consistent. When no draft is
 *  supplied (evidence-only manual review), every priced field is left blank so
 *  the user supplies all values manually. */
export function deriveInitialSourceBackedForm(
  draft?: SourceBackedReviewDraft,
): SourceBackedFieldValues {
  if (!draft) {
    return {
      desc: '',
      unit: '',
      qty: EMPTY_NUMERIC,
      materialCost: EMPTY_NUMERIC,
      labourCost: EMPTY_NUMERIC,
      isSingleRate: false,
      singleRate: null,
      missingFields: ['description', 'unit', 'quantity', 'materialRate', 'labourRate', 'amount'],
    }
  }
  const resolved = draft.resolvedValues
  const hasComponentPrices = resolved.materialRate !== undefined || resolved.labourRate !== undefined
  const hasGenericPrice = resolved.rate !== undefined || resolved.total !== undefined
  const isSingleRate = !hasComponentPrices && hasGenericPrice
  const singleRate = isFiniteNonNegative(resolved.rate) ? resolved.rate : null
  return {
    desc: typeof resolved.description === "string" && resolved.description.trim() !== "" ? resolved.description : "",
    unit: typeof resolved.unit === "string" && resolved.unit.trim() !== "" ? resolved.unit : "",
    qty: isFiniteNonNegative(resolved.quantity) ? resolved.quantity : EMPTY_NUMERIC,
    // When the source provided component rates, pre-fill each side. When only a
    // generic rate exists, route the entire rate through materialCost and keep
    // labourCost at zero — the server re-derives rate = material + labour.
    materialCost: hasComponentPrices
      ? (isFiniteNonNegative(resolved.materialRate) ? resolved.materialRate : EMPTY_NUMERIC)
      : isSingleRate && singleRate !== null
        ? singleRate
        : EMPTY_NUMERIC,
    labourCost: hasComponentPrices
      ? (isFiniteNonNegative(resolved.labourRate) ? resolved.labourRate : EMPTY_NUMERIC)
      : 0,
    isSingleRate,
    singleRate,
    missingFields: [...draft.missingFields],
  }
}

function normalizeSectionHeader(header: string): string {
  return header.trim().toLowerCase()
}

/** Narrows the server-side extraction review row to just the slice the editor
 *  needs to pick a default destination section. Defined locally so the editor
 *  never imports the server-side AI review module; `ExtractionReview` passes
 *  full review rows that structurally satisfy this contract. */
export interface SourceBackedEditorSourceRow {
  section: string | null
}

/** Chooses the destination section index for a source-backed edit.
 *
 *  - A mapped draft with a section keeps its declared index.
 *  - A mapped draft with `section: null` returns `null` so the explicit user
 *    selection is preserved.
 *  - With no draft (evidence-only manual review), the first non-empty source
 *    row section is matched case-insensitively against the BOQ headers.
 *  - When nothing matches, the first BOQ section is chosen, or `null` when the
 *    BOQ has no sections. */
export function defaultSourceBackedSectionIndex(
  draft: SourceBackedReviewDraft | undefined,
  sourceRows: readonly SourceBackedEditorSourceRow[],
  sections: readonly Pick<Boq["sections"][number], "header">[],
): number | null {
  if (draft) {
    return draft.section === null ? null : draft.section.index
  }
  const sourceSection = sourceRows
    .map((row) => row.section)
    .find((section): section is string => typeof section === "string" && section.trim() !== "")
  if (sourceSection !== undefined) {
    const needle = normalizeSectionHeader(sourceSection)
    const matched = sections.findIndex((section) => normalizeSectionHeader(section.header) === needle)
    if (matched !== -1) return matched
  }
  return sections.length > 0 ? 0 : null
}

/** Returns the live qty × (material + labour) total, or null when any input
 *  is non-finite or negative. The server re-derives total from the same
 *  formula inside `applyManualCostAllocation`, so this stays in lockstep. */
export function computeSourceBackedLiveTotal(input: { qty: number; materialCost: number; labourCost: number }): number | null {
  if (!isFiniteNonNegative(input.qty) || !isFiniteNonNegative(input.materialCost) || !isFiniteNonNegative(input.labourCost)) return null
  return input.qty * (input.materialCost + input.labourCost)
}

/** Blocks save on empty descriptions, missing units, non-positive qty, or any
 *  non-finite / negative / over-precise component value. Mirrors the server's
 *  `parseSourceBackedItemRequest` defences without duplicating its logic. */
export function validateSourceBackedForm(values: SourceBackedEditableFields): SourceBackedFormValidation {
  const errors: SourceBackedFormValidation["errors"] = {}
  if (typeof values.desc !== "string" || values.desc.trim() === "" || values.desc.length > 500) errors.desc = "Enter a description."
  if (typeof values.unit !== "string" || values.unit.trim() === "" || values.unit.length > 50) errors.unit = "Enter a unit."
  if (!isFiniteNonNegative(values.qty) || values.qty === 0) errors.qty = "Quantity must be a positive number."
  if (!isFiniteNonNegative(values.materialCost)) errors.materialCost = "Material cost must be a finite non-negative number."
  if (!isFiniteNonNegative(values.labourCost)) errors.labourCost = "Labour cost must be a finite non-negative number."
  if (errors.materialCost === undefined && !hasCentsPrecision(values.materialCost)) errors.materialCost = "Material cost supports up to two decimal places."
  if (errors.labourCost === undefined && !hasCentsPrecision(values.labourCost)) errors.labourCost = "Labour cost supports up to two decimal places."
  return { valid: Object.keys(errors).length === 0, errors }
}

/** Emits the request payload the Task 5 endpoint expects. Only editable values
 *  + sectionIndex; never provenance. */
export function buildSourceBackedItemPayload(values: SourceBackedEditableFields, sectionIndex: number): SourceBackedItemPayload {
  return {
    sectionIndex,
    item: {
      desc: values.desc.trim(),
      unit: values.unit.trim(),
      qty: values.qty,
      materialCost: values.materialCost,
      labourCost: values.labourCost,
    },
  }
}

interface SourceBackedItemEditorProps {
  boq: Boq
  proposal: ValidatedProposal
  /** Returns whether the mutation succeeded. On failure, the editor stays open
   *  and surfaces the server error inline + via toast. */
  onSubmit: (payload: SourceBackedItemPayload) => Promise<{ ok: true } | { ok: false; error: string }>
  onCancel: () => void
  busy?: boolean
  serverError?: string | null
  /** Source rows backing this proposal. Used only to pick a default
   *  destination section for evidence-only (no-draft) edits; mapped drafts keep
   *  their own section. Structurally narrowed so the editor never imports the
   *  server-side AI review module. */
  sourceRows?: readonly SourceBackedEditorSourceRow[]
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return ""
  return Number.isInteger(value) ? String(value) : String(value)
}

function parseNumberInput(text: string): number {
  if (text.trim() === "") return EMPTY_NUMERIC
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : EMPTY_NUMERIC
}

function FieldBadge({ source, missingLabel }: { source: boolean; missingLabel?: string }) {
  if (missingLabel) {
    return <span className="source-backed-field-badge is-missing">{missingLabel}</span>
  }
  if (source) {
    return <span className="source-backed-field-badge is-source">Source</span>
  }
  return <span className="source-backed-field-badge is-manual">Manual</span>
}

const EMPTY_SOURCE_ROWS: readonly SourceBackedEditorSourceRow[] = []

export function SourceBackedItemEditor({ boq, proposal, onSubmit, onCancel, busy = false, serverError = null, sourceRows }: SourceBackedItemEditorProps) {
  const draft = proposal.reviewDraft ?? null
  const initial = useMemo(() => deriveInitialSourceBackedForm(draft ?? undefined), [draft])
  const [values, setValues] = useState<SourceBackedFieldValues>(initial)
  const [sectionIndex, setSectionIndex] = useState<number | null>(
    defaultSourceBackedSectionIndex(draft ?? undefined, sourceRows ?? EMPTY_SOURCE_ROWS, boq.sections),
  )
  const [submitTouched, setSubmitTouched] = useState(false)

  const validation = validateSourceBackedForm(values)
  const liveTotal = computeSourceBackedLiveTotal(values)
  const needsSectionSelect = !draft || draft.section === null
  const sectionMissing = needsSectionSelect && sectionIndex === null
  const formInvalid = !validation.valid || sectionMissing
  const showErrors = submitTouched

  const fieldIsMissing = (field: SourceReviewMissingField) => values.missingFields.includes(field)
  const sourceBadgeFor = (field: SourceReviewMissingField) => Boolean(draft) && !fieldIsMissing(field)
  // Only a mapped draft carries resolved source cells, so "missing from source"
  // badges are meaningful there. Evidence-only edits are entirely manual.
  const missingLabelFor = (field: SourceReviewMissingField): string | undefined =>
    Boolean(draft) && fieldIsMissing(field) ? MISSING_LABEL[field] : undefined

  const handleSubmit = async () => {
    setSubmitTouched(true)
    if (formInvalid) return
    if (sectionIndex === null) return
    const payload = buildSourceBackedItemPayload(values, sectionIndex)
    await onSubmit(payload)
  }

  // Maps each editable field key to the corresponding reviewDraft missing-field
  // identifier, so typing into a previously-missing field clears its badge.
  const fieldToMissingKey: Partial<Record<keyof SourceBackedFieldValues, SourceReviewMissingField>> = {
    desc: "description",
    unit: "unit",
    qty: "quantity",
    materialCost: "materialRate",
    labourCost: "labourRate",
  }
  const updateValue = <K extends keyof SourceBackedFieldValues>(key: K, value: SourceBackedFieldValues[K]) => {
    setValues((current) => {
      if (!current) return current
      const missingKey = fieldToMissingKey[key]
      return {
        ...current,
        [key]: value,
        missingFields: missingKey ? current.missingFields.filter((field) => field !== missingKey) : current.missingFields,
      }
    })
  }

  const descError = showErrors ? validation.errors.desc : undefined
  const unitError = showErrors ? validation.errors.unit : undefined
  const qtyError = showErrors ? validation.errors.qty : undefined
  const materialError = showErrors ? validation.errors.materialCost : undefined
  const labourError = showErrors ? validation.errors.labourCost : undefined

  return (
    <form
      className="source-backed-item-editor"
      data-od-id={`source-backed-editor-${proposal.id}`}
      aria-label="Add BOQ item from reviewed source"
      onSubmit={(event) => { event.preventDefault(); void handleSubmit() }}
    >
      <div className="source-backed-item-editor-heading">
        <strong>Review &amp; add BOQ item</strong>
        <span>Correct editable values before adding this row to the BOQ.</span>
      </div>

      <div className="source-backed-item-editor-fields">
        <div className="source-backed-field">
          <label htmlFor={`source-backed-desc-${proposal.id}`}>Description</label>
          <Input
            id={`source-backed-desc-${proposal.id}`}
            name="desc"
            value={values.desc}
            aria-invalid={Boolean(descError) || undefined}
            onChange={(event) => updateValue("desc", (event.target as HTMLInputElement).value)}
          />
          <FieldBadge source={sourceBadgeFor("description")} missingLabel={missingLabelFor("description")} />
          {descError ? <small className="source-backed-field-error" role="alert">{descError}</small> : null}
        </div>

        <div className="source-backed-field">
          <label htmlFor={`source-backed-unit-${proposal.id}`}>Unit</label>
          <Input
            id={`source-backed-unit-${proposal.id}`}
            name="unit"
            value={values.unit}
            aria-invalid={Boolean(unitError) || undefined}
            onChange={(event) => updateValue("unit", (event.target as HTMLInputElement).value)}
          />
          <FieldBadge source={sourceBadgeFor("unit")} missingLabel={missingLabelFor("unit")} />
          {unitError ? <small className="source-backed-field-error" role="alert">{unitError}</small> : null}
        </div>

        <div className="source-backed-field">
          <label htmlFor={`source-backed-qty-${proposal.id}`}>Quantity</label>
          <Input
            id={`source-backed-qty-${proposal.id}`}
            name="qty"
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            value={Number.isFinite(values.qty) ? values.qty : ""}
            aria-invalid={Boolean(qtyError) || undefined}
            onChange={(event) => updateValue("qty", parseNumberInput((event.target as HTMLInputElement).value))}
          />
          <FieldBadge source={sourceBadgeFor("quantity")} missingLabel={missingLabelFor("quantity")} />
          {qtyError ? <small className="source-backed-field-error" role="alert">{qtyError}</small> : null}
        </div>

        {values.isSingleRate ? (
          <div className="source-backed-field">
            <label htmlFor={`source-backed-rate-${proposal.id}`}>Rate (combined)</label>
            <Input
              id={`source-backed-rate-${proposal.id}`}
              name="materialCost"
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              value={Number.isFinite(values.materialCost) ? values.materialCost : ""}
              aria-invalid={Boolean(materialError) || undefined}
              onChange={(event) => {
                const parsed = parseNumberInput((event.target as HTMLInputElement).value)
                setValues((current) => current ? { ...current, materialCost: parsed, singleRate: parsed } : current)
              }}
            />
            <FieldBadge source={values.singleRate !== null} />
            {materialError ? <small className="source-backed-field-error" role="alert">{materialError}</small> : null}
          </div>
        ) : (
          <>
            <div className="source-backed-field">
              <label htmlFor={`source-backed-material-${proposal.id}`}>Material rate</label>
              <Input
                id={`source-backed-material-${proposal.id}`}
                name="materialCost"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={formatNumber(values.materialCost)}
                aria-invalid={Boolean(materialError) || undefined}
                onChange={(event) => updateValue("materialCost", parseNumberInput((event.target as HTMLInputElement).value))}
              />
              <FieldBadge source={sourceBadgeFor("materialRate")} missingLabel={missingLabelFor("materialRate")} />
              {materialError ? <small className="source-backed-field-error" role="alert">{materialError}</small> : null}
            </div>

            <div className="source-backed-field">
              <label htmlFor={`source-backed-labour-${proposal.id}`}>Labour rate</label>
              <Input
                id={`source-backed-labour-${proposal.id}`}
                name="labourCost"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={formatNumber(values.labourCost)}
                aria-invalid={Boolean(labourError) || undefined}
                onChange={(event) => updateValue("labourCost", parseNumberInput((event.target as HTMLInputElement).value))}
              />
              <FieldBadge source={sourceBadgeFor("labourRate")} missingLabel={missingLabelFor("labourRate")} />
              {labourError ? <small className="source-backed-field-error" role="alert">{labourError}</small> : null}
            </div>
          </>
        )}

        {needsSectionSelect ? (
          <div className="source-backed-field">
            <label htmlFor={`source-backed-section-${proposal.id}`}>Destination section</label>
            <select
              id={`source-backed-section-${proposal.id}`}
              name="sectionIndex"
              value={sectionIndex === null ? "" : String(sectionIndex)}
              aria-invalid={Boolean(sectionMissing) || undefined}
              onChange={(event) => {
                const next = (event.target as HTMLSelectElement).value
                setSectionIndex(next === "" ? null : Number(next))
              }}
            >
              <option value="">Select a section…</option>
              {boq.sections.map((section, index) => (
                <option key={`${index}-${section.header}`} value={String(index)}>{section.header}</option>
              ))}
            </select>
            {sectionMissing ? <small className="source-backed-field-error" role="alert">Choose a destination section.</small> : null}
          </div>
        ) : (
          <p className="source-backed-section-resolved">
            Destination: <strong>{boq.sections[sectionIndex ?? 0]?.header ?? draft?.section?.header ?? "Unknown section"}</strong>
          </p>
        )}

        <p className="source-backed-live-total" aria-live="polite">
          {liveTotal === null
            ? "Enter valid qty and rates to see the row total."
            : `Row total: ฿${liveTotal.toLocaleString()}`}
        </p>
      </div>

      {serverError ? <div className="source-backed-server-error" role="alert">{serverError}</div> : null}

      <div className="source-backed-item-editor-actions">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" size="sm" disabled={busy || formInvalid}>
          {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          Add BOQ item
        </Button>
      </div>
    </form>
  )
}
