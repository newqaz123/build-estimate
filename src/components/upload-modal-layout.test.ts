import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const uploadSource = readFileSync(
	new URL("./upload-modal.tsx", import.meta.url),
	"utf8",
);
const dialogSource = readFileSync(
	new URL("./ui/dialog.tsx", import.meta.url),
	"utf8",
);
const appCss = readFileSync(
	new URL("../app/globals.css", import.meta.url),
	"utf8",
);
const sharedCss = readFileSync(
	new URL("../styles/globals.css", import.meta.url),
	"utf8",
);

test("Upload BOQ delegates viewport centering only to shared DialogContent", () => {
	const uploadClasses = uploadSource.match(
		/<DialogContent[\s\S]*?className="([^"]*\bupload-modal\b[^"]*)"/,
	)?.[1];
	assert.ok(uploadClasses, "Upload BOQ DialogContent classes must be present");
	assert.equal(
		uploadClasses.split(/\s+/).includes("modal"),
		false,
		"Upload BOQ must not inherit the legacy .modal transform contract",
	);

	assert.match(
		dialogSource,
		/fixed top-1\/2 left-1\/2[\s\S]*-translate-x-1\/2 -translate-y-1\/2/,
	);

	const uploadRule = appCss.match(/\.upload-modal\s*\{([^}]*)\}/)?.[1];
	assert.ok(uploadRule, "scoped .upload-modal rule must be present");
	assert.doesNotMatch(uploadRule, /\b(?:transform|translate)\s*:/);
	assert.doesNotMatch(
		appCss,
		/\.upload-modal\[data-open\]\s*\{[^}]*\b(?:transform|translate)\s*:/,
	);
	assert.doesNotMatch(
		sharedCss,
		/\[data-slot="dialog-content"\]\.upload-modal/,
	);
});

test("Upload BOQ keeps its existing visual and inner-scroll layout", () => {
	const uploadRule = appCss.match(/\.upload-modal\s*\{([^}]*)\}/)?.[1] ?? "";

	assert.match(uploadRule, /background:\s*var\(--surface\)/);
	assert.match(uploadRule, /border-radius:\s*var\(--radius-lg\)/);
	assert.match(uploadRule, /box-shadow:\s*var\(--elev-raised\)/);
	assert.match(uploadRule, /width:\s*min\(520px,\s*calc\(100vw - 32px\)\)/);
	assert.match(uploadRule, /max-height:\s*min\(80vh,\s*720px\)/);
	assert.match(uploadRule, /display:\s*flex/);
	assert.match(uploadRule, /flex-direction:\s*column/);
	assert.match(uploadRule, /padding:\s*0/);
	assert.match(uploadRule, /gap:\s*0/);

	assert.match(uploadSource, /className="modal-header"/);
	assert.match(uploadSource, /className="modal-body upload-modal-body"/);
	assert.match(uploadSource, /className="modal-footer"/);
	assert.match(appCss, /\.modal-body\s*\{[^}]*overflow-y:\s*auto/);
});
