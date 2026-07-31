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

  // The Approve request runs the explicit saved-version approval. Its disabled
  // state is a render-safe gate (approvalDisabledReason) derived from canonical
  // state — not local drafts or invalid draft keys; ref-based revalidation
  // lives in the request/confirm handlers.
  assert.match(source, /onClick=\{requestApproval\}/)
  assert.match(source, /disabled=\{Boolean\(approvalDisabledReason\)\}/)
  assert.doesNotMatch(source, /disabled=\{Boolean\(approvalBlockedReason\(\)\)\}/)
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

// Extract a top-level (2-space-indented) handler body up to the next sibling.
function handlerBody(name: string): string {
  const start = source.indexOf(`const ${name} =`)
  assert.ok(start !== -1, `${name} is defined`)
  const rest = source.slice(start)
  const nextIdx = rest.search(/\n  const [A-Za-z]/)
  return nextIdx === -1 ? rest : rest.slice(0, nextIdx)
}

test('splits approval gating into a render-safe gate and a ref-based event revalidation', () => {
  // One shared predicate takes an explicit saved BOQ + active mutation count.
  assert.match(source, /computeApprovalBlockedReason\s*=\s*\(\s*savedBoq[^)]*activeMutationCount/)
  const predStart = source.indexOf('computeApprovalBlockedReason =')
  const predEnd = source.indexOf('return undefined', predStart)
  assert.ok(predStart !== -1 && predEnd !== -1, 'shared predicate is defined')
  const predFn = source.slice(predStart, predEnd)
  // Saved-version blockers are computed from the saved BOQ, never displayBoq.
  assert.match(predFn, /buildReviewVerification\(savedBoq/)
  assert.match(predFn, /getBoqCatalogReadiness\(savedBoq/)
  // Pending deletes still block; local drafts and invalid component drafts do not.
  assert.match(predFn, /pendingDeletes\.length\s*>\s*0/)
  assert.doesNotMatch(predFn, /pendingChanges/)
  assert.doesNotMatch(predFn, /invalidDraftKeys/)

  // Render-safe gate: derived from canonical boq state + state mutation count.
  assert.match(source, /approvalDisabledReason\s*=\s*computeApprovalBlockedReason\(\s*boq\s*,\s*activeCanonicalMutations\s*\)/)
  assert.match(source, /disabled=\{Boolean\(approvalDisabledReason\)\}/)
  assert.doesNotMatch(source, /disabled=\{Boolean\(approvalBlockedReason\(\)\)\}/)

  // Event-only revalidation reads the synchronous refs.
  assert.match(source, /computeApprovalBlockedReason\(\s*boqRef\.current\s*,\s*activeCanonicalMutationsRef\.current\s*\)/)
})

test('all canonical and draft action handlers respect the synchronous approval barrier', () => {
  const barrierHandlers = [
    'handleAcceptCatalogSuggestion',
    'handleAiSuggest',
    'handleEdit',
    'handleAddMissingItem',
    'handleIncludeOptional',
    'handleDelete',
    'handleMetadataChange',
    'handleSaveAll',
    'reloadAfterManualMatch',
    'handleExclude',
    'handleDeleteBoq',
  ]
  for (const name of barrierHandlers) {
    assert.match(
      handlerBody(name),
      /approvalBarrierRef\.current/,
      `${name} must guard with the synchronous approval barrier`,
    )
  }
})

test('clears drafts only after the saved version is force-applied and preserves them on failure', () => {
  const approveStart = source.indexOf('const approveSavedVersion')
  const approveEnd = source.indexOf('const requestApproval', approveStart)
  assert.ok(approveStart !== -1 && approveEnd !== -1)
  const approveFn = source.slice(approveStart, approveEnd)
  const forceIdx = approveFn.indexOf('force: true')
  const clearIdx = approveFn.indexOf('replaceEdits({})')
  assert.ok(forceIdx !== -1, 'force-apply is present')
  assert.ok(clearIdx > forceIdx, 'drafts cleared only after force-apply')
  const failureStart = approveFn.indexOf('catch', forceIdx)
  const failureBlock = approveFn.slice(failureStart)
  assert.doesNotMatch(failureBlock, /replaceEdits\(\{\}\)/)
  assert.doesNotMatch(failureBlock, /replaceMetadataEdits\(\{\}\)/)
  assert.doesNotMatch(failureBlock, /setInvalidDraftKeys\(new Set/)
})

test('requestApproval and approveSavedVersion each recheck blockers via approvalBlockedReason before acting', () => {
  // Characterization coverage: the production already re-validates at the top of
  // each handler. These independent slices pin that ordering so a future refactor
  // cannot drop or reorder the synchronous ref-based recheck.

  // requestApproval (click handler): must re-validate before opening the
  // warning or delegating to approveSavedVersion.
  const requestBody = handlerBody('requestApproval')
  const requestCheck = requestBody.indexOf('approvalBlockedReason()')
  assert.notStrictEqual(requestCheck, -1, 'requestApproval calls approvalBlockedReason()')
  assert.ok(
    requestBody.indexOf('setApproveWarningOpen') > requestCheck,
    'requestApproval opens the warning only after rechecking blockers',
  )
  assert.ok(
    requestBody.indexOf('approveSavedVersion') > requestCheck,
    'requestApproval delegates to approveSavedVersion only after rechecking blockers',
  )

  // approveSavedVersion (confirm handler): must re-validate before raising the
  // synchronous barrier or publishing the approving state.
  const approveBody = handlerBody('approveSavedVersion')
  const approveCheck = approveBody.indexOf('approvalBlockedReason()')
  assert.notStrictEqual(approveCheck, -1, 'approveSavedVersion calls approvalBlockedReason()')
  assert.ok(
    approveBody.indexOf('approvalBarrierRef.current = true') > approveCheck,
    'approveSavedVersion raises the approval barrier only after rechecking blockers',
  )
  assert.ok(
    approveBody.indexOf('setApproving(true)') > approveCheck,
    'approveSavedVersion publishes the approving state only after rechecking blockers',
  )
})

test('approveSavedVersion rechecks blockers before the network request and before raising the barrier', () => {
  // Explicit ordering: the synchronous ref-based recheck must happen before any
  // network action (the approval PUT), and (retained) before the barrier rises.
  const approveBody = handlerBody('approveSavedVersion')
  const approveCheck = approveBody.indexOf('approvalBlockedReason()')
  assert.notStrictEqual(approveCheck, -1, 'approveSavedVersion calls approvalBlockedReason()')
  assert.ok(
    approveBody.indexOf('fetch(') > approveCheck,
    'approveSavedVersion issues the approval PUT only after rechecking blockers',
  )
  assert.ok(
    approveBody.indexOf('approvalBarrierRef.current = true') > approveCheck,
    'approveSavedVersion raises the barrier only after rechecking blockers (retained)',
  )
})
