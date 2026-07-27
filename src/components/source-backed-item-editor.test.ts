import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  SourceBackedItemEditor,
  buildSourceBackedItemPayload,
  computeSourceBackedLiveTotal,
  deriveInitialSourceBackedForm,
  validateSourceBackedForm,
  type SourceBackedEditableFields,
} from './source-backed-item-editor'
import type { Boq, BoqSection } from '@/lib/boq-schema'
import type { ValidatedProposal } from '@/lib/boq-extraction-proposals'
import type { SourceBackedReviewDraft } from '@/lib/boq-extraction-cell-mapping'

function section(overrides: Partial<BoqSection> = {}): BoqSection {
  return { header: 'Substructure', items: [], ...overrides }
}

function boq(overrides: Partial<Boq> = {}): Boq {
  return {
    id: 'boq-1',
    project: 'Project',
    vendor: 'Vendor',
    workType: 'Structural',
    date: '2026-07-26',
    totalItems: 0,
    grandTotal: 0,
    status: 'parsed',
    stdStatus: 'none',
    sections: [section({ header: 'Substructure' }), section({ header: 'Finishing' })],
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
    ...overrides,
  }
}

function draft(overrides: Partial<SourceBackedReviewDraft> = {}): SourceBackedReviewDraft {
  return {
    mapping: { sourceRowIds: ['row-1'] },
    resolvedValues: {
      description: 'Wall installation',
      unit: 'm2',
      quantity: 18,
      materialRate: 980,
      materialTotal: 17640,
      labourRate: 650,
      labourTotal: 11700,
      amount: 29340,
    },
    missingFields: [],
    sourceRowIds: ['row-1'],
    sourceRefs: [{ page: 1, table: 0, row: 4 }],
    section: { index: 0, header: 'Substructure' },
    ...overrides,
  }
}

function proposal(overrides: Partial<ValidatedProposal> = {}): ValidatedProposal {
  return {
    id: 'prop-1',
    extractionRunId: 'run-1',
    operation: 'needs_human_review',
    sourceRowIds: ['row-1'],
    targetItemIds: [],
    affectedItemFingerprints: {},
    confidence: 0.4,
    explanation: 'Ambiguous mapping',
    proposedItems: [],
    evidenceValid: true,
    reconciled: true,
    stale: false,
    reviewDraft: draft(),
    ...overrides,
  }
}

function render(props: Partial<Parameters<typeof SourceBackedItemEditor>[0]> = {}) {
  const submitted: SourceBackedEditableFields[] = []
  const cancelled: boolean[] = []
  const html = renderToStaticMarkup(
    createElement(SourceBackedItemEditor, {
      boq: boq(),
      proposal: proposal(),
      onSubmit: async (payload) => {
        submitted.push(payload.item)
        return { ok: true }
      },
      onCancel: () => { cancelled.push(true) },
      busy: false,
      serverError: null,
      ...props,
    }),
  )
  return { html, submitted, cancelled }
}

test('deriveInitialSourceBackedForm prefills editable values from resolved source cells', () => {
  const values = deriveInitialSourceBackedForm(draft())
  assert.equal(values.desc, 'Wall installation')
  assert.equal(values.unit, 'm2')
  assert.equal(values.qty, 18)
  assert.equal(values.materialCost, 980)
  assert.equal(values.labourCost, 650)
  assert.equal(values.isSingleRate, false)
})

test('deriveInitialSourceBackedForm labels description, unit, and quantity as missing when absent', () => {
  const values = deriveInitialSourceBackedForm(draft({
    resolvedValues: { materialRate: 100, materialTotal: 200, labourRate: 50, labourTotal: 100, amount: 300 },
    missingFields: ['description', 'unit', 'quantity'],
  }))
  assert.equal(values.desc, '')
  assert.equal(values.unit, '')
  assert.ok(Number.isNaN(values.qty as number) || values.qty === 0)
  assert.deepEqual(values.missingFields, ['description', 'unit', 'quantity'])
})

test('deriveInitialSourceBackedForm exposes a single-rate path when only generic rate/total are resolved', () => {
  const values = deriveInitialSourceBackedForm(draft({
    resolvedValues: { description: 'Tile lays', unit: 'm2', quantity: 12, rate: 320, total: 3840 },
    missingFields: [],
  }))
  assert.equal(values.isSingleRate, true)
  assert.equal(values.singleRate, 320)
  assert.equal(values.materialCost, 320)
  assert.equal(values.labourCost, 0)
})

test('computeSourceBackedLiveTotal multiplies qty by combined material + labour rates', () => {
  assert.equal(computeSourceBackedLiveTotal({ qty: 18, materialCost: 980, labourCost: 650 }), 29340)
  assert.equal(computeSourceBackedLiveTotal({ qty: 12, materialCost: 320, labourCost: 0 }), 3840)
})

test('computeSourceBackedLiveTotal returns null when any component is non-finite or negative', () => {
  assert.equal(computeSourceBackedLiveTotal({ qty: Number.NaN, materialCost: 10, labourCost: 5 }), null)
  assert.equal(computeSourceBackedLiveTotal({ qty: 5, materialCost: -1, labourCost: 5 }), null)
  assert.equal(computeSourceBackedLiveTotal({ qty: 5, materialCost: 10, labourCost: Number.POSITIVE_INFINITY }), null)
})

test('validateSourceBackedForm blocks non-finite, negative, or empty-field payloads', () => {
  assert.equal(validateSourceBackedForm({ desc: '', unit: 'm2', qty: 5, materialCost: 10, labourCost: 0 }).valid, false)
  assert.equal(validateSourceBackedForm({ desc: 'Wall', unit: '', qty: 5, materialCost: 10, labourCost: 0 }).valid, false)
  assert.equal(validateSourceBackedForm({ desc: 'Wall', unit: 'm2', qty: 0, materialCost: 10, labourCost: 0 }).valid, false)
  assert.equal(validateSourceBackedForm({ desc: 'Wall', unit: 'm2', qty: 5, materialCost: Number.NaN, labourCost: 0 }).valid, false)
  assert.equal(validateSourceBackedForm({ desc: 'Wall', unit: 'm2', qty: 5, materialCost: 10, labourCost: -3 }).valid, false)
  assert.equal(validateSourceBackedForm({ desc: 'Wall', unit: 'm2', qty: 5, materialCost: 10, labourCost: 0 }).valid, true)
})

test('validateSourceBackedForm rejects cent precision beyond two decimals', () => {
  assert.equal(validateSourceBackedForm({ desc: 'Wall', unit: 'm2', qty: 5, materialCost: 10.123, labourCost: 0 }).valid, false)
  assert.equal(validateSourceBackedForm({ desc: 'Wall', unit: 'm2', qty: 5, materialCost: 10.12, labourCost: 0 }).valid, true)
})

test('buildSourceBackedItemPayload emits editable values plus sectionIndex only', () => {
  const payload = buildSourceBackedItemPayload(
    { desc: 'Wall installation', unit: 'm2', qty: 18, materialCost: 980, labourCost: 650 },
    0,
  )
  assert.deepEqual(payload, {
    sectionIndex: 0,
    item: { desc: 'Wall installation', unit: 'm2', qty: 18, materialCost: 980, labourCost: 650 },
  })
  // Provenance is never echoed back by the editor.
  assert.equal('sourceRowIds' in payload.item, false)
  assert.equal('sourceRef' in payload.item, false)
  assert.equal('sourceCosts' in payload.item, false)
  assert.equal('mapping' in payload.item, false)
})

test('editor prefills editable fields from source-backed resolved values and tags them as source', () => {
  const { html } = render()
  assert.match(html, /value="Wall installation"/)
  assert.match(html, /value="m2"/)
  assert.match(html, /value="18"/)
  assert.match(html, /value="980"/)
  assert.match(html, /value="650"/)
  // Source-backed fields are tagged so users can tell provenance apart from manual edits.
  assert.match(html, /Source/)
  // Live arithmetic renders in the editor so users see qty × rate before saving.
  assert.match(html, /29,?340/)
})

test('editor marks unresolved fields as missing from source and renders them blank', () => {
  const { html } = render({
    proposal: proposal({
      reviewDraft: draft({
        resolvedValues: { materialRate: 100, materialTotal: 200, labourRate: 50, labourTotal: 100, amount: 300 },
        missingFields: ['description', 'unit', 'quantity'],
      }),
    }),
  })
  // Each unresolved field surfaces a visible "missing from source" badge.
  assert.match(html, /Description missing from source/)
  assert.match(html, /Unit missing from source/)
  assert.match(html, /Quantity missing from source/)
  // The description input renders empty (no resolved value to prefill).
  const descMatches = html.match(/<input[^>]*name="desc"[^>]*>/)
  assert.ok(descMatches)
  assert.match(descMatches[0], /value=""/)
})

test('editor renders a destination-section select for unfamiliar layouts and blocks save until chosen', () => {
  const { html } = render({
    proposal: proposal({ reviewDraft: draft({ section: null }) }),
  })
  assert.match(html, /Destination section/)
  assert.match(html, /Substructure/)
  assert.match(html, /Finishing/)
  // Save remains disabled until the user picks a section.
  assert.match(html, /disabled/)
})

test('editor disables Save when numeric inputs become invalid', () => {
  const validation = validateSourceBackedForm({ desc: 'Wall', unit: 'm2', qty: Number.NaN, materialCost: 10, labourCost: 0 })
  assert.equal(validation.valid, false)
  assert.ok(validation.errors.qty)
  assert.match(validation.errors.qty!, /quantity/i)
})

test('editor never imports server-side mapping resolution logic', () => {
  const source = readModuleSource()
  // The editor must work only off reviewDraft.resolvedValues. It must not import
  // server-side reconstruction (resolveSourceCellMapping, parseSourceNumber, etc.).
  assert.doesNotMatch(source, /from ['"]@\/lib\/boq-extraction-cell-mapping['"]/)
  assert.doesNotMatch(source, /resolveSourceCellMapping/)
  assert.doesNotMatch(source, /reconstructSourceMappedItem/)
})

function readModuleSource(): string {
  // Lazy require so the editor module exists by the time the assertion runs.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs')
  return fs.readFileSync(new URL('./source-backed-item-editor.tsx', import.meta.url), 'utf8')
}
