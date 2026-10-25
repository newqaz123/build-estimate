import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const ROUTES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['boqs/import/route.ts', ['POST']],
  ['docling/parse/route.ts', ['POST']],
  ['boqs/[id]/route.ts', ['GET', 'PUT', 'DELETE']],
  ['boqs/[id]/source/route.ts', ['GET']],
  ['boqs/[id]/duplicates/route.ts', ['GET']],
  ['boqs/[id]/re-extract/route.ts', ['POST']],
  ['boqs/[id]/extraction-runs/[runId]/review/route.ts', ['GET', 'POST']],
  ['boqs/[id]/extraction-runs/[runId]/proposals/accept-batch/route.ts', ['POST']],
  ['boqs/[id]/extraction-runs/[runId]/proposals/[proposalId]/accept/route.ts', ['POST']],
  ['boqs/[id]/extraction-runs/[runId]/proposals/[proposalId]/reject/route.ts', ['POST']],
  ['boqs/[id]/extraction-runs/[runId]/proposals/[proposalId]/skip/route.ts', ['POST']],
  ['boqs/[id]/extraction-runs/[runId]/proposals/[proposalId]/reopen/route.ts', ['POST']],
  ['boqs/[id]/extraction-runs/[runId]/proposals/[proposalId]/undo/route.ts', ['POST']],
  ['boqs/[id]/extraction-runs/[runId]/proposals/[proposalId]/add-source-item/route.ts', ['POST']],
  ['boqs/preflight/route.ts', ['POST']],
  ['boqs/preflight/[id]/route.ts', ['GET', 'PATCH', 'DELETE']],
  ['internal/cleanup/preflight/route.ts', ['DELETE']],
]

test('new BOQ ingestion route modules export only supported HTTP handlers', () => {
  for (const [relativePath, expectedExports] of ROUTES) {
    const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
    const exports = Array.from(
      source.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class|type|interface|enum)\s+(\w+)/g),
      (match) => match[1],
    )
    // Also collect destructured const exports: `export const { A, B } = ...`
    for (const match of source.matchAll(/export\s+const\s+\{([^}]*)\}/g)) {
      for (const name of match[1].split(',')) {
        const trimmed = name.trim().split(':')[0].trim()
        if (trimmed) exports.push(trimmed)
      }
    }

    assert.deepEqual(exports.sort(), [...expectedExports].sort(), relativePath)
  }
})

test('review route forwards preserved fallback proposals through the production lease adapter', () => {
  const source = readFileSync(new URL('boqs/[id]/extraction-runs/[runId]/review/route.ts', import.meta.url), 'utf8')
  const adapter = source.match(/failReviewLease:\s*\(([^)]*)\)\s*=>\s*createFirestoreExtractionProposalStore\(getDb\(\)\)\.failReviewLease\(([^)]*)\)/)
  assert.ok(adapter, 'production review route must define the failReviewLease adapter')
  assert.deepEqual(
    adapter[1]!.split(',').map((value) => value.trim()),
    ['boqId', 'runId', 'leaseId', 'failureCode', 'retryDelayMs', 'preservedProposals', 'refreshedSourceRowIds', 'validationSummary'],
  )
  assert.deepEqual(
    adapter[2]!.split(',').map((value) => value.trim()),
    ['boqId', 'runId', 'leaseId', 'failureCode', 'retryDelayMs', 'preservedProposals', 'refreshedSourceRowIds', 'validationSummary'],
  )
})
