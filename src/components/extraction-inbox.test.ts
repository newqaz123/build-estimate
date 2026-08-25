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
