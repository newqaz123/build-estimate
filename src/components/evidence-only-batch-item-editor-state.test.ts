import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildEvidenceOnlyDecisionBatchPayload,
  defaultEvidenceOnlyBatchSectionIndex,
  evidenceOnlyBatchEditorReducer,
  evidenceOnlyDecisionActionLabel,
  initializeEvidenceOnlyBatchEditorState,
  validateEvidenceOnlyDecisionBatch,
  type EvidenceOnlyBatchEditorState,
  type EvidenceOnlyBatchSourceRow,
  type EvidenceOnlyRowDecision,
} from './evidence-only-batch-item-editor-state'
import type { SourceBackedEditableFields } from './source-backed-item-editor'
import type { Boq, BoqSection } from '@/lib/boq-schema'
import type { SourceRowDispositionSuggestion, ValidatedProposal } from '@/lib/boq-extraction-proposals'

function section(overrides: Partial<BoqSection> = {}): BoqSection {
  return { header: 'Substructure', items: [], ...overrides }
}

function sections(): BoqSection[] {
  return [section({ header: 'Substructure' }), section({ header: 'Finishing' })]
}

function sourceRow(overrides: Partial<EvidenceOnlyBatchSourceRow> = {}): EvidenceOnlyBatchSourceRow {
  return { sourceRowId: 'row-1', section: 'Substructure', page: 1, table: 0, row: 4, ...overrides }
}

function twoSourceRows(): EvidenceOnlyBatchSourceRow[] {
  return [
    sourceRow({ sourceRowId: 'row-1', section: 'Finishing', page: 1, table: 0, row: 4 }),
    sourceRow({ sourceRowId: 'row-2', section: 'Substructure', page: 2, table: 1, row: 7 }),
  ]
}

function twoRowProposal(overrides: Partial<ValidatedProposal> = {}): ValidatedProposal {
  return {
    id: 'prop-multi',
    extractionRunId: 'run-1',
    operation: 'needs_human_review',
    sourceRowIds: ['row-1', 'row-2'],
    targetItemIds: [],
    affectedItemFingerprints: {},
    confidence: 0.4,
    explanation: 'Multiple source rows need manual review with no automatic correction.',
    proposedItems: [],
    evidenceValid: true,
    reconciled: true,
    stale: false,
    reviewDraft: undefined,
    ...overrides,
  }
}

function tenRowProposal(): ValidatedProposal {
  return twoRowProposal({
    id: 'prop-ten',
    sourceRowIds: Array.from({ length: 10 }, (_, index) => `row-${index + 1}`),
  })
}

function validForm(overrides: Partial<SourceBackedEditableFields> = {}): SourceBackedEditableFields {
  return { desc: 'Wall', unit: 'm2', qty: 10, materialCost: 100, labourCost: 50, ...overrides }
}

function ignoreSuggestion(sourceRowId: string): SourceRowDispositionSuggestion {
  return {
    sourceRowId,
    suggestedAction: 'ignore',
    reasonCode: 'already_represented',
    reason: 'Already represented elsewhere',
    confidence: 0.92,
  }
}

/** Builds an editor state seeded from `initializeEvidenceOnlyBatchEditorState`
 *  (so every row starts undecided with a blank form, default section, and empty
 *  note) and then applies the supplied overrides. Keeps each validation/payload
 *  test focused on the decision/form/section/note under inspection. */
function stateOf(input: {
  proposal: ValidatedProposal
  decisions?: Record<string, EvidenceOnlyRowDecision>
  forms?: Record<string, SourceBackedEditableFields>
  sectionIndexes?: Record<string, number>
  notes?: Record<string, string>
}): EvidenceOnlyBatchEditorState {
  const state = initializeEvidenceOnlyBatchEditorState({
    proposal: input.proposal,
    sourceRows: [],
    sections: sections(),
  })
  if (input.decisions) for (const [id, decision] of Object.entries(input.decisions)) state.decisions.set(id, decision)
  if (input.forms) for (const [id, form] of Object.entries(input.forms)) state.forms.set(id, form)
  if (input.sectionIndexes) for (const [id, index] of Object.entries(input.sectionIndexes)) state.sectionIndexes.set(id, index)
  if (input.notes) for (const [id, note] of Object.entries(input.notes)) state.notes.set(id, note)
  return state
}

test('initializeEvidenceOnlyBatchEditorState seeds undecided decisions, blank forms, default sections, and empty notes per row in proposal order', () => {
  const proposal = twoRowProposal()
  const state = initializeEvidenceOnlyBatchEditorState({
    proposal,
    sourceRows: twoSourceRows(),
    sections: sections(),
  })
  // One undecided decision per row, keyed in proposal order.
  assert.deepEqual([...state.decisions.keys()], proposal.sourceRowIds)
  for (const id of proposal.sourceRowIds) assert.equal(state.decisions.get(id), 'undecided')
  // One blank/manual form per row in proposal order.
  assert.deepEqual([...state.forms.keys()], proposal.sourceRowIds)
  for (const form of state.forms.values()) {
    assert.equal(form.desc, '')
    assert.equal(form.unit, '')
    assert.equal(Number.isNaN(form.qty), true)
    assert.equal(Number.isNaN(form.materialCost), true)
    assert.equal(Number.isNaN(form.labourCost), true)
  }
  // Destination sections resolve from the source-row hint: row-1 Finishing -> 1, row-2 Substructure -> 0.
  assert.equal(state.sectionIndexes.get('row-1'), 1)
  assert.equal(state.sectionIndexes.get('row-2'), 0)
  assert.deepEqual([...state.sectionIndexes.keys()], proposal.sourceRowIds)
  // One empty note per row in proposal order.
  assert.deepEqual([...state.notes.keys()], proposal.sourceRowIds)
  for (const note of state.notes.values()) assert.equal(note, '')
})

test('initializeEvidenceOnlyBatchEditorState never copies AI per-row advice into decisions', () => {
  const proposal = twoRowProposal({
    sourceRowSuggestions: [ignoreSuggestion('row-1'), ignoreSuggestion('row-2')],
  })
  const state = initializeEvidenceOnlyBatchEditorState({
    proposal,
    sourceRows: twoSourceRows(),
    sections: sections(),
  })
  // The AI advises ignoring every row, but every decision stays undecided.
  assert.equal(state.decisions.get('row-1'), 'undecided')
  assert.equal(state.decisions.get('row-2'), 'undecided')
})

test('defaultEvidenceOnlyBatchSectionIndex matches section headers case-insensitively and otherwise defaults to index 0', () => {
  const secs = sections()
  assert.equal(defaultEvidenceOnlyBatchSectionIndex(sourceRow({ section: 'finishing' }), secs), 1)
  assert.equal(defaultEvidenceOnlyBatchSectionIndex(sourceRow({ section: 'SUBSTRUCTURE' }), secs), 0)
  assert.equal(defaultEvidenceOnlyBatchSectionIndex(sourceRow({ section: 'Unknown' }), secs), 0)
  assert.equal(defaultEvidenceOnlyBatchSectionIndex(sourceRow({ section: null }), secs), 0)
})

test('reducer transitions follow explicit actions, never AI advice, and preserve typed form and note state', () => {
  const proposal = twoRowProposal({
    sourceRowSuggestions: [ignoreSuggestion('row-1'), ignoreSuggestion('row-2')],
  })
  let state = initializeEvidenceOnlyBatchEditorState({
    proposal,
    sourceRows: twoSourceRows(),
    sections: sections(),
  })
  // Type into the add form while the row is still undecided.
  state = evidenceOnlyBatchEditorReducer(state, { type: 'set_field', sourceRowId: 'row-1', field: 'desc', value: 'Typed description' })
  state = evidenceOnlyBatchEditorReducer(state, { type: 'set_field', sourceRowId: 'row-1', field: 'qty', value: 12 })
  // Switch to add — the AI advice (ignore) is ignored; the typed form survives.
  state = evidenceOnlyBatchEditorReducer(state, { type: 'set_decision', sourceRowId: 'row-1', decision: 'add' })
  assert.equal(state.decisions.get('row-1'), 'add')
  assert.equal(state.forms.get('row-1')?.desc, 'Typed description')
  assert.equal(state.forms.get('row-1')?.qty, 12)
  // Switch to ignore — the add form stays hidden but preserved; type a note.
  state = evidenceOnlyBatchEditorReducer(state, { type: 'set_decision', sourceRowId: 'row-1', decision: 'ignore' })
  assert.equal(state.forms.get('row-1')?.desc, 'Typed description')
  state = evidenceOnlyBatchEditorReducer(state, { type: 'set_note', sourceRowId: 'row-1', note: 'Already represented' })
  assert.equal(state.notes.get('row-1'), 'Already represented')
  // Switch back to undecided — note and form both survive.
  state = evidenceOnlyBatchEditorReducer(state, { type: 'set_decision', sourceRowId: 'row-1', decision: 'undecided' })
  assert.equal(state.decisions.get('row-1'), 'undecided')
  assert.equal(state.forms.get('row-1')?.desc, 'Typed description')
  assert.equal(state.notes.get('row-1'), 'Already represented')
})

test('reducer set_section updates the destination section for one row without touching others', () => {
  let state = initializeEvidenceOnlyBatchEditorState({
    proposal: twoRowProposal(),
    sourceRows: twoSourceRows(),
    sections: sections(),
  })
  state = evidenceOnlyBatchEditorReducer(state, { type: 'set_section', sourceRowId: 'row-1', sectionIndex: 0 })
  assert.equal(state.sectionIndexes.get('row-1'), 0)
  assert.equal(state.sectionIndexes.get('row-2'), 0)
})

test('reducer set_field updates a single editable field on one row', () => {
  let state = initializeEvidenceOnlyBatchEditorState({
    proposal: twoRowProposal(),
    sourceRows: twoSourceRows(),
    sections: sections(),
  })
  state = evidenceOnlyBatchEditorReducer(state, { type: 'set_field', sourceRowId: 'row-1', field: 'unit', value: 'm' })
  state = evidenceOnlyBatchEditorReducer(state, { type: 'set_field', sourceRowId: 'row-1', field: 'labourCost', value: 25 })
  assert.equal(state.forms.get('row-1')?.unit, 'm')
  assert.equal(state.forms.get('row-1')?.labourCost, 25)
  // The other row's form is untouched.
  assert.equal(state.forms.get('row-2')?.unit, '')
})

test('reducer leaves unknown source-row ids unchanged', () => {
  const initial = initializeEvidenceOnlyBatchEditorState({
    proposal: twoRowProposal(),
    sourceRows: twoSourceRows(),
    sections: sections(),
  })
  const state = evidenceOnlyBatchEditorReducer(initial, { type: 'set_decision', sourceRowId: 'missing-row', decision: 'add' })
  assert.equal(state.decisions.has('missing-row'), false)
})

test('validateEvidenceOnlyDecisionBatch rejects an all-undecided state', () => {
  const proposal = twoRowProposal()
  const state = stateOf({ proposal })
  assert.equal(validateEvidenceOnlyDecisionBatch({ state, proposal, sections: sections() }).valid, false)
})

test('validateEvidenceOnlyDecisionBatch rejects a partially decided state', () => {
  const proposal = twoRowProposal()
  const state = stateOf({ proposal, decisions: { 'row-1': 'ignore' } })
  assert.equal(validateEvidenceOnlyDecisionBatch({ state, proposal, sections: sections() }).valid, false)
})

test('validateEvidenceOnlyDecisionBatch rejects an add row until its form and section are valid', () => {
  const proposal = twoRowProposal()
  const secs = sections()
  // Add row with a blank form is invalid.
  const blankAdd = stateOf({ proposal, decisions: { 'row-1': 'add', 'row-2': 'ignore' } })
  assert.equal(validateEvidenceOnlyDecisionBatch({ state: blankAdd, proposal, sections: secs }).valid, false)
  // Add row with a valid form but out-of-range section is invalid.
  const badSection = stateOf({
    proposal,
    decisions: { 'row-1': 'add', 'row-2': 'ignore' },
    forms: { 'row-1': validForm() },
    sectionIndexes: { 'row-1': 99 },
  })
  assert.equal(validateEvidenceOnlyDecisionBatch({ state: badSection, proposal, sections: secs }).valid, false)
  // Add row valid with an in-range section, ignore row valid -> the batch is valid.
  const good = stateOf({
    proposal,
    decisions: { 'row-1': 'add', 'row-2': 'ignore' },
    forms: { 'row-1': validForm() },
    sectionIndexes: { 'row-1': 0 },
  })
  assert.equal(validateEvidenceOnlyDecisionBatch({ state: good, proposal, sections: secs }).valid, true)
})

test('validateEvidenceOnlyDecisionBatch accepts an ignore row with no note and rejects an overlong note', () => {
  const proposal = twoRowProposal()
  const secs = sections()
  const ignoreOnly = stateOf({ proposal, decisions: { 'row-1': 'ignore', 'row-2': 'ignore' } })
  assert.equal(validateEvidenceOnlyDecisionBatch({ state: ignoreOnly, proposal, sections: secs }).valid, true)
  // A 501-character note is invalid; a 500-character note is fine.
  const overlong = stateOf({
    proposal,
    decisions: { 'row-1': 'ignore', 'row-2': 'ignore' },
    notes: { 'row-1': 'x'.repeat(500), 'row-2': 'x'.repeat(501) },
  })
  assert.equal(validateEvidenceOnlyDecisionBatch({ state: overlong, proposal, sections: secs }).valid, false)
  const atLimit = stateOf({
    proposal,
    decisions: { 'row-1': 'ignore', 'row-2': 'ignore' },
    notes: { 'row-1': 'x'.repeat(500), 'row-2': 'x'.repeat(500) },
  })
  assert.equal(validateEvidenceOnlyDecisionBatch({ state: atLimit, proposal, sections: secs }).valid, true)
})

test('validateEvidenceOnlyDecisionBatch accepts mixed, add-only, and ignore-only complete states', () => {
  const proposal = tenRowProposal()
  const secs = sections()
  const addIds = proposal.sourceRowIds.slice(0, 5)
  const ignoreIds = proposal.sourceRowIds.slice(5)
  const mixed = stateOf({
    proposal,
    decisions: {
      ...Object.fromEntries(addIds.map((id) => [id, 'add' as EvidenceOnlyRowDecision])),
      ...Object.fromEntries(ignoreIds.map((id) => [id, 'ignore' as EvidenceOnlyRowDecision])),
    },
    forms: Object.fromEntries(addIds.map((id) => [id, validForm()])),
    sectionIndexes: Object.fromEntries(addIds.map((id) => [id, 0])),
  })
  assert.equal(validateEvidenceOnlyDecisionBatch({ state: mixed, proposal, sections: secs }).valid, true)
  const allAdd = stateOf({
    proposal,
    decisions: Object.fromEntries(proposal.sourceRowIds.map((id) => [id, 'add' as EvidenceOnlyRowDecision])),
    forms: Object.fromEntries(proposal.sourceRowIds.map((id) => [id, validForm()])),
    sectionIndexes: Object.fromEntries(proposal.sourceRowIds.map((id) => [id, 1])),
  })
  assert.equal(validateEvidenceOnlyDecisionBatch({ state: allAdd, proposal, sections: secs }).valid, true)
  const allIgnore = stateOf({
    proposal,
    decisions: Object.fromEntries(proposal.sourceRowIds.map((id) => [id, 'ignore' as EvidenceOnlyRowDecision])),
  })
  assert.equal(validateEvidenceOnlyDecisionBatch({ state: allIgnore, proposal, sections: secs }).valid, true)
})

test('buildEvidenceOnlyDecisionBatchPayload follows proposal order and emits each row exactly once', () => {
  const proposal = twoRowProposal()
  const state = stateOf({
    proposal,
    decisions: { 'row-1': 'add', 'row-2': 'ignore' },
    forms: { 'row-1': validForm({ desc: 'Row one' }) },
    sectionIndexes: { 'row-1': 1 },
    notes: { 'row-2': 'Already represented' },
  })
  const payload = buildEvidenceOnlyDecisionBatchPayload({ state, proposal })
  assert.deepEqual(payload.decisions.map((decision) => decision.sourceRowId), ['row-1', 'row-2'])
  assert.equal(new Set(payload.decisions.map((decision) => decision.sourceRowId)).size, payload.decisions.length)
})

test('buildEvidenceOnlyDecisionBatchPayload follows proposal order even when state maps are out of order', () => {
  const proposal = twoRowProposal({ sourceRowIds: ['row-2', 'row-1'] })
  const state = stateOf({
    proposal,
    decisions: { 'row-1': 'add', 'row-2': 'ignore' },
    forms: { 'row-1': validForm({ desc: 'Row one' }) },
    sectionIndexes: { 'row-1': 0 },
  })
  const payload = buildEvidenceOnlyDecisionBatchPayload({ state, proposal })
  assert.deepEqual(payload.decisions.map((decision) => decision.sourceRowId), ['row-2', 'row-1'])
})

test('buildEvidenceOnlyDecisionBatchPayload emits editable item values for add and trims ignore notes', () => {
  const proposal = twoRowProposal()
  const state = stateOf({
    proposal,
    decisions: { 'row-1': 'add', 'row-2': 'ignore' },
    forms: { 'row-1': validForm({ desc: '  Row one  ' }) },
    sectionIndexes: { 'row-1': 1 },
    notes: { 'row-2': '  Already represented  ' },
  })
  const payload = buildEvidenceOnlyDecisionBatchPayload({ state, proposal })
  assert.deepEqual(payload.decisions, [
    { sourceRowId: 'row-1', action: 'add', sectionIndex: 1, item: { desc: 'Row one', unit: 'm2', qty: 10, materialCost: 100, labourCost: 50 } },
    { sourceRowId: 'row-2', action: 'ignore', note: 'Already represented' },
  ])
})

test('buildEvidenceOnlyDecisionBatchPayload omits the note when an ignore note is blank or whitespace', () => {
  const proposal = twoRowProposal()
  const state = stateOf({
    proposal,
    decisions: { 'row-1': 'ignore', 'row-2': 'ignore' },
    notes: { 'row-1': '   ', 'row-2': '' },
  })
  const payload = buildEvidenceOnlyDecisionBatchPayload({ state, proposal })
  assert.deepEqual(payload.decisions, [
    { sourceRowId: 'row-1', action: 'ignore' },
    { sourceRowId: 'row-2', action: 'ignore' },
  ])
  for (const decision of payload.decisions) {
    assert.equal('note' in decision, false)
  }
})

test('buildEvidenceOnlyDecisionBatchPayload never carries AI suggestion, reason, confidence, raw evidence, or provider explanation', () => {
  const proposal = twoRowProposal({
    sourceRowSuggestions: [ignoreSuggestion('row-1'), ignoreSuggestion('row-2')],
  })
  const state = stateOf({
    proposal,
    decisions: { 'row-1': 'add', 'row-2': 'ignore' },
    forms: { 'row-1': validForm() },
    sectionIndexes: { 'row-1': 0 },
    notes: { 'row-2': 'Already represented' },
  })
  const payload = buildEvidenceOnlyDecisionBatchPayload({ state, proposal })
  const serialized = JSON.stringify(payload)
  for (const term of ['suggestion', 'suggestedAction', 'reasonCode', 'confidence', 'explanation', 'sourceRowSuggestions', 'rawText', 'rawCells']) {
    assert.equal(serialized.includes(term), false, `payload must not include ${term}`)
  }
  // Each add item carries only the editable values plus sectionIndex.
  for (const decision of payload.decisions) {
    if (decision.action === 'add') {
      assert.deepEqual(Object.keys(decision.item).sort(), ['desc', 'labourCost', 'materialCost', 'qty', 'unit'])
    }
  }
})

test('evidenceOnlyDecisionActionLabel describes a mixed add/ignore state', () => {
  const proposal = tenRowProposal()
  const addIds = proposal.sourceRowIds.slice(0, 5)
  const ignoreIds = proposal.sourceRowIds.slice(5)
  const state = stateOf({
    proposal,
    decisions: {
      ...Object.fromEntries(addIds.map((id) => [id, 'add' as EvidenceOnlyRowDecision])),
      ...Object.fromEntries(ignoreIds.map((id) => [id, 'ignore' as EvidenceOnlyRowDecision])),
    },
  })
  assert.equal(evidenceOnlyDecisionActionLabel(state, proposal), 'Add 5 BOQ items · Ignore 5 rows')
})

test('evidenceOnlyDecisionActionLabel describes an all-add state', () => {
  const proposal = tenRowProposal()
  const state = stateOf({
    proposal,
    decisions: Object.fromEntries(proposal.sourceRowIds.map((id) => [id, 'add' as EvidenceOnlyRowDecision])),
  })
  assert.equal(evidenceOnlyDecisionActionLabel(state, proposal), 'Add 10 BOQ items')
})

test('evidenceOnlyDecisionActionLabel describes an all-ignore state', () => {
  const proposal = tenRowProposal()
  const state = stateOf({
    proposal,
    decisions: Object.fromEntries(proposal.sourceRowIds.map((id) => [id, 'ignore' as EvidenceOnlyRowDecision])),
  })
  assert.equal(evidenceOnlyDecisionActionLabel(state, proposal), 'Ignore 10 rows')
})
