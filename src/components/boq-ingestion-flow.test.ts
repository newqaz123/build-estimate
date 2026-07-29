import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";

const uploadSource = readFileSync(
	new URL("./upload-modal.tsx", import.meta.url),
	"utf8",
);
const reviewSource = readFileSync(
	new URL("./review-panel.tsx", import.meta.url),
	"utf8",
);
const pdfViewerSource = readFileSync(
	new URL("./pdf-review-viewer.tsx", import.meta.url),
	"utf8",
);
const dataTableSource = readFileSync(
	new URL("./proto-data-table.tsx", import.meta.url),
	"utf8",
);
const standardizationSource = readFileSync(
	new URL("./standardization-review.tsx", import.meta.url),
	"utf8",
);
const boqsPageSource = readFileSync(
	new URL("../app/(authenticated)/boqs/page.tsx", import.meta.url),
	"utf8",
);
const boqDetailSource = readFileSync(
	new URL("../app/(authenticated)/boqs/[id]/page.tsx", import.meta.url),
	"utf8",
);
const unifiedItemsSource = readFileSync(
	new URL("./unified-boq-items-table.tsx", import.meta.url),
	"utf8",
);

test("BOQ upload uses the atomic multipart import API and consumes its returned BOQ", () => {
	assert.doesNotMatch(uploadSource, /MOCK_PARSED_ITEMS/);
	assert.match(uploadSource, /fetch\("\/api\/boqs\/import"/);
	assert.match(uploadSource, /formData\.append\("file", file\)/);
	assert.doesNotMatch(uploadSource, /\/api\/docling\/parse/);
	assert.doesNotMatch(uploadSource, /fetch\("\/api\/boqs"/);
	assert.match(uploadSource, /const boq = \(?await response\.json\(\)\)? as Boq/);
	assert.match(uploadSource, /onUploadComplete\(boq\)/);
});

test("atomic BOQ import route accepts multipart input without a browser-side sidecar upload", () => {
	const routeUrl = new URL("../app/api/boqs/import/route.ts", import.meta.url);
	const handlerUrl = new URL(
		"../app/api/boqs/import/handler.ts",
		import.meta.url,
	);
	assert.equal(existsSync(routeUrl), true);
	assert.equal(existsSync(handlerUrl), true);
	const routeSource = readFileSync(routeUrl, "utf8");
	const handlerSource = readFileSync(handlerUrl, "utf8");
	assert.match(routeSource, /createImportHandler/);
	assert.match(handlerSource, /await request\.formData\(\)/);
	assert.doesNotMatch(uploadSource, /sidecarForm\.append/);
});

test("BOQ upload reads a categorized safe API error", () => {
	assert.match(uploadSource, /await readError\(response,/);
	assert.match(uploadSource, /typeof body\.error === "string"/);
});

test("BOQ upload rejects invalid files with actionable feedback and has no unpersisted notes field", () => {
	assert.match(uploadSource, /onDropRejected/);
	assert.match(uploadSource, /uploadRejectionMessage/);
	assert.doesNotMatch(uploadSource, /boqNotes|Notes \(optional\)/);
});

test("review embeds the authenticated source PDF and does not manufacture source content", () => {
	assert.match(
		reviewSource,
		/`\/api\/boqs\/\$\{encodeURIComponent\(boq\.id\)\}\/source`/,
	);
	assert.match(reviewSource, /<PdfReviewViewer[^>]+sourceUrl=\{sourceUrl\}/);
	assert.match(pdfViewerSource, /href=\{sourceUrl\}/);
	assert.match(pdfViewerSource, /Open PDF/);
	assert.match(pdfViewerSource, /Retry preview/);
	assert.match(reviewSource, /No source PDF is available for this legacy BOQ/);
	assert.doesNotMatch(reviewSource, /pdfZoom|ZoomIn|ZoomOut/);
	assert.doesNotMatch(
		reviewSource,
		/Sino-Thai|Ratchaphruek|GRAND TOTAL|Prepared by/,
	);
});

test("review exposes only normalized editable fields and derived approval blockers", () => {
	assert.doesNotMatch(reviewSource, />Code<|Code for item/);
	assert.doesNotMatch(reviewSource, />Type<|Type for item/);
	assert.match(reviewSource, /buildReviewVerification/);
	assert.match(reviewSource, /useMemo/);
	assert.match(reviewSource, /value="Unclassified"/);
	assert.match(reviewSource, /verification\.hasBlockingIssues/);
	assert.match(reviewSource, /localWarnings/);
	assert.match(reviewSource, /buildReviewFingerprint/);
	assert.match(reviewSource, /key=\{reviewItemKey\(boq\.id, item, idx\)\}/);
});

test("review verification request preserves intentional option exclusions", () => {
	assert.match(
		reviewSource,
		/excludedFromTotal:\s*item\.excludedFromTotal\s*===\s*true/,
	);
	assert.match(reviewSource, /optional:\s*item\.optional\s*===\s*true/);
});

test("review distinguishes completed AI verification from actionable local fallback", () => {
	assert.match(reviewSource, /boqId: boq\.id/);
	assert.match(reviewSource, /extractionWarnings:/);
	assert.match(reviewSource, /sourceTotal: boq\.sourceTotal/);
	assert.match(reviewSource, /response\.json\(\)/);
	assert.match(reviewSource, /mode === "ai"/);
	assert.match(reviewSource, /Verified with AI/);
	assert.match(reviewSource, /Retry AI verification/);
	assert.match(reviewSource, /verificationResult\.issues\.length/);
	assert.match(reviewSource, /<ul[^>]+aria-label="Verification findings"/);
	assert.match(reviewSource, /issue\.severity/);
	assert.match(reviewSource, /verificationIssueTarget/);
	assert.match(reviewSource, /parseVerificationApiResponse/);
	assert.doesNotMatch(reviewSource, /messages:\s*\[/);
});

test("standardization review hides legacy item codes while retaining normalized matching", () => {
	assert.doesNotMatch(standardizationSource, /\{item\.code\}/);
	assert.match(standardizationSource, /normalizeDesc\(item\.desc\)/);
	assert.match(standardizationSource, /s\.unit\.toLowerCase\(\) === itemUnit/);
});

test("BOQ list uses the shared behavior-tested CSV builder", () => {
	assert.match(boqsPageSource, /buildBoqCsv\(boq\)/);
});

test("BOQ detail totals use the shared pricing calculator after applying edits", () => {
	assert.match(boqDetailSource, /calculateBoqTotals/);
	assert.doesNotMatch(boqDetailSource, /contributesToBoqTotal/);
	assert.match(boqDetailSource, /parseNonNegativeBoqEditValue/);
	assert.match(unifiedItemsSource, /min="0"/);
});

test("a failed review save reports the safe error without resetting edited items", () => {
	const approveSource = reviewSource.slice(
		reviewSource.indexOf("const handleApprove"),
	);
	const catchBlock =
		approveSource.match(/catch \(error\) \{([\s\S]*?)\} finally \{/)?.[1] ?? "";
	assert.match(catchBlock, /setSaveError\(message\)/);
	assert.doesNotMatch(
		catchBlock,
		/setItems|setVendor|setProject|setWorkType|setDate/,
	);
});

test("shared data table accepts accessible labels used by the BOQ page", () => {
	assert.match(dataTableSource, /ariaLabel\?: string/);
	assert.match(dataTableSource, /dataOdId\?: string/);
	assert.match(dataTableSource, /aria-label=\{ariaLabel\}/);
});

test("upload-modal posts to preflight endpoint and renders BoqPreflight", () => {
	assert.match(uploadSource, /BoqPreflight/);
	assert.match(uploadSource, /fetch\("\/api\/boqs\/preflight"/);
	assert.match(uploadSource, /formData\.append\("file", file\)/);
	assert.match(
		uploadSource,
		/const preflightData = \(?await response\.json\(\)\)? as PreflightUpload/,
	);
	assert.match(uploadSource, /setPreflight\(preflightData\)/);
	assert.match(uploadSource, /onExtract=\{/);
	assert.match(uploadSource, /sourceFile=\{file\}/);
});

test("preflight-then-import submits confirmed pages to consume endpoint", () => {
	assert.match(
		uploadSource,
		/formData\.append\("preflightId", preflight\.id\)/,
	);
	assert.match(
		uploadSource,
		/formData\.append\("pages", JSON\.stringify\(pages\)\)/,
	);
	assert.match(uploadSource, /\/api\/boqs\/import/);
	assert.match(uploadSource, /setImportError\(/);
});

test("page selector is preserved when import fails", () => {
	assert.match(uploadSource, /const \[preflight, setPreflight\]/);
	assert.match(uploadSource, /setImportError\(/);
	assert.match(uploadSource, /importError &&/);
	// Check that preflight is not cleared on error - verify error message is displayed and state is preserved
	const handleExtractSection = uploadSource.slice(
		uploadSource.indexOf("const handleExtract"),
	);
	// Verify error handling sets importError
	assert.match(handleExtractSection, /setImportError\(errorMessage\)/);
	assert.match(handleExtractSection, /toast\.error\(errorMessage\)/);
	// The catch block should not reset preflight
	const catchContent =
		handleExtractSection.match(/catch \([^)]+\) \{([\s\S]*?)\} finally/)?.[1] ??
		"";
	assert.doesNotMatch(catchContent, /setPreflight\(null\)/);
});
