/**
 * Pure, testable magnifier placement helper for the BOQ preflight page selector.
 *
 * Given the cursor/focus anchor, the viewport size, and the measured popup size,
 * returns a fixed `{left, top}` that is guaranteed to keep the popup fully on
 * screen on both axes. No CSS `transform` is needed — callers apply the values
 * directly to a `position: fixed` element.
 *
 * Horizontal: prefer placing the popup to the right of the anchor; flip left
 * when there is not enough room. Then clamp into the safe viewport margin.
 *
 * Vertical: center the popup on the anchor, then clamp so it never overflows
 * the top or bottom viewport edge.
 */

export interface Point {
	x: number;
	y: number;
}

export interface Size {
	width: number;
	height: number;
}

export const MAGNIFIER_GAP = 16;
export const MAGNIFIER_PADDING = 8;

export interface MagnifierPlacementInput {
	anchor: Point;
	viewport: Size;
	popup: Size;
	gap?: number;
	padding?: number;
}

export interface MagnifierPlacement {
	left: number;
	top: number;
}

function clamp(value: number, min: number, max: number): number {
	if (max < min) return min;
	return Math.min(Math.max(value, min), max);
}

export function computeMagnifierPlacement(
	input: MagnifierPlacementInput,
): MagnifierPlacement {
	const {
		anchor,
		viewport,
		popup,
		gap = MAGNIFIER_GAP,
		padding = MAGNIFIER_PADDING,
	} = input;

	// --- Horizontal ---
	// Prefer right of the anchor unless there is not enough room.
	const roomRight = viewport.width - anchor.x - gap;
	const preferRight = roomRight >= popup.width;
	const preferredLeft = preferRight
		? anchor.x + gap
		: anchor.x - gap - popup.width;

	// Clamp into [padding, viewport.width - popup.width - padding].
	// If the popup is wider than the viewport, max < min, so we floor at padding.
	const hMax = Math.max(padding, viewport.width - popup.width - padding);
	const left = clamp(preferredLeft, padding, hMax);

	// --- Vertical ---
	// Center the popup on the anchor.
	const centeredTop = anchor.y - popup.height / 2;
	const vMax = Math.max(padding, viewport.height - popup.height - padding);
	const top = clamp(centeredTop, padding, vMax);

	return { left, top };
}
