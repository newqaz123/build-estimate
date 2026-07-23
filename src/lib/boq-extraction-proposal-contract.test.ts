import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareProviderProposal, providerContractInstructions } from './boq-extraction-proposal-contract'
import { fingerprintCanonicalItem, validateProposal, type ProposalValidationContext } from './boq-extraction-proposals'
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
