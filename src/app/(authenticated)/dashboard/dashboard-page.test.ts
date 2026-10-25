import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')
const listRoute = readFileSync(new URL('../../api/boqs/route.ts', import.meta.url), 'utf8')

test('dashboard has no hardcoded trend lines', () => {
  for (const trend of ['+12 this month', '+847 this month', '+5 this month', '+3 this week']) {
    assert.equal(source.includes(trend), false, `found hardcoded trend "${trend}"`)
  }
  assert.doesNotMatch(source, /TrendUpIcon/)
})

test('dashboard totals come from every quote, not the five newest', () => {
  assert.match(listRoute, /summary: summarizeBoqWorkspace\(boqs\)/)
  assert.match(source, /boqsJson\.summary/)
  assert.doesNotMatch(source, /data\.boqs\.reduce/)
})

test('dashboard counts vendors from quotes instead of the empty vendor directory', () => {
  assert.doesNotMatch(source, /fetch\("\/api\/vendors"\)/)
  assert.match(source, /Vendors with quotes/)
})

test('dashboard quick stats show real counts instead of placeholders', () => {
  assert.doesNotMatch(source, /Comparison Match Rate|Data Coverage|Add BOQs to calculate|Standardize items to calculate/)
  assert.match(source, /AWAITING_APPROVAL_LABEL/)
  assert.match(source, /Estimates started/)
})
