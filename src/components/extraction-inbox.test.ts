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
