import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

test('no longer renders the All/Unit/Lump Sum/Job type filter chips', () => {
  assert.doesNotMatch(source, /FILTERS\s*=\s*\[/)
  assert.doesNotMatch(source, /boq-detail-filters/)
  assert.doesNotMatch(source, /activeFilter/)
})
