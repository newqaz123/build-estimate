import assert from 'node:assert/strict'
import test from 'node:test'
import type { BoqPricedItem, BoqSection } from './boq-schema'
import {
  applyValidatedProposal,
  fingerprintCanonicalItem,
  isHighConfidenceProposal,
  undoAcceptedProposal,
  validateProposal,
  validateProposalBatch,
  type ProposalValidationContext,
} from './boq-extraction-proposals'

const sections: BoqSection[] = [{
  header: 'Pump Works',
  items: [{
    id: 'combined-work', desc: 'Pump supply and installation', pricingRole: 'standard',
    unit: 'set', qty: 1, rate: 100, total: 100, type: 'unit', costComponent: 'combined',
    sourceRowIds: ['row-combined'], entryOrigin: 'docling', stdStatus: 'unmatched',
  }, {
    id: 'pump-accessory', desc: 'Pump accessory', pricingRole: 'standard',
    unit: 'set', qty: 1, rate: 20, total: 20, type: 'unit', costComponent: 'combined',
    sourceRowIds: ['row-extra'], entryOrigin: 'docling', stdStatus: 'unmatched',
  }],
}]

function context(overrides: Partial<ProposalValidationContext> = {}): ProposalValidationContext {
  return {
    extractionRunId: 'run-1',
    sourceRows: [{ id: 'row-combined' }, { id: 'row-extra' }],
    sourceEvidence: {
      'row-combined': {
        quotedTotal: 100,
        components: {
          material: { qty: 1, unit: 'set', rate: 40, total: 40 },
          labour: { qty: 1, unit: 'set', rate: 60, total: 60 },
        },
      },
      'row-extra': { quotedTotal: 20 },
    },
    sections,
    ...overrides,
  }
}

function separateComponentsProposal(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proposal-components', extractionRunId: 'run-1', operation: 'separate_components', sourceRowIds: ['row-combined'],
    targetItemIds: ['combined-work'],
    affectedItemFingerprints: { 'combined-work': fingerprintCanonicalItem(sections[0].items[0]) },
    confidence: 0.96, explanation: 'The quote lists distinct material and labour amounts.',
    proposedItems: [
      {
        id: 'pump-material', desc: 'Pump material', pricingRole: 'standard', sourceRowIds: ['row-combined'],
        entryOrigin: 'ai_accepted', optional: false, excludedFromTotal: false, exclusionReason: null,
        unit: 'set', qty: 1, rate: 40, total: 40, costComponent: 'material',
      },
      {
        id: 'pump-labour', desc: 'Pump labour', pricingRole: 'standard', sourceRowIds: ['row-combined'],
        entryOrigin: 'ai_accepted', optional: false, excludedFromTotal: false, exclusionReason: null,
        unit: 'set', qty: 1, rate: 60, total: 60, costComponent: 'labour',
      },
    ],
    ...overrides,
  }
}

test('accept then undo round-trips canonical sections', () => {
  const proposal = validateProposal(separateComponentsProposal(), context())
  assert.equal(proposal.valid, true)
  if (!proposal.valid) return

  const accepted = applyValidatedProposal(sections, proposal.proposal)
  assert.deepEqual(accepted.sections[0].items.map((item) => item.id), ['pump-material', 'pump-labour', 'pump-accessory'])
  assert.deepEqual((accepted.sections[0].items[0] as BoqPricedItem).costAllocation, {
    basis: 'rate', material: 40, labour: 0, origin: 'source',
  })
  assert.deepEqual((accepted.sections[0].items[1] as BoqPricedItem).costAllocation, {
    basis: 'rate', material: 0, labour: 60, origin: 'source',
  })
  assert.deepEqual(undoAcceptedProposal(accepted.sections, accepted.audit), sections)
})

test('rejects material and labour labels on a generic split without component evidence', () => {
  const aggregateOnlyContext = context({
    sourceEvidence: { 'row-combined': { quotedTotal: 100 }, 'row-extra': { quotedTotal: 20 } },
  })
  const split = validateProposal({
    id: 'split-with-labels', extractionRunId: 'run-1', operation: 'split', sourceRowIds: ['row-combined'], targetItemIds: ['combined-work'],
    affectedItemFingerprints: { 'combined-work': fingerprintCanonicalItem(sections[0].items[0]) },
    confidence: 0.91, explanation: 'Two aggregate children with no component price evidence.',
    proposedItems: [
      { id: 'split-material', desc: 'Labelled material', pricingRole: 'standard', sourceRowIds: ['row-combined'], entryOrigin: 'ai_accepted', unit: 'set', qty: 1, rate: 40, total: 40, costComponent: 'material' },
      { id: 'split-labour', desc: 'Labelled labour', pricingRole: 'standard', sourceRowIds: ['row-combined'], entryOrigin: 'ai_accepted', unit: 'set', qty: 1, rate: 60, total: 60, costComponent: 'labour' },
    ],
  }, aggregateOnlyContext)
  assert.deepEqual(split, { valid: false, code: 'invented_component_price' })
})

test('rejects aggregate-price allocation without source component prices', () => {
  const aggregateOnly = context({
    sourceEvidence: { 'row-combined': { quotedTotal: 100 }, 'row-extra': { quotedTotal: 20 } },
  })
  assert.deepEqual(validateProposal(separateComponentsProposal(), aggregateOnly), {
    valid: false,
    code: 'invented_component_price',
  })
})

test('validates all operation shapes without silently applying review-only proposals', () => {
  const common = {
    extractionRunId: 'run-1',
    sourceRowIds: ['row-combined'], targetItemIds: ['combined-work'],
    affectedItemFingerprints: { 'combined-work': fingerprintCanonicalItem(sections[0].items[0]) },
    confidence: 0.91, explanation: 'Evidence checked.',
  }
  assert.equal(validateProposal({ id: 'keep', operation: 'keep', proposedItems: [], ...common }, context()).valid, true)
  assert.equal(validateProposal({ id: 'human', operation: 'needs_human_review', proposedItems: [], ...common }, context()).valid, true)
  const human = validateProposal({ id: 'human', operation: 'needs_human_review', proposedItems: [], ...common }, context())
  assert.equal(human.valid, true)
  if (human.valid) assert.throws(() => applyValidatedProposal(sections, human.proposal), /human review/)
})

test('keep records explicit acceptance without replacing the deterministic structure', () => {
  const proposal = validateProposal({
    id: 'keep-apply', extractionRunId: 'run-1', operation: 'keep', sourceRowIds: ['row-combined'], targetItemIds: ['combined-work'],
    affectedItemFingerprints: { 'combined-work': fingerprintCanonicalItem(sections[0].items[0]) },
    confidence: 0.91, explanation: 'The deterministic item already matches the evidence.', proposedItems: [],
  }, context())
  assert.equal(proposal.valid, true)
  if (!proposal.valid) return
  assert.deepEqual(applyValidatedProposal(sections, proposal.proposal).sections, sections)
})

test('validates split, merge, and bundle totals against source evidence', () => {
  const split = validateProposal({
    id: 'split', extractionRunId: 'run-1', operation: 'split', sourceRowIds: ['row-combined'], targetItemIds: ['combined-work'],
    affectedItemFingerprints: { 'combined-work': fingerprintCanonicalItem(sections[0].items[0]) },
    confidence: 0.91, explanation: 'Two priced source lines.',
    proposedItems: [
      { id: 'split-a', desc: 'Pump A', pricingRole: 'standard', sourceRowIds: ['row-combined'], entryOrigin: 'ai_accepted', unit: 'set', qty: 1, rate: 40, total: 40, costComponent: 'combined' },
      { id: 'split-b', desc: 'Pump B allowance', pricingRole: 'standard', sourceRowIds: ['row-combined'], entryOrigin: 'ai_accepted', unit: 'L/S', qty: 1, rate: 60, total: 60, costComponent: 'lump_sum' },
    ],
  }, context())
  assert.equal(split.valid, true)

  const merge = validateProposal({
    id: 'merge', extractionRunId: 'run-1', operation: 'merge', sourceRowIds: ['row-combined', 'row-extra'], targetItemIds: ['combined-work', 'pump-accessory'],
    affectedItemFingerprints: {
      'combined-work': fingerprintCanonicalItem(sections[0].items[0]),
      'pump-accessory': fingerprintCanonicalItem(sections[0].items[1]),
    },
    confidence: 0.91, explanation: 'A priced grouping.',
    proposedItems: [
      { id: 'merged', desc: 'Pump package', pricingRole: 'standard', sourceRowIds: ['row-combined', 'row-extra'], entryOrigin: 'ai_accepted', unit: 'set', qty: 1, rate: 120, total: 120, costComponent: 'combined' },
    ],
  }, context())
  assert.equal(merge.valid, true)

  const bundle = validateProposal({
    id: 'bundle', extractionRunId: 'run-1', operation: 'create_bundle', sourceRowIds: ['row-combined'], targetItemIds: ['combined-work'],
    affectedItemFingerprints: { 'combined-work': fingerprintCanonicalItem(sections[0].items[0]) },
    confidence: 0.91, explanation: 'One aggregate price with information-only children.',
    proposedItems: [
      { id: 'bundle-parent', desc: 'Pump package', pricingRole: 'bundle_parent', sourceRowIds: ['row-combined'], entryOrigin: 'ai_accepted', unit: 'set', qty: 1, rate: 100, total: 100, costComponent: 'combined' },
      { id: 'bundle-child', desc: 'Pump body', pricingRole: 'bundle_child', parentBundleId: 'bundle-parent', sourceRowIds: ['row-combined'], entryOrigin: 'ai_accepted' },
    ],
  }, context())
  assert.equal(bundle.valid, true)
})

test('rejects unknown evidence, bad arithmetic, stale edits, and duplicate batch targets', () => {
  assert.deepEqual(validateProposal(separateComponentsProposal({ sourceRowIds: ['missing-row'] }), context()), {
    valid: false, code: 'unknown_source_row',
  })
  const badMath = separateComponentsProposal()
  badMath.proposedItems[0].total = 41
  assert.deepEqual(validateProposal(badMath, context()), { valid: false, code: 'arithmetic_mismatch' })
  assert.deepEqual(validateProposal(separateComponentsProposal({
    affectedItemFingerprints: { 'combined-work': 'sha256:stale' },
  }), context()), { valid: false, code: 'stale_item' })
  const batch = validateProposalBatch([separateComponentsProposal(), separateComponentsProposal({ id: 'duplicate-target' })], context())
  assert.equal(batch.valid, false)
  assert.equal(batch.results[1].valid, false)
  assert.equal(batch.results[1].code, 'overlapping_target')
})

test('high confidence requires valid evidence, reconciliation, a non-review operation, and fresh state', () => {
  const result = validateProposal(separateComponentsProposal(), context())
  assert.equal(result.valid, true)
  if (!result.valid) return
  assert.equal(isHighConfidenceProposal(result.proposal), true)
  assert.equal(isHighConfidenceProposal({ ...result.proposal, confidence: 0.89 }), false)
  assert.equal(isHighConfidenceProposal({ ...result.proposal, operation: 'needs_human_review' }), false)
})

test('rejects negative values, duplicate source rows, and merge totals that do not reconcile', () => {
  const negative = separateComponentsProposal()
  negative.proposedItems[0].rate = -1
  assert.equal(validateProposal(negative, context()).valid, false)
  assert.deepEqual(validateProposal(separateComponentsProposal({ sourceRowIds: ['row-combined', 'row-combined'] }), context()), {
    valid: false, code: 'duplicate_source_row',
  })
  const badMerge = validateProposal({
    id: 'bad-merge', extractionRunId: 'run-1', operation: 'merge', sourceRowIds: ['row-combined', 'row-extra'],
    targetItemIds: ['combined-work', 'pump-accessory'],
    affectedItemFingerprints: {
      'combined-work': fingerprintCanonicalItem(sections[0].items[0]),
      'pump-accessory': fingerprintCanonicalItem(sections[0].items[1]),
    },
    confidence: 0.91, explanation: 'Bad total.',
    proposedItems: [
      { id: 'bad-merged', desc: 'Pump package', pricingRole: 'standard', sourceRowIds: ['row-combined', 'row-extra'], entryOrigin: 'ai_accepted', unit: 'set', qty: 1, rate: 119, total: 119, costComponent: 'combined' },
    ],
  }, context())
  assert.deepEqual(badMerge, { valid: false, code: 'reconciliation_mismatch' })
})

test('a second application or modified accepted structure is refused instead of applying or undoing silently', () => {
  const validated = validateProposal(separateComponentsProposal(), context())
  assert.equal(validated.valid, true)
  if (!validated.valid) return
  const accepted = applyValidatedProposal(sections, validated.proposal)
  assert.throws(() => applyValidatedProposal(accepted.sections, validated.proposal), /changed after acceptance/)
  const modified = structuredClone(accepted.sections)
  modified[0].items[0] = { ...modified[0].items[0], desc: 'Later user edit' }
  assert.throws(() => undoAcceptedProposal(modified, accepted.audit), /changed after acceptance/)
})

test('requires run-bound, non-empty source evidence for every review operation', () => {
  assert.deepEqual(validateProposal(separateComponentsProposal({ sourceRowIds: [] }), context()), {
    valid: false, code: 'invalid_operation_shape',
  })
  assert.deepEqual(validateProposal(separateComponentsProposal({ extractionRunId: 'run-other' }), context()), {
    valid: false, code: 'run_identity_mismatch',
  })
  assert.deepEqual(validateProposal({
    id: 'keep-no-evidence', extractionRunId: 'run-1', operation: 'keep', sourceRowIds: ['row-combined'],
    targetItemIds: ['combined-work'], affectedItemFingerprints: { 'combined-work': fingerprintCanonicalItem(sections[0].items[0]) },
    confidence: 0.95, explanation: 'No source payload.', proposedItems: [],
  }, context({ sourceEvidence: {} })), { valid: false, code: 'missing_source_evidence' })
  assert.deepEqual(validateProposal({
    id: 'human-no-target', extractionRunId: 'run-1', operation: 'needs_human_review', sourceRowIds: ['row-combined'],
    targetItemIds: [], affectedItemFingerprints: {}, confidence: 0.95, explanation: 'Needs a person.', proposedItems: [],
  }, context()), { valid: false, code: 'invalid_operation_shape' })
})

test('rejects malformed exclusion flags and relationships, including zero-source replacements', () => {
  const malformed = separateComponentsProposal()
  const malformedItem = malformed.proposedItems[0] as unknown as Record<string, unknown>
  malformedItem.excludedFromTotal = 'yes'
  assert.deepEqual(validateProposal(malformed, context()), { valid: false, code: 'invalid_shape' })
  const reasonWithoutExclusion = separateComponentsProposal()
  const reasonItem = reasonWithoutExclusion.proposedItems[0] as unknown as Record<string, unknown>
  reasonItem.exclusionReason = 'not excluded'
  assert.deepEqual(validateProposal(reasonWithoutExclusion, context()), { valid: false, code: 'invalid_shape' })
  const excludedWithoutOptional = separateComponentsProposal()
  const excludedItem = excludedWithoutOptional.proposedItems[0] as unknown as Record<string, unknown>
  excludedItem.excludedFromTotal = true
  excludedItem.exclusionReason = 'Optional source row'
  assert.deepEqual(validateProposal(excludedWithoutOptional, context()), { valid: false, code: 'invalid_shape' })
  const zeroSource = separateComponentsProposal({
    sourceRowIds: ['row-combined'],
    proposedItems: [{ ...separateComponentsProposal().proposedItems[0], sourceRowIds: [], total: 0, rate: 0 }],
  })
  assert.deepEqual(validateProposal(zeroSource, context()), { valid: false, code: 'invalid_shape' })
})

test('returns dedicated operation and confidence failures for malformed model output', () => {
  const valid = separateComponentsProposal()
  assert.deepEqual(validateProposal({ ...valid, operation: 'invent_price' }, context()), { valid: false, code: 'unknown_operation' })
  assert.deepEqual(validateProposal({ ...valid, confidence: 2 }, context()), { valid: false, code: 'invalid_confidence' })
  assert.deepEqual(validateProposal({ ...valid, confidence: Number.NaN }, context()), { valid: false, code: 'invalid_confidence' })
})

test('requires proposed provenance to cover every declared source row', () => {
  const provenanceDrop = {
    id: 'provenance-drop', extractionRunId: 'run-1', operation: 'merge', sourceRowIds: ['row-combined', 'row-extra'],
    targetItemIds: ['combined-work', 'pump-accessory'],
    affectedItemFingerprints: {
      'combined-work': fingerprintCanonicalItem(sections[0].items[0]),
      'pump-accessory': fingerprintCanonicalItem(sections[0].items[1]),
    },
    confidence: 0.95, explanation: 'The second source row is silently dropped.',
    proposedItems: [{
      id: 'merged-provenance-drop', desc: 'Pump package', pricingRole: 'standard', sourceRowIds: ['row-combined'],
      entryOrigin: 'ai_accepted', unit: 'set', qty: 1, rate: 120, total: 120, costComponent: 'combined',
    }],
  }
  assert.deepEqual(validateProposal(provenanceDrop, context()), {
    valid: false, code: 'source_provenance_mismatch',
  })
})

test('rejects exclusion state on informational bundle children', () => {
  const bundle = {
    id: 'bundle-exclusion', extractionRunId: 'run-1', operation: 'create_bundle', sourceRowIds: ['row-combined'],
    targetItemIds: ['combined-work'],
    affectedItemFingerprints: { 'combined-work': fingerprintCanonicalItem(sections[0].items[0]) },
    confidence: 0.95, explanation: 'Bundle child cannot be excluded.',
    proposedItems: [
      { id: 'bundle-parent', desc: 'Pump package', pricingRole: 'bundle_parent', sourceRowIds: ['row-combined'], entryOrigin: 'ai_accepted', unit: 'set', qty: 1, rate: 100, total: 100, costComponent: 'combined' },
      { id: 'bundle-child', desc: 'Pump body', pricingRole: 'bundle_child', parentBundleId: 'bundle-parent', sourceRowIds: ['row-combined'], entryOrigin: 'ai_accepted', optional: true },
    ],
  }
  assert.deepEqual(validateProposal(bundle, context()), { valid: false, code: 'invalid_shape' })
})

test('separate_components only accepts standard priced children', () => {
  const components = separateComponentsProposal()
  const component = components.proposedItems[0] as unknown as Record<string, unknown>
  component.pricingRole = 'bundle_parent'
  assert.deepEqual(validateProposal(components, context()), { valid: false, code: 'invalid_operation_shape' })
})
