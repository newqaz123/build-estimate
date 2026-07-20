import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const ROUTES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['boqs/import/route.ts', ['POST']],
  ['docling/parse/route.ts', ['POST']],
  ['boqs/[id]/route.ts', ['GET', 'PUT', 'DELETE']],
  ['boqs/[id]/source/route.ts', ['GET']],
  ['boqs/[id]/re-extract/route.ts', ['POST']],
  ['boqs/[id]/extraction-runs/[runId]/review/route.ts', ['GET', 'POST']],
  ['boqs/[id]/extraction-runs/[runId]/proposals/accept-batch/route.ts', ['POST']],
  ['boqs/[id]/extraction-runs/[runId]/proposals/[proposalId]/accept/route.ts', ['POST']],
  ['boqs/[id]/extraction-runs/[runId]/proposals/[proposalId]/reject/route.ts', ['POST']],
  ['boqs/[id]/extraction-runs/[runId]/proposals/[proposalId]/undo/route.ts', ['POST']],
]

test('new BOQ ingestion route modules export only supported HTTP handlers', () => {
  for (const [relativePath, expectedExports] of ROUTES) {
    const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
    const exports = Array.from(
      source.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class|type|interface|enum)\s+(\w+)/g),
      (match) => match[1],
    )

    assert.deepEqual(exports.sort(), [...expectedExports].sort(), relativePath)
  }
})
