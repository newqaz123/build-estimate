import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

function sourceSection(start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.ok(startIndex >= 0, `missing source marker: ${start}`);
  assert.ok(endIndex > startIndex, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("no longer renders the All/Unit/Lump Sum/Job type filter chips", () => {
	assert.doesNotMatch(source, /FILTERS\s*=\s*\[/);
	assert.doesNotMatch(source, /boq-detail-filters/);
	assert.doesNotMatch(source, /activeFilter/);
});

test("wires row delete with an optimistic hide and an undoable DELETE commit", () => {
	assert.match(source, /pendingDeletes/);
	assert.match(source, /method:\s*"DELETE"/);
	assert.match(source, /label:\s*"Undo"/);
	assert.match(source, /onAutoClose:\s*finalize,/);
	assert.match(source, /onDismiss:\s*finalize,/);
	assert.match(source, /unit-combobox|UnitCombobox|units=\{units\}|onAddUnit=/);
});

test("blocks delete when there are pending edits", () => {
	assert.match(source, /Save pending changes before deleting an item/);
});

test("rechecks pending edits at commit time, not just at click time", () => {
	// The pending-edit guard appears both at click time and at commit time.
	assert.ok(
		(source.match(/Save pending changes before deleting an item/g) || [])
			.length >= 2,
		"pending-edit guard must run at click time AND commit time",
	);
});

test("loads workspace custom units and persists added units through the settings API", () => {
	assert.match(source, /loadWorkspaceCustomUnits/);
	assert.match(source, /addWorkspaceUnit/);
	assert.match(source, /handleAddWorkspaceUnit/);
	assert.match(source, /workspaceUnitsError=/);
	assert.match(source, /setWorkspaceUnitsError/);
	assert.match(source, /onAddUnit=\{handleAddWorkspaceUnit\}/);
});

test("validates compare returnTo and preserves it while removing legacy mode", () => {
  assert.match(source, /safeCompareReturnPath/);
  assert.match(source, /searchParams\.get\("returnTo"\)/);
  assert.match(source, /boqDetailReturnHref\(id,\s*returnTo\)/);
  assert.match(source, /router\.replace\(returnTo/);
});

test("approval redirects only from the successful response branch", () => {
  const approval = sourceSection(
    "const handleApprove",
    "const reloadAfterManualMatch",
  );
  const responseCheck = approval.indexOf("if (!response.ok)");
  const approvedCallback = approval.indexOf("onApproved(approved)");
  const catchBlock = approval.indexOf("catch (error)");

  assert.ok(responseCheck >= 0);
  assert.ok(approvedCallback > responseCheck);
  assert.ok(catchBlock > approvedCallback);
  assert.doesNotMatch(approval.slice(catchBlock), /onApproved/);
});

test("every existing approval blocker remains before the approval request", () => {
  const approval = sourceSection(
    "const handleApprove",
    "const reloadAfterManualMatch",
  );
  const requestIndex = approval.indexOf("await fetch");

  for (const guard of [
    "invalidDraftRef.current.size > 0",
    "pendingChanges > 0",
    "verification.hasBlockingIssues",
    "catalogReadiness.blocking > 0",
  ]) {
    const guardIndex = approval.indexOf(guard);
    assert.ok(guardIndex >= 0, `missing approval guard: ${guard}`);
    assert.ok(guardIndex < requestIndex, `${guard} must run before fetch`);
  }
});

test("approval exposes progress and disables duplicate mutations", () => {
  assert.match(source, /aria-busy=\{approving\}/);
  assert.match(source, /approving \? "Approving…" : "Approve BOQ"/);
  assert.match(source, /const mutationBusy[\s\S]*approving/);
});

test("approval exposes one disabled state and an actionable blocker message", () => {
  const approval = sourceSection(
    "const approvalDisabledReason",
    "const handleApprove",
  );
  // Reason precedence must mirror guard order: mutationBusy → invalid
  // drafts → pending changes → verification blockers → catalog readiness
  // (gated by requireCatalogReadiness).
  const busyIdx = approval.indexOf("mutationBusy");
  const invalidIdx = approval.indexOf("invalidDraftKeys.size > 0");
  const pendingIdx = approval.indexOf("pendingChanges > 0");
  const verifyIdx = approval.indexOf("verification.hasBlockingIssues");
  const catalogIdx = approval.indexOf(
    "requireCatalogReadiness && catalogReadiness.blocking > 0",
  );
  assert.ok(busyIdx >= 0, "reason must start from mutationBusy");
  assert.ok(
    invalidIdx > busyIdx,
    "invalid drafts must come after mutationBusy",
  );
  assert.ok(
    pendingIdx > invalidIdx,
    "pending changes must come after invalid drafts",
  );
  assert.ok(
    verifyIdx > pendingIdx,
    "verification blockers must come after pending changes",
  );
  assert.ok(
    catalogIdx > verifyIdx,
    "catalog readiness (gated by requireCatalogReadiness) must come last",
  );
  // The button disabled state is the single derived predicate.
  assert.match(source, /disabled=\{approvalDisabled\}/);
  // Accessible blocker message wired to the button.
  assert.match(source, /aria-describedby=\{\s*approvalDisabledReason/);
  assert.match(source, /data-od-id="approval-blocker"/);
});

test("manual match reload failures reject while successful reloads stay on Details", () => {
  const match = sourceSection(
    "const reloadAfterManualMatch",
    "const handleExclude",
  );
  const responseCheck = match.indexOf("if (!response.ok)");
  const applyReload = match.indexOf("applyMutationBoq");
  const closeTarget = match.indexOf("setCatalogMatchTarget(null)");
  const catchBlock = match.indexOf("catch (error)");

  assert.ok(responseCheck >= 0);
  assert.ok(applyReload > responseCheck);
  assert.ok(closeTarget > applyReload);
  assert.ok(catchBlock > closeTarget);
  assert.match(match.slice(catchBlock), /throw error;/);
  // setMatching(false) must be INSIDE the finally block body. The regex
  // /finally\s*\{[^}]*setMatching\(false\)/ requires that no closing
  // brace appears between "finally {" and the call, so it fails if the
  // call were moved after the finally block closes.
  assert.match(
    match,
    /finally\s*\{[^}]*setMatching\(false\)/,
    "setMatching(false) must be inside the finally block",
  );
  // No redirect after matching — the user stays on Details.
  assert.doesNotMatch(match, /router\.(push|replace)/);
});

test("compare-origin Details navigation has a safe manual recovery path", () => {
  // The validated returnTo remains the preferred destination; the direct
  // compare fallback is only used when returnTo is absent.
  assert.match(source, /returnTo \?\? compareBoqHref\(id\)/);
  assert.match(source, /href=\{backHref\}/);
});

test("direct BOQ Details exposes a safe Back to Compare fallback", () => {
  assert.match(source, /compareBoqHref/);
  assert.match(source, /backHref=\{returnTo \?\? compareBoqHref\(id\)\}/);
  assert.match(
    source,
    /backLabel=\{returnTo \? "Back to comparison" : "Back to Compare"\}/,
  );
});

test("BOQ Details remains the canonical catalog action workspace", () => {
  assert.match(source, /onAiSuggest=/);
  assert.match(source, /onDismissSuggestion=/);
  assert.match(source, /onFindMatch=/);
  assert.match(source, /onExclude=/);
  assert.match(source, /CatalogMatchModal/);
  assert.match(source, /catalogReadiness\.blocking/);
});

test("load and approval failures stay on Details with recovery controls", () => {
  assert.match(source, /Couldn’t load this BOQ/);
  assert.match(source, /onClick=\{\(\) => void fetchBoq\(\)\}/);
  assert.match(source, /Failed to approve BOQ/);
  assert.match(source, /setApproving\(false\)/);
});
