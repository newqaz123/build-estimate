import type { Boq } from "./boq-schema";
import {
	getBoqItemRequestIdentity,
	resolveBoqItemIdentity,
} from "./boq-item-identity";
import { isPricedBoqItem } from "./boq-pricing";

export type BoqDetailEdits = Record<
	string,
	Record<string, string | number | undefined>
>;

export interface BoqMutationReconciliation {
	boq: Boq;
	edits: BoqDetailEdits;
}

const DOCUMENT_TOTAL_TOLERANCE = 0.01;

function formatBaht(value: number): string {
	return `฿${value.toLocaleString("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})}`;
}

export function documentTotalMismatchMessage(
	sourceTotal: number | undefined,
	itemTotal: number,
): string | null {
	if (
		sourceTotal === undefined ||
		!Number.isFinite(sourceTotal) ||
		!Number.isFinite(itemTotal)
	)
		return null;
	const difference = Math.abs(sourceTotal - itemTotal);
	if (difference <= DOCUMENT_TOTAL_TOLERANCE) return null;
	return `Source total ${formatBaht(sourceTotal)}; BOQ items ${formatBaht(
		itemTotal,
	)}; difference ${formatBaht(difference)}.`;
}

function matchedStandardizationChanged(
	previous: Boq["sections"][number]["items"][number],
	incoming: Boq["sections"][number]["items"][number],
): boolean {
	if (incoming.stdStatus !== "matched" || !incoming.stdId?.trim()) return false;
	if (!isPricedBoqItem(previous) || !isPricedBoqItem(incoming)) return false;
	return (
		previous.stdStatus !== incoming.stdStatus ||
		previous.stdId !== incoming.stdId ||
		previous.stdMatch !== incoming.stdMatch ||
		previous.stdConfidence !== incoming.stdConfidence ||
		previous.desc !== incoming.desc ||
		previous.unit !== incoming.unit
	);
}

export function reconcileBoqMutation(
	previous: Boq,
	incoming: Boq,
	edits: BoqDetailEdits,
): BoqMutationReconciliation {
	const sourceAvailable =
		typeof incoming.sourceAvailable === "boolean"
			? incoming.sourceAvailable
			: previous.sourceAvailable;
	const reconciledBoq =
		sourceAvailable === undefined ? incoming : { ...incoming, sourceAvailable };
	let reconciledEdits = edits;

	previous.sections.forEach((section, sectionIndex) => {
		const incomingSection = incoming.sections[sectionIndex];
		if (!incomingSection) return;

		section.items.forEach((previousItem, itemIndex) => {
			const resolution = resolveBoqItemIdentity(
				incomingSection.items,
				getBoqItemRequestIdentity(previousItem),
			);
			if (resolution.status !== "found") return;
			const incomingItem = incomingSection.items[resolution.index];
			if (
				!incomingItem ||
				!matchedStandardizationChanged(previousItem, incomingItem)
			)
				return;

			const key = `${sectionIndex}-${itemIndex}`;
			const rowEdits = edits[key];
			if (
				!rowEdits ||
				(rowEdits.desc === undefined && rowEdits.unit === undefined)
			)
				return;
			if (reconciledEdits === edits) reconciledEdits = { ...edits };
			const remaining = { ...rowEdits };
			delete remaining.desc;
			delete remaining.unit;
			if (Object.keys(remaining).length > 0) reconciledEdits[key] = remaining;
			else delete reconciledEdits[key];
		});
	});

	return { boq: reconciledBoq, edits: reconciledEdits };
}
