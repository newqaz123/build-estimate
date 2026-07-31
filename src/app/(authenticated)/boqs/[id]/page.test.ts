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

  // Render-safe gate: derived from canonical boq state + the state mutation
  // count + the in-flight refresh state mirror. It intentionally does NOT gate on
  // `required` so an approval attempt can still schedule a needed refresh.
  assert.match(source, /approvalDisabledReason\s*=\s*computeApprovalBlockedReason\(\s*boq\s*,\s*activeCanonicalMutations\s*,\s*\{\s*inFlight:\s*canonicalRefreshInFlight\s*\}/)
  assert.match(source, /disabled=\{Boolean\(approvalDisabledReason\)\}/)
  assert.doesNotMatch(source, /disabled=\{Boolean\(approvalBlockedReason\(\)\)\}/)

  // Event-only revalidation reads the synchronous refs, including the in-flight
  // and required canonical-refresh refs.
  assert.match(source, /computeApprovalBlockedReason\(\s*boqRef\.current\s*,\s*activeCanonicalMutationsRef\.current\s*,\s*\{\s*inFlight:\s*canonicalRefreshRef\.current !== null,\s*required:\s*canonicalRefreshNeededRef\.current\s*\}/)
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

test('Save clears only the captured snapshot drafts, preserving edits restored during the in-flight save', () => {
  const saveBody = handlerBody('handleSaveAll')
  assert.match(saveBody, /const editSnapshot = editsRef\.current/)
  assert.match(saveBody, /const metadataSnapshot = metadataEditsRef\.current/)
  // Success boundary clears only the snapshot via the pure helper — never the
  // whole current draft — so an Undo restored mid-save survives.
  assert.match(saveBody, /clearBoqDetailDraftSnapshot\(editsRef\.current, editSnapshot\)/)
  assert.doesNotMatch(saveBody, /replaceEdits\(\{\}\)/)
  // Metadata clears only the captured snapshot fields, not unrelated edits,
  // and only when the current value still equals the captured snapshot value
  // (a newer same-field value is preserved).
  assert.match(saveBody, /Object\.entries\(metadataEditsRef\.current\)\.filter\(/)
  assert.match(saveBody, /!\(field in metadataSnapshot\)\s*\|\|\s*!Object\.is\(value, metadataSnapshot\[field as MetadataField\]\)/)
})

test('serial canonical mutations await the authoritative refresh before resolving', () => {
  // The mutation finally must await (not fire-and-forget) the required idle
  // refresh so the serial delete queue cannot start the next task first.
  const mutationBody = handlerBody('runCanonicalMutation')
  // Literal await (not fire-and-forget) of the required idle refresh.
  assert.match(mutationBody, /await refreshCanonicalAfterIdle\(\)/)
  assert.doesNotMatch(mutationBody, /void refreshCanonicalAfterIdle\(\)/)
  const awaitIdx = mutationBody.indexOf('await refreshCanonicalAfterIdle()')
  const finallyIdx = mutationBody.lastIndexOf('finally')
  assert.ok(
    awaitIdx > finallyIdx,
    'refresh is awaited inside the mutation finally block',
  )

  // An overtaken refresh must await its replacement AFTER clearing the old
  // promise, so callers cannot return between the old and replacement refreshes.
  const refreshBody = handlerBody('refreshCanonicalAfterIdle')
  const clearIdx = refreshBody.indexOf('canonicalRefreshRef.current = null')
  const replIdx = refreshBody.search(/await refreshCanonicalAfterIdleRef\.current\(\)/)
  assert.notStrictEqual(clearIdx, -1)
  assert.notStrictEqual(replIdx, -1)
  assert.ok(
    replIdx > clearIdx,
    'overtaken replacement refresh is awaited after clearing the old promise',
  )
  // The overtaken-replacement boundary is never fire-and-forget.
  assert.doesNotMatch(refreshBody, /void refreshCanonicalAfterIdle\(\)/)
  assert.doesNotMatch(refreshBody, /void refreshCanonicalAfterIdleRef\.current\(\)/)
})

test('a refresh failure keeps the canonical refresh required and schedules replacement only when overtaken', () => {
  // Slice the catch and finally blocks of refreshCanonicalAfterIdle
  // independently to pin the failure-recovery contract.
  const refreshBody = handlerBody('refreshCanonicalAfterIdle')
  const catchIdx = refreshBody.indexOf('} catch {')
  const finallyIdx = refreshBody.indexOf('} finally {')
  assert.notStrictEqual(catchIdx, -1, 'refresh has a catch block')
  assert.notStrictEqual(finallyIdx, -1, 'refresh has a finally block')
  assert.ok(finallyIdx > catchIdx, 'finally follows catch')
  const catchBlock = refreshBody.slice(catchIdx, finallyIdx)
  const finallyBlock = refreshBody.slice(
    finallyIdx,
    refreshBody.indexOf('ownedTask = runRefresh()'),
  )

  // Catch: unconditionally keep the refresh required, and do NOT itself trigger
  // an immediate refresh/replacement (so an ordinary failure cannot loop).
  assert.match(catchBlock, /canonicalRefreshNeededRef\.current = true/)
  assert.doesNotMatch(catchBlock, /refreshCanonicalAfterIdle/)

  // Finally: the awaited replacement is invoked ONLY under the combined guard
  // (overtaken AND active mutation count zero AND refresh-needed), which pins
  // ordinary-failure no-loop vs overtaken replacement.
  const guardedReplacement = /if \(\s*refreshWasOvertaken\s*&&\s*activeCanonicalMutationsRef\.current === 0\s*&&\s*canonicalRefreshNeededRef\.current\s*\) \{[^}]*await refreshCanonicalAfterIdleRef\.current\(\)[^}]*\}/
  assert.match(
    finallyBlock,
    guardedReplacement,
    'replacement await is nested inside the complete overtaken-refresh guard',
  )
  const guardIdx = finallyBlock.indexOf(
    'refreshWasOvertaken && activeCanonicalMutationsRef.current === 0 && canonicalRefreshNeededRef.current',
  )
  assert.notStrictEqual(guardIdx, -1, 'combined replacement guard exists')
  const replIdx = finallyBlock.search(
    /await refreshCanonicalAfterIdleRef\.current\(\)/,
  )
  assert.notStrictEqual(replIdx, -1, 'finally awaits the replacement refresh')
  assert.ok(
    replIdx > guardIdx,
    'replacement await follows the combined guard',
  )
  // No unguarded replacement invocation precedes the awaited one.
  assert.doesNotMatch(
    finallyBlock.slice(0, replIdx),
    /refreshCanonicalAfterIdleRef\.current\(\)/,
  )
})

test('approval freshness gates on a render-safe in-flight refresh mirror with an event-time retry escape hatch', () => {
  // Render-safe state mirror for the in-flight canonical refresh.
  assert.match(source, /const \[canonicalRefreshInFlight, setCanonicalRefreshInFlight\] = useState\(false\)/)

  // The shared predicate accepts refresh freshness and blocks on in-flight /
  // required refreshes.
  const predStart = source.indexOf('computeApprovalBlockedReason =')
  const predEnd = source.indexOf('return undefined', predStart)
  const predFn = source.slice(predStart, predEnd)
  assert.match(predFn, /refresh:\s*\{\s*inFlight:\s*boolean;\s*required\?:\s*boolean\s*\}/)
  assert.match(predFn, /if \(refresh\.inFlight\) return/)
  assert.match(predFn, /if \(refresh\.required\) return/)

  // An approval attempt blocked only by a required-but-not-in-flight refresh
  // schedules that refresh and asks the user to retry (no permanent dead end).
  const approveBody = handlerBody('approveSavedVersion')
  assert.match(approveBody, /canonicalRefreshNeededRef\.current && !canonicalRefreshRef\.current/)
  assert.match(approveBody, /void refreshCanonicalAfterIdle\(\)/)
  assert.match(approveBody, /Please retry approval in a moment/)
})

test('handleIncludeOptional fails closed on a missing or ambiguous identity before the network', () => {
  const body = handlerBody('handleIncludeOptional')
  // The unique-identity check runs before the network request and surfaces the
  // existing error, so no section-only PATCH is ever sent for an unsafe row.
  const checkIdx = body.search(/if \(!identityKey \|\| row\.identityIssue\) \{/)
  assert.notStrictEqual(checkIdx, -1, 'identity gate exists before the network')
  const toastIdx = body.indexOf('cannot be edited')
  assert.ok(toastIdx > checkIdx, 'identity failure surfaces the unique-identity error')
  const fetchIdx = body.indexOf('fetch(')
  assert.ok(fetchIdx > toastIdx, 'no network request runs before the identity check')
  // The PATCH still carries the request identity, not a bare section mutation.
  assert.match(body, /getBoqItemRequestIdentity\(row\.item\)/)
})
