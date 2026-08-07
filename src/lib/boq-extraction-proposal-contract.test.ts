import assert from 'node:assert/strict'
import test from 'node:test'
import {
  prepareProviderProposal,
  prepareProviderProposalV2,
  providerContractInstructions,
  providerContractInstructionsV2,
  reconstructSourceMappedItem,
  type ProviderCandidateRef,
} from './boq-extraction-proposal-contract'
import { fingerprintCanonicalItem, validateProposal, SOURCE_ROW_DISPOSITION_REASON_CODES, type ProposalValidationContext } from './boq-extraction-proposals'
import { stableCanonicalJson } from './boq-extraction-run'
import type { BoqItem, BoqSection } from './boq-schema'
import type { BoqSourceRowV3 } from './boq-extraction-schema'

const target: BoqItem = {
  id: 'target-1', desc: 'Combined supply and install', pricingRole: 'standard',
  unit: 'set', qty: 1, rate: 100, total: 100, type: 'unit', costComponent: 'combined',
  sourceRowIds: ['sr-1'], entryOrigin: 'docling', stdStatus: 'unmatched',
}
const sections: BoqSection[] = [{ header: 'Works', items: [target] }]
const sourceRows: BoqSourceRowV3[] = [{
  id: 'sr-1', page: 1, table: 1, row: 1, section: 'Works', headers: ['Description'],
  rawCells: [{ column: 0, rawText: 'Supply and install', lines: ['Supply and install'], rowSpan: 1, columnSpan: 1, startRowOffset: 0, endRowOffset: 1, startColumnOffset: 0, endColumnOffset: 1, columnHeader: false, rowHeader: false, rowSection: false, carried: false }],
  rawText: 'Supply and install', classification: 'item', confidence: 0.95, warnings: [],
}]
const targetItems = new Map<string, BoqItem>([['target-1', target]])
const validationContext: ProposalValidationContext = {
  extractionRunId: 'run-1',
  sourceRows,
  sourceEvidence: {
    'sr-1': {
      quotedTotal: 100,
      components: { material: { qty: 1, unit: 'set', rate: 40, total: 40 }, labour: { qty: 1, unit: 'set', rate: 60, total: 60 } },
    },
  },
  sections,
}

interface TestProviderProposal {
  id: string
  operation: string
  sourceRowIds: string[]
  targetItemIds: string[]
  confidence: number
  explanation: string
  proposedItems: Record<string, unknown>[]
}

function providerSeparateComponents(): TestProviderProposal {
  return {
    id: 'proposal-1', operation: 'separate_components', sourceRowIds: ['sr-1'], targetItemIds: ['target-1'],
    confidence: 0.96, explanation: 'Split into material and labour.',
    proposedItems: [
      { id: 'mat', desc: 'Material', pricingRole: 'standard', parentBundleId: null, sourceRowIds: ['sr-1'], optional: false, excludedFromTotal: false, exclusionReason: null, unit: 'set', qty: 1, rate: 40, total: 40, costComponent: 'material' },
      { id: 'lab', desc: 'Labour', pricingRole: 'standard', parentBundleId: null, sourceRowIds: ['sr-1'], optional: false, excludedFromTotal: false, exclusionReason: null, unit: 'set', qty: 1, rate: 60, total: 60, costComponent: 'labour' },
    ],
  }
}

test('prepares a provider DTO that omits server-owned fields and passes validation', () => {
  const prep = prepareProviderProposal(providerSeparateComponents(), { extractionRunId: 'run-1', targetItems })
  assert.equal(prep.ok, true)
  if (!prep.ok) return
  const result = validateProposal(prep.proposal, validationContext)
  assert.equal(result.valid, true)
})

test('injected fingerprints match fingerprintCanonicalItem for known targets', () => {
  const prep = prepareProviderProposal(providerSeparateComponents(), { extractionRunId: 'run-1', targetItems })
  if (!prep.ok) throw new Error('preparation failed')
  assert.equal(prep.proposal.affectedItemFingerprints['target-1'], fingerprintCanonicalItem(target))
})

test('injected extractionRunId comes from context, not the provider', () => {
  const withProviderRunId = { ...providerSeparateComponents(), extractionRunId: 'forged-run' }
  const prep = prepareProviderProposal(withProviderRunId, { extractionRunId: 'run-1', targetItems })
  assert.equal(prep.ok, false)
})

test('injected entryOrigin is set on every proposed item', () => {
  const prep = prepareProviderProposal(providerSeparateComponents(), { extractionRunId: 'run-1', targetItems })
  if (!prep.ok) throw new Error('preparation failed')
  assert.ok(prep.proposal.proposedItems.every((item) => item.entryOrigin === 'ai_accepted'))
})

test('rejects provider proposals that include affectedItemFingerprints', () => {
  const withFingerprints = { ...providerSeparateComponents(), affectedItemFingerprints: { 'target-1': 'forged' } }
  const prep = prepareProviderProposal(withFingerprints, { extractionRunId: 'run-1', targetItems })
  assert.equal(prep.ok, false)
})

test('rejects proposed items that include entryOrigin', () => {
  const base = providerSeparateComponents()
  const withEntryOrigin = {
    ...base,
    proposedItems: base.proposedItems.map((item) => ({ ...item, entryOrigin: 'ai_accepted' })),
  }
  const prep = prepareProviderProposal(withEntryOrigin, { extractionRunId: 'run-1', targetItems })
  assert.equal(prep.ok, false)
})

test('rejects unknown top-level keys', () => {
  const withExtra = { ...providerSeparateComponents(), provider: 'openai', model: 'gpt-4o' }
  assert.equal(prepareProviderProposal(withExtra, { extractionRunId: 'run-1', targetItems }).ok, false)
})

test('rejects unknown proposed-item keys', () => {
  const base = providerSeparateComponents()
  const withExtraItem = {
    ...base,
    proposedItems: [{ ...base.proposedItems[0]!, extra: 'bad' }],
  }
  assert.equal(prepareProviderProposal(withExtraItem, { extractionRunId: 'run-1', targetItems }).ok, false)
})

test('rejects numeric strings for qty, rate, total', () => {
  const base = providerSeparateComponents()
  for (const field of ['qty', 'rate', 'total'] as const) {
    const withString = {
      ...base,
      proposedItems: [{ ...base.proposedItems[0]!, [field]: '40' }],
    }
    assert.equal(prepareProviderProposal(withString, { extractionRunId: 'run-1', targetItems }).ok, false)
  }
})

test('rejects singular sourceRowId instead of sourceRowIds array', () => {
  const withSingular = { ...providerSeparateComponents(), sourceRowId: 'sr-1' }
  assert.equal(prepareProviderProposal(withSingular, { extractionRunId: 'run-1', targetItems }).ok, false)
})

test('rejects singular targetItemId instead of targetItemIds array', () => {
  const withSingular = { ...providerSeparateComponents(), targetItemId: 'target-1' }
  assert.equal(prepareProviderProposal(withSingular, { extractionRunId: 'run-1', targetItems }).ok, false)
})

test('rejects missing costComponent on priced items', () => {
  const base = providerSeparateComponents()
  const withoutComponent = {
    ...base,
    proposedItems: [
      { id: 'mat', desc: 'Material', pricingRole: 'standard', parentBundleId: null, sourceRowIds: ['sr-1'], unit: 'set', qty: 1, rate: 40, total: 40 },
      base.proposedItems[1],
    ],
  }
  assert.equal(prepareProviderProposal(withoutComponent, { extractionRunId: 'run-1', targetItems }).ok, false)
})

test('rejects unsupported pricing role', () => {
  const base = providerSeparateComponents()
  const withBadRole = {
    ...base,
    proposedItems: [{ ...base.proposedItems[0]!, pricingRole: 'unknown' }],
  }
  assert.equal(prepareProviderProposal(withBadRole, { extractionRunId: 'run-1', targetItems }).ok, false)
})

test('rejects operation aliases (wrong casing)', () => {
  assert.equal(prepareProviderProposal({ ...providerSeparateComponents(), operation: 'KEEP' }, { extractionRunId: 'run-1', targetItems }).ok, false)
  assert.equal(prepareProviderProposal({ ...providerSeparateComponents(), operation: 'Split' }, { extractionRunId: 'run-1', targetItems }).ok, false)
})

test('rejects missing sourceRowIds array', () => {
  const base = providerSeparateComponents()
  const rest = Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'sourceRowIds'))
  assert.equal(prepareProviderProposal(rest, { extractionRunId: 'run-1', targetItems }).ok, false)
})

test('rejects missing targetItemIds array', () => {
  const base = providerSeparateComponents()
  const rest = Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'targetItemIds'))
  assert.equal(prepareProviderProposal(rest, { extractionRunId: 'run-1', targetItems }).ok, false)
})

test('rejects confidence as a string', () => {
  assert.equal(prepareProviderProposal({ ...providerSeparateComponents(), confidence: '0.96' }, { extractionRunId: 'run-1', targetItems }).ok, false)
})

test('rejects negative numbers for qty, rate, total', () => {
  const base = providerSeparateComponents()
  const withNegative = {
    ...base,
    proposedItems: [{ ...base.proposedItems[0]!, qty: -1 }],
  }
  assert.equal(prepareProviderProposal(withNegative, { extractionRunId: 'run-1', targetItems }).ok, false)
})

test('bundle child without pricing fields passes preparation but validator catches missing parent', () => {
  const bundleProposal = {
    id: 'proposal-bundle', operation: 'create_bundle', sourceRowIds: ['sr-1'], targetItemIds: ['target-1'],
    confidence: 0.9, explanation: 'Create a bundle.',
    proposedItems: [
      { id: 'parent', desc: 'Bundle parent', pricingRole: 'bundle_parent', parentBundleId: null, sourceRowIds: ['sr-1'], optional: false, excludedFromTotal: false, exclusionReason: null, unit: 'set', qty: 1, rate: 100, total: 100, costComponent: 'combined' },
      { id: 'child', desc: 'Bundle child', pricingRole: 'bundle_child', parentBundleId: 'parent', sourceRowIds: ['sr-1'] },
    ],
  }
  const prep = prepareProviderProposal(bundleProposal, { extractionRunId: 'run-1', targetItems })
  assert.equal(prep.ok, true)
})

test('unknown target IDs pass preparation but validator catches them', () => {
  const withUnknownTarget = { ...providerSeparateComponents(), targetItemIds: ['target-1', 'nonexistent'] }
  const prep = prepareProviderProposal(withUnknownTarget, { extractionRunId: 'run-1', targetItems })
  assert.equal(prep.ok, true)
  if (!prep.ok) return
  const result = validateProposal(prep.proposal, validationContext)
  assert.equal(result.valid, false)
  if (!result.valid) assert.equal(result.code, 'unknown_target_item')
})

test('invented component prices pass preparation but validator catches them', () => {
  const inventedPrice = {
    ...providerSeparateComponents(),
    proposedItems: [
      { id: 'mat', desc: 'Material', pricingRole: 'standard', parentBundleId: null, sourceRowIds: ['sr-1'], optional: false, excludedFromTotal: false, exclusionReason: null, unit: 'set', qty: 1, rate: 99, total: 99, costComponent: 'material' },
      { id: 'lab', desc: 'Labour', pricingRole: 'standard', parentBundleId: null, sourceRowIds: ['sr-1'], optional: false, excludedFromTotal: false, exclusionReason: null, unit: 'set', qty: 1, rate: 1, total: 1, costComponent: 'labour' },
    ],
  }
  const prep = prepareProviderProposal(inventedPrice, { extractionRunId: 'run-1', targetItems })
  assert.equal(prep.ok, true)
  if (!prep.ok) return
  const result = validateProposal(prep.proposal, validationContext)
  assert.equal(result.valid, false)
})

test('arithmetic mismatch passes preparation but validator catches it', () => {
  const base = providerSeparateComponents()
  const badArithmetic = {
    ...base,
    proposedItems: [
      { id: 'mat', desc: 'Material', pricingRole: 'standard', parentBundleId: null, sourceRowIds: ['sr-1'], optional: false, excludedFromTotal: false, exclusionReason: null, unit: 'set', qty: 1, rate: 40, total: 50, costComponent: 'material' },
      base.proposedItems[1],
    ],
  }
  const prep = prepareProviderProposal(badArithmetic, { extractionRunId: 'run-1', targetItems })
  assert.equal(prep.ok, true)
  if (!prep.ok) return
  const result = validateProposal(prep.proposal, validationContext)
  assert.equal(result.valid, false)
})

test('provider contract instructions contain all DTO fields and operation names', () => {
  const instructions = providerContractInstructions()
  for (const key of ['id', 'operation', 'sourceRowIds', 'targetItemIds', 'confidence', 'explanation', 'proposedItems']) {
    assert.match(instructions, new RegExp(key))
  }
  for (const key of ['unit', 'qty', 'rate', 'total', 'costComponent', 'parentBundleId', 'pricingRole']) {
    assert.match(instructions, new RegExp(key))
  }
  for (const op of ['keep', 'split', 'merge', 'separate_components', 'create_bundle', 'needs_human_review']) {
    assert.match(instructions, new RegExp(`"${op}"`))
  }
  assert.match(instructions, /FORBIDDEN/)
  assert.match(instructions, /extractionRunId/)
  assert.match(instructions, /affectedItemFingerprints/)
  assert.match(instructions, /entryOrigin/)
})

// ── Canonical provenance: source/target relationship ──

const target2: BoqItem = {
  id: 'target-2', desc: 'Unrelated supply', pricingRole: 'standard',
  unit: 'set', qty: 1, rate: 50, total: 50, type: 'unit', costComponent: 'combined',
  sourceRowIds: ['sr-2'], entryOrigin: 'docling', stdStatus: 'unmatched',
}
const sourceRow2: BoqSourceRowV3 = {
  id: 'sr-2', page: 1, table: 1, row: 2, section: 'Works', headers: ['Description'],
  rawCells: [{ column: 0, rawText: 'Unrelated supply', lines: ['Unrelated supply'], rowSpan: 1, columnSpan: 1, startRowOffset: 0, endRowOffset: 1, startColumnOffset: 0, endColumnOffset: 1, columnHeader: false, rowHeader: false, rowSection: false, carried: false }],
  rawText: 'Unrelated supply', classification: 'item', confidence: 0.95, warnings: [],
}
const multiTargetSections: BoqSection[] = [{ header: 'Works', items: [target, target2] }]
const multiTargetItems = new Map<string, BoqItem>([['target-1', target], ['target-2', target2]])
const multiValidationContext: ProposalValidationContext = {
  extractionRunId: 'run-1',
  sourceRows: [sourceRows[0]!, sourceRow2],
  sourceEvidence: {
    'sr-1': { quotedTotal: 100, components: { material: { qty: 1, unit: 'set', rate: 40, total: 40 }, labour: { qty: 1, unit: 'set', rate: 60, total: 60 } } },
    'sr-2': { quotedTotal: 50 },
  },
  sections: multiTargetSections,
}

function pricedItem(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, desc: `Item ${id}`, pricingRole: 'standard', parentBundleId: null, sourceRowIds: ['sr-1'], optional: false, excludedFromTotal: false, exclusionReason: null, unit: 'set', qty: 1, rate: 40, total: 40, costComponent: 'material', ...overrides }
}

test('cross-mapped source evidence to unrelated target is rejected as target_source_mismatch', () => {
  // sr-1 has material/labour components. target-2 derives from sr-2 (unrelated).
  const crossMapped = { ...providerSeparateComponents(), targetItemIds: ['target-2'] }
  const prep = prepareProviderProposal(crossMapped, { extractionRunId: 'run-1', targetItems: multiTargetItems })
  assert.equal(prep.ok, true)
  if (!prep.ok) return
  const result = validateProposal(prep.proposal, multiValidationContext)
  assert.equal(result.valid, false)
  if (!result.valid) assert.equal(result.code, 'target_source_mismatch')
})

test('separate_components attack using unrelated source evidence is rejected', () => {
  const attack = {
    id: 'attack-1', operation: 'separate_components', sourceRowIds: ['sr-1'], targetItemIds: ['target-2'],
    confidence: 0.95, explanation: 'Use sr-1 components for target-2.',
    proposedItems: [
      pricedItem('mat', { rate: 40, total: 40, costComponent: 'material' }),
      pricedItem('lab', { id: 'lab', rate: 60, total: 60, costComponent: 'labour' }),
    ],
  }
  const prep = prepareProviderProposal(attack, { extractionRunId: 'run-1', targetItems: multiTargetItems })
  assert.equal(prep.ok, true)
  if (!prep.ok) return
  const result = validateProposal(prep.proposal, multiValidationContext)
  assert.equal(result.valid, false)
  if (!result.valid) assert.equal(result.code, 'target_source_mismatch')
})

test('valid keep proposal with matching provenance remains valid', () => {
  const keep = {
    id: 'keep-1', operation: 'keep', sourceRowIds: ['sr-1'], targetItemIds: ['target-1'],
    confidence: 0.95, explanation: 'No correction needed.', proposedItems: [],
  }
  const prep = prepareProviderProposal(keep, { extractionRunId: 'run-1', targetItems })
  assert.equal(prep.ok, true)
  if (!prep.ok) return
  const result = validateProposal(prep.proposal, validationContext)
  assert.equal(result.valid, true)
})

test('valid merge of two related targets remains valid', () => {
  const merge = {
    id: 'merge-1', operation: 'merge', sourceRowIds: ['sr-1', 'sr-2'], targetItemIds: ['target-1', 'target-2'],
    confidence: 0.9, explanation: 'Merge both items.',
    proposedItems: [
      { id: 'merged', desc: 'Merged', pricingRole: 'standard', parentBundleId: null, sourceRowIds: ['sr-1', 'sr-2'], optional: false, excludedFromTotal: false, exclusionReason: null, unit: 'set', qty: 1, rate: 150, total: 150, costComponent: 'combined' },
    ],
  }
  const prep = prepareProviderProposal(merge, { extractionRunId: 'run-1', targetItems: multiTargetItems })
  assert.equal(prep.ok, true)
  if (!prep.ok) return
  const result = validateProposal(prep.proposal, multiValidationContext)
  assert.equal(result.valid, true)
})

test('needs_human_review with matching provenance remains valid', () => {
  const review = {
    id: 'review-1', operation: 'needs_human_review', sourceRowIds: ['sr-1'], targetItemIds: ['target-1'],
    confidence: 0.8, explanation: 'Ambiguous row.', proposedItems: [],
  }
  const prep = prepareProviderProposal(review, { extractionRunId: 'run-1', targetItems })
  assert.equal(prep.ok, true)
  if (!prep.ok) return
  const result = validateProposal(prep.proposal, validationContext)
  assert.equal(result.valid, true)
})

// ── Exact priced-item DTO keys ──

test('rejects priced item missing parentBundleId', () => {
  const base = providerSeparateComponents()
  const item = { ...base.proposedItems[0]! }
  delete item.parentBundleId
  assert.equal(prepareProviderProposal({ ...base, proposedItems: [item, base.proposedItems[1]!] }, { extractionRunId: 'run-1', targetItems }).ok, false)
})

test('rejects priced item with parentBundleId as a non-null string', () => {
  const base = providerSeparateComponents()
  const item = { ...base.proposedItems[0]!, parentBundleId: 'some-id' }
  assert.equal(prepareProviderProposal({ ...base, proposedItems: [item, base.proposedItems[1]!] }, { extractionRunId: 'run-1', targetItems }).ok, false)
})

test('rejects priced item missing optional boolean', () => {
  const base = providerSeparateComponents()
  const item = { ...base.proposedItems[0]! }
  delete item.optional
  assert.equal(prepareProviderProposal({ ...base, proposedItems: [item, base.proposedItems[1]!] }, { extractionRunId: 'run-1', targetItems }).ok, false)
})

test('rejects priced item missing excludedFromTotal boolean', () => {
  const base = providerSeparateComponents()
  const item = { ...base.proposedItems[0]! }
  delete item.excludedFromTotal
  assert.equal(prepareProviderProposal({ ...base, proposedItems: [item, base.proposedItems[1]!] }, { extractionRunId: 'run-1', targetItems }).ok, false)
})

test('rejects priced item missing exclusionReason', () => {
  const base = providerSeparateComponents()
  const item = { ...base.proposedItems[0]! }
  delete item.exclusionReason
  assert.equal(prepareProviderProposal({ ...base, proposedItems: [item, base.proposedItems[1]!] }, { extractionRunId: 'run-1', targetItems }).ok, false)
})

const v2Candidate: ProviderCandidateRef = {
  id: 'candidate-2', sectionIndex: 0, sectionHeader: 'Works', sourceOrder: 1,
  sourceRowIds: ['sr-2'], desc: 'Immutable valve', pricingRole: 'standard', parentBundleId: null,
  unit: 'pcs', qty: 2, rate: 50, total: 100, costComponent: 'material', sourceCosts: null,
  optional: false, excludedFromTotal: false, exclusionReason: null,
}
const v2ExistingCandidate: ProviderCandidateRef = {
  ...v2Candidate, id: 'candidate-1', sourceOrder: 0, sourceRowIds: ['sr-1'],
  desc: target.desc, unit: 'set', qty: 1, rate: 100, total: 100, costComponent: 'combined',
}
const v2Context = {
  extractionRunId: 'run-1', sections, targetItems,
  candidateItems: new Map<string, ProviderCandidateRef>([
    ['candidate-1', v2ExistingCandidate], ['candidate-2', v2Candidate],
  ]),
}

const mappedSourceRow: BoqSourceRowV3 = {
  id: 'mapped-row', page: 2, table: 1, row: 3, section: 'Works', headers: [],
  rawCells: [
    { column: 1, rawText: 'Mapped valve', lines: ['Mapped valve'], rowSpan: 1, columnSpan: 1, startRowOffset: 2, endRowOffset: 3, startColumnOffset: 1, endColumnOffset: 2, columnHeader: false, rowHeader: false, rowSection: false, carried: false },
    { column: 2, rawText: 'pcs', lines: ['pcs'], rowSpan: 1, columnSpan: 1, startRowOffset: 2, endRowOffset: 3, startColumnOffset: 2, endColumnOffset: 3, columnHeader: false, rowHeader: false, rowSection: false, carried: false },
    { column: 3, rawText: '2', lines: ['2'], rowSpan: 1, columnSpan: 1, startRowOffset: 2, endRowOffset: 3, startColumnOffset: 3, endColumnOffset: 4, columnHeader: false, rowHeader: false, rowSection: false, carried: false },
    { column: 4, rawText: '50', lines: ['50'], rowSpan: 1, columnSpan: 1, startRowOffset: 2, endRowOffset: 3, startColumnOffset: 4, endColumnOffset: 5, columnHeader: false, rowHeader: false, rowSection: false, carried: false },
    { column: 5, rawText: '100', lines: ['100'], rowSpan: 1, columnSpan: 1, startRowOffset: 2, endRowOffset: 3, startColumnOffset: 5, endColumnOffset: 6, columnHeader: false, rowHeader: false, rowSection: false, carried: false },
    { column: 6, rawText: 'carried-unit', lines: ['carried-unit'], rowSpan: 1, columnSpan: 1, startRowOffset: 2, endRowOffset: 3, startColumnOffset: 6, endColumnOffset: 7, columnHeader: false, rowHeader: false, rowSection: false, carried: true },
  ],
  rawText: 'Mapped valve | pcs | 2 | 50 | 100', classification: 'unknown', confidence: 0.96, warnings: [],
}

const mappedDecision = {
  id: 'mapped-1', operation: 'map_source_item', sourceRowIds: ['mapped-row'], targetItemIds: [],
  confidence: 0.96, explanation: 'Mapped from retained cells.',
  cellMapping: {
    sourceRowIds: ['mapped-row'],
    description: [{ sourceRowId: 'mapped-row', column: 1 }],
    unit: { sourceRowId: 'mapped-row', column: 2 },
    quantity: { sourceRowId: 'mapped-row', column: 3 },
    rate: { sourceRowId: 'mapped-row', column: 4 },
    total: { sourceRowId: 'mapped-row', column: 5 },
  },
}

const mappedContext = {
  ...v2Context,
  sourceRows: [mappedSourceRow],
  allowedSourceRowIds: new Set(['mapped-row']),
}

test('v2 map_source_item resolves immutable cells into an actionable canonical insert', () => {
  const prepared = prepareProviderProposalV2(mappedDecision, mappedContext)
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  assert.equal(prepared.proposal.operation, 'insert_missing_item')
  assert.deepEqual(prepared.proposal.sourceCellMapping, mappedDecision.cellMapping)
  assert.equal(prepared.proposal.mappedCandidate?.desc, 'Mapped valve')
  assert.equal(prepared.proposal.mappedCandidate?.total, 100)
  assert.deepEqual(prepared.proposal.candidateItemIds, [prepared.proposal.mappedCandidate?.id])
})

test('v2 incomplete map_source_item becomes a source-backed human review draft', () => {
  const incomplete = {
    ...mappedDecision,
    cellMapping: {
      sourceRowIds: ['mapped-row'],
      description: [{ sourceRowId: 'mapped-row', column: 1 }],
      unit: { sourceRowId: 'mapped-row', column: 2 },
      quantity: { sourceRowId: 'mapped-row', column: 3 },
    },
  }
  const prepared = prepareProviderProposalV2(incomplete, mappedContext)
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  assert.equal(prepared.proposal.operation, 'needs_human_review')
  assert.deepEqual(prepared.proposal.reviewDraft?.missingFields, ['rate', 'total'])
  assert.deepEqual(prepared.proposal.proposedItems, [])
})

test('v2 map_source_item becomes replace_item when it safely addresses an existing target', () => {
  const mappedTarget = { ...target, sourceRowIds: ['mapped-row'] }
  const prepared = prepareProviderProposalV2(
    { ...mappedDecision, targetItemIds: ['target-1'] },
    {
      ...mappedContext,
      sections: [{ header: 'Works', items: [mappedTarget] }],
      targetItems: new Map([['target-1', mappedTarget]]),
    },
  )
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  assert.equal(prepared.proposal.operation, 'replace_item')
  assert.deepEqual(prepared.proposal.targetItemIds, ['target-1'])
})

test('v2 mapping resolves only provider-visible cell text and lines', () => {
  const longDescription = 'x'.repeat(600)
  const longLines = Array.from({ length: 12 }, (_, index) => `line-${index}`)
  const longRow = {
    ...mappedSourceRow,
    rawCells: mappedSourceRow.rawCells.map((cell) => cell.column === 1
      ? { ...cell, rawText: longDescription, lines: longLines }
      : cell),
  }
  const context = { ...mappedContext, sourceRows: [longRow] }
  const prepared = prepareProviderProposalV2(mappedDecision, context)
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  assert.equal(prepared.proposal.mappedCandidate?.desc, longDescription.slice(0, 500))
  assert.equal(prepareProviderProposalV2({
    ...mappedDecision,
    cellMapping: {
      ...mappedDecision.cellMapping,
      description: [{ sourceRowId: 'mapped-row', column: 1, line: 10 }],
    },
  }, context).ok, false)
})

for (const [name, rowSection, sectionHeaders] of [
  ['null', null, ['Section A', 'Section B']],
  ['unfamiliar', 'New layout section', ['Section A', 'Section B']],
  ['duplicate', 'Works', ['Works', 'Works']],
] as const) {
  test(`v2 targetless ${name} section mapping becomes a destination-selection draft`, () => {
    const row = { ...mappedSourceRow, section: rowSection }
    const prepared = prepareProviderProposalV2(mappedDecision, {
      ...mappedContext,
      sourceRows: [row],
      sections: sectionHeaders.map((header) => ({ header, items: [] })),
      targetItems: new Map(),
    })
    assert.equal(prepared.ok, true)
    if (!prepared.ok) return
    assert.equal(prepared.proposal.operation, 'needs_human_review')
    assert.deepEqual(prepared.proposal.reviewDraft?.missingFields, ['destinationSection'])
    assert.equal(prepared.proposal.reviewDraft?.section, null)
    assert.equal(prepared.proposal.reviewDraft?.resolvedValues.total, 100)
  })
}

test('v2 mapped replacement preserves common optional and exclusion state', () => {
  const mappedTarget = {
    ...target,
    sourceRowIds: ['mapped-row'],
    optional: true,
    excludedFromTotal: true,
    exclusionReason: 'Client option',
  }
  const mappedSections: BoqSection[] = [{ header: 'Works', items: [mappedTarget] }]
  const prepared = prepareProviderProposalV2(
    { ...mappedDecision, targetItemIds: ['target-1'] },
    {
      ...mappedContext,
      sections: mappedSections,
      targetItems: new Map([['target-1', mappedTarget]]),
    },
  )
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  assert.equal(prepared.proposal.operation, 'replace_item')
  assert.deepEqual({
    optional: prepared.proposal.mappedCandidate?.optional,
    excludedFromTotal: prepared.proposal.mappedCandidate?.excludedFromTotal,
    exclusionReason: prepared.proposal.mappedCandidate?.exclusionReason,
  }, { optional: true, excludedFromTotal: true, exclusionReason: 'Client option' })
  assert.deepEqual({
    optional: prepared.proposal.proposedItems[0]?.optional,
    excludedFromTotal: prepared.proposal.proposedItems[0]?.excludedFromTotal,
    exclusionReason: prepared.proposal.proposedItems[0]?.exclusionReason,
  }, { optional: true, excludedFromTotal: true, exclusionReason: 'Client option' })
  const validation = validateProposal(prepared.proposal, {
    extractionRunId: 'run-1',
    sourceRows: [mappedSourceRow],
    sourceEvidence: {},
    sections: mappedSections,
    candidateItems: new Map([[prepared.proposal.mappedCandidate!.id, prepared.proposal.mappedCandidate!]]),
  })
  assert.equal(validation.valid, true)
})

test('server-owned reconstruction deterministically reproduces the final excluded replacement candidate', () => {
  const mappedTarget = {
    ...target,
    sourceRowIds: ['mapped-row'],
    optional: true,
    excludedFromTotal: true,
    exclusionReason: 'Client option',
  }
  const reconstructionInput = {
    mapping: mappedDecision.cellMapping,
    targetItemIds: ['target-1'],
    sourceRows: [mappedSourceRow],
    allowedSourceRowIds: new Set(['mapped-row']),
    sections: [{ header: 'Works', items: [mappedTarget] }],
    targetItems: new Map([['target-1', mappedTarget]]),
  }
  const first = reconstructSourceMappedItem(reconstructionInput)
  const second = reconstructSourceMappedItem(reconstructionInput)
  assert.equal(first.kind, 'candidate')
  assert.equal(second.kind, 'candidate')
  if (first.kind !== 'candidate' || second.kind !== 'candidate') return
  assert.equal(stableCanonicalJson(first.candidate), stableCanonicalJson(second.candidate))
  const prepared = prepareProviderProposalV2(
    { ...mappedDecision, targetItemIds: ['target-1'] },
    { ...mappedContext, sections: reconstructionInput.sections, targetItems: reconstructionInput.targetItems },
  )
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  assert.equal(stableCanonicalJson(first.candidate), stableCanonicalJson(prepared.proposal.mappedCandidate))
  assert.deepEqual({
    optional: first.candidate.optional,
    excludedFromTotal: first.candidate.excludedFromTotal,
    exclusionReason: first.candidate.exclusionReason,
  }, { optional: true, excludedFromTotal: true, exclusionReason: 'Client option' })
})

test('v2 mapped replacement with conflicting target state becomes human review', () => {
  const included = { ...target, id: 'target-included', sourceRowIds: ['mapped-row'] }
  const excluded = {
    ...target,
    id: 'target-excluded',
    sourceRowIds: ['mapped-row'],
    optional: true,
    excludedFromTotal: true,
    exclusionReason: 'Client option',
  }
  const conflictingSections: BoqSection[] = [{ header: 'Works', items: [included, excluded] }]
  const prepared = prepareProviderProposalV2(
    { ...mappedDecision, targetItemIds: ['target-included', 'target-excluded'] },
    {
      ...mappedContext,
      sections: conflictingSections,
      targetItems: new Map([['target-included', included], ['target-excluded', excluded]]),
    },
  )
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  assert.equal(prepared.proposal.operation, 'needs_human_review')
  assert.deepEqual(prepared.proposal.reviewDraft?.missingFields, ['targetItemState'])
  assert.equal(prepared.proposal.reviewDraft?.resolvedValues.total, 100)
  assert.equal(validateProposal(prepared.proposal, {
    extractionRunId: 'run-1',
    sourceRows: [mappedSourceRow],
    sourceEvidence: {},
    sections: conflictingSections,
  }).valid, true)
})

test('complete component mapping review draft preserves component-shaped resolved values', () => {
  const componentRow: BoqSourceRowV3 = {
    ...mappedSourceRow,
    section: null,
    rawCells: [
      ...mappedSourceRow.rawCells.filter((cell) => cell.column <= 3),
      { ...mappedSourceRow.rawCells[3], column: 4, rawText: '20', lines: ['20'], carried: false },
      { ...mappedSourceRow.rawCells[4], column: 5, rawText: '40', lines: ['40'], carried: false },
      { ...mappedSourceRow.rawCells[3], column: 6, rawText: '30', lines: ['30'], carried: false },
      { ...mappedSourceRow.rawCells[4], column: 7, rawText: '60', lines: ['60'], carried: false },
      { ...mappedSourceRow.rawCells[4], column: 8, rawText: '100', lines: ['100'], carried: false },
    ],
  }
  const prepared = prepareProviderProposalV2({
    ...mappedDecision,
    cellMapping: {
      sourceRowIds: ['mapped-row'],
      description: [{ sourceRowId: 'mapped-row', column: 1 }],
      unit: { sourceRowId: 'mapped-row', column: 2 },
      quantity: { sourceRowId: 'mapped-row', column: 3 },
      materialRate: { sourceRowId: 'mapped-row', column: 4 },
      materialTotal: { sourceRowId: 'mapped-row', column: 5 },
      labourRate: { sourceRowId: 'mapped-row', column: 6 },
      labourTotal: { sourceRowId: 'mapped-row', column: 7 },
      amount: { sourceRowId: 'mapped-row', column: 8 },
    },
  }, {
    ...mappedContext,
    sourceRows: [componentRow],
    sections: [{ header: 'Section A', items: [] }, { header: 'Section B', items: [] }],
  })
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  assert.deepEqual(prepared.proposal.reviewDraft?.resolvedValues, {
    description: 'Mapped valve',
    unit: 'pcs',
    quantity: 2,
    materialRate: 20,
    materialTotal: 40,
    labourRate: 30,
    labourTotal: 60,
    amount: 100,
  })
})

test('v2 mapping boundary rejects provider-authored source values and invalid coordinates', () => {
  for (const [key, value] of Object.entries({ qty: 2, rate: 50, total: 100, description: 'Invented', unit: 'pcs' })) {
    assert.equal(prepareProviderProposalV2({ ...mappedDecision, [key]: value }, mappedContext).ok, false)
  }
  assert.equal(prepareProviderProposalV2({
    ...mappedDecision,
    cellMapping: { ...mappedDecision.cellMapping, total: { sourceRowId: 'mapped-row', column: 99 } },
  }, mappedContext).ok, false)
  assert.equal(prepareProviderProposalV2({
    ...mappedDecision,
    cellMapping: { ...mappedDecision.cellMapping, unit: { sourceRowId: 'mapped-row', column: 6 } },
  }, mappedContext).ok, false)
})

test('v2 mapping boundary rejects declared source rows that contribute no mapped cell', () => {
  const unusedRow = { ...mappedSourceRow, id: 'unused-row', row: 4 }
  const prepared = prepareProviderProposalV2({
    ...mappedDecision,
    sourceRowIds: ['mapped-row', 'unused-row'],
    cellMapping: {
      ...mappedDecision.cellMapping,
      sourceRowIds: ['mapped-row', 'unused-row'],
    },
  }, {
    ...mappedContext,
    sourceRows: [mappedSourceRow, unusedRow],
    allowedSourceRowIds: new Set(['mapped-row', 'unused-row']),
  })
  assert.equal(prepared.ok, false)
})

test('v2 decision expands immutable candidates and injects revision and destination metadata', () => {
  const prepared = prepareProviderProposalV2({
    id: 'insert-2', operation: 'insert_missing_item', sourceRowIds: ['sr-2'], targetItemIds: [],
    candidateItemIds: ['candidate-2'], confidence: 0.96, explanation: 'Missing source-backed item.',
  }, v2Context)
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  assert.equal(prepared.proposal.proposedItems[0].desc, 'Immutable valve')
  assert.equal((prepared.proposal.proposedItems[0] as { total: number }).total, 100)
  assert.equal(prepared.proposal.destinationSectionIndex, 0)
  assert.equal(prepared.proposal.destinationItemIndex, 1)
  assert.match(prepared.proposal.baseSectionsFingerprint ?? '', /^sha256:/)
})

test('v2 decision DTO cannot author values or use invalid operation shapes', () => {
  const valid = {
    id: 'insert-2', operation: 'insert_missing_item', sourceRowIds: ['sr-2'], targetItemIds: [],
    candidateItemIds: ['candidate-2'], confidence: 0.96, explanation: 'Missing item.',
  }
  assert.equal(prepareProviderProposalV2({ ...valid, proposedItems: [{ total: 999 }] }, v2Context).ok, false)
  assert.equal(prepareProviderProposalV2({ ...valid, candidateItemIds: ['missing'] }, v2Context).ok, false)
  assert.equal(prepareProviderProposalV2({ ...valid, operation: 'keep' }, v2Context).ok, false)
  assert.equal(prepareProviderProposalV2({ ...valid, operation: 'remove_spurious_item' }, v2Context).ok, false)
})

test('v2 preparation rejects bundle-parent candidates that lack immutable child structure', () => {
  const bundleCandidate = { ...v2Candidate, id: 'bundle-parent', pricingRole: 'bundle_parent' }
  const context = {
    ...v2Context,
    candidateItems: new Map([['bundle-parent', bundleCandidate]]) as unknown as Map<string, ProviderCandidateRef>,
  }
  assert.equal(prepareProviderProposalV2({
    id: 'insert-bundle', operation: 'insert_missing_item', sourceRowIds: ['sr-2'], targetItemIds: [],
    candidateItemIds: ['bundle-parent'], confidence: 0.96, explanation: 'Unsafe partial bundle.',
  }, context).ok, false)
})

test('v2 contract asks only for source-backed add, replace, remove or human-review decisions', () => {
  const instructions = providerContractInstructionsV2()
  assert.match(instructions, /insert_missing_item/)
  assert.match(instructions, /replace_item/)
  assert.match(instructions, /remove_spurious_item/)
  assert.match(instructions, /NEVER invent prices/)
  assert.match(instructions, /NEVER propose keep or separate_components/)
  assert.match(instructions, /map_source_item/)
  assert.match(instructions, /Return cell coordinates only\. Never return source values\./)
  assert.doesNotMatch(instructions, /All values come from the provided candidateItems/)
  assert.match(instructions, /immutable deterministic candidates or mapped source cells/)
})

test('v2 needs_human_review normalizes a complete source-row suggestion block into proposal order', () => {
  const prepared = prepareProviderProposalV2({
    id: 'mixed-review', operation: 'needs_human_review',
    sourceRowIds: ['sr-1', 'sr-2'], targetItemIds: [], candidateItemIds: [],
    confidence: 0.9, explanation: 'Bundle needs manual review.',
    sourceRowSuggestions: [
      { sourceRowId: 'sr-2', suggestedAction: 'ignore', reasonCode: 'summary_or_tax', reason: 'Subtotal', confidence: 0.99 },
      { sourceRowId: 'sr-1', suggestedAction: 'add', reasonCode: 'missing_priced_item', reason: 'Missing line', confidence: 0.91 },
    ],
  }, v2Context)
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  assert.deepEqual(
    prepared.proposal.sourceRowSuggestions?.map((entry) => entry.sourceRowId),
    ['sr-1', 'sr-2'],
  )
})

test('v2 needs_human_review omits malformed advisory suggestions while the proposal remains ok', () => {
  const incomplete = prepareProviderProposalV2({
    id: 'incomplete-suggestions', operation: 'needs_human_review',
    sourceRowIds: ['sr-1', 'sr-2'], targetItemIds: [], candidateItemIds: [],
    confidence: 0.9, explanation: 'Bundle.',
    sourceRowSuggestions: [
      { sourceRowId: 'sr-1', suggestedAction: 'add', reasonCode: 'missing_priced_item', reason: 'Missing', confidence: 0.9 },
    ],
  }, v2Context)
  assert.equal(incomplete.ok, true)
  if (!incomplete.ok) return
  assert.equal(incomplete.proposal.sourceRowSuggestions, undefined)

  const badConfidence = prepareProviderProposalV2({
    id: 'bad-confidence', operation: 'needs_human_review',
    sourceRowIds: ['sr-1'], targetItemIds: [], candidateItemIds: [],
    confidence: 0.9, explanation: 'Bundle.',
    sourceRowSuggestions: [
      { sourceRowId: 'sr-1', suggestedAction: 'add', reasonCode: 'missing_priced_item', reason: 'Missing', confidence: 1.5 },
    ],
  }, v2Context)
  assert.equal(badConfidence.ok, true)
  if (!badConfidence.ok) return
  assert.equal(badConfidence.proposal.sourceRowSuggestions, undefined)
})

test('v2 advisory suggestions on non-human-review operations fail preparation', () => {
  const suggestion = [
    { sourceRowId: 'sr-1', suggestedAction: 'add', reasonCode: 'missing_priced_item', reason: 'Missing', confidence: 0.9 },
  ]
  assert.equal(prepareProviderProposalV2({
    id: 'advisory-insert', operation: 'insert_missing_item',
    sourceRowIds: ['sr-1'], targetItemIds: [], candidateItemIds: ['candidate-1'],
    confidence: 0.9, explanation: 'Bad.', sourceRowSuggestions: suggestion,
  }, v2Context).ok, false)
  assert.equal(prepareProviderProposalV2({
    id: 'advisory-replace', operation: 'replace_item',
    sourceRowIds: ['sr-1'], targetItemIds: ['target-1'], candidateItemIds: ['candidate-1'],
    confidence: 0.9, explanation: 'Bad.', sourceRowSuggestions: suggestion,
  }, v2Context).ok, false)
  assert.equal(prepareProviderProposalV2({
    id: 'advisory-remove', operation: 'remove_spurious_item',
    sourceRowIds: ['sr-1'], targetItemIds: ['target-1'], candidateItemIds: [],
    confidence: 0.9, explanation: 'Bad.', sourceRowSuggestions: suggestion,
  }, v2Context).ok, false)
  assert.equal(prepareProviderProposalV2({
    ...mappedDecision, sourceRowSuggestions: suggestion,
  }, mappedContext).ok, false)
})

test('v2 contract advisory instructions request one entry per source row and forbid item values', () => {
  const instructions = providerContractInstructionsV2()
  assert.match(instructions, /sourceRowSuggestions/)
  assert.match(instructions, /one advisory entry per sourceRowId/i)
  for (const code of SOURCE_ROW_DISPOSITION_REASON_CODES) {
    assert.match(instructions, new RegExp(code))
  }
  assert.match(instructions, /non-binding/i)
  assert.match(instructions, /descriptions, units, quantities, rates, totals, section choices, source mappings, or preselected human decisions/i)
})
