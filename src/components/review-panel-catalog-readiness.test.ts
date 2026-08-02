import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const reviewSource = readFileSync(new URL('./review-panel.tsx', import.meta.url), 'utf8')
const standardizationSource = readFileSync(new URL('./standardization-review.tsx', import.meta.url), 'utf8')

test('compare review keeps catalog resolution inside the side-by-side panel', () => {
  assert.match(reviewSource, /requireCatalogReadiness\?: boolean/)
  assert.match(reviewSource, /getBoqCatalogReadiness/)
  assert.match(reviewSource, /<CatalogMatchModal/)
  assert.match(reviewSource, /catalogReadiness\.blocking > 0/)
  assert.match(standardizationSource, /onMatchRequest/)
  assert.match(standardizationSource, /onExcludeRequest/)
})
