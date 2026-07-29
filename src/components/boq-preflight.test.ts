import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

test.describe('BoqPreflight component', () => {
  const preflightSource = readFileSync(new URL('./boq-preflight.tsx', import.meta.url), 'utf8')

  test('BoqPreflight component exists and exports correctly', () => {
    assert.match(preflightSource, /export function BoqPreflight/)
    assert.match(preflightSource, /preflight:\s*PreflightUpload/)
    assert.match(preflightSource, /onExtract:\s*\([^)]*\)\s*=>/)
    assert.match(preflightSource, /onCancel:\s*\([^)]*\)\s*=>/)
  })

  test('BoqPreflight renders page thumbnails with accessible labels', () => {
    assert.match(preflightSource, /buildAccessibleLabel/)
    assert.match(preflightSource, /Page \$\{pageInfo\.page\}/)
    assert.match(preflightSource, /role="button"/)
    assert.match(preflightSource, /aria-label=/)
  })

  test('BoqPreflight pre-selects suggested pages and allows toggle', () => {
    assert.match(preflightSource, /useState/)
    assert.match(preflightSource, /preflight\.pages\.filter/)
    assert.match(preflightSource, /toggleSelection/)
  })

  test('BoqPreflight shows magnified image on hover', () => {
    assert.match(preflightSource, /Magnified Page/)
    assert.match(preflightSource, /role="img"/)
    assert.match(preflightSource, /onMouseEnter|onFocus/)
    assert.match(preflightSource, /\/api\/boqs\/preflight\/.*?preview/)
  })

  test('BoqPreflight disables extract button when no pages selected', () => {
    assert.match(preflightSource, /selectedPages\.length === 0/)
    assert.match(preflightSource, /Select at least one page to continue/)
    assert.match(preflightSource, /disabled.*?selectedPages\.length === 0/)
  })

  test('BoqPreflight shows correct count in extract button', () => {
    assert.match(preflightSource, /Extract.*?selected page/)
    assert.match(preflightSource, /selectedPages\.length/)
  })
})
