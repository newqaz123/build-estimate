import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDoclingResult } from './boq-ingestion'
import { buildDraftImport } from './boq-ingestion'
import { v3Fixture } from './boq-extraction-test-fixtures'
import {
  buildExtractionRun,
  checksumSourceRows,
  extractionRunIdentityFingerprint,
  fingerprintParserConfig,
  stableCanonicalJson,
} from './boq-extraction-run'

test('canonical JSON and row checksum are stable across key and row order', () => {
  assert.equal(stableCanonicalJson({ b: 2, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":2}')
  const parsed = parseDoclingResult(v3Fixture())
  assert.equal(parsed.contractVersion, 3)
  const reversed = [...parsed.sourceRows].reverse().map((row) => ({
    ...row,
    rawCells: row.rawCells.map((cell) => {
      const { lines, ...rest } = cell
      return { lines, ...rest }
    }),
  }))
  assert.equal(checksumSourceRows(parsed.sourceRows), checksumSourceRows(reversed))
})

test('run metadata is immutable, review-targeted, and omits large document text', () => {
  const parsed = parseDoclingResult(v3Fixture())
  assert.equal(parsed.contractVersion, 3)
  const draft = buildDraftImport('boq-1', 'boqs/boq-1/source.pdf', parsed, 'run-1')
  assert.ok(draft.run)
  const run = buildExtractionRun({
    seed: draft.run,
    sourceDigest: 'sha256:pdf',
    parserConfigFingerprint: 'sha256:config',
    now: new Date('2026-07-19T00:00:00.000Z'),
  })
  assert.equal(run.status, 'staging')
  assert.equal(run.aiReviewStatus, 'queued')
  assert.equal(run.sourceRowCount, parsed.sourceRows.length)
  assert.equal(run.sourceFile.digest, 'sha256:pdf')
  assert.equal(run.parser.configFingerprint, 'sha256:config')
  assert.equal('documentText' in run, false)
  assert.equal(run.stagingExpiresAt, '2026-07-20T00:00:00.000Z')
  assert.ok(Object.isFrozen(run))
})

test('clean reconciled extraction without ambiguous evidence needs no AI review', () => {
  const payload = v3Fixture()
  payload.warnings = []
  for (const row of payload.sourceRows as Array<Record<string, unknown>>) {
    row.classification = 'item'
    row.warnings = []
  }
  const parsed = parseDoclingResult(payload)
  assert.equal(parsed.contractVersion, 3)
  const draft = buildDraftImport('boq-1', 'source.pdf', parsed, 'run-1')
  const run = buildExtractionRun({
    seed: draft.run!, sourceDigest: 'digest', parserConfigFingerprint: 'config',
    now: new Date('2026-07-19T00:00:00Z'),
  })
  assert.equal(run.aiReviewStatus, 'not_required')
})

test('review targeting preserves distinct compound, ambiguous, and row reconciliation reasons', () => {
  const payload = v3Fixture()
  const sourceRows = payload.sourceRows as Array<Record<string, unknown>>
  Object.assign(sourceRows[0]!, { classification: 'continuation', confidence: 0.98, warnings: [] })
  Object.assign(sourceRows[1]!, { classification: 'item', confidence: 0.72, warnings: [] })
  Object.assign(sourceRows[2]!, { classification: 'item', confidence: 0.98, warnings: [] })
  Object.assign(sourceRows[3]!, {
    classification: 'item', confidence: 0.98,
    warnings: [{ code: 'section_total_mismatch', message: 'Section total does not reconcile.' }],
  })
  payload.warnings = [
    { code: 'section_total_mismatch', message: 'Section total does not reconcile.', sourceRef: { page: 1, table: 1, row: 4 } },
    { code: 'document_total_mismatch', message: 'Document total does not reconcile.' },
  ]
  payload.sourceTotal = 95_301
  payload.reconciliation = { itemTotal: 95_300, sourceTotal: 95_301, reconciled: false, difference: -1 }

  const parsed = parseDoclingResult(payload)
  assert.equal(parsed.contractVersion, 3)
  const draft = buildDraftImport('boq-1', 'source.pdf', parsed, 'run-1')
  const run = buildExtractionRun({
    seed: draft.run!, sourceDigest: 'digest', parserConfigFingerprint: 'config',
    now: new Date('2026-07-19T00:00:00Z'),
  })

  assert.deepEqual(run.reviewTargeting.candidateRowIds, ['row-1', 'row-2', 'row-4'])
  assert.deepEqual(run.reviewTargeting.ambiguousRowIds, ['row-2'])
  assert.deepEqual(run.reviewTargeting.unreconciledRowIds, ['row-4'])
  assert.equal(run.reviewTargeting.unreconciled, true)
})

test('parser identity changes when confirmed original pages change', () => {
  assert.notEqual(
    fingerprintParserConfig({ contractVersion: 3, selectedPages: [1], pageSelectionContract: 1 }),
    fingerprintParserConfig({ contractVersion: 3, selectedPages: [2], pageSelectionContract: 1 }),
  )
})

test('extraction identity changes when immutable source or parser metadata changes', () => {
  const parsed = parseDoclingResult(v3Fixture())
  const draft = buildDraftImport('boq-1', 'source.pdf', parsed, 'run-1')
  const run = buildExtractionRun({
    seed: draft.run!, sourceDigest: 'digest', parserConfigFingerprint: 'config',
    now: new Date('2026-07-19T00:00:00Z'),
  })
  assert.notEqual(
    extractionRunIdentityFingerprint(run),
    extractionRunIdentityFingerprint({ ...run, sourceFile: { ...run.sourceFile, digest: 'different' } }),
  )
  assert.notEqual(
    extractionRunIdentityFingerprint(run),
    extractionRunIdentityFingerprint({ ...run, parser: { ...run.parser, configFingerprint: 'different' } }),
  )
  assert.notEqual(
    extractionRunIdentityFingerprint(run),
    extractionRunIdentityFingerprint({ ...run, sections: [{ header: 'Changed', items: [] }] }),
  )
})
