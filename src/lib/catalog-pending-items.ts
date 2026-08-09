import type { Boq, BoqPricedItem } from "./boq-schema";
import { isCatalogPricedItem } from "./boq-catalog-readiness";
import {
	buildUnifiedBoqSections,
	isPricedUnifiedBoqRow,
	type UnifiedBoqPricedRow,
} from "./boq-unified-rows";

/**
 * A priced BOQ item is catalog-pending when it still blocks approval: it is a
 * positive-rate priced item that is neither resolved by a standard match nor
 * excluded. This mirrors the blocking rows of {@link getBoqCatalogReadiness}.
 */
function isCatalogPendingItem(item: BoqPricedItem): boolean {
	if (!isCatalogPricedItem(item)) return false;
	if (item.stdStatus === "matched" && item.stdId?.trim()) return false;
	if (item.stdStatus === "excluded") return false;
	return true;
}

/**
 * Returns the catalog-pending subset of a BOQ as unified priced rows: positive-
 * rate priced items that are still unmatched or pending (not resolved by a
 * catalog match id and not excluded). Informational bundle children and zero/
 * negative-rate rows are excluded. Mirrors {@link getBoqCatalogReadiness}
 * blocking semantics so the result can drive the Stage 2 readiness context.
 */
export function catalogPendingItems(
	boq: Pick<Boq, "sections">,
): UnifiedBoqPricedRow[] {
	return buildUnifiedBoqSections(boq.sections)
		.flatMap((section) => section.rows)
		.filter(isPricedUnifiedBoqRow)
		.filter((row) => isCatalogPendingItem(row.item));
}
