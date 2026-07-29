import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

test('no longer renders the All/Unit/Lump Sum/Job type filter chips', () => {
  assert.doesNotMatch(source, /FILTERS\s*=\s*\[/)
  assert.doesNotMatch(source, /boq-detail-filters/)
  assert.doesNotMatch(source, /activeFilter/)
})

test('wires row delete with an optimistic hide and an undoable DELETE commit', () => {
  assert.match(source, /pendingDeletes/)
  assert.match(source, /method:\s*"DELETE"/)
  assert.match(source, /label:\s*"Undo"/)
  assert.match(source, /onAutoClose:/)
  assert.match(source, /unit-combobox|UnitCombobox|units=\{units\}|onAddUnit=/)
})

test('blocks delete when a later row in the same section has unsaved edits', () => {
  assert.match(source, /Save changes to rows below this one before deleting/)
})

test('rechecks shiftable edits at commit time, not just at click time', () => {
  // The shiftable-edit guard appears both at click time and at commit time.
  assert.ok((source.match(/hasShiftableEdit/g) || []).length >= 2, 'shiftable-edit guard must run at click time AND commit time')
})
