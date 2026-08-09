import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import type { RowRole } from './actionable-review-types'
import type { BoqExtractionRun } from './boq-extraction-run'
import type { BoqSourceRowV3 } from './boq-extraction-schema'
import {
  classifySourceRows,
  type RowRoleFinding,
} from './boq-row-role-classifier'

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../test-fixtures/actionable-review/row-role-cases.json',
)

interface FixtureExpectation {
  sourceRowId: string
  role: RowRole
  deterministic: boolean
  sourceRef: { page: number; table: number; row: number }
}

interface FixtureCase {
  id: string
  description: string
  sourceRows: BoqSourceRowV3[]
  expected: FixtureExpectation[]
}

interface FixtureFile {
  cases: FixtureCase[]
}

const DISMISSIBLE_ROLES = new Set<RowRole>([
  'continuation',
  'section_header',
  'column_header',
  'note',
  'subtotal',
  'total',
  'tax',
  'amount_in_words',
  'blank_or_noise',
])

const REQUIRED_CASE_IDS = [
  'column-header-band',
  'repeated-column-header',
  'section-header',
  'continuation-description',
  'note-row',
  'subtotal-row',
  'grand-total-row',
  'vat-tax-row',
  'amount-in-words',
  'blank-noise',
  'clear-priced-item',
  'amount-bearing-ambiguous',
] as const

function loadFixture(): FixtureFile {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as FixtureFile
}

function minimalRun(sourceRows: readonly BoqSourceRowV3[]): BoqExtractionRun {
  return {
    id: 'run-row-role',
    boqId: 'boq-row-role',
    contractVersion: 3,
    status: 'ready',
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z',
    stagingExpiresAt: null,
    sourceFile: {
      path: 'boqs/boq-row-role/source.pdf',
      name: 'synthetic-row-role-cases.pdf',
      digest: 'sha256:synthetic-row-role',
    },
    parser: {
      name: 'docling',
      contractVersion: 3,
      configFingerprint: 'sha256:parser-config',
    },
    metadataCandidates: {
      vendor: { value: 'Synthetic Vendor', confidence: 1, source: 'fixture' },
      project: { value: 'Synthetic Project', confidence: 1, source: 'fixture' },
      date: { value: '2026-08-08', confidence: 1, source: 'fixture' },
      workType: { value: 'MEP', confidence: 1, source: 'fixture' },
    },
    metadataConfidence: {
      vendor: 1,
      project: 1,
      date: 1,
      workType: 1,
    },
    sourceRowCount: sourceRows.length,
    sourceRowChecksum: 'sha256:synthetic-rows',
    reconciliation: {
      itemTotal: 0,
      sourceTotal: null,
      reconciled: true,
      difference: 0,
    },
    warnings: [],
    sections: [],
    totalItems: 0,
    aiReviewStatus: 'not_required',
    reviewTargeting: {
      candidateRowIds: [],
      candidateCount: 0,
      unreconciled: false,
    },
  }
}

function findingById(
  findings: readonly RowRoleFinding[],
  sourceRowId: string,
): RowRoleFinding {
  const found = findings.find((finding) => finding.sourceRowId === sourceRowId)
  assert.ok(found, `missing finding for ${sourceRowId}`)
  return found
}

function assertFindingMatches(
  finding: RowRoleFinding,
  expected: FixtureExpectation,
): void {
  assert.equal(finding.sourceRowId, expected.sourceRowId)
  assert.equal(finding.role, expected.role)
  assert.equal(finding.deterministic, expected.deterministic)
  assert.deepEqual(finding.sourceRef, expected.sourceRef)
  assert.ok(
    Array.isArray(finding.reasonCodes) && finding.reasonCodes.length > 0,
    `expected reason codes for ${expected.sourceRowId}`,
  )
  for (const code of finding.reasonCodes) {
    assert.equal(typeof code, 'string')
    assert.ok(code.trim().length > 0, 'reason codes must be non-empty strings')
  }
  // Findings are evidence-only: no authoritative pricing payload may appear.
  assert.equal(
    Object.prototype.hasOwnProperty.call(finding, 'quantity'),
    false,
  )
  assert.equal(Object.prototype.hasOwnProperty.call(finding, 'rate'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(finding, 'total'), false)
  assert.equal(
    Object.prototype.hasOwnProperty.call(finding, 'materialRate'),
    false,
  )
  assert.equal(
    Object.prototype.hasOwnProperty.call(finding, 'labourRate'),
    false,
  )
}

test('fixture covers every required structural and uncertain case family', () => {
  const fixture = loadFixture()
  const ids = new Set(fixture.cases.map((entry) => entry.id))
  for (const required of REQUIRED_CASE_IDS) {
    assert.ok(ids.has(required), `missing fixture case ${required}`)
  }
})

test('classifySourceRows assigns deterministic roles from sanitized fixtures', () => {
  const fixture = loadFixture()

  for (const fixtureCase of fixture.cases) {
    const findings = classifySourceRows({
      run: minimalRun(fixtureCase.sourceRows),
      sourceRows: fixtureCase.sourceRows,
    })

    assert.equal(
      findings.length,
      fixtureCase.sourceRows.length,
      `${fixtureCase.id}: one finding per source row`,
    )
    assert.deepEqual(
      findings.map((finding) => finding.sourceRowId),
      fixtureCase.sourceRows.map((row) => row.id),
      `${fixtureCase.id}: findings preserve source row order`,
    )

    for (const expected of fixtureCase.expected) {
      assertFindingMatches(findingById(findings, expected.sourceRowId), expected)
    }
  }
})

test('obvious non-items are deterministic while amount-bearing ambiguity stays uncertain', () => {
  const fixture = loadFixture()
  const byId = new Map(fixture.cases.map((entry) => [entry.id, entry]))

  const structuralIds = [
    'column-header-band',
    'section-header',
    'continuation-description',
    'note-row',
    'subtotal-row',
    'grand-total-row',
    'vat-tax-row',
    'amount-in-words',
    'blank-noise',
  ] as const

  for (const caseId of structuralIds) {
    const fixtureCase = byId.get(caseId)
    assert.ok(fixtureCase, caseId)
    const findings = classifySourceRows({
      run: minimalRun(fixtureCase.sourceRows),
      sourceRows: fixtureCase.sourceRows,
    })
    for (const expected of fixtureCase.expected) {
      if (expected.role === 'priced_item') continue
      const finding = findingById(findings, expected.sourceRowId)
      assert.equal(finding.deterministic, true, `${caseId}/${expected.sourceRowId}`)
      assert.ok(
        DISMISSIBLE_ROLES.has(finding.role),
        `${caseId}/${expected.sourceRowId} should be a structural non-item role, got ${finding.role}`,
      )
    }
  }

  const ambiguous = byId.get('amount-bearing-ambiguous')
  assert.ok(ambiguous)
  const ambiguousFindings = classifySourceRows({
    run: minimalRun(ambiguous.sourceRows),
    sourceRows: ambiguous.sourceRows,
  })
  const ambiguousFinding = findingById(ambiguousFindings, 'sr-ambiguous-amount')
  assert.equal(ambiguousFinding.role, 'uncertain')
  assert.equal(ambiguousFinding.deterministic, true)
  assert.ok(
    ambiguousFinding.reasonCodes.some((code) => /amount|uncertain|unproven|ambiguous/i.test(code)),
    'amount-bearing uncertain rows need an explicit uncertainty reason code',
  )
  assert.ok(
    !DISMISSIBLE_ROLES.has(ambiguousFinding.role),
    'amount-bearing unproven rows must not be dismissed as structural non-items',
  )
})

test('repeated header labels are classified without inventing pricing fields', () => {
  const fixture = loadFixture()
  const repeated = fixture.cases.find((entry) => entry.id === 'repeated-column-header')
  assert.ok(repeated)
  const findings = classifySourceRows({
    run: minimalRun(repeated.sourceRows),
    sourceRows: repeated.sourceRows,
  })
  const headerRepeat = findingById(findings, 'sr-header-repeat')
  assert.equal(headerRepeat.role, 'column_header')
  assert.ok(
    headerRepeat.reasonCodes.some((code) => /header|repeated/i.test(code)),
    'repeated headers should cite header/repeated reason evidence',
  )
  assert.deepEqual(headerRepeat.sourceRef, { page: 1, table: 2, row: 3 })
})

test('subtotal can use nearby arithmetic evidence without persisting amounts', () => {
  const fixture = loadFixture()
  const subtotalCase = fixture.cases.find((entry) => entry.id === 'subtotal-row')
  assert.ok(subtotalCase)
  const findings = classifySourceRows({
    run: minimalRun(subtotalCase.sourceRows),
    sourceRows: subtotalCase.sourceRows,
  })
  const subtotal = findingById(findings, 'sr-subtotal')
  assert.equal(subtotal.role, 'subtotal')
  assert.ok(
    subtotal.reasonCodes.some((code) => /subtotal|arithmetic|total_label|parser_classification_total/i.test(code)),
  )
  assert.equal(
    JSON.stringify(subtotal).includes('1200'),
    false,
    'classifier output must not embed raw amount text as authoritative pricing',
  )
})

test('run-level warnings remain advisory and never create priced snapshots', () => {
  const row: BoqSourceRowV3 = {
    id: 'sr-warn',
    page: 9,
    table: 1,
    row: 1,
    section: null,
    headers: ['Description', 'Amount'],
    rawCells: [
      {
        column: 0,
        rawText: 'Misc line',
        lines: ['Misc line'],
        rowSpan: 1,
        columnSpan: 1,
        startRowOffset: 0,
        endRowOffset: 1,
        startColumnOffset: 0,
        endColumnOffset: 1,
        columnHeader: false,
        rowHeader: false,
        rowSection: false,
        carried: false,
      },
      {
        column: 1,
        rawText: '99.00',
        lines: ['99.00'],
        rowSpan: 1,
        columnSpan: 1,
        startRowOffset: 0,
        endRowOffset: 1,
        startColumnOffset: 1,
        endColumnOffset: 2,
        columnHeader: false,
        rowHeader: false,
        rowSection: false,
        carried: false,
      },
    ],
    rawText: 'Misc line | 99.00',
    classification: 'unknown',
    confidence: 0.4,
    warnings: [],
  }
  const run = minimalRun([row])
  run.warnings = [
    {
      code: 'ambiguous_row',
      message: 'Unclear amount-bearing row',
      sourceRef: { page: 9, table: 1, row: 1 },
    },
  ]

  const [finding] = classifySourceRows({ run, sourceRows: [row] })
  assert.equal(finding.role, 'uncertain')
  assert.ok(finding.reasonCodes.length > 0)
  assert.deepEqual(finding.sourceRef, { page: 9, table: 1, row: 1 })
  assert.equal('extractedItem' in finding, false)
  assert.equal('pricing' in finding, false)
})
