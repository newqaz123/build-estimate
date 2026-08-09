import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ACTIONABLE_REVIEW_PROMPT_VERSION,
  buildActionableReviewFingerprint,
  generateActionableReview,
  type GenerateActionableReviewInput,
} from './actionable-review-projection'
import type { ActionableReviewAiAdvice, ActionableReviewProviderCall } from './actionable-review-ai'
import type { ExtractionProposalAudit } from './boq-extraction-acceptance'
import type { BoqExtractionRun } from './boq-extraction-run'
import type { BoqSourceRowV3 } from './boq-extraction-schema'
import type { ValidatedProposal } from './boq-extraction-proposals'
import type { Boq, BoqPricedItem } from './boq-schema'
import {
  buildCatalogMappingCacheKey,
  buildScopedSourceSignature,
  buildSourceSignature,
  type ApprovedCatalogMapping,
  type CatalogMappingCache,
} from './catalog-mapping-cache'
import type { HumanApprovedCatalogConversionRule } from './catalog-conversion'
import type { ActionableReviewSettings } from './settings-schema'

const UNIT_MAP: Record<string, string> = {
  m3: 'm3',
  'cu m': 'm3',
  m: 'm',
  pcs: 'pcs',
}

function cell(
  column: number,
  rawText: string,
): BoqSourceRowV3['rawCells'][number] {
  return {
    column,
    rawText,
    lines: rawText.split('\n'),
    rowSpan: 1,
    columnSpan: 1,
    startRowOffset: 0,
    endRowOffset: 1,
    startColumnOffset: column,
    endColumnOffset: column + 1,
    columnHeader: false,
    rowHeader: false,
    rowSection: false,
    carried: false,
  }
}

function sourceRow(input: {
  id: string
  row: number
  desc: string
  unit?: string
  qty?: string
  rate?: string
  amount?: string
  classification?: BoqSourceRowV3['classification']
  page?: number
  table?: number
  section?: string
}): BoqSourceRowV3 {
  const headers = ['Description', 'Unit', 'Qty', 'Rate', 'Amount']
  const unit = input.unit ?? 'm3'
  const qty = input.qty ?? '10'
  const rate = input.rate ?? '100'
  const amount = input.amount ?? '1000'
  return {
    id: input.id,
    page: input.page ?? 1,
    table: input.table ?? 0,
    row: input.row,
    section: input.section ?? 'Works',
    headers,
    rawCells: [
      cell(0, input.desc),
      cell(1, unit),
      cell(2, qty),
      cell(3, rate),
      cell(4, amount),
    ],
    rawText: `${input.desc} | ${unit} | ${qty} | ${rate} | ${amount}`,
    classification: input.classification ?? 'item',
    confidence: 0.95,
    warnings: [],
  }
}

function headerRow(id: string, row: number): BoqSourceRowV3 {
  const headers = ['Description', 'Unit', 'Qty', 'Rate', 'Amount']
  return {
    id,
    page: 1,
    table: 0,
    row,
    section: 'Works',
    headers,
    rawCells: headers.map((text, column) => cell(column, text)),
    rawText: headers.join(' | '),
    classification: 'header',
    confidence: 0.99,
    warnings: [],
  }
}

function noteRow(id: string, row: number): BoqSourceRowV3 {
  return {
    id,
    page: 1,
    table: 0,
    row,
    section: 'Works',
    headers: ['Description', 'Unit', 'Qty', 'Rate', 'Amount'],
    rawCells: [cell(0, 'Note: verify site conditions'), cell(1, ''), cell(2, ''), cell(3, ''), cell(4, '')],
    rawText: 'Note: verify site conditions',
    classification: 'note',
    confidence: 0.9,
    warnings: [],
  }
}

function totalRow(id: string, row: number, amount: string): BoqSourceRowV3 {
  return {
    id,
    page: 1,
    table: 0,
    row,
    section: 'Works',
    headers: ['Description', 'Unit', 'Qty', 'Rate', 'Amount'],
    rawCells: [cell(0, 'Grand Total'), cell(1, ''), cell(2, ''), cell(3, ''), cell(4, amount)],
    rawText: `Grand Total | ${amount}`,
    classification: 'total',
    confidence: 0.99,
    warnings: [],
  }
}

function pricedItem(input: {
  id: string
  desc: string
  unit: string
  qty: number
  rate: number
  total: number
  sourceRowId?: string
}): BoqPricedItem {
  return {
    id: input.id,
    desc: input.desc,
    unit: input.unit,
    qty: input.qty,
    rate: input.rate,
    total: input.total,
    type: 'unit',
    costComponent: 'combined',
    stdStatus: 'unmatched',
    entryOrigin: 'docling',
    ...(input.sourceRowId ? { sourceRowId: input.sourceRowId } : {}),
  }
}

function minimalRun(sourceRows: readonly BoqSourceRowV3[], sourceTotal = 3000): BoqExtractionRun {
  return {
    id: 'run-1',
    boqId: 'boq-1',
    contractVersion: 3,
    status: 'ready',
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z',
    stagingExpiresAt: null,
    sourceFile: {
      path: 'boqs/boq-1/source.pdf',
      name: 'synthetic.pdf',
      digest: 'sha256:source',
    },
    parser: {
      name: 'docling',
      contractVersion: 3,
      configFingerprint: 'sha256:parser',
    },
    metadataCandidates: {
      vendor: { value: 'Vendor', confidence: 1, source: 'fixture' },
      project: { value: 'Project', confidence: 1, source: 'fixture' },
      date: { value: '2026-08-08', confidence: 1, source: 'fixture' },
      workType: { value: 'MEP', confidence: 1, source: 'fixture' },
    },
    metadataConfidence: { vendor: 1, project: 1, date: 1, workType: 1 },
    sourceRowCount: sourceRows.length,
    sourceRowChecksum: 'sha256:rows',
    reconciliation: {
      itemTotal: sourceTotal,
      sourceTotal,
      reconciled: true,
      difference: 0,
    },
    warnings: [],
    sections: [{ header: 'Works', items: [] }],
    totalItems: 0,
    aiReviewStatus: 'completed',
    reviewTargeting: {
      candidateRowIds: [],
      candidateCount: 0,
      unreconciled: false,
    },
  }
}

function boq(items: BoqPricedItem[] = [], status: Boq['status'] = 'review'): Boq {
  return {
    id: 'boq-1',
    project: 'Project',
    vendor: 'Vendor',
    workType: 'MEP',
    date: '2026-08-08',
    totalItems: items.length,
    grandTotal: items.reduce((sum, item) => sum + item.total, 0),
    status,
    stdStatus: 'none',
    sections: [{ header: 'Works', items }],
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z',
    sourceTotal: 3000,
  }
}

function settings(overrides: Partial<ActionableReviewSettings> = {}): ActionableReviewSettings {
  return {
    stage: 'shadow',
    lowCostModel: 'gpt-4o-mini',
    escalationModel: 'gpt-4o',
    maxRows: 100,
    maxPromptTokens: 8_000,
    maxEstimatedCostMinor: 500,
    escalationEnabled: true,
    ...overrides,
  }
}

function memoryCache(
  initial: Record<string, ApprovedCatalogMapping> = {},
): CatalogMappingCache & { gets: string[]; puts: string[] } {
  const store = new Map(Object.entries(initial))
  const gets: string[] = []
  const puts: string[] = []
  return {
    gets,
    puts,
    async get(key) {
      gets.push(key)
      return store.get(key) ?? null
    },
    async put(key) {
      puts.push(key)
      throw new Error('projection must not human-approve via cache.put')
    },
    async remove() {
      throw new Error('projection must not remove cache entries')
    },
  }
}

function proposal(input: {
  id: string
  sourceRowIds: string[]
}): ValidatedProposal {
  return {
    id: input.id,
    operation: 'create',
    confidence: 0.8,
    explanation: 'fixture proposal',
    sourceRowIds: input.sourceRowIds,
    sourceRefs: input.sourceRowIds.map((sourceRowId, index) => ({
      sourceRowId,
      page: 1,
      table: 0,
      row: index + 1,
    })),
    proposedItems: [
      {
        desc: 'ignored',
        unit: 'm3',
        qty: 1,
        rate: 1,
        total: 1,
        type: 'unit',
        costComponent: 'combined',
        pricingRole: 'standard',
      },
    ],
    sourceEvidence: Object.fromEntries(
      input.sourceRowIds.map((id) => [id, { quotedTotal: 1 }]),
    ),
    validated: true,
  } as unknown as ValidatedProposal
}

const CATALOG = [
  {
    id: 'std-concrete',
    description: 'Ready mix concrete C25',
    unit: 'm3',
    aliases: ['concrete c25'],
  },
  {
    id: 'std-rebar',
    description: 'High yield rebar',
    unit: 'kg',
    aliases: ['rebar'],
  },
]

function baseRows(): BoqSourceRowV3[] {
  return [
    headerRow('row-h', 0),
    sourceRow({
      id: 'row-1',
      row: 1,
      desc: 'Ready mix concrete C25',
      unit: 'm3',
      qty: '10',
      rate: '100',
      amount: '1000',
    }),
    sourceRow({
      id: 'row-2',
      row: 2,
      desc: 'High yield rebar',
      unit: 'kg',
      qty: '50',
      rate: '20',
      amount: '1000',
    }),
    sourceRow({
      id: 'row-3',
      row: 3,
      desc: 'Formwork to sides of beams',
      unit: 'm2',
      qty: '20',
      rate: '50',
      amount: '1000',
    }),
    noteRow('row-note', 4),
    totalRow('row-total', 5, '3000'),
  ]
}

function baseInput(
  overrides: Partial<GenerateActionableReviewInput> = {},
): GenerateActionableReviewInput {
  const sourceRows = overrides.sourceRows ?? baseRows()
  return {
    extractionRunId: 'run-1',
    run: overrides.run ?? minimalRun(sourceRows),
    sourceRows,
    boq: overrides.boq ?? boq(),
    proposals: overrides.proposals ?? [],
    audits: overrides.audits ?? ([] as ExtractionProposalAudit[]),
    catalog: overrides.catalog ?? CATALOG,
    conversionRules: overrides.conversionRules ?? ([] as HumanApprovedCatalogConversionRule[]),
    unitMap: overrides.unitMap ?? UNIT_MAP,
    settings: overrides.settings ?? settings(),
    workspaceScope: overrides.workspaceScope ?? 'ws-1',
    promptVersion: overrides.promptVersion ?? ACTIONABLE_REVIEW_PROMPT_VERSION,
    modelVersion: overrides.modelVersion ?? 'gpt-4o-mini',
    cache: overrides.cache ?? memoryCache(),
    callProvider: overrides.callProvider ?? (async () => {
      throw new Error('provider should not be required for deterministic path')
    }),
    estimateCostMinor: overrides.estimateCostMinor ?? (() => 0),
    now: overrides.now ?? (() => '2026-08-08T12:00:00.000Z'),
    currencyScale: overrides.currencyScale ?? 2,
    mode: overrides.mode ?? 'shadow',
    ...overrides,
  }
}

test('identical source rows project identically for multi-row vs single-row proposals', async () => {
  const sourceRows = baseRows()
  const multiProposals = [proposal({ id: 'p-multi', sourceRowIds: ['row-1', 'row-2', 'row-3'] })]
  const singleProposals = [
    proposal({ id: 'p-1', sourceRowIds: ['row-1'] }),
    proposal({ id: 'p-2', sourceRowIds: ['row-2'] }),
    proposal({ id: 'p-3', sourceRowIds: ['row-3'] }),
  ]

  const provider: ActionableReviewProviderCall = async () => ({
    advice: [
      {
        sourceRowId: 'row-3',
        decision: 'uncertain',
        confidence: 0.4,
        reason: 'ambiguous formwork',
      },
    ],
  })

  const left = await generateActionableReview(baseInput({
    sourceRows,
    proposals: multiProposals,
    callProvider: provider,
    estimateCostMinor: () => 10,
  }))
  const right = await generateActionableReview(baseInput({
    sourceRows,
    proposals: singleProposals,
    callProvider: provider,
    estimateCostMinor: () => 10,
  }))

  assert.deepEqual(
    left.review.actionableItemSuggestions.map((item) => ({
      sourceRowIds: item.sourceRowIds,
      rowRole: item.rowRole,
      extractedItem: item.extractedItem,
      catalogCandidates: item.catalogCandidates,
      deterministicReasons: item.deterministicReasons,
      status: item.status,
      versions: item.versions,
    })),
    right.review.actionableItemSuggestions.map((item) => ({
      sourceRowIds: item.sourceRowIds,
      rowRole: item.rowRole,
      extractedItem: item.extractedItem,
      catalogCandidates: item.catalogCandidates,
      deterministicReasons: item.deterministicReasons,
      status: item.status,
      versions: item.versions,
    })),
  )
  assert.deepEqual(
    left.review.dismissedEvidence.map((item) => ({
      sourceRowId: item.sourceRowId,
      role: item.role,
      sourceRef: item.sourceRef,
    })),
    right.review.dismissedEvidence.map((item) => ({
      sourceRowId: item.sourceRowId,
      role: item.role,
      sourceRef: item.sourceRef,
    })),
  )
  assert.deepEqual(left.review.representedRows, right.review.representedRows)
  assert.equal(left.review.versions.extractionFingerprint, right.review.versions.extractionFingerprint)
  assert.equal(
    buildActionableReviewFingerprint(left.review),
    buildActionableReviewFingerprint(right.review),
  )
  assert.equal(left.review.id, right.review.id)
})

test('processes at most 100 rows and preserves source refs, cell mapping, and order', async () => {
  const many: BoqSourceRowV3[] = [headerRow('h', 0)]
  for (let index = 1; index <= 120; index += 1) {
    many.push(sourceRow({
      id: `row-${index}`,
      row: index,
      desc: `Item ${index} unique description`,
      unit: 'pcs',
      qty: '1',
      rate: '5',
      amount: '5',
    }))
  }

  const result = await generateActionableReview(baseInput({
    sourceRows: many,
    run: minimalRun(many, 600),
    settings: settings({ maxRows: 100, maxEstimatedCostMinor: 0 }),
    callProvider: async () => {
      throw new Error('budget zero should not call provider')
    },
  }))

  assert.equal(result.review.validationSummary.rawRowCount, 100)
  assert.ok(result.review.actionableItemSuggestions.length <= 100)
  const ids = result.review.actionableItemSuggestions.flatMap((item) => item.sourceRowIds)
  assert.ok(!ids.includes('row-120'))
  for (const suggestion of result.review.actionableItemSuggestions) {
    assert.ok(suggestion.sourceRefs.length === suggestion.sourceRowIds.length)
    assert.ok(suggestion.sourceRefs.every((ref) => Number.isInteger(ref.page)))
    if (suggestion.sourceCellMapping) {
      assert.deepEqual(suggestion.sourceCellMapping.sourceRowIds, suggestion.sourceRowIds)
    }
  }
  const ordered = result.review.actionableItemSuggestions.map((item) => item.sourceRowIds[0]!)
  const sorted = [...ordered].sort((left, right) => {
    const leftN = Number(left.replace('row-', ''))
    const rightN = Number(right.replace('row-', ''))
    return leftN - rightN
  })
  assert.deepEqual(ordered, sorted)
})

test('excludes represented rows and retains non-item evidence; only priced/uncertain become suggestions', async () => {
  const sourceRows = baseRows()
  const existing = boq([
    pricedItem({
      id: 'item-1',
      desc: 'Ready mix concrete C25',
      unit: 'm3',
      qty: 10,
      rate: 100,
      total: 1000,
      sourceRowId: 'row-1',
    }),
  ])

  const result = await generateActionableReview(baseInput({
    sourceRows,
    boq: existing,
    settings: settings({ maxEstimatedCostMinor: 0 }),
    callProvider: async () => ({ advice: [] }),
  }))

  const actionableIds = result.review.actionableItemSuggestions.flatMap((item) => item.sourceRowIds)
  assert.ok(!actionableIds.includes('row-1'))
  assert.ok(actionableIds.includes('row-2') || actionableIds.includes('row-3'))
  assert.ok(result.review.representedRows.some((entry) => entry.sourceRowIds.includes('row-1')))
  const dismissedRoles = new Set(result.review.dismissedEvidence.map((entry) => entry.role))
  assert.ok(dismissedRoles.has('note') || dismissedRoles.has('column_header') || dismissedRoles.has('total'))
  assert.ok(result.review.dismissedEvidence.every((entry) => entry.role !== 'priced_item'))
  assert.equal(result.review.mode, 'shadow')
})

test('uses exact decimal source total reconciliation and stable versioned fingerprints', async () => {
  const sourceRows = baseRows()
  const result = await generateActionableReview(baseInput({
    sourceRows,
    settings: settings({ maxEstimatedCostMinor: 0 }),
    callProvider: async () => ({ advice: [] }),
  }))

  assert.equal(typeof result.review.validationSummary.sourceTotalDifference, 'string')
  assert.match(result.review.validationSummary.sourceTotalDifference!, /^-?\d+(?:\.\d+)?$/)
  assert.ok(result.review.versions.extractionFingerprint.startsWith('sha256:'))
  assert.ok(result.review.versions.catalogFingerprint.startsWith('sha256:'))
  assert.ok(result.review.versions.conversionFingerprint.startsWith('sha256:'))
  assert.equal(result.review.versions.promptVersion, ACTIONABLE_REVIEW_PROMPT_VERSION)
  assert.equal(result.review.versions.modelVersion, 'gpt-4o-mini')
  assert.ok(result.review.id.startsWith('sha256:'))
  assert.ok(result.review.actionableItemSuggestions.every((item) => item.id.startsWith('sha256:')))
})

test('precomputes Task 6 hashed cache keys and revalidates without human approval', async () => {
  const sourceRows = [
    headerRow('h', 0),
    sourceRow({
      id: 'row-1',
      row: 1,
      desc: 'Ready mix concrete C25',
      unit: 'm3',
      qty: '10',
      rate: '100',
      amount: '1000',
    }),
  ]
  // Cache key embeds scoped signature (unitMap + workspaceScope); mapping signature does not.
  const scopedSignature = buildScopedSourceSignature({
    description: 'Ready mix concrete C25',
    unit: 'm3',
    unitMap: UNIT_MAP,
    workspaceScope: 'ws-1',
  })
  const plainSignature = buildSourceSignature({
    description: 'Ready mix concrete C25',
    unit: 'm3',
  })
  assert.notEqual(scopedSignature, plainSignature)
  // Will be aligned by generateActionableReview to active fingerprints.
  const cache = memoryCache()
  let capturedKey: string | undefined
  const originalGet = cache.get.bind(cache)
  cache.get = async (key: string) => {
    capturedKey = key
    return originalGet(key)
  }

  const result = await generateActionableReview(baseInput({
    sourceRows,
    run: minimalRun(sourceRows, 1000),
    cache,
    settings: settings({ maxEstimatedCostMinor: 0 }),
    callProvider: async () => ({ advice: [] }),
  }))

  assert.ok(capturedKey === undefined || capturedKey.startsWith('sha256:'))
  const rowKey = result.cacheKeysBySourceRowId['row-1']
  assert.ok(typeof rowKey === 'string' && rowKey.startsWith('sha256:'))
  assert.equal(cache.puts.length, 0)
  assert.equal(
    rowKey,
    buildCatalogMappingCacheKey({
      sourceSignature: scopedSignature,
      workspaceScope: 'ws-1',
      catalogFingerprint: result.review.versions.catalogFingerprint,
      conversionFingerprint: result.review.versions.conversionFingerprint,
      promptVersion: ACTIONABLE_REVIEW_PROMPT_VERSION,
      modelVersion: 'gpt-4o-mini',
    }),
  )
})

test('seeded scoped cache mapping hits with unitMap + multiple candidates and zero provider calls', async () => {
  const description = 'Structural concrete package ambiguous'
  const unit = 'cu m'
  const sourceRows = [
    headerRow('h', 0),
    sourceRow({
      id: 'row-1',
      row: 1,
      desc: description,
      unit,
      qty: '10',
      rate: '100',
      amount: '1000',
    }),
  ]
  const plainSignature = buildSourceSignature({ description, unit })
  const catalog = [
    {
      id: 'std-a',
      description: 'Structural concrete package A',
      unit: 'm3',
      aliases: ['structural concrete package'],
    },
    {
      id: 'std-b',
      description: 'Structural concrete package B',
      unit: 'm3',
      aliases: ['structural concrete package'],
    },
    {
      id: 'std-c',
      description: 'Structural concrete package C',
      unit: 'm3',
      aliases: ['structural concrete package'],
    },
  ]
  const versionsInput = baseInput({
    sourceRows,
    run: minimalRun(sourceRows, 1000),
    catalog,
    settings: settings({ maxEstimatedCostMinor: 0 }),
    callProvider: async () => ({ advice: [] }),
  })
  // Probe fingerprints once so we can seed the exact Task 6 hashed key.
  const probe = await generateActionableReview(versionsInput)
  const scopedSignature = buildScopedSourceSignature({
    description,
    unit,
    unitMap: UNIT_MAP,
    workspaceScope: 'ws-1',
  })
  const cacheKey = buildCatalogMappingCacheKey({
    sourceSignature: scopedSignature,
    workspaceScope: 'ws-1',
    catalogFingerprint: probe.review.versions.catalogFingerprint,
    conversionFingerprint: probe.review.versions.conversionFingerprint,
    promptVersion: ACTIONABLE_REVIEW_PROMPT_VERSION,
    modelVersion: 'gpt-4o-mini',
  })
  const seededMapping: ApprovedCatalogMapping = {
    sourceSignature: plainSignature,
    catalogId: 'std-b',
    approvedBy: 'model:prior',
    approvedAt: '2026-08-01T00:00:00.000Z',
  }
  const cache = memoryCache({ [cacheKey]: seededMapping })
  let providerCalls = 0

  const result = await generateActionableReview(baseInput({
    sourceRows,
    run: minimalRun(sourceRows, 1000),
    catalog,
    cache,
    workspaceScope: 'ws-1',
    unitMap: UNIT_MAP,
    settings: settings({ maxEstimatedCostMinor: 500 }),
    estimateCostMinor: () => 10,
    callProvider: async () => {
      providerCalls += 1
      throw new Error('provider must not run on validated cache hit')
    },
  }))

  assert.equal(providerCalls, 0)
  assert.ok(result.aiBatch.cacheHitCount >= 1)
  assert.equal(result.aiBatch.initialCallCount, 0)
  const suggestion = result.review.actionableItemSuggestions.find(
    (item) => item.sourceRowIds.includes('row-1'),
  )
  assert.ok(suggestion)
  assert.equal(suggestion.aiAdvice?.decision, 'match')
  assert.equal(suggestion.aiAdvice?.catalogId, 'std-b')
  // Multiple candidates remain on the shortlist; cache hit still wins.
  assert.ok(suggestion.catalogCandidates.length >= 2)
})

test('identity normalization aliases cu m to m3 while extracted snapshot keeps raw unit', async () => {
  const sourceRows = [
    headerRow('h', 0),
    sourceRow({
      id: 'row-1',
      row: 1,
      desc: 'Ready mix concrete C25',
      unit: 'cu m',
      qty: '10',
      rate: '100',
      amount: '1000',
    }),
  ]
  const result = await generateActionableReview(baseInput({
    sourceRows,
    run: minimalRun(sourceRows, 1000),
    unitMap: UNIT_MAP,
    catalog: [
      {
        id: 'std-concrete',
        description: 'Ready mix concrete C25',
        unit: 'm3',
        aliases: ['concrete c25'],
      },
    ],
    settings: settings({ maxEstimatedCostMinor: 0 }),
    callProvider: async () => ({ advice: [] }),
  }))

  const suggestion = result.review.actionableItemSuggestions.find(
    (item) => item.sourceRowIds.includes('row-1'),
  )
  assert.ok(suggestion)
  assert.equal(suggestion.extractedItem.unit, 'cu m')
  assert.ok(suggestion.normalization, 'identity normalization must succeed for alias units')
  assert.equal(suggestion.normalization?.ruleId, 'identity:m3:v1')
  assert.equal(suggestion.normalization?.catalogUnit, 'm3')
  assert.equal(suggestion.normalization?.catalogUnitsPerSourceUnit, '1')
  assert.equal(suggestion.normalization?.normalizedQuantity, '10')
  assert.equal(suggestion.normalization?.normalizedTotal, '1000')
})

test('provider failure and budget zero still produce deterministic local shadow fallback', async () => {
  const failing: ActionableReviewProviderCall = async () => {
    throw new Error('provider down')
  }
  const zeroBudget = await generateActionableReview(baseInput({
    settings: settings({ maxEstimatedCostMinor: 0 }),
    callProvider: failing,
  }))
  assert.ok(zeroBudget.review.actionableItemSuggestions.length > 0)
  assert.equal(zeroBudget.aiBatch.initialCallCount, 0)
  assert.equal(zeroBudget.aiBatch.estimatedCostMinor, 0)

  const failed = await generateActionableReview(baseInput({
    settings: settings({ maxEstimatedCostMinor: 100 }),
    callProvider: failing,
    estimateCostMinor: () => 10,
  }))
  assert.ok(failed.review.actionableItemSuggestions.length > 0)
  assert.equal(failed.aiBatch.providerUnavailable, true)
  assert.ok(
    failed.review.actionableItemSuggestions.every((item) => {
      const advice = item.aiAdvice as ActionableReviewAiAdvice | undefined
      return advice === undefined || advice.decision === 'uncertain' || advice.decision === 'match'
    }),
  )
})
