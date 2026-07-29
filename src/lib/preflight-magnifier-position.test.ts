import assert from "node:assert/strict";
import test from "node:test";

import {
	computeMagnifierPlacement,
	MAGNIFIER_GAP,
	MAGNIFIER_PADDING,
} from "@/lib/preflight-magnifier-position";

test("narrow 320px viewport keeps popup fully on-screen", () => {
	// CSS constrains popup width to min(320px, 100vw - 16px) = 304px in a 320px viewport.
	const cssConstrainedWidth = 320 - MAGNIFIER_GAP;
	const result = computeMagnifierPlacement({
		anchor: { x: 160, y: 300 },
		viewport: { width: 320, height: 600 },
		popup: { width: cssConstrainedWidth, height: 300 },
	});
	// left >= padding (8) and right <= 320 - 8 = 312
	assert.ok(result.left >= MAGNIFIER_PADDING, `left ${result.left} < padding`);
	assert.ok(
		result.left + cssConstrainedWidth <= 320 - MAGNIFIER_PADDING,
		`right ${result.left + cssConstrainedWidth} > ${320 - MAGNIFIER_PADDING}`,
	);
	// top/bottom within bounds
	assert.ok(result.top >= MAGNIFIER_PADDING);
	assert.ok(result.top + 300 <= 600 - MAGNIFIER_PADDING);
});

test("anchor near right edge flips left when space permits", () => {
	// Cursor at x=900 in a 1000px viewport with a 320px popup.
	// roomRight = 1000 - 900 - 16 = 84 < 320 → flips left.
	const result = computeMagnifierPlacement({
		anchor: { x: 900, y: 400 },
		viewport: { width: 1000, height: 800 },
		popup: { width: 320, height: 400 },
	});
	assert.ok(
		result.left < 900,
		`expected left-flip but got left=${result.left}`,
	);
	assert.ok(result.left >= MAGNIFIER_PADDING);
	assert.ok(result.left + 320 <= 1000 - MAGNIFIER_PADDING);
});

test("anchor near left keeps popup on right side", () => {
	// Cursor at x=50 in a 1000px viewport — roomRight = 934 >= 320 → right side.
	const result = computeMagnifierPlacement({
		anchor: { x: 50, y: 400 },
		viewport: { width: 1000, height: 800 },
		popup: { width: 320, height: 400 },
	});
	assert.ok(result.left > 50, `expected right-side placement`);
	assert.ok(result.left + 320 <= 1000 - MAGNIFIER_PADDING);
});

test("tall popup near top stays within bottom bound", () => {
	const result = computeMagnifierPlacement({
		anchor: { x: 400, y: 20 },
		viewport: { width: 1000, height: 600 },
		popup: { width: 320, height: 500 },
	});
	assert.ok(result.top >= MAGNIFIER_PADDING, `top ${result.top} < padding`);
	// bottom = top + 500 <= 600 - 8 = 592
	assert.ok(
		result.top + 500 <= 600 - MAGNIFIER_PADDING,
		`bottom ${result.top + 500} > ${600 - MAGNIFIER_PADDING}`,
	);
});

test("tall popup near bottom clamps within top bound", () => {
	const result = computeMagnifierPlacement({
		anchor: { x: 400, y: 580 },
		viewport: { width: 1000, height: 600 },
		popup: { width: 320, height: 500 },
	});
	assert.ok(result.top >= MAGNIFIER_PADDING, `top ${result.top} < padding`);
	assert.ok(
		result.top + 500 <= 600 - MAGNIFIER_PADDING,
		`bottom ${result.top + 500} > ${600 - MAGNIFIER_PADDING}`,
	);
});

test("popup taller than viewport clamps at padding", () => {
	const result = computeMagnifierPlacement({
		anchor: { x: 400, y: 300 },
		viewport: { width: 1000, height: 300 },
		popup: { width: 320, height: 600 },
	});
	// viewport too small for popup; top floors at padding (CSS max-height handles shrinking)
	assert.equal(result.top, MAGNIFIER_PADDING);
	assert.ok(result.left >= MAGNIFIER_PADDING);
});

test("popup wider than viewport clamps left at padding", () => {
	const result = computeMagnifierPlacement({
		anchor: { x: 50, y: 300 },
		viewport: { width: 280, height: 600 },
		popup: { width: 320, height: 300 },
	});
	assert.equal(result.left, MAGNIFIER_PADDING);
});
