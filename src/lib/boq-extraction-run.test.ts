import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDoclingResult } from './boq-ingestion'
import { buildDraftImport } from './boq-ingestion'
import { v3Fixture } from './boq-extraction-test-fixtures'
import {
  buildExtractionRun,
  checksumSourceRows,
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
