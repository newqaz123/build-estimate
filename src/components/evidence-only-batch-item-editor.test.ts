import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { EvidenceOnlyBatchItemEditor } from './evidence-only-batch-item-editor'
import type { EvidenceOnlyBatchSourceRow } from './evidence-only-batch-item-editor-state'
import type { Boq, BoqSection } from '@/lib/boq-schema'
import type { SourceRowDispositionSuggestion, ValidatedProposal } from '@/lib/boq-extraction-proposals'

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

function ignoreSuggestion(sourceRowId: string): SourceRowDispositionSuggestion {
  return {
    sourceRowId,
    suggestedAction: 'ignore',
    reasonCode: 'already_represented',
    reason: 'Already represented elsewhere',
    confidence: 0.92,
  }
}

function render(props: Partial<Parameters<typeof EvidenceOnlyBatchItemEditor>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(EvidenceOnlyBatchItemEditor, {
      boq: boq(),
      proposal: multiRowProposal(),
      sourceRows: twoSourceRows(),
      onSubmit: async () => ({ ok: true as const }),
      onCancel: () => {},
      busy: false,
      serverError: null,
      ...props,
    }),
  )
}

test('initial render shows one fieldset with a unique source legend per proposal row', () => {
  const html = render()
  // One fieldset/legend per source row, each labelled with its source reference.
  const legends = html.match(/<legend[^>]*>[\s\S]*?<\/legend>/g) ?? []
  assert.equal(legends.length, 2)
  assert.match(html, /Source row p\.1 t\.0 r\.4/)
  assert.match(html, /Source row p\.2 t\.1 r\.7/)
})

test('initial render leaves every Add/Do not add radio unchecked', () => {
  const html = render()
  const radios = html.match(/<input[^>]*type="radio"[^>]*>/g) ?? []
  // Two radios (Add + Do not add) per source row.
  assert.equal(radios.length, 4)
  for (const radio of radios) assert.doesNotMatch(radio, /checked/)
})

test('each row exposes accessible, unique Add and Do not add radio controls', () => {
  const html = render()
  // Unique radio ids and paired labels per row; the two radios share one name.
  assert.equal((html.match(/id="eob-add-row-1"/g) ?? []).length, 1)
  assert.equal((html.match(/id="eob-add-row-2"/g) ?? []).length, 1)
  assert.equal((html.match(/id="eob-ignore-row-1"/g) ?? []).length, 1)
  assert.equal((html.match(/id="eob-ignore-row-2"/g) ?? []).length, 1)
  assert.equal((html.match(/for="eob-add-row-1"/g) ?? []).length, 1)
  assert.equal((html.match(/for="eob-add-row-2"/g) ?? []).length, 1)
  assert.equal((html.match(/for="eob-ignore-row-1"/g) ?? []).length, 1)
  assert.equal((html.match(/for="eob-ignore-row-2"/g) ?? []).length, 1)
  assert.equal((html.match(/name="decision-row-1"/g) ?? []).length, 2)
  assert.equal((html.match(/name="decision-row-2"/g) ?? []).length, 2)
})

test('initial render hides add fields and the ignore note while every row is undecided', () => {
  const html = render()
  // No editable add inputs render until a row is switched to Add.
  assert.doesNotMatch(html, /name="desc-/)
  assert.doesNotMatch(html, /name="qty-/)
  assert.doesNotMatch(html, /name="materialCost-/)
  // No ignore-note textarea renders until a row is switched to Do not add.
  assert.doesNotMatch(html, /<textarea/)
})

test('initial render uses the review heading, a dynamic neutral action label, and a disabled submit', () => {
  const html = render()
  assert.match(html, /Review source-row decisions/)
  // The neutral primary action label sits on the submit button and stays disabled
  // while no row carries a complete decision.
  assert.match(html, /<button[^>]*type="submit"[^>]*>[\s\S]*?Review source-row decisions[\s\S]*?<\/button>/)
  assert.match(html, /disabled/)
})

test('render follows the proposal source-row count', () => {
  const proposal = multiRowProposal({ sourceRowIds: ['row-1', 'row-2', 'row-3'] })
  const rows = [
    ...twoSourceRows(),
    sourceRow({ sourceRowId: 'row-3', section: 'Finishing', page: 3, table: 0, row: 11 }),
  ]
  const html = render({ proposal, sourceRows: rows })
  const legends = html.match(/<legend[^>]*>[\s\S]*?<\/legend>/g) ?? []
  assert.equal(legends.length, 3)
  const radios = html.match(/<input[^>]*type="radio"[^>]*>/g) ?? []
  assert.equal(radios.length, 6)
})

test('an advisory badge shows the AI reason and confidence when a suggestion is present', () => {
  const html = render({
    proposal: multiRowProposal({
      sourceRowSuggestions: [ignoreSuggestion('row-1'), ignoreSuggestion('row-2')],
    }),
  })
  // Each row surfaces the AI reason and a confidence percentage.
  assert.match(html, /AI suggests do not add/)
  assert.match(html, /Already represented elsewhere/)
  assert.match(html, /92%/)
})

test('an advisory badge reads AI suggestion unavailable when no suggestion is present', () => {
  const html = render()
  assert.match(html, /AI suggestion unavailable/)
})

test('editor never imports server reconstruction logic and never inspects rawText/rawCells/provider explanation', () => {
  for (const file of ['evidence-only-batch-item-editor.tsx', 'evidence-only-batch-item-editor-state.ts']) {
    const source = readModuleSource(file)
    assert.doesNotMatch(source, /from ['"]@\/lib\/boq-extraction-cell-mapping['"]/)
    assert.doesNotMatch(source, /resolveSourceCellMapping/)
    assert.doesNotMatch(source, /reconstructSourceMappedItem/)
    // The editor works only off editable form values and advisory suggestions;
    // it never inspects raw evidence cells or the provider explanation.
    assert.doesNotMatch(source, /rawText/)
    assert.doesNotMatch(source, /rawCells/)
    assert.doesNotMatch(source, /\.explanation/)
  }
})

function readModuleSource(file: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs')
  return fs.readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
}
