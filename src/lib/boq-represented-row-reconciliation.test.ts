import assert from 'node:assert/strict'
import test from 'node:test'

import type { ExtractionProposalAudit } from './boq-extraction-acceptance'
import type { BoqSourceRowV3 } from './boq-extraction-schema'
import {
  fingerprintCanonicalItem,
  type ValidatedProposal,
} from './boq-extraction-proposals'
import type { Boq, BoqItem, BoqPricedItem, BoqSourceRef } from './boq-schema'
import type { RowRoleFinding } from './boq-row-role-classifier'
import {
  reconcileRepresentedRows,
  type RepresentedRowFinding,
} from './boq-represented-row-reconciliation'

const UNIT_MAP: Record<string, string> = {
  m3: 'm3',
  'cu m': 'm3',
  cum: 'm3',
  pcs: 'pcs',
  pc: 'pcs',
  nos: 'pcs',
}

function cell(
  column: number,
  rawText: string,
  extras: Partial<BoqSourceRowV3['rawCells'][number]> = {},
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
    ...extras,
  }
}

function sourceRow(input: {
  id: string
  row: number
  page?: number
  table?: number
  headers?: string[]
  cells: Array<string | { text: string; column?: number }>
  classification?: BoqSourceRowV3['classification']
  rawText?: string
}): BoqSourceRowV3 {
  const headers = input.headers ?? ['Description', 'Unit', 'Qty', 'Rate', 'Amount']
  const rawCells = input.cells.map((entry, index) => {
    if (typeof entry === 'string') return cell(index, entry)
    return cell(entry.column ?? index, entry.text)
  })
  const rawText = input.rawText
    ?? rawCells.map((entry) => entry.rawText).filter(Boolean).join(' | ')
  return {
    id: input.id,
    page: input.page ?? 1,
    table: input.table ?? 0,
    row: input.row,
    section: 'Works',
    headers,
    rawCells,
    rawText,
    classification: input.classification ?? 'item',
    confidence: 0.95,
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
  code?: string
  sourceRowId?: string
  sourceRowIds?: string[]
  sourceRef?: BoqSourceRef
}): BoqPricedItem {
  return {
    id: input.id,
    ...(input.code ? { code: input.code } : {}),
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
    ...(input.sourceRowIds ? { sourceRowIds: input.sourceRowIds } : {}),
    ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
  }
}

function boqWith(items: BoqItem[]): Boq {
  return {
    id: 'boq-1',
    project: 'Project',
    vendor: 'Vendor',
    workType: 'MEP',
    date: '2026-08-08',
    totalItems: items.length,
    grandTotal: items.reduce((sum, item) => (
      'total' in item && typeof item.total === 'number' ? sum + item.total : sum
    ), 0),
    status: 'review',
    stdStatus: 'none',
    sections: [{ header: 'Works', items }],
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z',
  }
}

function role(
  sourceRowId: string,
  roleName: RowRoleFinding['role'],
  sourceRef: BoqSourceRef,
): RowRoleFinding {
  return {
    sourceRowId,
    role: roleName,
    reasonCodes: [`fixture_${roleName}`],
    deterministic: true,
    sourceRef,
  }
}

function emptyAudit(overrides: Partial<ExtractionProposalAudit> = {}): ExtractionProposalAudit {
  return {
    auditId: 'audit-1',
    proposalId: 'proposal-1',
    extractionRunId: 'run-1',
    status: 'accepted',
    actorId: 'user-1',
    timestamp: '2026-08-08T01:00:00.000Z',
    operation: 'insert_missing_item',
    targetItemIds: [],
    affectedItemFingerprints: {},
    confidence: 1,
    explanation: 'fixture',
    sourceRowIds: [],
    sourceRefs: [],
    proposedItems: [],
    beforeSections: [],
    beforeSectionsFingerprint: 'sha256:before',
    afterSections: [],
    afterSectionsFingerprint: 'sha256:after',
    ...overrides,
  }
}

function refOf(row: BoqSourceRowV3): BoqSourceRef {
  return { page: row.page, table: row.table, row: row.row }
}

function byFirstSourceOrder(
  findings: readonly RepresentedRowFinding[],
  sourceRows: readonly BoqSourceRowV3[],
): string[] {
  const order = new Map(sourceRows.map((row, index) => [row.id, index]))
  return findings.map((finding) => {
    const first = finding.sourceRowIds
      .map((id) => order.get(id) ?? Number.MAX_SAFE_INTEGER)
      .sort((a, b) => a - b)[0]
    return `${first}:${finding.sourceRowIds.join(',')}:${finding.reason}:${finding.boqItemId}`
  })
}

test('source identity outranks later reasons and preserves multi-row provenance', () => {
  const rowA = sourceRow({
    id: 'sr-a',
    row: 1,
    cells: ['C25 concrete', 'm3', '10', '100', '1000'],
  })
  const rowB = sourceRow({
    id: 'sr-b',
    row: 2,
    cells: ['including formwork', '', '', '', ''],
    classification: 'continuation',
  })
  const rowC = sourceRow({
    id: 'sr-c',
    row: 3,
    cells: ['Rebar Y12', 'kg', '50', '20', '1000'],
  })

  const item = pricedItem({
    id: 'item-concrete',
    desc: 'C25 concrete',
    unit: 'm3',
    qty: 10,
    rate: 100,
    total: 1000,
    sourceRowIds: ['sr-a', 'sr-b'],
  })

  // Accepted audit and normalized identity would also map sr-a, but source_identity wins.
  const audit = emptyAudit({
    sourceRowIds: ['sr-a'],
    targetItemIds: ['item-concrete'],
    affectedItemFingerprints: {
      'item-concrete': fingerprintCanonicalItem(item),
    },
    sourceRefs: [{ sourceRowId: 'sr-a', ...refOf(rowA) }],
  })

  const findings = reconcileRepresentedRows({
    boq: boqWith([item]),
    sourceRows: [rowA, rowB, rowC],
    proposals: [],
    audits: [audit],
    roles: [
      role('sr-a', 'priced_item', refOf(rowA)),
      role('sr-b', 'continuation', refOf(rowB)),
      role('sr-c', 'priced_item', refOf(rowC)),
    ],
    unitMap: UNIT_MAP,
  })

  assert.deepEqual(
    findings.map((finding) => ({
      sourceRowIds: finding.sourceRowIds,
      boqItemId: finding.boqItemId,
      reason: finding.reason,
      sourceRefs: finding.sourceRefs,
    })),
    [{
      sourceRowIds: ['sr-a', 'sr-b'],
      boqItemId: 'item-concrete',
      reason: 'source_identity',
      sourceRefs: [refOf(rowA), refOf(rowB)],
    }],
  )
  assert.deepEqual(byFirstSourceOrder(findings, [rowA, rowB, rowC]), [
    '0:sr-a,sr-b:source_identity:item-concrete',
  ])
})

test('accepted audit links rows when BOQ provenance ids were stripped', () => {
  const row = sourceRow({
    id: 'sr-pump',
    row: 4,
    cells: ['Pump package', 'set', '1', '5000', '5000'],
  })
  const item = pricedItem({
    id: 'item-pump',
    desc: 'Pump package',
    unit: 'set',
    qty: 1,
    rate: 5000,
    total: 5000,
    // provenance intentionally absent
  })
  const fingerprint = fingerprintCanonicalItem(item)
  const audit = emptyAudit({
    sourceRowIds: ['sr-pump'],
    targetItemIds: ['item-pump'],
    affectedItemFingerprints: { 'item-pump': fingerprint },
    sourceRefs: [{ sourceRowId: 'sr-pump', ...refOf(row) }],
  })

  const findings = reconcileRepresentedRows({
    boq: boqWith([item]),
    sourceRows: [row],
    proposals: [],
    audits: [audit],
    roles: [role('sr-pump', 'priced_item', refOf(row))],
    unitMap: UNIT_MAP,
  })

  assert.deepEqual(findings, [{
    sourceRowIds: ['sr-pump'],
    boqItemId: 'item-pump',
    reason: 'accepted_audit',
    sourceRefs: [refOf(row)],
  }])
})

test('accepted audit add decisions bind specific rows; ignore decisions stay unrepresented', () => {
  const addRow = sourceRow({
    id: 'sr-add',
    row: 1,
    cells: ['Valve 50mm', 'pcs', '2', '100', '200'],
  })
  const ignoreRow = sourceRow({
    id: 'sr-ignore',
    row: 2,
    cells: ['Note: see drawing', '', '', '', ''],
    classification: 'note',
  })
  const item = pricedItem({
    id: 'item-valve',
    desc: 'Valve 50mm',
    unit: 'pcs',
    qty: 2,
    rate: 100,
    total: 200,
  })
  const audit = emptyAudit({
    sourceRowIds: ['sr-add', 'sr-ignore'],
    targetItemIds: ['item-valve'],
    affectedItemFingerprints: {
      'item-valve': fingerprintCanonicalItem(item),
    },
    sourceRefs: [
      { sourceRowId: 'sr-add', ...refOf(addRow) },
      { sourceRowId: 'sr-ignore', ...refOf(ignoreRow) },
    ],
    sourceRowDecisions: [
      { sourceRowId: 'sr-add', action: 'add', itemId: 'item-valve' },
      { sourceRowId: 'sr-ignore', action: 'ignore', note: 'heading noise' },
    ],
  })

  const findings = reconcileRepresentedRows({
    boq: boqWith([item]),
    sourceRows: [addRow, ignoreRow],
    proposals: [],
    audits: [audit],
    roles: [
      role('sr-add', 'priced_item', refOf(addRow)),
      role('sr-ignore', 'note', refOf(ignoreRow)),
    ],
    unitMap: UNIT_MAP,
  })

  assert.deepEqual(findings, [{
    sourceRowIds: ['sr-add'],
    boqItemId: 'item-valve',
    reason: 'accepted_audit',
    sourceRefs: [refOf(addRow)],
  }])
})

test('stale or missing audit fingerprints never bind as accepted_audit', () => {
  const row = sourceRow({
    id: 'sr-stale',
    row: 1,
    cells: ['Cable tray', 'm', '10', '50', '500'],
  })
  const live = pricedItem({
    id: 'item-tray',
    desc: 'Cable tray',
    unit: 'm',
    qty: 10,
    rate: 50,
    total: 500,
  })
  const drifted = pricedItem({
    id: 'item-tray',
    desc: 'Cable tray',
    unit: 'm',
    qty: 10,
    rate: 55,
    total: 550,
  })

  const staleAudit = emptyAudit({
    sourceRowIds: ['sr-stale'],
    targetItemIds: ['item-tray'],
    affectedItemFingerprints: { 'item-tray': 'sha256:stale-fingerprint' },
    sourceRefs: [{ sourceRowId: 'sr-stale', ...refOf(row) }],
  })
  const missingFingerprintAudit = emptyAudit({
    auditId: 'audit-missing-fp',
    sourceRowIds: ['sr-stale'],
    targetItemIds: ['item-tray'],
    affectedItemFingerprints: {},
    sourceRefs: [{ sourceRowId: 'sr-stale', ...refOf(row) }],
  })
  const blankFingerprintAudit = emptyAudit({
    auditId: 'audit-blank-fp',
    sourceRowIds: ['sr-stale'],
    targetItemIds: ['item-tray'],
    affectedItemFingerprints: { 'item-tray': '   ' },
    sourceRefs: [{ sourceRowId: 'sr-stale', ...refOf(row) }],
  })

  // Stale fingerprint + amount conflict: no audit bind and no normalized fallback.
  assert.deepEqual(reconcileRepresentedRows({
    boq: boqWith([drifted]),
    sourceRows: [row],
    proposals: [],
    audits: [staleAudit],
    roles: [role('sr-stale', 'priced_item', refOf(row))],
    unitMap: UNIT_MAP,
  }), [])

  // Missing/blank fingerprint must not suppress as accepted_audit even when item is live.
  for (const audit of [missingFingerprintAudit, blankFingerprintAudit]) {
    const findings = reconcileRepresentedRows({
      boq: boqWith([live]),
      sourceRows: [row],
      proposals: [],
      audits: [audit],
      roles: [role('sr-stale', 'priced_item', refOf(row))],
      unitMap: UNIT_MAP,
    })
    assert.equal(findings.some((finding) => finding.reason === 'accepted_audit'), false)
    // Independent strict normalized identity may still apply.
    assert.deepEqual(findings, [{
      sourceRowIds: ['sr-stale'],
      boqItemId: 'item-tray',
      reason: 'normalized_identity',
      sourceRefs: [refOf(row)],
    }])
  }

  // Stale fingerprint blocks accepted_audit; independent normalized identity may still win.
  const staleButNormalized = reconcileRepresentedRows({
    boq: boqWith([live]),
    sourceRows: [row],
    proposals: [],
    audits: [staleAudit],
    roles: [role('sr-stale', 'priced_item', refOf(row))],
    unitMap: UNIT_MAP,
  })
  assert.deepEqual(staleButNormalized, [{
    sourceRowIds: ['sr-stale'],
    boqItemId: 'item-tray',
    reason: 'normalized_identity',
    sourceRefs: [refOf(row)],
  }])

  // Sparse row cannot normalize and stays unrepresented when audit fingerprint is stale.
  const sparse = sourceRow({
    id: 'sr-sparse',
    row: 2,
    cells: ['Cable tray only description', '', '', '', ''],
  })
  assert.deepEqual(reconcileRepresentedRows({
    boq: boqWith([live]),
    sourceRows: [sparse],
    proposals: [],
    audits: [emptyAudit({
      auditId: 'audit-sparse',
      sourceRowIds: ['sr-sparse'],
      targetItemIds: ['item-tray'],
      affectedItemFingerprints: { 'item-tray': 'sha256:stale' },
      sourceRefs: [{ sourceRowId: 'sr-sparse', ...refOf(sparse) }],
    })],
    roles: [role('sr-sparse', 'uncertain', refOf(sparse))],
    unitMap: UNIT_MAP,
  }), [])
})

test('strict normalized identity matches canonical units and amounts without source ids', () => {
  const row = sourceRow({
    id: 'sr-norm',
    row: 5,
    cells: ['C25 concrete pour', 'cu m', '12.5', '100', '1250'],
  })
  const item = pricedItem({
    id: 'item-norm',
    desc: 'C25 concrete pour',
    unit: 'm3',
    qty: 12.5,
    rate: 100,
    total: 1250,
  })

  const findings = reconcileRepresentedRows({
    boq: boqWith([item]),
    sourceRows: [row],
    proposals: [],
    audits: [],
    roles: [role('sr-norm', 'priced_item', refOf(row))],
    unitMap: UNIT_MAP,
  })

  assert.deepEqual(findings, [{
    sourceRowIds: ['sr-norm'],
    boqItemId: 'item-norm',
    reason: 'normalized_identity',
    sourceRefs: [refOf(row)],
  }])
})

test('description similarity alone never represents when units or amounts conflict', () => {
  const row = sourceRow({
    id: 'sr-conflict',
    row: 6,
    cells: ['C25 concrete pour', 'm3', '12.5', '100', '1250'],
  })
  const unitConflict = pricedItem({
    id: 'item-unit',
    desc: 'C25 concrete pour',
    unit: 'pcs',
    qty: 12.5,
    rate: 100,
    total: 1250,
  })
  const amountConflict = pricedItem({
    id: 'item-amount',
    desc: 'C25 concrete pour',
    unit: 'm3',
    qty: 12.5,
    rate: 110,
    total: 1375,
  })

  assert.deepEqual(reconcileRepresentedRows({
    boq: boqWith([unitConflict]),
    sourceRows: [row],
    proposals: [],
    audits: [],
    roles: [role('sr-conflict', 'priced_item', refOf(row))],
    unitMap: UNIT_MAP,
  }), [])

  assert.deepEqual(reconcileRepresentedRows({
    boq: boqWith([amountConflict]),
    sourceRows: [row],
    proposals: [],
    audits: [],
    roles: [role('sr-conflict', 'priced_item', refOf(row))],
    unitMap: UNIT_MAP,
  }), [])
})

test('ambiguous normalized identity across multiple BOQ items leaves the row unrepresented', () => {
  const row = sourceRow({
    id: 'sr-ambig',
    row: 7,
    cells: ['G.I. pipe 50mm', 'm', '20', '40', '800'],
  })
  const left = pricedItem({
    id: 'item-left',
    desc: 'G.I. pipe 50mm',
    unit: 'm',
    qty: 20,
    rate: 40,
    total: 800,
  })
  const right = pricedItem({
    id: 'item-right',
    desc: 'G.I. pipe 50mm',
    unit: 'm',
    qty: 20,
    rate: 40,
    total: 800,
  })

  assert.deepEqual(reconcileRepresentedRows({
    boq: boqWith([left, right]),
    sourceRows: [row],
    proposals: [],
    audits: [],
    roles: [role('sr-ambig', 'priced_item', refOf(row))],
    unitMap: UNIT_MAP,
  }), [])
})

test('continuation rows attach to the preceding represented item and keep separate evidence', () => {
  const priced = sourceRow({
    id: 'sr-main',
    row: 10,
    cells: ['Cable ladder', 'm', '5', '200', '1000'],
  })
  const cont = sourceRow({
    id: 'sr-cont',
    row: 11,
    cells: ['including brackets and fixings', '', '', '', ''],
    classification: 'continuation',
  })
  const other = sourceRow({
    id: 'sr-other',
    row: 12,
    cells: ['Trunking', 'm', '3', '100', '300'],
  })
  const item = pricedItem({
    id: 'item-ladder',
    desc: 'Cable ladder',
    unit: 'm',
    qty: 5,
    rate: 200,
    total: 1000,
    sourceRowIds: ['sr-main'],
  })

  const findings = reconcileRepresentedRows({
    boq: boqWith([item]),
    sourceRows: [priced, cont, other],
    proposals: [],
    audits: [],
    roles: [
      role('sr-main', 'priced_item', refOf(priced)),
      role('sr-cont', 'continuation', refOf(cont)),
      role('sr-other', 'priced_item', refOf(other)),
    ],
    unitMap: UNIT_MAP,
  })

  assert.deepEqual(
    findings.map((finding) => ({
      sourceRowIds: finding.sourceRowIds,
      boqItemId: finding.boqItemId,
      reason: finding.reason,
    })),
    [
      {
        sourceRowIds: ['sr-main'],
        boqItemId: 'item-ladder',
        reason: 'source_identity',
      },
      {
        sourceRowIds: ['sr-cont'],
        boqItemId: 'item-ladder',
        reason: 'continuation',
      },
    ],
  )
  assert.deepEqual(findings[1]?.sourceRefs, [refOf(cont)])
})

test('each source row is represented at most once and conflicts stay actionable', () => {
  const row = sourceRow({
    id: 'sr-once',
    row: 1,
    cells: ['Panel board', 'set', '1', '9000', '9000'],
  })
  const viaSource = pricedItem({
    id: 'item-a',
    desc: 'Panel board',
    unit: 'set',
    qty: 1,
    rate: 9000,
    total: 9000,
    sourceRowIds: ['sr-once'],
  })
  const viaOther = pricedItem({
    id: 'item-b',
    desc: 'Panel board',
    unit: 'set',
    qty: 1,
    rate: 9000,
    total: 9000,
    sourceRowIds: ['sr-once'],
  })

  // Two BOQ items claim the same source identity → conflict, leave unrepresented.
  assert.deepEqual(reconcileRepresentedRows({
    boq: boqWith([viaSource, viaOther]),
    sourceRows: [row],
    proposals: [],
    audits: [],
    roles: [role('sr-once', 'priced_item', refOf(row))],
    unitMap: UNIT_MAP,
  }), [])
})

test('findings follow source-row order across mixed reasons', () => {
  const rowNorm = sourceRow({
    id: 'sr-order-norm',
    row: 1,
    cells: ['Earthing rod', 'pcs', '4', '250', '1000'],
  })
  const rowSource = sourceRow({
    id: 'sr-order-source',
    row: 2,
    cells: ['Lightning tape', 'm', '30', '20', '600'],
  })
  const rowCont = sourceRow({
    id: 'sr-order-cont',
    row: 3,
    cells: ['complete with clamps', '', '', '', ''],
    classification: 'continuation',
  })
  const rowAudit = sourceRow({
    id: 'sr-order-audit',
    row: 4,
    cells: ['Surge protector', 'pcs', '2', '400', '800'],
  })

  const itemNorm = pricedItem({
    id: 'item-norm',
    desc: 'Earthing rod',
    unit: 'pcs',
    qty: 4,
    rate: 250,
    total: 1000,
  })
  const itemSource = pricedItem({
    id: 'item-source',
    desc: 'Lightning tape',
    unit: 'm',
    qty: 30,
    rate: 20,
    total: 600,
    sourceRowIds: ['sr-order-source'],
  })
  const itemAudit = pricedItem({
    id: 'item-audit',
    desc: 'Surge protector',
    unit: 'pcs',
    qty: 2,
    rate: 400,
    total: 800,
  })
  const audit = emptyAudit({
    sourceRowIds: ['sr-order-audit'],
    targetItemIds: ['item-audit'],
    affectedItemFingerprints: {
      'item-audit': fingerprintCanonicalItem(itemAudit),
    },
    sourceRefs: [{ sourceRowId: 'sr-order-audit', ...refOf(rowAudit) }],
  })

  const sourceRows = [rowNorm, rowSource, rowCont, rowAudit]
  const findings = reconcileRepresentedRows({
    boq: boqWith([itemNorm, itemSource, itemAudit]),
    sourceRows,
    proposals: [] as ValidatedProposal[],
    audits: [audit],
    roles: [
      role('sr-order-norm', 'priced_item', refOf(rowNorm)),
      role('sr-order-source', 'priced_item', refOf(rowSource)),
      role('sr-order-cont', 'continuation', refOf(rowCont)),
      role('sr-order-audit', 'priced_item', refOf(rowAudit)),
    ],
    unitMap: UNIT_MAP,
  })

  assert.deepEqual(
    findings.map((finding) => finding.sourceRowIds[0]),
    ['sr-order-norm', 'sr-order-source', 'sr-order-cont', 'sr-order-audit'],
  )
  assert.deepEqual(
    findings.map((finding) => finding.reason),
    ['normalized_identity', 'source_identity', 'continuation', 'accepted_audit'],
  )
})

test('validated proposals never authorize representation without provenance, audit, or strict normalized evidence', () => {
  // Sparse source row has no extractable identity. Proposal/model payload looks like a
  // perfect match for a live BOQ item, but must never create representation on its own.
  const sparseRow = sourceRow({
    id: 'sr-proposal',
    row: 1,
    cells: ['see vendor schedule', '', '', '', ''],
    classification: 'unknown',
  })
  const item = pricedItem({
    id: 'item-damper',
    desc: 'Fire damper',
    unit: 'pcs',
    qty: 3,
    rate: 700,
    total: 2100,
    // no sourceRowIds — no source identity
  })
  const proposal = {
    id: 'p-1',
    extractionRunId: 'run-1',
    operation: 'insert_missing_item',
    sourceRowIds: ['sr-proposal'],
    targetItemIds: ['item-damper'],
    affectedItemFingerprints: {
      'item-damper': fingerprintCanonicalItem(item),
    },
    confidence: 0.99,
    explanation: 'model says already represented',
    proposedItems: [{
      id: 'item-damper',
      desc: 'Fire damper',
      pricingRole: 'standard' as const,
      parentBundleId: null,
      sourceRowIds: ['sr-proposal'],
      unit: 'pcs',
      qty: 3,
      rate: 700,
      total: 2100,
      costComponent: 'combined' as const,
      optional: false,
      excludedFromTotal: false,
      entryOrigin: 'ai_accepted' as const,
    }],
    evidenceValid: true as const,
    reconciled: true as const,
    stale: false,
  } satisfies ValidatedProposal

  assert.deepEqual(reconcileRepresentedRows({
    boq: boqWith([item]),
    sourceRows: [sparseRow],
    proposals: [proposal],
    audits: [],
    roles: [role('sr-proposal', 'uncertain', refOf(sparseRow))],
    unitMap: UNIT_MAP,
  }), [])
})

test('duplicate source rows cannot both consume one BOQ item via normalized_identity', () => {
  const rowA = sourceRow({
    id: 'sr-dup-a',
    row: 1,
    cells: ['G.I. pipe 50mm', 'm', '20', '40', '800'],
  })
  const rowB = sourceRow({
    id: 'sr-dup-b',
    row: 2,
    cells: ['G.I. pipe 50mm', 'm', '20', '40', '800'],
  })
  const item = pricedItem({
    id: 'item-pipe',
    desc: 'G.I. pipe 50mm',
    unit: 'm',
    qty: 20,
    rate: 40,
    total: 800,
  })

  const findings = reconcileRepresentedRows({
    boq: boqWith([item]),
    sourceRows: [rowA, rowB],
    proposals: [],
    audits: [],
    roles: [
      role('sr-dup-a', 'priced_item', refOf(rowA)),
      role('sr-dup-b', 'priced_item', refOf(rowB)),
    ],
    unitMap: UNIT_MAP,
  })

  // Pure normalized duplicates are ambiguous — neither unsafe extra row is hidden.
  assert.deepEqual(findings, [])
})

test('normalized_identity cannot re-bind an item already claimed by source_identity', () => {
  const bound = sourceRow({
    id: 'sr-bound-source',
    row: 1,
    cells: ['Ductwork galvanized', 'm', '15', '120', '1800'],
  })
  const twin = sourceRow({
    id: 'sr-twin-source',
    row: 2,
    cells: ['Ductwork galvanized', 'm', '15', '120', '1800'],
  })
  const item = pricedItem({
    id: 'item-duct',
    desc: 'Ductwork galvanized',
    unit: 'm',
    qty: 15,
    rate: 120,
    total: 1800,
    sourceRowIds: ['sr-bound-source'],
  })

  const findings = reconcileRepresentedRows({
    boq: boqWith([item]),
    sourceRows: [bound, twin],
    proposals: [],
    audits: [],
    roles: [
      role('sr-bound-source', 'priced_item', refOf(bound)),
      role('sr-twin-source', 'priced_item', refOf(twin)),
    ],
    unitMap: UNIT_MAP,
  })

  assert.deepEqual(
    findings.map((finding) => ({
      sourceRowIds: finding.sourceRowIds,
      boqItemId: finding.boqItemId,
      reason: finding.reason,
    })),
    [{
      sourceRowIds: ['sr-bound-source'],
      boqItemId: 'item-duct',
      reason: 'source_identity',
    }],
  )
  assert.equal(
    findings.some((finding) => finding.sourceRowIds.includes('sr-twin-source')),
    false,
  )
})

test('normalized_identity cannot re-bind an item already claimed by accepted_audit', () => {
  const bound = sourceRow({
    id: 'sr-bound-audit',
    row: 1,
    cells: ['Fire sleeve', 'pcs', '8', '45', '360'],
  })
  const twin = sourceRow({
    id: 'sr-twin-audit',
    row: 2,
    cells: ['Fire sleeve', 'pcs', '8', '45', '360'],
  })
  const item = pricedItem({
    id: 'item-sleeve',
    desc: 'Fire sleeve',
    unit: 'pcs',
    qty: 8,
    rate: 45,
    total: 360,
    // provenance stripped — only audit binds row A
  })
  const audit = emptyAudit({
    sourceRowIds: ['sr-bound-audit'],
    targetItemIds: ['item-sleeve'],
    affectedItemFingerprints: {
      'item-sleeve': fingerprintCanonicalItem(item),
    },
    sourceRefs: [{ sourceRowId: 'sr-bound-audit', ...refOf(bound) }],
  })

  const findings = reconcileRepresentedRows({
    boq: boqWith([item]),
    sourceRows: [bound, twin],
    proposals: [],
    audits: [audit],
    roles: [
      role('sr-bound-audit', 'priced_item', refOf(bound)),
      role('sr-twin-audit', 'priced_item', refOf(twin)),
    ],
    unitMap: UNIT_MAP,
  })

  assert.deepEqual(
    findings.map((finding) => ({
      sourceRowIds: finding.sourceRowIds,
      boqItemId: finding.boqItemId,
      reason: finding.reason,
    })),
    [{
      sourceRowIds: ['sr-bound-audit'],
      boqItemId: 'item-sleeve',
      reason: 'accepted_audit',
    }],
  )
  assert.equal(
    findings.some((finding) => finding.sourceRowIds.includes('sr-twin-audit')),
    false,
  )
})

test('rejected and skipped audits never represent rows', () => {
  const row = sourceRow({
    id: 'sr-reject',
    row: 1,
    cells: ['Junction box', 'pcs', '5', '80', '400'],
  })
  // Drift amounts so normalized identity cannot salvage a non-accepted audit.
  const item = pricedItem({
    id: 'item-box',
    desc: 'Junction box',
    unit: 'pcs',
    qty: 5,
    rate: 90,
    total: 450,
  })
  const fingerprint = fingerprintCanonicalItem(item)

  for (const status of ['rejected', 'skipped'] as const) {
    const findings = reconcileRepresentedRows({
      boq: boqWith([item]),
      sourceRows: [row],
      proposals: [],
      audits: [emptyAudit({
        auditId: `audit-${status}`,
        status,
        sourceRowIds: ['sr-reject'],
        targetItemIds: ['item-box'],
        affectedItemFingerprints: { 'item-box': fingerprint },
        sourceRefs: [{ sourceRowId: 'sr-reject', ...refOf(row) }],
      })],
      roles: [role('sr-reject', 'priced_item', refOf(row))],
      unitMap: UNIT_MAP,
    })
    assert.deepEqual(findings, [], `status=${status} must not represent`)
  }
})
