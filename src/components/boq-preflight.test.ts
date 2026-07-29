import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

test.describe("BoqPreflight component", () => {
	const preflightSource = readFileSync(
		new URL("./boq-preflight.tsx", import.meta.url),
		"utf8",
	);

	const globalCssPath = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"styles",
		"globals.css",
	);

	test("BoqPreflight component exists and exports correctly", () => {
		assert.match(preflightSource, /export function BoqPreflight/);
		assert.match(preflightSource, /preflight:\s*PreflightUpload/);
		assert.match(preflightSource, /onExtract:\s*\([^)]*\)\s*=>/);
		assert.match(preflightSource, /onCancel:\s*\([^)]*\)\s*=>/);
	});

	test("BoqPreflight renders page thumbnails with accessible labels", () => {
		assert.match(preflightSource, /buildAccessibleLabel/);
		assert.match(preflightSource, /Page \$\{pageInfo\.page\}/);
		assert.match(preflightSource, /role="button"/);
		assert.match(preflightSource, /aria-label=/);
	});

	test("BoqPreflight pre-selects suggested pages and allows toggle", () => {
		assert.match(preflightSource, /useState/);
		assert.match(preflightSource, /preflight\.pages\s*\.\s*filter/);
		assert.match(preflightSource, /toggleSelection/);
	});

	test("BoqPreflight renders client-side page previews from the local PDF file", () => {
		// Server never generates preview PNGs; thumbnails/magnifier come from the
		// browser File still held by UploadModal (pdfjs webpack entry, same as review viewer).
		assert.match(preflightSource, /sourceFile:\s*File/);
		assert.match(preflightSource, /pdfjs-dist\/webpack\.mjs/);
		assert.match(preflightSource, /createObjectURL\(sourceFile\)/);
		assert.match(preflightSource, /toDataURL/);
		assert.match(preflightSource, /preflight-thumbnail-image/);
		assert.doesNotMatch(preflightSource, /\/api\/boqs\/preflight\/.*?preview/);
	});

	test("BoqPreflight magnifier follows the pointer and avoids center/clip", () => {
		// Tracks pointer coordinates from the thumbnail, not centered.
		assert.match(preflightSource, /onMouseMove=/);
		assert.match(preflightSource, /setMagnifierPos|magnifierPos/);
		// Viewport-aware clamping: both viewport dimensions are read.
		assert.match(preflightSource, /window\.innerWidth/);
		assert.match(preflightSource, /window\.innerHeight/);
		// Focus without a prior mouse move still shows the magnifier.
		assert.match(preflightSource, /getBoundingClientRect/);
		// Uses the measured pure placement helper, not inline midpoint guesses.
		assert.match(
			preflightSource,
			/computeMagnifierPlacement/,
		);
		assert.match(preflightSource, /preflight-magnifier-position/);
		// Magnifier content still present.
		assert.match(preflightSource, /preflight-magnifier/);
		assert.match(preflightSource, /Magnified Page/);
		assert.match(preflightSource, /role="img"/);
		assert.match(preflightSource, /preflight-magnifier-image/);
		// CSS: viewport-anchored (fixed), not centered, no transform.
		const css = readFileSync(globalCssPath, "utf8");
		assert.match(css, /\.preflight-magnifier\s*\{[^}]*position:\s*fixed/);
		assert.match(css, /\.preflight-magnifier\s*\{[^}]*max-width:\s*calc\(100vw - 16px\)/);
		assert.match(css, /\.preflight-magnifier\s*\{[^}]*max-height:\s*calc\(100vh - 16px\)/);
		assert.match(css, /\.preflight-magnifier-image\s*\{[^}]*object-fit:\s*contain/);
		assert.doesNotMatch(
			css,
			/\.preflight-magnifier\s*\{[^}]*transform:\s*translate/,
		);
	});

	test("BoqPreflight disables extract button when no pages selected", () => {
		assert.match(preflightSource, /selectedPages\.length === 0/);
		assert.match(preflightSource, /Select at least one page to continue/);
		assert.match(preflightSource, /disabled.*?selectedPages\.length === 0/);
	});

	test("BoqPreflight shows correct count in extract button", () => {
		assert.match(preflightSource, /Extract.*?selected page/);
		assert.match(preflightSource, /selectedPages\.length/);
	});
});
