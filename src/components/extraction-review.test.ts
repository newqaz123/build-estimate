import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";

const componentUrl = new URL("./extraction-review.tsx", import.meta.url);
const detailUrl = new URL(
	"../app/(authenticated)/boqs/[id]/page.tsx",
	import.meta.url,
);

test("focused extraction review renders evidence, reconciliation, source navigation, and deliberate decisions", () => {
	assert.equal(existsSync(componentUrl), true);
	if (!existsSync(componentUrl)) return;
	const source = readFileSync(componentUrl, "utf8");
	assert.match(source, /Original source/);
	assert.match(source, /Proposed structure/);
	assert.match(source, /Validation & reconciliation/);
	assert.match(source, /Accept all validated high-confidence/);
	// Updated to match new tab-based proposal rendering
	assert.match(source, /isComplete.*canAccept.*Accept/);
	assert.match(source, /Add missing item/);
	assert.match(source, /Replace item/);
	assert.match(source, /Remove non-item row/);
	assert.match(source, /one combined BOQ row/);
	// Updated to match new reject confirmation flow
	assert.match(source, /handleReject.*proposal/);
	assert.match(source, />Reject\{/);
	assert.match(source, />Undo\{/);
	// Updated to match new recheck button naming
	assert.match(source, /Review this row with AI/);
	assert.match(source, /onNavigateToEvidence/);
	assert.match(source, /remainingCandidateRowIds/);
	assert.match(source, /extraction-review-technical-details/);
	assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
});

test("canonical detail switches only the right pane and no longer mounts the legacy review panel", () => {
	const source = readFileSync(detailUrl, "utf8");
	assert.match(source, /type RightPaneMode = "items" \| "extraction"/);
	assert.match(source, /<ExtractionReview/);
	assert.doesNotMatch(readFileSync(componentUrl, "utf8"), /Back to BOQ items/);
	assert.doesNotMatch(source, /onBack=\{/);
	assert.match(source, /requestedPage=/);
	assert.match(source, /onNavigateToEvidence=/);
	assert.doesNotMatch(source, /role="tablist"/);
	assert.doesNotMatch(source, /boq-right-pane-mode/);
	assert.doesNotMatch(source, /id="boq-items-tab"/);
	assert.doesNotMatch(source, /id="boq-extraction-tab"/);
	assert.equal((source.match(/setRightPaneMode\(/g) ?? []).length, 1);
	assert.match(source, /rightPaneMode === "items" \? "extraction" : "items"/);
	assert.match(
		source,
		/aria-controls=\{\s*rightPaneMode === "items"\s*\?\s*"boq-extraction-panel"\s*:\s*"boq-items-panel"\s*\}/,
	);
	assert.match(
		source,
		/id="boq-items-panel"\s+hidden=\{rightPaneMode !== "items"\}/,
	);
	assert.match(
		source,
		/id="boq-extraction-panel"\s+hidden=\{rightPaneMode !== "extraction"\}/,
	);
	assert.match(source, /Add missing item/);
	assert.match(source, /\/items`,\s*\{[\s\S]{0,120}?method: "POST"/);
	assert.doesNotMatch(source, /import \{ ReviewPanel \}/);
	assert.doesNotMatch(source, /<ReviewPanel/);
	assert.equal((source.match(/<PdfReviewViewer/g) ?? []).length, 1);
});

test("explicit AI rechecks are forced and follow-up rows expose readable labels and in-flight feedback", () => {
	const source = readFileSync(componentUrl, "utf8");
	assert.match(source, /force:\s*true/);
	assert.match(source, /requestedSourceRowId/);
	assert.match(source, /Checking…/);
	assert.match(source, /const sourceRowLabels = useMemo/);
	assert.match(source, /sourceReferenceLabel\(reference\)/);
	assert.match(source, /Row \$\{index \+ 1\}/);
	// Updated to match new button naming
	assert.match(source, /Review this row with AI/);
});

test("extraction review filters derive per-chip counts from displayed results and disable empty categories", () => {
	const source = readFileSync(componentUrl, "utf8");
	// Filter counts are still calculated internally for technical use
	assert.match(source, /const filterCounts = useMemo/);
	assert.match(
		source,
		/selectReviewVisibility\(review, statuses, filter\.value\)/,
	);
	// The filter chip UI is replaced by tabs, but technical logic remains
	assert.match(source, /selectEffectiveFilter/);
	assert.match(source, /Candidate source rows without proposals/);
	assert.match(source, /selectExtractionReviewOutcome/);
	assert.match(source, /extractionReviewOutcomeTitle/);
	assert.match(source, /extractionReviewOutcomeMessage/);
	assert.match(source, /rejectionLabelGroups/);
	assert.match(source, /reviewProgress\.progressText/);
	assert.doesNotMatch(source, /reviewTitle/);
});

test("active extraction review chip uses pale accent with dark text instead of white accent-on", () => {
	const css = readFileSync(
		new URL("../app/globals.css", import.meta.url),
		"utf8",
	);
	assert.match(
		css,
		/\.extraction-review-filters \.filter-chip\.active[\s\S]*?color:\s*var\(--fg\)/,
	);
	assert.match(
		css,
		/\.extraction-review-filters \.filter-chip\.active[\s\S]*?color-mix\(in oklab, var\(--accent\) 12%[^)]+\)/,
	);
	const section = css.slice(
		css.indexOf(".extraction-review-filters"),
		css.indexOf(".extraction-review-filters") + 500,
	);
	assert.doesNotMatch(section, /--accent-on/);
});

test("compare review reuses the standalone extraction review instead of a duplicate controller", () => {
	const source = readFileSync(
		new URL("./review-panel.tsx", import.meta.url),
		"utf8",
	);
	assert.match(source, /<ExtractionReview/);
	assert.equal((source.match(/runExtractionReview/g) ?? []).length, 0);
});

test("approved review receives a read-only contract", () => {
	const source = readFileSync(detailUrl, "utf8");
	assert.match(source, /readOnly=\{isReadOnly\}/);
	assert.match(readFileSync(componentUrl, "utf8"), /readOnly/);
});

test("unsaved detail and compare edits block structural extraction mutations until Save draft", () => {
	const componentSource = readFileSync(componentUrl, "utf8");
	const detailSource = readFileSync(detailUrl, "utf8");
	const compareSource = readFileSync(
		new URL("./review-panel.tsx", import.meta.url),
		"utf8",
	);
	assert.match(componentSource, /mutationBlockedReason\?: string/);
	assert.match(
		componentSource,
		/mutationBlockedReason && \(action === "accept" \|\| action === "undo"\)/,
	);
	assert.match(componentSource, /Save draft to continue/);
	assert.match(
		componentSource,
		/disabled=\{readOnly \|\| Boolean\(mutationBlockedReason\)/,
	);
	assert.match(
		detailSource,
		/mutationBlockedReason=\{\s*invalidDraftKeys\.size > 0\s*\?/,
	);
	assert.match(detailSource, /:\s*pendingChanges > 0\s*\?/);
	assert.match(
		detailSource,
		/Component costs contain invalid drafts\. Fix them before applying extraction corrections\./,
	);
	assert.match(
		detailSource,
		/You have unsaved BOQ item or detail edits\. Use Save draft before applying extraction corrections\./,
	);
	assert.match(
		compareSource,
		/const reviewDirty = reviewFingerprint !== savedReviewFingerprint/,
	);
	assert.match(compareSource, /mutationBlockedReason=\{reviewDirty \? /);
	assert.match(compareSource, /Save draft<\/Button>/);
	assert.match(compareSource, /status: "draft"/);
});

test("accepted and undone actions reload durable LIFO Undo eligibility", () => {
	const source = readFileSync(componentUrl, "utf8");
	assert.match(source, /const refreshStoredReview = useCallback/);
	assert.match(
		source,
		/action === "accept" \|\| action === "undo"[\s\S]*?await refreshStoredReview\(\)/,
	);
	assert.match(
		source,
		/proposal_status", proposalId, status: "accepted", canUndo: false/,
	);
	assert.doesNotMatch(
		source,
		/bulkProposalIds\.forEach\(\(proposalId\) => dispatch\(\{ type: "proposal_status", proposalId, status: "accepted" \}\)\)/,
	);
});

test("a saved canonical revision reloads durable staleness without dispatching another provider review", () => {
	const componentSource = readFileSync(componentUrl, "utf8");
	const detailSource = readFileSync(detailUrl, "utf8");
	const compareSource = readFileSync(
		new URL("./review-panel.tsx", import.meta.url),
		"utf8",
	);
	assert.match(componentSource, /canonicalRevisionKey: string/);
	assert.match(
		componentSource,
		/canonicalRevisionRef\.current !== canonicalRevisionKey/,
	);
	assert.match(
		componentSource,
		/canonicalRevisionRef\.current = canonicalRevisionKey[\s\S]*?void refreshStoredReview\(\)/,
	);
	assert.match(componentSource, /reviewSnapshotGenerationRef/);
	assert.match(
		componentSource,
		/beginReviewSnapshotRequest\(reviewSnapshotGenerationRef\)/,
	);
	assert.match(
		componentSource,
		/isLatestReviewSnapshotRequest\(reviewSnapshotGenerationRef, requestGeneration\)/,
	);
	assert.match(
		componentSource,
		/invalidateReviewSnapshotRequests\(reviewSnapshotGenerationRef\)/,
	);
	assert.match(componentSource, /Canonical BOQ changed\. Recheck with AI/);
	assert.match(
		detailSource,
		/const canonicalRevisionKey = useMemo\(\s*\(\) => buildCanonicalRevisionKey\(boq\),\s*\[boq\],?\s*\)/,
	);
	assert.match(detailSource, /canonicalRevisionKey=\{canonicalRevisionKey\}/);
	assert.match(
		compareSource,
		/const \[canonicalRevisionKey, setCanonicalRevisionKey\] = useState\(\(\) => buildCanonicalRevisionKey\(boq\)\)/,
	);
	assert.match(
		compareSource,
		/setCanonicalRevisionKey\(buildCanonicalRevisionKey\(updated\)\)/,
	);
	assert.match(compareSource, /canonicalRevisionKey=\{canonicalRevisionKey\}/);
});

test("compare approval cannot start while a draft or item mutation is in flight", () => {
	const source = readFileSync(
		new URL("./review-panel.tsx", import.meta.url),
		"utf8",
	);
	assert.match(
		source,
		/const handleApprove = async \(\) => \{\s*if \(busy \|\| verification\.hasBlockingIssues\) return/,
	);
	assert.match(
		source,
		/onClick=\{handleApprove\} disabled=\{busy \|\| verification\.hasBlockingIssues/,
	);
});

test("responsive review follows the 920px and 520px Open Design breakpoints", () => {
	const css = readFileSync(
		new URL("../app/globals.css", import.meta.url),
		"utf8",
	);
	assert.match(
		css,
		/@media \(max-width: 920px\)[\s\S]*?\.review-body[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/,
	);
	assert.match(
		css,
		/@media \(max-width: 520px\)[\s\S]*?\.extraction-proposal-footer/,
	);
});

test("blocked diagnostics are hidden behind a collapsed technical-details section, not inline jargon", () => {
	const source = readFileSync(componentUrl, "utf8");
	// Reject diagnostics render only inside a collapsible <details>, not in the default result-counts
	assert.match(source, /extraction-review-technical-details/);
	assert.match(source, /Technical details/);
	// The inline result-counts no longer carry 'unsafe suggestion' jargon
	assert.doesNotMatch(
		source,
		/unsafe suggestion\{[^}]*\} blocked by server validation/,
	);
});

test("technical-details fallback renders when rejectedProposalCount exists without rejectionCounts", () => {
	const source = readFileSync(componentUrl, "utf8");
	// When blockedGroups is empty but rejectedProposalCount > 0, a fallback diagnostic renders
	assert.match(source, /detailed breakdown was not retained/);
	// The condition is gated on rejectedProposalCount, not blockedGroups.length
	assert.match(source, /rejectedCount === 0/); // guard
	assert.match(source, /blockedGroups\.length > 0/); // fallback branch
});

test("dirty-draft warning uses concise actionable wording", () => {
	const source = readFileSync(componentUrl, "utf8");
	assert.match(source, /Save draft to continue/);
});

test("detail page renders the grouped extraction notes component instead of a flat list", () => {
	const detailSource = readFileSync(detailUrl, "utf8");
	assert.match(
		detailSource,
		/<ExtractionWarnings\s+warnings=\{boq\.extractionWarnings\}/,
	);
	// The old flat repetitive mapping is gone
	assert.doesNotMatch(
		detailSource,
		/extractionWarnings\.map\(\(warning, index\) => <span[^>]*>\{warning\.message\}<\/span>\)/,
	);
});

test("needs_human_review proposals expose Review & add but never render Accept", () => {
	const source = readFileSync(componentUrl, "utf8");
	// A focused editor opens for source-backed needs_human_review proposals.
	// JSX escapes the ampersand as &amp; in source; accept either form.
	assert.match(source, /Review &amp; add|Review & add/);
	assert.match(source, /setEditingProposalId/);
	assert.match(source, /editingProposalId/);
	assert.match(source, /SourceBackedItemEditor/);
	// The Accept gate stays strict: needs_human_review never appears in the accept branch.
	assert.match(source, /humanReview && proposal\.reviewDraft && !readOnly/);
	// The mutation posts editable values only to the source-item route.
	assert.match(source, /\/add-source-item/);
	// The payload comes from the editor's validated builder; only the route + body shape live here.
	assert.match(source, /body: JSON\.stringify\(payload\)/);
	// After success, the BOQ is refreshed and a confirmation toast renders.
	assert.match(source, /BOQ item added from reviewed source\./);
	// The needs_human_review branch is never made directly acceptable.
	assert.doesNotMatch(
		source,
		/proposalCanBeAccepted\(proposal\) && humanReview/,
	);
});

test("Task 8: reject confirmation flow shows dialog before posting to endpoint", () => {
	const source = readFileSync(componentUrl, "utf8");
	// Reject opens a confirmation dialog with specific wording
	assert.match(
		source,
		/Reject this suggestion\? It will not be added to the BOQ\./,
	);
	assert.match(source, /Confirm reject/);
	// The dialog should have a confirmation button
	assert.match(source, /setRejectConfirmProposalId/);
	// There should be state to track which proposal is being confirmed
	assert.match(source, /rejectConfirmProposalId/);
	// The actual reject endpoint is only called after confirmation
	assert.match(source, /handleConfirmedReject/);
	// Reject button triggers the dialog, not the direct endpoint
	assert.match(source, /handleReject.*proposal/);
});

test("Task 8: Review source button navigates to evidence focus with page, table, row, cells", () => {
	const source = readFileSync(componentUrl, "utf8");
	// Review source button exists
	assert.match(source, /Review source/);
	// onNavigateToEvidence is used instead of onNavigateToPage
	assert.match(source, /onNavigateToEvidence/);
	// Evidence focus is created from source data
	assert.match(source, /const evidenceFocus/);
	// SourceEvidence component receives onNavigateToEvidence
	assert.match(source, /onNavigateToEvidence=/);
});

test("Task 8: tabs render as Needs your review and History only", () => {
	const source = readFileSync(componentUrl, "utf8");
	// selectReviewTab is imported
	assert.match(source, /selectReviewTab/);
	// Tab state exists
	assert.match(source, /state\.tab/);
	// Set tab action exists
	assert.match(source, /set_tab.*tab/);
	// Tabs render with specific labels
	assert.match(source, /Needs your review/);
	assert.match(source, /History/);
	// Tab switching uses set_tab
	assert.match(source, /onClick=\{.*\(\) => dispatch\(\{ type: "set_tab"/);
});

test("Task 8: pending complete proposals show Validated suggestion and Accept/Reject", () => {
	const source = readFileSync(componentUrl, "utf8");
	// Pending complete proposals show the "Validated suggestion" label
	assert.match(source, /Validated suggestion — ready for your approval/);
	// Complete proposals show Accept, Review source, and Reject buttons
	assert.match(source, /isComplete.*canAccept.*Accept/);
	assert.match(source, /Review source/);
	assert.match(source, /Reject/);
});

test("Task 8: pending incomplete proposals show More information needed and Skip, no Accept", () => {
	const source = readFileSync(componentUrl, "utf8");
	// Incomplete proposals show "More information needed" label
	assert.match(source, /More information needed/);
	// Incomplete proposals show Review source and Skip
	assert.match(source, /Review source/);
	assert.match(source, /Skip/);
	// Incomplete proposals have logic to prevent Accept
	assert.match(source, /isComplete.*canAccept/);
});

test("Task 8: skip posts to durable skip endpoint and moves to History", () => {
	const source = readFileSync(componentUrl, "utf8");
	// Skip endpoint is called
	assert.match(source, /executeAction.*skip/);
	// Skip is only shown for incomplete proposals
	assert.match(source, /isIncomplete.*Skip/);
	// After skip, the proposal moves to History tab
	assert.match(source, /await refreshStoredReview\(\)/);
});

test("Task 8: renamed recheck buttons use new wording", () => {
	const source = readFileSync(componentUrl, "utf8");
	// Global recheck button is now "Review all flagged rows with AI"
	assert.match(source, /Review all flagged rows with AI/);
	// Per-row recheck is now "Review this row with AI"
	assert.match(source, /Review this row with AI/);
	// Remaining rows group is now "Rows needing review"
	assert.match(source, /Rows needing review/);
});

test("Task 8: Review source is pure viewer navigation with no AI fetch", () => {
	const source = readFileSync(componentUrl, "utf8");
	// Review source only calls onNavigateToEvidence
	assert.match(source, /onNavigateToEvidence\(evidenceFocus\)/);
	// Review source does NOT call runReview or any AI endpoint
	assert.doesNotMatch(source, /Review source.*runReview/);
	// Review source button is separate from recheck button
	assert.match(source, /Review source/);
	assert.match(source, /Review this row with AI/);
});

test("Task 8: undo moves item back to Needs your review only after server response", () => {
	const source = readFileSync(componentUrl, "utf8");
	// Undo calls the undo endpoint
	assert.match(source, /executeAction.*undo/);
	// Undo waits for refreshStoredReview() after the endpoint call
	assert.match(source, /action === "undo".*await refreshStoredReview\(\)/);
	// Undo does NOT optimistically update local state
	assert.doesNotMatch(
		source,
		/dispatch.*type: "proposal_status".*status: "undone"/,
	);
});

test("Task 8: filter chips are removed and tabs are the only navigation", () => {
	const source = readFileSync(componentUrl, "utf8");
	// The old filter-chip row should be gone
	assert.doesNotMatch(source, /extraction-review-filters.*filter-chip/);
	// Tabs are the only user-facing navigation
	assert.match(source, /role="tablist"/);
	assert.match(source, /role="tab"/);
	// selectReviewTab is used to determine tab content
	assert.match(source, /selectReviewTab\(\{ review.*proposalStatuses/);
});

test("Task 9: session-expired recovery detects 401 and shows sign-in link", () => {
	const source = readFileSync(componentUrl, "utf8");
	// Component should detect 401 responses
	assert.match(source, /response\.status === 401/);
	// Session-expired state should be managed
	assert.match(source, /sessionExpired|session-expired/);
	// Exact session-expired message should be rendered
	assert.match(
		source,
		/Your session has expired\. Sign in again to continue reviewing this BOQ\./,
	);
	// Sign in again link should be present
	assert.match(source, /Sign in again/);
	// Link should use safeReviewReturnPath
	assert.match(source, /safeReviewReturnPath/);
	// returnTo query parameter should be used
	assert.match(source, /returnTo=/);
	// 401 detection should happen before error parsing
	assert.match(source, /response\.status === 401[\s\S]*?readError/);
	// All mutation paths should check for 401: accept, reject, undo, skip
	assert.match(source, /executeAction[\s\S]*?response\.status === 401/);
	// AI review fetch should check for 401
	assert.match(source, /runReview[\s\S]*?response\.status === 401/);
	// Review snapshot GET should check for 401
	assert.match(
		source,
		/fetch.*\/review[\s\S]*?response\.ok[\s\S]*?response\.status === 401/,
	);
	// add-source-item should check for 401
	assert.match(
		source,
		/submitSourceBackedItem[\s\S]*?response\.status === 401/,
	);
	// accept-batch should check for 401
	assert.match(source, /acceptAll[\s\S]*?response\.status === 401/);
});
