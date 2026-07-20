import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./review-panel.tsx', import.meta.url), 'utf8')

test('the review panel keeps compound evidence and accepted suggestions visibly auditable', () => {
  assert.match(source, /data-od-id="extraction-review-workspace"/)
  assert.match(source, /data-od-id=\{`extraction-proposal-\$\{proposal\.id\}`\}/)
  assert.match(source, /Informational bundle child/)
  assert.match(source, /Source: \{sourceReferenceLabel\(reference\)\}/)
  assert.match(source, /item\.optional \? <span[^>]*>\{item\.excludedFromTotal === true \? "Optional · excluded from total" : "Optional"\}/)
})

test('the review panel requires deliberate accept/reject actions and supports safe bulk accept and undo', () => {
  assert.match(source, /Accept all high-confidence/)
  assert.match(source, /proposalCanBeAccepted/)
  assert.match(source, /\/proposals\/\$\{encodeURIComponent\(proposal\.id\)\}\/\$\{action\}/)
  assert.match(source, /executeProposalAction\(proposal, "accept"\)/)
  assert.match(source, /executeProposalAction\(proposal, "reject"\)/)
  assert.match(source, /executeProposalAction\(proposal, "undo"\)/)
  assert.match(source, /Recheck with AI/)
})

test('the review panel offers a user-entered missing-item path without manufacturing a source price', () => {
  assert.match(source, /Add missing item/)
  assert.match(source, /entryOrigin: "user"/)
  assert.match(source, /sourceRowIds: \[\]/)
  assert.match(source, /New items are user-entered and remain unpriced until you add a rate\./)
})
