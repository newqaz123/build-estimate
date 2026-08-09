export interface CatalogMatchCandidate {
	id: string;
	description: string;
	unit: string;
	aliases: string[];
	score: number;
	unitCompatible: boolean;
	matchReason: "exact" | "alias" | "fuzzy";
}

type CatalogEntry = {
	id: string;
	description: string;
	unit: string;
	aliases?: string[];
};

const DASH_AND_PUNCTUATION = /[‐‑‒–—―−\-]|[^\p{L}\p{N}\s/²³µ]/gu;

function collapseWhitespace(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function normalizeUnitKey(value: string): string {
	return collapseWhitespace(
		value
			.toLowerCase()
			.replace(DASH_AND_PUNCTUATION, " ")
			.replace(/\s*\/\s*/g, "/"),
	);
}

export function normalizeCatalogText(value: string): string {
	return collapseWhitespace(
		value
			.toLowerCase()
			.replace(/[‐‑‒–—―−\-]/g, " ")
			.replace(/[^\p{L}\p{N}\s/]/gu, " "),
	);
}

function tokenize(value: string): string[] {
	return normalizeCatalogText(value).split(" ").filter(Boolean);
}

function uniqueNormalized(values: string[] | undefined): string[] {
	if (!values || values.length === 0) return [];
	const seen = new Set<string>();
	const normalized: string[] = [];

	for (const value of values) {
		const text = normalizeCatalogText(value);
		if (!text || seen.has(text)) continue;
		seen.add(text);
		normalized.push(text);
	}

	return normalized;
}

export function canonicalUnit(
	unit: string,
	unitMap: Record<string, string>,
): string {
	const normalized = normalizeUnitKey(unit);
	const mapped =
		unitMap[normalized] ?? unitMap[unit] ?? unitMap[unit.toLowerCase()];

	return mapped ? normalizeUnitKey(mapped) : normalized;
}

export function unitsCompatible(
	itemUnit: string,
	catalogUnit: string,
	unitMap: Record<string, string>,
): boolean {
	return (
		canonicalUnit(itemUnit, unitMap) === canonicalUnit(catalogUnit, unitMap)
	);
}

function tokenOverlapScore(
	searchTokens: string[],
	targetTokens: string[],
): number {
	if (searchTokens.length === 0 || targetTokens.length === 0) return 0;

	const target = new Set(targetTokens);
	let matches = 0;
	for (const token of searchTokens) {
		if (target.has(token)) matches++;
	}

	if (matches === 0) return 0;

	const coverage = matches / Math.max(searchTokens.length, targetTokens.length);
	return Math.round(coverage * 75);
}

function scoreCandidate(
	searchText: string,
	candidateText: string,
	aliases: string[],
): { score: number; reason: "exact" | "alias" | "fuzzy" } {
	if (candidateText === searchText) {
		return { score: 300, reason: "exact" };
	}

	if (aliases.includes(searchText)) {
		return { score: 200, reason: "alias" };
	}

	const allCandidates = [candidateText, ...aliases];
	const searchTokens = tokenize(searchText);
	let bestOverlap = 0;
	for (const candidate of allCandidates) {
		bestOverlap = Math.max(
			bestOverlap,
			tokenOverlapScore(searchTokens, tokenize(candidate)),
		);
	}

	if (bestOverlap === 0) {
		return { score: 0, reason: "fuzzy" };
	}

	return { score: 100 + bestOverlap, reason: "fuzzy" };
}

/**
 * Pure description/alias score shared by ranking and local shortlisting.
 * Does not apply unit compatibility boosts.
 */
export function scoreCatalogTextMatch(
	description: string,
	candidateDescription: string,
	aliases: string[] = [],
): { score: number; reason: "exact" | "alias" | "fuzzy" } {
	const searchText = normalizeCatalogText(description);
	const candidateText = normalizeCatalogText(candidateDescription);
	const normalizedAliases = uniqueNormalized(aliases);
	return scoreCandidate(searchText, candidateText, normalizedAliases);
}

export function rankCatalogMatches(
	description: string,
	unit: string,
	catalog: Array<CatalogEntry>,
	unitMap: Record<string, string>,
): CatalogMatchCandidate[] {
	if (catalog.length === 0) return [];

	const searchText = normalizeCatalogText(description);
	const candidates = catalog.map((entry) => {
		const normalizedDescription = normalizeCatalogText(entry.description);
		const normalizedAliases = uniqueNormalized(entry.aliases);
		const unitCompatible = unitsCompatible(unit, entry.unit, unitMap);
		const { score: baseScore, reason } = scoreCandidate(
			searchText,
			normalizedDescription,
			normalizedAliases,
		);
		const score =
			baseScore > 0 && unitCompatible ? baseScore + 1000 : baseScore;

		return {
			id: entry.id,
			description: entry.description,
			unit: entry.unit,
			aliases: normalizedAliases,
			score,
			unitCompatible,
			matchReason: reason,
		};
	});

	return candidates.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		const descriptionComparison = a.description.localeCompare(b.description);
		if (descriptionComparison !== 0) return descriptionComparison;
		return a.id.localeCompare(b.id);
	});
}
