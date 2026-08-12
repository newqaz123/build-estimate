import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./catalog-match-modal.tsx', import.meta.url), 'utf8')

/** Extract `const name = async (...) => { ... }` body via brace balance (format-tolerant). */
function extractAsyncConstHandler(src: string, name: string): string {
  const startRe = new RegExp(
    String.raw`const\s+${name}\s*=\s*async\s*\([^)]*\)\s*=>\s*\{`,
  )
  const startMatch = startRe.exec(src)
  assert.ok(startMatch, `${name} async handler must exist`)
  const openBrace = startMatch.index + startMatch[0].length - 1
  let depth = 0
  let end = -1
  for (let i = openBrace; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  assert.ok(end > openBrace, `${name} body must close`)
  return src.slice(startMatch.index, end + 1)
}

test('catalog matching keeps one search control and switches the footer for create mode', () => {
  assert.equal((source.match(/data-od-id="catalog-match-search"/g) ?? []).length, 1)
  assert.doesNotMatch(source, /catalog-match-search-existing|Search existing items/)

  // Footer labels switch on create mode; tolerate multiline ternary formatting.
  assert.match(
    source,
    /primaryActionLabel\s*=\s*newItemOpen\s*\?\s*"Create and link item"\s*:\s*"Confirm match"/,
  )
  assert.match(
    source,
    /secondaryActionLabel\s*=\s*newItemOpen\s*\?\s*"Back to matches"\s*:\s*"Cancel"/,
  )
  // Labels must be rendered in the footer (not dead assignments).
  assert.match(source, /\{secondaryActionLabel\}/)
  assert.match(
    source,
    /\{applying\s*\?[\s\S]*?:\s*primaryActionLabel\}/,
  )
})

test('catalog matching closes only after the caller reload promise resolves', () => {
  for (const fnName of ['handleApply', 'handleCreateNew'] as const) {
    const section = extractAsyncConstHandler(source, fnName)

    const awaitPositions: number[] = []
    const awaitRe = /await\s+onMatch\s*\(/g
    let match: RegExpExecArray | null
    while ((match = awaitRe.exec(section)) !== null) {
      awaitPositions.push(match.index)
    }
    assert.ok(
      awaitPositions.length >= 1,
      `${fnName} must await onMatch (caller reload promise)`,
    )

    const closeIndex = section.search(/setOpen\s*\(\s*false\s*\)/)
    assert.ok(closeIndex >= 0, `${fnName} must call setOpen(false)`)

    const catchIndex = section.search(/catch\s*\(/)
    assert.ok(catchIndex >= 0, `${fnName} must have a catch path`)

    for (const matchIndex of awaitPositions) {
      assert.ok(
        matchIndex < closeIndex,
        `${fnName} must close only after onMatch resolves`,
      )
    }
    assert.ok(
      closeIndex < catchIndex,
      `${fnName} must retain the modal when onMatch rejects (close before catch)`,
    )
  }
})
test("catalog match modal stays legacy manual matching and does not own actionable add_and_match", () => {
  assert.doesNotMatch(source, /add_and_match/);
  assert.doesNotMatch(source, /ActionableExtractionReview|actionable-review-detail/);
  assert.doesNotMatch(source, /createActionableReviewClient/);
  // Modal may create catalog entries for legacy manual matching only.
  assert.match(source, /Create and link item|handleCreateNew/);
});
