import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  EvidenceOnlyBatchItemEditor,
  buildEvidenceOnlyBatchPayload,
  defaultEvidenceOnlyBatchSectionIndex,
  initializeEvidenceOnlyBatchForms,
  validateEvidenceOnlyBatch,
  type EvidenceOnlyBatchPayload,
  type EvidenceOnlyBatchSourceRow,
} from './evidence-only-batch-item-editor'
import {
  computeSourceBackedLiveTotal,
  type SourceBackedEditableFields,
} from './source-backed-item-editor'
import type { Boq, BoqSection } from '@/lib/boq-schema'
import type { ValidatedProposal } from '@/lib/boq-extraction-proposals'

function section(overrides: Partial<BoqSection> = {}): BoqSection {
  return { header: 'Substructure', items: [], ...overrides }
}

function boq(overrides: Partial<Boq> = {}): Boq {
  return {
    id: 'boq-1',
    project: 'Project',
    vendor: 'Vendor',
    workType: 'Structural',
    date: '2026-08-06',
    totalItems: 0,
    grandTotal: 0,
    status: 'parsed',
    stdStatus: 'none',
    sections: [section({ header: 'Substructure' }), section({ header: 'Finishing' })],
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
    ...overrides,
  }
}

function multiRowProposal(overrides: Partial<ValidatedProposal> = {}): ValidatedProposal {
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

function sourceRow(overrides: Partial<EvidenceOnlyBatchSourceRow> = {}): EvidenceOnlyBatchSourceRow {
  return { sourceRowId: 'row-1', section: 'Substructure', page: 1, table: 0, row: 4, ...overrides }
}

function twoSourceRows(): EvidenceOnlyBatchSourceRow[] {
  return [
    sourceRow({ sourceRowId: 'row-1', section: 'Finishing', page: 1, table: 0, row: 4 }),
    sourceRow({ sourceRowId: 'row-2', section: 'Substructure', page: 2, table: 1, row: 7 }),
  ]
}

function validForm(overrides: Partial<SourceBackedEditableFields> = {}): SourceBackedEditableFields {
  return { desc: 'Wall', unit: 'm2', qty: 10, materialCost: 100, labourCost: 50, ...overrides }
}

test('initializeEvidenceOnlyBatchForms creates one blank/manual form per source row in proposal order', () => {
  const proposal = multiRowProposal()
  const forms = initializeEvidenceOnlyBatchForms(proposal)
  // One form per source row, keyed in proposal order.
  assert.deepEqual([...forms.keys()], proposal.sourceRowIds)
  // Every priced field starts NaN and every text field blank.
  for (const values of forms.values()) {
    assert.equal(values.desc, '')
    assert.equal(values.unit, '')
    assert.equal(Number.isNaN(values.qty), true)
    assert.equal(Number.isNaN(values.materialCost), true)
    assert.equal(Number.isNaN(values.labourCost), true)
  }
})

test('defaultEvidenceOnlyBatchSectionIndex matches section headers case-insensitively and otherwise defaults to index 0', () => {
  const sections = boq().sections
  assert.equal(defaultEvidenceOnlyBatchSectionIndex(sourceRow({ section: 'finishing' }), sections), 1)
  assert.equal(defaultEvidenceOnlyBatchSectionIndex(sourceRow({ section: 'SUBSTRUCTURE' }), sections), 0)
  assert.equal(defaultEvidenceOnlyBatchSectionIndex(sourceRow({ section: 'Unknown' }), sections), 0)
  assert.equal(defaultEvidenceOnlyBatchSectionIndex(sourceRow({ section: null }), sections), 0)
})

test('buildEvidenceOnlyBatchPayload emits every source row exactly once in proposal order', () => {
  const proposal = multiRowProposal()
  const forms = new Map<string, SourceBackedEditableFields>([
    ['row-1', validForm({ desc: 'Row one' })],
    ['row-2', validForm({ desc: 'Row two' })],
  ])
  const sectionIndexes = new Map<string, number>([['row-1', 1], ['row-2', 0]])
  const payload = buildEvidenceOnlyBatchPayload({ proposal, forms, sectionIndexes })
  // One entry per source row in proposal order, no duplicates.
  assert.deepEqual(payload.items.map((entry) => entry.sourceRowId), ['row-1', 'row-2'])
  assert.equal(new Set(payload.items.map((entry) => entry.sourceRowId)).size, payload.items.length)
  assert.deepEqual(payload.items, [
    { sourceRowId: 'row-1', sectionIndex: 1, item: { desc: 'Row one', unit: 'm2', qty: 10, materialCost: 100, labourCost: 50 } },
    { sourceRowId: 'row-2', sectionIndex: 0, item: { desc: 'Row two', unit: 'm2', qty: 10, materialCost: 100, labourCost: 50 } },
  ])
  // Provenance is never echoed back — only editable values plus sectionIndex.
  for (const entry of payload.items) {
    assert.equal('sourceRowIds' in entry.item, false)
    assert.equal('sourceRef' in entry.item, false)
    assert.equal('sourceCosts' in entry.item, false)
  }
})

test('buildEvidenceOnlyBatchPayload follows proposal order even when forms are supplied out of order', () => {
  const proposal = multiRowProposal({ sourceRowIds: ['row-2', 'row-1'] })
  const forms = new Map<string, SourceBackedEditableFields>([
    ['row-1', validForm({ desc: 'Row one' })],
    ['row-2', validForm({ desc: 'Row two' })],
  ])
  const sectionIndexes = new Map<string, number>([['row-1', 0], ['row-2', 1]])
  const payload = buildEvidenceOnlyBatchPayload({ proposal, forms, sectionIndexes })
  assert.deepEqual(payload.items.map((entry) => entry.sourceRowId), ['row-2', 'row-1'])
})

test('validateEvidenceOnlyBatch is false until every form and section is valid', () => {
  const proposal = multiRowProposal()
  const sections = boq().sections
  const sectionIndexes = new Map<string, number>([['row-1', 0], ['row-2', 1]])
  // A single blank form invalidates the whole batch.
  const blankForm = new Map<string, SourceBackedEditableFields>([
    ['row-1', validForm({ desc: '' })],
    ['row-2', validForm()],
  ])
  assert.equal(validateEvidenceOnlyBatch({ proposal, forms: blankForm, sectionIndexes, sections }).valid, false)
  // A partially valid batch (one valid, one with a non-finite rate) is still invalid.
  const partialForm = new Map<string, SourceBackedEditableFields>([
    ['row-1', validForm()],
    ['row-2', validForm({ materialCost: Number.NaN })],
  ])
  assert.equal(validateEvidenceOnlyBatch({ proposal, forms: partialForm, sectionIndexes, sections }).valid, false)
  // An out-of-range section index invalidates the batch.
  const badSection = new Map<string, SourceBackedEditableFields>([
    ['row-1', validForm()],
    ['row-2', validForm()],
  ])
  assert.equal(
    validateEvidenceOnlyBatch({
      proposal,
      forms: badSection,
      sectionIndexes: new Map<string, number>([['row-1', 0], ['row-2', 99]]),
      sections,
    }).valid,
    false,
  )
  // Every form valid and every section in range.
  const allValid = new Map<string, SourceBackedEditableFields>([
    ['row-1', validForm()],
    ['row-2', validForm()],
  ])
  assert.equal(validateEvidenceOnlyBatch({ proposal, forms: allValid, sectionIndexes, sections }).valid, true)
})

test('live totals calculate independently per row via the shared helper', () => {
  // Row one: qty 10 x (100 + 50) = 1500.
  assert.equal(computeSourceBackedLiveTotal(validForm({ qty: 10, materialCost: 100, labourCost: 50 })), 1500)
  // Row two: qty 4 x (200 + 0) = 800, independent of row one.
  assert.equal(computeSourceBackedLiveTotal(validForm({ qty: 4, materialCost: 200, labourCost: 0 })), 800)
  // A blank numeric input yields no total.
  assert.equal(computeSourceBackedLiveTotal({ qty: Number.NaN, materialCost: 100, labourCost: 50 }), null)
})

function render(props: Partial<Parameters<typeof EvidenceOnlyBatchItemEditor>[0]> = {}): {
  html: string
  submitted: EvidenceOnlyBatchPayload[]
  cancelled: boolean[]
} {
  const submitted: EvidenceOnlyBatchPayload[] = []
  const cancelled: boolean[] = []
  const html = renderToStaticMarkup(
    createElement(EvidenceOnlyBatchItemEditor, {
      boq: boq(),
      proposal: multiRowProposal(),
      sourceRows: twoSourceRows(),
      onSubmit: async (payload) => {
        submitted.push(payload)
        return { ok: true }
      },
      onCancel: () => {
        cancelled.push(true)
      },
      busy: false,
      serverError: null,
      ...props,
    }),
  )
  return { html, submitted, cancelled }
}

test('rendered forms use unique accessible labels containing the source reference', () => {
  const { html } = render()
  // Each source row reference appears so screen-reader labels stay unique.
  assert.match(html, /p\.1[\s\S]*t\.0[\s\S]*r\.4/)
  assert.match(html, /p\.2[\s\S]*t\.1[\s\S]*r\.7/)
  // One fieldset legend per source row groups its fields.
  const legends = html.match(/<legend[^>]*>[\s\S]*?<\/legend>/g) ?? []
  assert.equal(legends.length, 2)
  // Description labels are unique per row (paired by htmlFor/id).
  assert.equal((html.match(/<label[^>]*for="eob-desc-row-1"[^>]*>/g) ?? []).length, 1)
  assert.equal((html.match(/<label[^>]*for="eob-desc-row-2"[^>]*>/g) ?? []).length, 1)
  // Each row carries its own destination-section select.
  assert.equal((html.match(/<select[^>]*id="eob-section-row-1"[^>]*>/g) ?? []).length, 1)
  assert.equal((html.match(/<select[^>]*id="eob-section-row-2"[^>]*>/g) ?? []).length, 1)
})

test('submit reads "Add 2 BOQ items" and is disabled for a blank batch', () => {
  const { html } = render()
  assert.match(html, /Add 2 BOQ items/)
  // The submit button stays disabled while any form is blank or invalid.
  assert.match(html, /disabled/)
})

test('submit count follows the proposal source-row count', () => {
  const proposal = multiRowProposal({ sourceRowIds: ['row-1', 'row-2', 'row-3'] })
  const rows = [
    ...twoSourceRows(),
    sourceRow({ sourceRowId: 'row-3', section: 'Finishing', page: 3, table: 0, row: 11 }),
  ]
  const { html } = render({ proposal, sourceRows: rows })
  assert.match(html, /Add 3 BOQ items/)
})

test('editor never imports server reconstruction logic and never inspects rawText/rawCells/provider explanation', () => {
  const source = readModuleSource()
  assert.doesNotMatch(source, /from ['"]@\/lib\/boq-extraction-cell-mapping['"]/)
  assert.doesNotMatch(source, /resolveSourceCellMapping/)
  assert.doesNotMatch(source, /reconstructSourceMappedItem/)
  // The editor works only off editable form values; it never inspects raw
  // evidence cells or the provider explanation.
  assert.doesNotMatch(source, /rawText/)
  assert.doesNotMatch(source, /rawCells/)
  assert.doesNotMatch(source, /\.explanation/)
})

function readModuleSource(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs')
  return fs.readFileSync(new URL('./evidence-only-batch-item-editor.tsx', import.meta.url), 'utf8')
}
