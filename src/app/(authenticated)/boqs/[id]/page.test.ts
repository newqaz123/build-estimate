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

test('stashes only the deleted row draft and serializes final commits', () => {
  assert.match(source, /takeBoqDetailDraft/)
  assert.match(source, /restoreBoqDetailDraft/)
  assert.match(source, /createSerialTaskQueue/)
  assert.match(source, /resolveBoqItemIdentityKey/)
  assert.doesNotMatch(source, /Save pending changes before deleting an item/)
  assert.doesNotMatch(source, /pending\.sectionIndex === row\.sectionIndex/)
})

test('keeps the idempotent six-second Sonner finalizer', () => {
  assert.match(source, /duration:\s*6000/)
  assert.match(source, /label:\s*"Undo"/)
  assert.match(source, /onAutoClose:\s*finalize/)
  assert.match(source, /onDismiss:\s*finalize/)
  assert.match(source, /if \(undone \|\| committed\) return/)
})

test('approves the saved version explicitly and warns before discarding drafts', () => {
  // Explicit approve-the-saved-version flow with a confirm warning dialog.
  assert.match(source, /approveWarningOpen/)
  assert.match(source, /approveCancelRef/)
  assert.match(source, /requestApproval/)
  assert.match(source, /approveSavedVersion/)
  assert.match(source, /approvalBlockedReason/)

  // Warning dialog title, exact copy, and Cancel/Approve saved version actions.
  assert.match(source, /Approve saved version\?/)
  assert.match(source, /unsaved change\(s\) will not be included and will be discarded/)
  assert.match(source, /Approve saved version</)
  assert.match(source, /Cancel</)

  // Amber "Unsaved changes" status beside the Save action.
  assert.match(source, /Unsaved changes/)

  // The Approve request runs the explicit saved-version approval and is gated
  // only by approvalBlockedReason — not by local drafts or invalid draft keys.
  assert.match(source, /onClick=\{requestApproval\}/)
  assert.match(source, /disabled=\{Boolean\(approvalBlockedReason\(\)\)\}/)
  assert.doesNotMatch(source, /handleApprove/)

  // The approval PUT sends only the saved status and force-applies the response.
  assert.match(source, /JSON\.stringify\(\{ status: "approved" \}\)/)
  assert.match(source, /force: true/)

  // The synchronous approval barrier is raised before the approving state.
  assert.match(source, /approvalBarrierRef\.current = true[\s\S]*?setApproving\(true\)/)

  // Drafts (item edits, metadata edits, invalid component drafts) clear only
  // inside the approve success path; a failure preserves them verbatim.
  const approveFlow = source.slice(source.indexOf('approveSavedVersion'))
  assert.match(approveFlow, /replaceEdits\(\{\}\)/)
  assert.match(approveFlow, /replaceMetadataEdits\(\{\}\)/)
  assert.match(approveFlow, /setInvalidDraftKeys\(new Set\(\)\)/)
})
