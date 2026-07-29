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
const estimatorSource = readFileSync(
	new URL("../app/(authenticated)/estimator/page.tsx", import.meta.url),
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

	assert.match(dialogSource, /dialog-content fixed top-1\/2 left-1\/2/);
	assert.match(
		appCss,
		/\.dialog-content\s*\{\s*translate:\s*-50%\s*-50%;\s*\}/,
		"shared DialogContent must own viewport centering explicitly",
	);
	assert.doesNotMatch(
		dialogSource,
		/-translate-x-1\/2|-translate-y-1\/2/,
		"shared DialogContent must not compose a second centering transform",
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

test("shared dialogs remain separate from the legacy modal contract", () => {
	const sharedDialogClasses = dialogSource.match(
		/<DialogPrimitive\.Popup[\s\S]*?className=\{cn\(\s*"([^"]*)"/,
	)?.[1];
	assert.ok(
		sharedDialogClasses,
		"shared DialogContent classes must be present",
	);
	assert.equal(
		sharedDialogClasses.split(/\s+/).includes("modal"),
		false,
		"shared DialogContent must not inherit the legacy .modal contract",
	);

	const uploadClasses = uploadSource.match(
		/<DialogContent[\s\S]*?className="([^"]*\bupload-modal\b[^"]*)"/,
	)?.[1];
	assert.ok(uploadClasses, "Upload BOQ DialogContent classes must be present");
	assert.equal(uploadClasses.split(/\s+/).includes("modal"), false);

	assert.doesNotMatch(
		`${appCss}\n${sharedCss}`,
		/\[data-slot=["']dialog-content["']\]\.modal/,
		"the removed generic DialogContent legacy-modal override must stay absent",
	);

	const legacyModalRule = appCss.match(/\.modal\s*\{([^}]*)\}/)?.[1];
	assert.ok(legacyModalRule, "legacy .modal rule must remain present");
	assert.match(legacyModalRule, /background:\s*var\(--surface\)/);
	assert.match(legacyModalRule, /display:\s*flex/);
	assert.match(legacyModalRule, /flex-direction:\s*column/);
	assert.match(legacyModalRule, /transform:\s*translateY\(8px\)/);
	assert.match(
		appCss,
		/\.modal-overlay\.open \.modal\s*\{\s*transform:\s*translateY\(0\);?\s*\}/,
	);
	assert.match(
		estimatorSource,
		/className="modal estimator-item-modal"/,
		"estimator must retain its plain legacy modal",
	);
});

test("Upload BOQ keeps its existing visual and inner-scroll layout", () => {
	const uploadRule = appCss.match(/\.upload-modal\s*\{([^}]*)\}/)?.[1] ?? "";

	assert.match(uploadRule, /background:\s*var\(--surface\)/);
	assert.match(uploadRule, /border-radius:\s*var\(--radius-lg\)/);
	assert.match(uploadRule, /box-shadow:\s*var\(--elev-raised\)/);
	assert.match(uploadRule, /width:\s*min\(520px,\s*calc\(100vw - 32px\)\)/);
	assert.match(uploadRule, /max-height:\s*calc\(100dvh - 32px\)/);
	assert.match(uploadRule, /overflow:\s*hidden/);
	assert.match(
		appCss,
		/\.upload-modal:has\(\.preflight-container\)\s*\{[^}]*height:\s*min\(720px,\s*calc\(100dvh - 32px\)\)/,
	);
	assert.match(uploadRule, /display:\s*flex/);
	assert.match(uploadRule, /flex-direction:\s*column/);
	assert.match(uploadRule, /padding:\s*0/);
	assert.match(uploadRule, /gap:\s*0/);

	assert.match(uploadSource, /className="modal-header"/);
	assert.match(uploadSource, /className="modal-body upload-modal-body"/);
	assert.match(uploadSource, /className="modal-footer"/);
	assert.match(appCss, /\.modal-body\s*\{[^}]*overflow-y:\s*auto/);
	const uploadBodyRule =
		appCss.match(/\.upload-modal-body\s*\{([^}]*)\}/)?.[1] ?? "";
	assert.match(uploadBodyRule, /flex:\s*1 1 auto/);
	assert.match(uploadBodyRule, /min-height:\s*0/);
	assert.match(uploadBodyRule, /overflow-y:\s*auto/);
	assert.match(
		appCss,
		/\.upload-modal-body:has\(> \.preflight-container\)\s*\{[^}]*overflow:\s*hidden/,
	);
	const uploadFooterRule =
		appCss.match(/\.upload-modal \.modal-footer\s*\{([^}]*)\}/)?.[1] ?? "";
	assert.match(uploadFooterRule, /margin:\s*0/);
	assert.match(
		uploadFooterRule,
		/padding:\s*var\(--space-4\) var\(--space-5\)/,
	);
	assert.match(sharedCss, /\.preflight-actions\s*\{[^}]*flex-wrap:\s*wrap/);
	assert.match(sharedCss, /\.preflight-buttons\s*\{[^}]*flex-wrap:\s*wrap/);
});
