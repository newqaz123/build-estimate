import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const globalsSource = readFileSync(
  new URL('../../app/globals.css', import.meta.url),
  'utf8',
)

test('reduced-motion suppression includes the AlertDialog backdrop/overlay', () => {
  // The AlertDialog backdrop fades in/out (and blurs), so it must be suppressed
  // under prefers-reduced-motion alongside the popup (`.alert-dialog-content`).
  const motionStart = globalsSource.indexOf(
    '@media (prefers-reduced-motion: reduce)',
  )
  assert.notStrictEqual(motionStart, -1, 'reduced-motion media query exists')
  // Slice to the media block's column-0 closing brace.
  const motionBlock = globalsSource.slice(
    motionStart,
    globalsSource.indexOf('\n}', motionStart),
  )
  assert.match(motionBlock, /\.alert-dialog-content/)
  assert.match(motionBlock, /\[data-slot="alert-dialog-backdrop"\]/)
})
