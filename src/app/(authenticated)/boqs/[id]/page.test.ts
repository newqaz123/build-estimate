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
  assert.match(source, /onAutoClose:\s*finalize,/)
  assert.match(source, /onDismiss:\s*finalize,/)
  assert.match(source, /unit-combobox|UnitCombobox|units=\{units\}|onAddUnit=/)
})

test('uses stable item identities for display and save resolution', () => {
  assert.doesNotMatch(source, /function rowEditKey/)
  assert.doesNotMatch(source, /\$\{row\.sectionIndex\}-\$\{row\.itemIndex\}/)
  assert.match(source, /getBoqItemIdentityKey/)
  assert.match(source, /applyBoqDetailEdits/)
  assert.match(source, /resolveBoqDetailEdits/)
})

test('does not use one broad mutation busy flag', () => {
  assert.doesNotMatch(source, /\bmutationBusy\b/)
  assert.match(source, /editingDisabled=\{saving \|\| approving\}/)
  assert.match(source, /disabled:\s*isReadOnly/)
  assert.match(source, /disabled=\{addingItem/)
})

test('loads and persists workspace units through settings APIs', () => {
  assert.match(source, /loadWorkspaceCustomUnits/)
  assert.match(source, /addWorkspaceUnit/)
  assert.match(source, /combineUnitOptions/)
  assert.match(source, /workspaceUnitsError=/)
  assert.match(source, /added to workspace units/)
})

test('coordinates overlapping mutations before force-applying a refresh', () => {
  assert.match(source, /compareBoqUpdatedAt/)
  assert.match(source, /activeCanonicalMutationsRef/)
  assert.match(source, /mutationEpochRef/)
  assert.match(source, /mutationOverlapRef/)
  assert.match(source, /canonicalRefreshNeededRef/)
  assert.match(source, /canonicalRefreshRef/)
  assert.match(source, /refreshWasOvertaken/)
})
