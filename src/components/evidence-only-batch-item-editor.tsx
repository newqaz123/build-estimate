"use client"

import { useMemo, useReducer, useState } from "react"
import { Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  buildEvidenceOnlyDecisionBatchPayload,
  evidenceOnlyBatchEditorReducer,
  evidenceOnlyDecisionActionLabel,
  initializeEvidenceOnlyBatchEditorState,
  validateEvidenceOnlyDecisionBatch,
  type EvidenceOnlyBatchSourceRow,
  type EvidenceOnlyDecisionBatchPayload,
  type EvidenceOnlyRowDecision,
} from "@/components/evidence-only-batch-item-editor-state"
import {
  computeSourceBackedLiveTotal,
  validateSourceBackedForm,
  type SourceBackedEditableFields,
} from "@/components/source-backed-item-editor"
import type { Boq } from "@/lib/boq-schema"
import type { ValidatedProposal } from "@/lib/boq-extraction-proposals"

/** Backward-compatible alias for the decision-batch payload so existing callers
 *  (e.g. extraction-review) keep type-checking against the server's decision
 *  shape without importing the state module directly. */
export type EvidenceOnlyBatchPayload = EvidenceOnlyDecisionBatchPayload

interface EvidenceOnlyBatchItemEditorProps {
  boq: Boq
  proposal: ValidatedProposal
  /** Source rows backing this proposal, keyed by `sourceRowId`. Used only to
   *  pick a default destination section and to label each form with its source
   *  reference. Structurally narrowed so the editor never imports the
   *  server-side AI review module. */
  sourceRows: readonly EvidenceOnlyBatchSourceRow[]
  onSubmit: (payload: EvidenceOnlyDecisionBatchPayload) => Promise<{ ok: true } | { ok: false; error: string }>
  onCancel: () => void
  busy?: boolean
  serverError?: string | null
}

function formatSourceRef(sourceRow: EvidenceOnlyBatchSourceRow): string {
  return `p.${sourceRow.page} t.${sourceRow.table} r.${sourceRow.row}`
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return ""
  return String(value)
}

function parseNumberInput(text: string): number {
  if (text.trim() === "") return Number.NaN
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : Number.NaN
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
  const suggestionsById = useMemo(
    () => new Map((proposal.sourceRowSuggestions ?? []).map((suggestion) => [suggestion.sourceRowId, suggestion])),
    [proposal.sourceRowSuggestions],
  )
  const [state, dispatch] = useReducer(
    evidenceOnlyBatchEditorReducer,
    { proposal, sourceRows, sections: boq.sections },
    initializeEvidenceOnlyBatchEditorState,
  )
  const [submitTouched, setSubmitTouched] = useState(false)

  const batchValid = validateEvidenceOnlyDecisionBatch({ state, proposal, sections: boq.sections }).valid
  const actionLabel = evidenceOnlyDecisionActionLabel(state, proposal)
  const count = proposal.sourceRowIds.length
  const showErrors = submitTouched

  const setDecision = (sourceRowId: string, decision: EvidenceOnlyRowDecision): void => {
    dispatch({ type: "set_decision", sourceRowId, decision })
  }
  const updateField = (sourceRowId: string, field: keyof SourceBackedEditableFields, value: string | number): void => {
    dispatch({ type: "set_field", sourceRowId, field, value })
  }
  const updateSection = (sourceRowId: string, nextIndex: number): void => {
    dispatch({ type: "set_section", sourceRowId, sectionIndex: nextIndex })
  }
  const setNote = (sourceRowId: string, note: string): void => {
    dispatch({ type: "set_note", sourceRowId, note })
  }

  const handleSubmit = async (): Promise<void> => {
    setSubmitTouched(true)
    if (!batchValid) return
    const payload = buildEvidenceOnlyDecisionBatchPayload({ state, proposal })
    await onSubmit(payload)
  }

  return (
    <form
      className="evidence-only-batch-item-editor"
      data-od-id={`evidence-only-batch-editor-${proposal.id}`}
      aria-label={`Review source-row decisions for ${count} rows`}
      onSubmit={(event) => {
        event.preventDefault()
        void handleSubmit()
      }}
    >
      <div className="evidence-only-batch-heading">
        <strong>Review source-row decisions</strong>
        <span>Choose Add or Do not add for each source row before submitting.</span>
      </div>

      {proposal.sourceRowIds.map((sourceRowId) => {
        const sourceRow = sourceRowsById.get(sourceRowId)
        if (!sourceRow) return null
        const values = state.forms.get(sourceRowId)
        const sectionIndex = state.sectionIndexes.get(sourceRowId)
        const decision = state.decisions.get(sourceRowId) ?? "undecided"
        const note = state.notes.get(sourceRowId) ?? ""
        const suggestion = suggestionsById.get(sourceRowId)
        if (!values || sectionIndex === undefined) return null
        const sourceRef = formatSourceRef(sourceRow)

        const validation = validateSourceBackedForm(values)
        const liveTotal = computeSourceBackedLiveTotal(values)
        const descError = showErrors ? validation.errors.desc : undefined
        const unitError = showErrors ? validation.errors.unit : undefined
        const qtyError = showErrors ? validation.errors.qty : undefined
        const materialError = showErrors ? validation.errors.materialCost : undefined
        const labourError = showErrors ? validation.errors.labourCost : undefined

        return (
          <fieldset key={sourceRowId} className="evidence-only-batch-row">
            <legend>Source row {sourceRef}</legend>

            {suggestion ? (
              <p className="evidence-only-batch-suggestion">
                {`AI suggests ${suggestion.suggestedAction === "add" ? "add" : "do not add"} · ${suggestion.reason} · ${Math.round(suggestion.confidence * 100)}% confidence`}
              </p>
            ) : (
              <p className="evidence-only-batch-suggestion-unavailable">AI suggestion unavailable</p>
            )}

            <div className="evidence-only-batch-decision" role="group" aria-label={`Decision for source row ${sourceRef}`}>
              <input
                type="radio"
                id={`eob-add-${sourceRowId}`}
                name={`decision-${sourceRowId}`}
                value="add"
                checked={decision === "add"}
                onChange={() => setDecision(sourceRowId, "add")}
              />
              <label htmlFor={`eob-add-${sourceRowId}`}>Add</label>
              <input
                type="radio"
                id={`eob-ignore-${sourceRowId}`}
                name={`decision-${sourceRowId}`}
                value="ignore"
                checked={decision === "ignore"}
                onChange={() => setDecision(sourceRowId, "ignore")}
              />
              <label htmlFor={`eob-ignore-${sourceRowId}`}>Do not add</label>
            </div>

            {decision === "add" ? (
              <>
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
              </>
            ) : null}

            {decision === "ignore" ? (
              <div className="evidence-only-batch-field">
                <label htmlFor={`eob-note-${sourceRowId}`}>Note (optional)</label>
                <textarea
                  id={`eob-note-${sourceRowId}`}
                  name={`note-${sourceRowId}`}
                  value={note}
                  maxLength={500}
                  onChange={(event) => setNote(sourceRowId, (event.target as HTMLTextAreaElement).value)}
                />
              </div>
            ) : null}
          </fieldset>
        )
      })}

      {serverError ? <div className="evidence-only-batch-server-error" role="alert">{serverError}</div> : null}

      <div className="evidence-only-batch-actions">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" size="sm" disabled={busy || !batchValid}>
          {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          {actionLabel}
        </Button>
      </div>
    </form>
  )
}
