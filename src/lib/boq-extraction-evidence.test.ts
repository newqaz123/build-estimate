import assert from 'node:assert/strict'
import test from 'node:test'
import type { BoqExtractionRun } from './boq-extraction-run'
import type { BoqSourceRowV3, DerivedPricedItemV3 } from './boq-extraction-schema'
import type { BoqPricedItem, BoqSection } from './boq-schema'
import {
  buildExtractionCandidates,
  buildExtractionEvidencePacket,
} from './boq-extraction-evidence'
import { prepareProviderProposalV2 } from './boq-extraction-proposal-contract'
import {
  applyValidatedProposal,
  isHighConfidenceProposal,
  undoAcceptedProposal,
  validateProposal,
  validateProposalBatch,
  type ProposalValidationContext,
} from './boq-extraction-proposals'

function sourceRow(id: string, row: number, page = 1, table = 1): BoqSourceRowV3 {
  return {
    id, page, table, row, section: 'Works', headers: ['Description', 'Qty', 'Unit', 'Rate', 'Amount'],
    rawCells: [
      { column: 0, rawText: `Item ${id}`, lines: [`Item ${id}`], rowSpan: 1, columnSpan: 1, startRowOffset: row - 1, endRowOffset: row, startColumnOffset: 0, endColumnOffset: 1, columnHeader: false, rowHeader: false, rowSection: false, carried: false },
      { column: 4, rawText: `${row * 10}`, lines: [`${row * 10}`], rowSpan: 1, columnSpan: 1, startRowOffset: row - 1, endRowOffset: row, startColumnOffset: 4, endColumnOffset: 5, columnHeader: false, rowHeader: false, rowSection: false, carried: false },
    ],
    rawText: `Item ${id} | ${row * 10}`, classification: 'item', confidence: 1, warnings: [],
  }
}

function pricedItem(id: string, sourceRowId: string, total: number, desc?: string): DerivedPricedItemV3 {
  return {
    id, desc: desc ?? `Item ${id}`, pricingRole: 'standard', sourceRowIds: [sourceRowId],
    optional: false, excludedFromTotal: false, entryOrigin: 'docling', costComponent: 'combined', sourceCosts: null,
    unit: 'set', qty: 1, rate: total, total,
  }
}

function canonicalItem(id: string, sourceRowId: string, total: number, desc?: string): BoqPricedItem {
  return {
    id, desc: desc ?? `Item ${id}`, pricingRole: 'standard', unit: 'set', qty: 1, rate: total, total,
    type: 'unit', costComponent: 'combined', sourceRowIds: [sourceRowId], entryOrigin: 'docling', stdStatus: 'unmatched',
  }
}

/** Build a Surasak-like scenario: a stale 3-item canonical BOQ versus a
 *  corrected run with 19 priced candidate items. */
function surasakScenario() {
  const totalRows = 19
  const sourceRows = [
    ...Array.from({ length: totalRows }, (_, i) => sourceRow(`sr-${i + 1}`, i + 1)),
    { ...sourceRow('sr-summary', 20), classification: 'total' as const },
  ]
  const runItems = sourceRows.slice(0, totalRows).map((row, i) => pricedItem(`cand-${i + 1}`, row.id, (i + 1) * 100, `Line ${i + 1}`))

  // Stale canonical BOQ: three valid rows survived while 16 source-backed
  // candidates were omitted by the older parser.
  const staleSections: BoqSection[] = [{
    header: 'Works',
    items: [
      canonicalItem('stale-1', 'sr-1', 100, 'Line 1'),
      canonicalItem('stale-2', 'sr-2', 200, 'Line 2'),
      canonicalItem('stale-19', 'sr-19', 1900, 'Line 19'),
    ],
  }]

  const run: BoqExtractionRun = {
    id: 'run-1', boqId: 'boq-1', contractVersion: 3, status: 'ready', createdAt: '', updatedAt: '', stagingExpiresAt: null,
    sourceFile: { path: 'boqs/boq-1/source.pdf', name: 'source.pdf', digest: 'sha256:source' },
    parser: { name: 'docling', contractVersion: 3, configFingerprint: 'sha256:config' },
    metadataCandidates: { vendor: { value: '', confidence: 0, source: '' }, project: { value: '', confidence: 0, source: '' }, date: { value: '', confidence: 0, source: '' }, workType: { value: 'MEP', confidence: 1, source: '' } },
    metadataConfidence: { vendor: 0, project: 0, date: 0, workType: 1 },
    sourceRowCount: totalRows, sourceRowChecksum: 'sha256:rows',
    reconciliation: { itemTotal: 19000, sourceTotal: 19000, reconciled: true, difference: 0 },
    warnings: [],
    sections: [{ header: 'Works', items: runItems }],
    totalItems: totalRows,
    aiReviewStatus: 'queued',
    reviewTargeting: { candidateRowIds: sourceRows.slice(2, 18).map((r) => r.id), candidateCount: 16, unreconciled: false },
  }

  const boqSections = staleSections
  return { sourceRows, run, boqSections }
}

test('buildExtractionCandidates builds priced items from run sections', () => {
  const { run, sourceRows } = surasakScenario()
  const candidates = buildExtractionCandidates(run, sourceRows)
  assert.equal(candidates.size, 19)
  const first = candidates.get('cand-1')!
  assert.equal(first.desc, 'Line 1')
  assert.equal(first.sourceRowIds[0], 'sr-1')
  assert.equal(first.total, 100)
})

test('bundle parent and children remain evidence-only because partial bundle insertion is unsafe', () => {
  const row = sourceRow('sr-bundle', 1)
  const base = surasakScenario().run
  const run: BoqExtractionRun = {
    ...base,
    sections: [{
      header: 'Works',
      items: [
        {
          ...pricedItem('bundle-parent', row.id, 100, 'Package'),
          pricingRole: 'bundle_parent',
        },
        {
          id: 'bundle-child', desc: 'Package detail', pricingRole: 'bundle_child',
          parentBundleId: 'bundle-parent', sourceRowIds: [row.id], entryOrigin: 'docling',
          optional: false, excludedFromTotal: false,
        },
      ],
    }],
  }
  const candidates = buildExtractionCandidates(run, [row])
  assert.equal(candidates.size, 0)
  const packet = buildExtractionEvidencePacket({
    run, sourceRows: [row], candidates, boqSections: [{ items: [] }],
    selectedSourceRowIds: new Set([row.id]),
  })
  assert.deepEqual(packet.allowedSourceRowIds, [row.id])
  assert.deepEqual(packet.candidateItems, [])
  assert.equal(packet.sourceRows[0].reviewSelected, true)
})

test('duplicate immutable candidate IDs are rejected instead of silently overwriting evidence', () => {
  const { run, sourceRows } = surasakScenario()
  const duplicated = structuredClone(run)
  duplicated.sections[0].items[1].id = duplicated.sections[0].items[0].id
  assert.throws(
    () => buildExtractionCandidates(duplicated, sourceRows),
    /Duplicate extraction candidate item ID/,
  )
})

test('evidence packet orders candidates by source row position', () => {
  const { run, sourceRows, boqSections } = surasakScenario()
  const candidates = buildExtractionCandidates(run, sourceRows)
  const selected = new Set(sourceRows.slice(1, 18).map((r) => r.id))
  const packet = buildExtractionEvidencePacket({ run, sourceRows, candidates, boqSections, selectedSourceRowIds: selected })
  assert.equal(packet.candidateItems.length, 17)
  assert.equal(packet.candidateItems[0].id, 'cand-2')
  assert.equal(packet.candidateItems[16].id, 'cand-18')
  assert.equal(packet.allowedSourceRowIds.length, 17)
  assert.equal(packet.sourceRows.length, 20)
  assert.deepEqual(packet.sourceRows.map((row) => row.row), Array.from({ length: 20 }, (_, index) => index + 1))
  assert.equal(packet.sourceRows[0].rawCells[0].startRowOffset, 0)
  const selectedRow = packet.sourceRows.find((row) => row.id === 'sr-2')!
  const contextRow = packet.sourceRows.find((row) => row.id === 'sr-1')!
  assert.deepEqual(selectedRow.cellRefs, [
    { column: 0, lineCount: 1 },
    { column: 4, lineCount: 1 },
  ])
  assert.equal(contextRow.cellRefs, undefined)
})

test('evidence packet exposes only non-carried cell coordinates on addressable rows', () => {
  const { run, sourceRows, boqSections } = surasakScenario()
  const selectedRow = {
    ...sourceRows[0],
    rawCells: [
      ...sourceRows[0].rawCells,
      { ...sourceRows[0].rawCells[0], column: 9, carried: true },
    ],
  }
  const nextRows = [selectedRow, ...sourceRows.slice(1)]
  const packet = buildExtractionEvidencePacket({
    run, sourceRows: nextRows, candidates: buildExtractionCandidates(run, nextRows), boqSections,
    selectedSourceRowIds: new Set([selectedRow.id]),
  })
  assert.deepEqual(packet.sourceRows.find((row) => row.id === selectedRow.id)?.cellRefs, [
    { column: 0, lineCount: 1 },
    { column: 4, lineCount: 1 },
  ])
})

test('evidence packet includes current target items from BOQ', () => {
  const { run, sourceRows, boqSections } = surasakScenario()
  const candidates = buildExtractionCandidates(run, sourceRows)
  const selected = new Set(['sr-1'])
  const packet = buildExtractionEvidencePacket({ run, sourceRows, candidates, boqSections, selectedSourceRowIds: selected })
  assert.equal(packet.currentTargetItems.length, 1)
  assert.equal(packet.currentTargetItems[0].id, 'stale-1')
})

function prepareDecision(
  raw: Record<string, unknown>,
  run: BoqExtractionRun,
  sourceRows: BoqSourceRowV3[],
  sections: BoqSection[],
) {
  const candidates = buildExtractionCandidates(run, sourceRows)
  const targetItems = new Map(sections.flatMap((section) => section.items)
    .flatMap((item) => item.id ? [[item.id, item] as const] : []))
  const prepared = prepareProviderProposalV2(raw, {
    extractionRunId: run.id,
    sections,
    targetItems,
    candidateItems: candidates,
  })
  assert.equal(prepared.ok, true)
  if (!prepared.ok) throw new Error('Decision preparation failed')
  return prepared.proposal
}

function proposalContext(run: BoqExtractionRun, sourceRows: BoqSourceRowV3[], sections: BoqSection[]): ProposalValidationContext {
  const candidates = buildExtractionCandidates(run, sourceRows)
  const evidence: Record<string, { quotedTotal: number }> = {}
  for (const candidate of candidates.values()) {
    for (const sourceRowId of candidate.sourceRowIds) {
      evidence[sourceRowId] = { quotedTotal: candidate.total }
    }
  }
  return {
    extractionRunId: run.id,
    sourceRows,
    sourceEvidence: evidence,
    sections,
    candidateItems: candidates,
  }
}

test('stale 3-item BOQ vs corrected 19-item run yields 16 validated insert decisions', () => {
  const { run, sourceRows, boqSections } = surasakScenario()
  const ctx = proposalContext(run, sourceRows, boqSections)
  const insertProposals = Array.from({ length: 16 }, (_, i) => {
    const candidateIndex = i + 3
    return prepareDecision({
      id: `insert-${candidateIndex}`, operation: 'insert_missing_item',
      sourceRowIds: [`sr-${candidateIndex}`], targetItemIds: [], candidateItemIds: [`cand-${candidateIndex}`],
      confidence: 0.95, explanation: `Source row sr-${candidateIndex} was omitted.`,
    }, run, sourceRows, boqSections)
  })
  const batch = validateProposalBatch(insertProposals, ctx)
  assert.equal(batch.results.filter((result) => result.valid).length, 16)
})

test('prepared insert applies at source order and undo restores the draft', () => {
  const { run, sourceRows, boqSections } = surasakScenario()
  const ctx = proposalContext(run, sourceRows, boqSections)
  const decision = prepareDecision({
    id: 'insert-3', operation: 'insert_missing_item', sourceRowIds: ['sr-3'],
    targetItemIds: [], candidateItemIds: ['cand-3'], confidence: 0.95, explanation: 'Missing item.',
  }, run, sourceRows, boqSections)
  const proposal = validateProposal(decision, ctx)
  assert.equal(proposal.valid, true)
  if (!proposal.valid) return
  const accepted = applyValidatedProposal(boqSections, proposal.proposal)
  assert.deepEqual(accepted.sections[0].items.map((item) => item.id), ['stale-1', 'stale-2', 'cand-3', 'stale-19'])
  assert.deepEqual(undoAcceptedProposal(accepted.sections, accepted.audit), boqSections)
})

test('remove_spurious_item removes only numeric summary evidence', () => {
  const { run, sourceRows, boqSections } = surasakScenario()
  const sectionsWithSpurious: BoqSection[] = [{ ...boqSections[0], items: [
    ...boqSections[0].items,
    { id: 'stale-spurious', desc: '47,000.00', pricingRole: 'standard', unit: 'L/S', qty: 1, rate: 47000, total: 47000, type: 'lump_sum', costComponent: 'lump_sum', sourceRowIds: ['sr-summary'], entryOrigin: 'docling', stdStatus: 'unmatched' },
  ] }]
  const ctx = proposalContext(run, sourceRows, sectionsWithSpurious)
  const decision = prepareDecision({
    id: 'remove-spurious', operation: 'remove_spurious_item', sourceRowIds: ['sr-summary'],
    targetItemIds: ['stale-spurious'], candidateItemIds: [], confidence: 0.95,
    explanation: 'Amount-only total row is not a line item.',
  }, run, sourceRows, sectionsWithSpurious)
  const proposal = validateProposal(decision, ctx)
  assert.equal(proposal.valid, true)
  if (!proposal.valid) return
  const accepted = applyValidatedProposal(sectionsWithSpurious, proposal.proposal)
  assert.equal(accepted.sections[0].items.some((item) => item.id === 'stale-spurious'), false)
  assert.equal(accepted.sections[0].items.length, sectionsWithSpurious[0].items.length - 1)
  assert.notEqual(accepted.audit.afterSectionsFingerprint, accepted.audit.beforeSectionsFingerprint)
})

test('remove_spurious_item is blocked for an ordinary priced source row', () => {
  const { run, sourceRows, boqSections } = surasakScenario()
  const ctx = proposalContext(run, sourceRows, boqSections)
  const decision = prepareDecision({
    id: 'bad-remove', operation: 'remove_spurious_item', sourceRowIds: ['sr-1'],
    targetItemIds: ['stale-1'], candidateItemIds: [], confidence: 0.95, explanation: 'Unsafe removal.',
  }, run, sourceRows, boqSections)
  const proposal = validateProposal(decision, ctx)
  assert.deepEqual(proposal, { valid: false, code: 'spurious_removal_blocked' })
})

test('insert_missing_item rejects duplicate canonical coverage and tampered candidate values', () => {
  const { run, sourceRows, boqSections } = surasakScenario()
  const ctx = proposalContext(run, sourceRows, boqSections)
  const duplicate = prepareDecision({
    id: 'dup', operation: 'insert_missing_item', sourceRowIds: ['sr-1'], targetItemIds: [],
    candidateItemIds: ['cand-1'], confidence: 0.95, explanation: 'Duplicate.',
  }, run, sourceRows, boqSections)
  assert.deepEqual(validateProposal(duplicate, ctx), { valid: false, code: 'duplicate_canonical_source' })

  const tampered = prepareDecision({
    id: 'tampered', operation: 'insert_missing_item', sourceRowIds: ['sr-3'], targetItemIds: [],
    candidateItemIds: ['cand-3'], confidence: 0.95, explanation: 'Tampered.',
  }, run, sourceRows, boqSections)
  ;(tampered.proposedItems[0] as { desc: string }).desc = 'Model-authored description'
  assert.deepEqual(validateProposal(tampered, ctx), { valid: false, code: 'unknown_candidate_item' })
})

test('insert rejects a candidate item ID that collides with an unrelated canonical item', () => {
  const { run, sourceRows, boqSections } = surasakScenario()
  const collidingRun = structuredClone(run)
  collidingRun.sections[0].items[2].id = 'stale-1'
  const decision = prepareDecision({
    id: 'collision', operation: 'insert_missing_item', sourceRowIds: ['sr-3'], targetItemIds: [],
    candidateItemIds: ['stale-1'], confidence: 0.95, explanation: 'Colliding candidate.',
  }, collidingRun, sourceRows, boqSections)
  assert.deepEqual(
    validateProposal(decision, proposalContext(collidingRun, sourceRows, boqSections)),
    { valid: false, code: 'duplicate_item_id' },
  )
})

test('replace_item clones the immutable candidate and preserves target exclusion state', () => {
  const { run, sourceRows, boqSections } = surasakScenario()
  const wrongSections = structuredClone(boqSections)
  const target = wrongSections[0].items[0] as BoqPricedItem
  target.desc = 'Wrong description'
  const ctx = proposalContext(run, sourceRows, wrongSections)
  const decision = prepareDecision({
    id: 'replace-1', operation: 'replace_item', sourceRowIds: ['sr-1'],
    targetItemIds: ['stale-1'], candidateItemIds: ['cand-1'], confidence: 0.95,
    explanation: 'Use immutable source candidate.',
  }, run, sourceRows, wrongSections)
  const proposal = validateProposal(decision, ctx)
  assert.equal(proposal.valid, true)
  if (!proposal.valid) return
  const accepted = applyValidatedProposal(wrongSections, proposal.proposal)
  assert.equal(accepted.sections[0].items[0].desc, 'Line 1')
  assert.deepEqual(accepted.sections[0].items[0].sourceRef, { page: 1, table: 1, row: 1 })

  const optionalSections = structuredClone(wrongSections)
  optionalSections[0].items[0].optional = true
  optionalSections[0].items[0].excludedFromTotal = true
  optionalSections[0].items[0].exclusionReason = 'User exclusion'
  const drift = prepareDecision({
    id: 'replace-drift', operation: 'replace_item', sourceRowIds: ['sr-1'],
    targetItemIds: ['stale-1'], candidateItemIds: ['cand-1'], confidence: 0.95, explanation: 'Unsafe state drift.',
  }, run, sourceRows, optionalSections)
  assert.deepEqual(validateProposal(drift, proposalContext(run, sourceRows, optionalSections)), {
    valid: false, code: 'target_state_mismatch',
  })
})

test('combined candidate remains one row and preserves sourceCosts', () => {
  const rows: BoqSourceRowV3[] = [sourceRow('sr-combined', 1)]
  const combinedRun: BoqExtractionRun = {
    ...surasakScenario().run,
    sections: [{ header: 'Works', items: [{
      ...pricedItem('cand-combined', 'sr-combined', 1000, 'Combined work'),
      costComponent: 'combined' as const,
      sourceCosts: { material: { qty: 1, unit: 'lot', rate: 400, total: 400 }, labour: { qty: 1, unit: 'lot', rate: 600, total: 600 } },
      unit: 'lot',
    }] }],
  }
  const sections: BoqSection[] = [{ header: 'Works', items: [] }]
  const ctx = proposalContext(combinedRun, rows, sections)
  const decision = prepareDecision({
    id: 'insert-combined', operation: 'insert_missing_item', sourceRowIds: ['sr-combined'],
    targetItemIds: [], candidateItemIds: ['cand-combined'], confidence: 0.95, explanation: 'Missing combined row.',
  }, combinedRun, rows, sections)
  const proposal = validateProposal(decision, ctx)
  assert.equal(proposal.valid, true)
  if (!proposal.valid) return
  const accepted = applyValidatedProposal(sections, proposal.proposal)
  assert.equal(accepted.sections[0].items.length, 1)
  const inserted = accepted.sections[0].items[0] as BoqPricedItem
  assert.equal(inserted.sourceCosts?.material.rate, 400)
  assert.equal(inserted.sourceCosts?.labour.rate, 600)
  assert.equal(inserted.costAllocation?.material, 400)
  assert.equal(inserted.costAllocation?.labour, 600)
})

test('server high-confidence gate allows only v2 mutating decisions', () => {
  function validated(operation: string) {
    return {
      id: 'p', extractionRunId: 'r', operation, sourceRowIds: ['sr'], targetItemIds: [],
      affectedItemFingerprints: {}, confidence: 0.95, explanation: 'x', proposedItems: [],
      evidenceValid: true, reconciled: true, stale: false,
    }
  }
  assert.equal(isHighConfidenceProposal(validated('insert_missing_item') as never), true)
  assert.equal(isHighConfidenceProposal(validated('replace_item') as never), true)
  assert.equal(isHighConfidenceProposal(validated('remove_spurious_item') as never), true)
  assert.equal(isHighConfidenceProposal(validated('keep') as never), false)
  assert.equal(isHighConfidenceProposal(validated('split') as never), false)
  assert.equal(isHighConfidenceProposal(validated('separate_components') as never), false)
  assert.equal(isHighConfidenceProposal(validated('needs_human_review') as never), false)
})

test('batch overlap detection prevents inserting the same source row twice', () => {
  const { run, sourceRows, boqSections } = surasakScenario()
  const ctx = proposalContext(run, sourceRows, boqSections)

  const makeInsert = (id: string) => prepareDecision({
    id, operation: 'insert_missing_item', sourceRowIds: ['sr-3'], targetItemIds: [],
    candidateItemIds: ['cand-3'], confidence: 0.95, explanation: 'Insert.',
  }, run, sourceRows, boqSections)

  const batch = validateProposalBatch([
    makeInsert('p1'),
    makeInsert('p2'),
  ], ctx)
  const valid = batch.results.filter((r) => r.valid)
  assert.equal(valid.length, 1)
  assert.equal(batch.results[1].valid, false)
  if (!batch.results[1].valid) assert.equal(batch.results[1].code, 'overlapping_source_row')
})
