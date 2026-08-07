import {
  buildSourceBackedItemPayload,
  deriveInitialSourceBackedForm,
  validateSourceBackedForm,
  type SourceBackedEditableFields,
  type SourceBackedItemPayload,
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

export type EvidenceOnlyRowDecision = "undecided" | "add" | "ignore"

export interface EvidenceOnlyBatchEditorState {
  decisions: Map<string, EvidenceOnlyRowDecision>
  forms: Map<string, SourceBackedEditableFields>
  sectionIndexes: Map<string, number>
  notes: Map<string, string>
}

export type EvidenceOnlyBatchEditorAction =
  | { type: "set_decision"; sourceRowId: string; decision: EvidenceOnlyRowDecision }
  | { type: "set_field"; sourceRowId: string; field: keyof SourceBackedEditableFields; value: string | number }
  | { type: "set_section"; sourceRowId: string; sectionIndex: number }
  | { type: "set_note"; sourceRowId: string; note: string }

/** Request payload emitted for a multi-row evidence-only decision batch. Mirrors
 *  the server's decision-batch request shape: each source row appears exactly
 *  once, carrying either an add decision (editable item + section) or an ignore
 *  decision with an optional trimmed note. */
export interface EvidenceOnlyDecisionBatchPayload {
  decisions: Array<
    | { sourceRowId: string; action: "add"; sectionIndex: number; item: SourceBackedItemPayload["item"] }
    | { sourceRowId: string; action: "ignore"; note?: string }
  >
}

const MAX_NOTE_LENGTH = 500

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

/** Builds the initial per-row review state. Every source row starts undecided
 *  with a blank/manual form, a destination section resolved from its source-row
 *  hint, and an empty ignore note — never preselected from non-binding AI
 *  advice. Every map is keyed in `proposal.sourceRowIds` order. */
export function initializeEvidenceOnlyBatchEditorState(input: {
  proposal: ValidatedProposal
  sourceRows: readonly EvidenceOnlyBatchSourceRow[]
  sections: readonly Pick<Boq["sections"][number], "header">[]
}): EvidenceOnlyBatchEditorState {
  const sourceRowsById = new Map(input.sourceRows.map((row) => [row.sourceRowId, row]))
  const decisions = new Map<string, EvidenceOnlyRowDecision>()
  const forms = new Map<string, SourceBackedEditableFields>()
  const sectionIndexes = new Map<string, number>()
  const notes = new Map<string, string>()
  for (const sourceRowId of input.proposal.sourceRowIds) {
    decisions.set(sourceRowId, "undecided")
    forms.set(sourceRowId, deriveInitialSourceBackedForm(undefined))
    const sourceRow = sourceRowsById.get(sourceRowId)
    sectionIndexes.set(sourceRowId, sourceRow ? defaultEvidenceOnlyBatchSectionIndex(sourceRow, input.sections) : 0)
    notes.set(sourceRowId, "")
  }
  return { decisions, forms, sectionIndexes, notes }
}

/** Pure state transition for the evidence-only batch editor. Each action maps
 *  to a single independent slice, so switching a row's decision never clears the
 *  typed form or note — hidden add fields survive a temporary ignore. Decisions
 *  change only on an explicit `set_decision`; AI advice never drives state. */
export function evidenceOnlyBatchEditorReducer(
  state: EvidenceOnlyBatchEditorState,
  action: EvidenceOnlyBatchEditorAction,
): EvidenceOnlyBatchEditorState {
  switch (action.type) {
    case "set_decision": {
      if (!state.decisions.has(action.sourceRowId)) return state
      const decisions = new Map(state.decisions)
      decisions.set(action.sourceRowId, action.decision)
      return { ...state, decisions }
    }
    case "set_field": {
      const form = state.forms.get(action.sourceRowId)
      if (!form) return state
      const forms = new Map(state.forms)
      forms.set(action.sourceRowId, { ...form, [action.field]: action.value } as SourceBackedEditableFields)
      return { ...state, forms }
    }
    case "set_section": {
      if (!state.sectionIndexes.has(action.sourceRowId)) return state
      const sectionIndexes = new Map(state.sectionIndexes)
      sectionIndexes.set(action.sourceRowId, action.sectionIndex)
      return { ...state, sectionIndexes }
    }
    case "set_note": {
      if (!state.notes.has(action.sourceRowId)) return state
      const notes = new Map(state.notes)
      notes.set(action.sourceRowId, action.note)
      return { ...state, notes }
    }
    default:
      return state
  }
}

/** Returns whether every source row carries a complete decision: no undecided
 *  rows, every add row has a valid form and in-range section, and every ignore
 *  note is within the 500-character limit. Iterates `proposal.sourceRowIds` so
 *  map insertion order never affects the result. */
export function validateEvidenceOnlyDecisionBatch(input: {
  state: EvidenceOnlyBatchEditorState
  proposal: ValidatedProposal
  sections: readonly Pick<Boq["sections"][number], "header">[]
}): { valid: boolean } {
  for (const sourceRowId of input.proposal.sourceRowIds) {
    const decision = input.state.decisions.get(sourceRowId)
    if (decision === undefined || decision === "undecided") return { valid: false }
    if (decision === "add") {
      const form = input.state.forms.get(sourceRowId)
      const sectionIndex = input.state.sectionIndexes.get(sourceRowId)
      if (!form || sectionIndex === undefined) return { valid: false }
      if (!validateSourceBackedForm(form).valid) return { valid: false }
      if (!Number.isInteger(sectionIndex) || sectionIndex < 0 || sectionIndex >= input.sections.length) {
        return { valid: false }
      }
    } else {
      const note = input.state.notes.get(sourceRowId) ?? ""
      if (note.length > MAX_NOTE_LENGTH) return { valid: false }
    }
  }
  return { valid: true }
}

/** Emits the decision-batch payload. Iterates `proposal.sourceRowIds` so the
 *  payload always follows proposal order with each row exactly once. Only the
 *  currently selected action enters the outgoing payload: add rows contribute
 *  editable item values plus sectionIndex; ignore rows contribute an optional
 *  trimmed note. AI suggestion, reason, confidence, raw evidence, and provider
 *  explanation never appear. */
export function buildEvidenceOnlyDecisionBatchPayload(input: {
  state: EvidenceOnlyBatchEditorState
  proposal: ValidatedProposal
}): EvidenceOnlyDecisionBatchPayload {
  const decisions = input.proposal.sourceRowIds.map<EvidenceOnlyDecisionBatchPayload["decisions"][number]>((sourceRowId) => {
    const decision = input.state.decisions.get(sourceRowId)
    if (decision === "add") {
      const form = input.state.forms.get(sourceRowId)
      const sectionIndex = input.state.sectionIndexes.get(sourceRowId)
      if (!form || sectionIndex === undefined) {
        throw new Error(`Missing form or section index for add source row ${sourceRowId}`)
      }
      return {
        sourceRowId,
        action: "add",
        sectionIndex,
        item: buildSourceBackedItemPayload(form, sectionIndex).item,
      }
    }
    if (decision === "ignore") {
      const note = (input.state.notes.get(sourceRowId) ?? "").trim()
      return note
        ? { sourceRowId, action: "ignore", note }
        : { sourceRowId, action: "ignore" }
    }
    throw new Error(`Source row ${sourceRowId} has no selected decision`)
  })
  return { decisions }
}

/** Renders the primary action label from the current decisions. Counts only
 *  explicit add/ignore decisions so an all-undecided state reads as a neutral
 *  review prompt; a mixed state lists both actions. */
export function evidenceOnlyDecisionActionLabel(
  state: EvidenceOnlyBatchEditorState,
  proposal: ValidatedProposal,
): string {
  let addCount = 0
  let ignoreCount = 0
  for (const sourceRowId of proposal.sourceRowIds) {
    const decision = state.decisions.get(sourceRowId)
    if (decision === "add") addCount += 1
    else if (decision === "ignore") ignoreCount += 1
  }
  if (addCount > 0 && ignoreCount > 0) return `Add ${addCount} BOQ items · Ignore ${ignoreCount} rows`
  if (addCount > 0) return `Add ${addCount} BOQ items`
  if (ignoreCount > 0) return `Ignore ${ignoreCount} rows`
  return "Review source-row decisions"
}
