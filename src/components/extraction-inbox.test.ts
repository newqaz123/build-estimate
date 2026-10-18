import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const review = readFileSync(
	new URL("./extraction-review.tsx", import.meta.url),
	"utf8",
);
const page = readFileSync(
	new URL("../app/(authenticated)/boqs/[id]/page.tsx", import.meta.url),
	"utf8",
);
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

test("extraction review reports pending inbox count to the page", () => {
	assert.match(review, /onInboxCountChange\?/);
	assert.match(review, /inboxPendingCount\(/);
});

test("page header uses Missed rows and BOQ items", () => {
	assert.match(page, /Missed rows/);
	assert.match(page, /BOQ items/);
	assert.doesNotMatch(page, /Extraction Suggestions/);
});

test("inbox uses Inbox/Done labels and a compact NOW/NEXT list", () => {
	assert.match(review, />Inbox</);
	assert.match(review, />Done</);
	assert.match(review, /NOW/);
	assert.match(review, /NEXT/);
	assert.match(review, /Missed rows/);
	assert.doesNotMatch(review, /Compound-cell extraction/);
	assert.match(review, /source lines are not in this BOQ yet/);
});

test("proposal evidence grid is behind a closed Details disclosure", () => {
	assert.match(review, /<details/);
	assert.match(review, />Details</);
	assert.doesNotMatch(review, /Hide evidence/);
});

test("NOW article is keyed by proposal id so Details remounts closed", () => {
	assert.match(review, /<article\s+key=\{proposal\.id\}/);
});

test("Add to BOQ is gated by proposalCanBeReviewedAndAdded and Skip is labeled Not an item", () => {
	assert.match(review, /Add to BOQ/);
	assert.match(review, /Not an item/);
	assert.match(review, /Mark all as not items/);
	assert.match(review, /unpricedInboxGroupIds/);
	assert.match(review, /This source line has no usable price/);
	assert.doesNotMatch(review, />Skip</);
	assert.doesNotMatch(review, /Review & add/);
});

test("grouped not-an-item uses sequential existing skip posts", () => {
	assert.match(review, /executeAction\([^,]+,\s*"skip"\)/);
	assert.doesNotMatch(review, /skip-batch/);
});

test("inbox editor mount requires the same chipAllowsAdd gate as the Add to BOQ button", () => {
	assert.match(
		review,
		/editingProposalId === proposal\.id\s*&&\s*humanReview\s*&&\s*canReviewAndAdd\s*&&\s*chipAllowsAdd\s*\?/,
	);
});

test("Mark all as not items renders only on the needs-review tab and disables read-only", () => {
	assert.match(
		review,
		/state\.tab === "needs-review"\s*&&\s*unpricedGroupIds\.length > 0/,
	);
	assert.match(
		review,
		/data-od-id="inbox-mark-unpriced"[\s\S]*?disabled=\{busy \|\| readOnly\}/,
	);
});

test("mobile inbox switches between list and detail panes via Back to list", () => {
	assert.match(
		review,
		/const \[inboxPane, setInboxPane\] = useState<"list" \| "detail">\("list"\)/,
	);
	assert.match(review, /data-pane=\{inboxPane\}/);
	assert.match(review, /setInboxPane\("detail"\)/);
	assert.match(review, /setInboxPane\("list"\)/);
	assert.match(review, />\s*Back to list\s*</);
	assert.match(review, /className="extraction-inbox-list"/);
	assert.match(review, /className="extraction-inbox-detail"/);
});

test("empty inbox shows the no missed rows copy", () => {
	assert.match(review, /No missed rows\./);
	assert.match(
		review,
		/Every leftover source line is marked not an item or already represented\./,
	);
});

test("no missed rows copy is gated on a loaded review", () => {
	assert.match(review, /review && inboxPending === 0\s*\?/);
});

test("stale proposals are excluded from the Inbox list projection", () => {
	assert.match(
		review,
		/const inboxRows = tabProposals\.filter\(\(proposal\) => state\.tab !== "needs-review" \|\| proposal\.stale !== true\)\.map\(/,
	);
	assert.match(review, /if \(inboxRows\.length === 0\) return null;?/);
});

test("skipped Done rows restore through the existing reopen endpoint", () => {
	assert.match(review, /const restoreProposal = useCallback/);
	assert.match(
		review,
		/proposals\/\$\{encodeURIComponent\(proposal\.id\)\}\/reopen/,
	);
	assert.match(review, /status === "skipped"[\s\S]*?Restore/);
});

test("open-row copy uses the reason chip and keeps technical validation in Details", () => {
	assert.match(
		review,
		/<span className="extraction-operation">\s*\{INBOX_CHIP_LABEL\[openRow\.chip\]\}\s*<\/span>/,
	);
	assert.match(
		review,
		/canAccept\s*\?\s*"Validated suggestion — ready for your approval"\s*:\s*null/,
	);
	const detailsStart = review.indexOf(
		'<details className="extraction-inbox-details">',
	);
	const validationSummary = review.indexOf(
		'<div className="extraction-validation-summary">',
	);
	const detailsEnd = review.indexOf("</details>", detailsStart);
	assert.ok(detailsStart >= 0 && validationSummary > detailsStart);
	assert.ok(detailsEnd > validationSummary);
	assert.doesNotMatch(review, /Needs human review/);
});

test("Not an item renders and dispatches only for proposals the server can skip", () => {
	assert.match(
		review,
		/const canSkip = !status && proposalCanBeSkipped\(proposal\);/,
	);
	assert.match(
		review,
		/\{canSkip \? \(\s*<Button[\s\S]*?void executeAction\(proposal, "skip"\)[\s\S]*?Not an item/,
	);
	assert.match(
		review,
		/if \(action === "skip" && !proposalCanBeSkipped\(proposal\)\) return false;/,
	);
});

test("grouped not-an-item selection and dispatch reuse the single-row skip gate", () => {
	assert.match(review, /status: statuses\[proposal\.id\],\s*sourceRef,/);
	assert.match(
		review,
		/const unpricedGroupIds = unpricedInboxGroupIds\(inboxRows\);/,
	);
	assert.match(
		review,
		/if \(!row \|\| !proposalCanBeSkipped\(row\.proposal\)\) continue;\s*const ok = await executeAction\(row\.proposal, "skip"\);\s*if \(!ok\) break;/,
	);
});

test("unpriced not-an-item guidance shows only when the open row can be skipped", () => {
	assert.match(
		review,
		/canSkip &&\s*\(openRow\.chip === "no_price" \|\| openRow\.chip === "quote_total"\)\s*\?\s*"This source line has no usable price/,
	);
});

test("Accept shows the deterministic outcome and complete legacy rows fall back to source review", () => {
	assert.match(
		review,
		/const acceptOutcome = proposalAcceptOutcomeLabel\(proposal\);/,
	);
	assert.match(
		review,
		/\{canAccept && acceptOutcome \? \(\s*<span className="extraction-action-status">\{acceptOutcome\}<\/span>/,
	);
	assert.match(
		review,
		/\) : isComplete \? null : \(\s*<span className="extraction-action-status">\s*Review source in Details\s*<\/span>/,
	);
});

test("mobile CSS hides one inbox pane at a time via data-pane", () => {
	assert.match(
		css,
		/\.extraction-inbox\[data-pane="list"\]\s*\.extraction-inbox-detail\s*\{\s*display:\s*none;\s*\}/,
	);
	assert.match(
		css,
		/\.extraction-inbox\[data-pane="detail"\]\s*\.extraction-inbox-list\s*\{\s*display:\s*none;\s*\}/,
	);
});
