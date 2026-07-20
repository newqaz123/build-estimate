import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./review-panel.tsx', import.meta.url), 'utf8')
const extractionSource = readFileSync(new URL('./extraction-review.tsx', import.meta.url), 'utf8')

test('the review panel keeps compound evidence and accepted suggestions visibly auditable', () => {
  assert.match(source, /<ExtractionReview/)
  assert.match(extractionSource, /data-od-id="focused-extraction-review"/)
  assert.match(extractionSource, /Current BOQ structure/)
  assert.match(extractionSource, /Informational child · no second total/)
  assert.match(extractionSource, /sourceReferenceLabel\(source\)/)
  assert.match(source, /item\.optional \? <span[^>]*>\{item\.excludedFromTotal === true \? "Optional · excluded from total" : "Optional"\}/)
})

test('the review panel requires deliberate accept/reject actions and supports safe bulk accept and undo', () => {
  assert.match(extractionSource, /Accept all validated high-confidence/)
  assert.match(extractionSource, /proposalCanBeAccepted/)
  assert.match(extractionSource, /\/proposals\/accept-batch/)
  assert.match(extractionSource, /executeAction\(proposal, "accept"\)/)
  assert.match(extractionSource, /executeAction\(proposal, "reject"\)/)
  assert.match(extractionSource, /executeAction\(proposal, "undo"\)/)
  assert.match(extractionSource, /Recheck with AI/)
})

test('the review panel offers a user-entered missing-item path without manufacturing a source price', () => {
  assert.match(source, /Add missing item/)
  assert.match(source, /entryOrigin: "user"/)
  assert.match(source, /sourceRowIds: \[\]/)
  assert.match(source, /New items are user-entered and remain unpriced until you add a rate\./)
})
