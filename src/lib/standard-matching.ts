export interface CatalogMatchCandidate {
	id: string;
	description: string;
	unit: string;
	aliases: string[];
	score: number;
	unitCompatible: boolean;
	matchReason: "exact" | "alias" | "fuzzy";
	/** Size/spec categories that agree with the search (e.g. size, schedule). */
	specAgreements?: string[];
	/** Set when a size/spec token contradicts the search; such candidates score 0. */
	specConflict?: boolean;
}

import {
	builtinUnit,
	canonicalSizeWords,
	catalogSpecTokens,
	compareSpecTokens,
	extractSpecTokens,
	normalizeThai,
	segmentThaiWords,
	type SpecTokens,
} from "./catalog-text";

type CatalogEntry = {
	id: string;
	description: string;
	unit: string;
	aliases?: string[];
};

// Thai vowel/tone marks (\p{M}) are part of the unit, not punctuation.
const DASH_AND_PUNCTUATION = /[‐‑‒–—―−\-]|[^\p{L}\p{M}\p{N}\s/²³µ]/gu;

function collapseWhitespace(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function normalizeUnitKey(value: string): string {
	return collapseWhitespace(
		normalizeThai(value)
			.toLowerCase()
			.replace(DASH_AND_PUNCTUATION, " ")
			.replace(/\s*\/\s*/g, "/"),
	);
}

/**
 * Lowercase, NFC (Thai sara am recomposed), punctuation to spaces. Thai vowel
 * and tone marks are kept, decimal points inside numbers are kept ("0.47"),
 * and an inch mark after a number becomes " in" so sizes survive.
 */
export function normalizeCatalogText(value: string): string {
	return collapseWhitespace(
		normalizeThai(value)
			.toLowerCase()
			.replace(/(\d)\s*(?:"|”|'')/g, "$1 in ")
			.replace(/[‐‑‒–—―−\-]/g, " ")
			.replace(/(\d)\.(?=\d)/g, "$1\u0000")
			.replace(/[^\p{L}\p{M}\p{N}\s/\u0000]/gu, " ")
			.replace(/\u0000/g, "."),
	);
}

/** English trade abbreviations folded to one spelling for word overlap. */
const WORD_SYNONYMS: Record<string, string> = {
	reducer: "reduce",
	reducing: "reduce",
	concentric: "con",
	conc: "con",
	eccentric: "ecc",
	elbows: "elbow",
	deg: "",
	degree: "",
	degrees: "",
	องศา: "",
	pipes: "pipe",
	flanges: "flange",
	valves: "valve",
};

/** Word tokens: Thai runs split with Intl.Segmenter, sizes canonicalised (2B = 2" = DN50 -> 2in). */
function tokenize(value: string): string[] {
	const text = segmentThaiWords(canonicalSizeWords(normalizeCatalogText(value)));
	return text
		.split(" ")
		.map((token) => WORD_SYNONYMS[token] ?? token)
		.filter(Boolean);
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

/**
 * Comparison key for unit compatibility: the workspace canonical unit folded
 * through the built-in synonyms (ea/No./pcs/ตัว, set/ชุด, lot/LS/เหมา,
 * m/เมตร, m2/ตร.ม., m3/ลบ.ม., kg/กก., bag/ถุง). canonicalUnit itself keeps the
 * workspace's own spelling because it is also a display and grouping key.
 */
export function unitMatchKey(
	unit: string,
	unitMap: Record<string, string>,
): string {
	const canonical = canonicalUnit(unit, unitMap);
	return builtinUnit(canonical) ?? canonical;
}

export function unitsCompatible(
	itemUnit: string,
	catalogUnit: string,
	unitMap: Record<string, string>,
): boolean {
	return unitMatchKey(itemUnit, unitMap) === unitMatchKey(catalogUnit, unitMap);
}

/**
 * OCR often drops a space ("existingroof"). A search word that is exactly two
 * neighbouring target words glued together is split back into those words.
 */
function splitGluedTokens(searchTokens: string[], targetTokens: string[]): string[] {
	const target = new Set(targetTokens);
	const out: string[] = [];
	for (const token of searchTokens) {
		let split: string[] | null = null;
		if (!target.has(token)) {
			for (let i = 0; i < targetTokens.length - 1; i++) {
				if (targetTokens[i]! + targetTokens[i + 1]! === token) {
					split = [targetTokens[i]!, targetTokens[i + 1]!];
					break;
				}
			}
		}
		out.push(...(split ?? [token]));
	}
	return out;
}

/** Words that say what is done, not what it is done to; they never decide the item. */
const GENERIC_WORDS = new Set([
	"and", "with", "for", "the", "of", "to", "in", "on", "at", "by", "from", "per", "all",
	"new", "old", "existing", "type", "work", "works", "include", "including", "included",
	"supply", "install", "installation", "installing", "take", "off", "remove", "removal",
	"dismantle", "provide", "complete", "set", "lot", "item", "items", "misc", "other",
	"dia", "diameter", "size",
]);

function editDistance(a: string, b: string): number {
	if (Math.abs(a.length - b.length) > 2) return 3;
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		previous = current;
	}
	return previous[b.length]!;
}

/** A typo of the same word ("roofinf"/"roofing"); short words must be one edit apart so pipe/pump still clash. */
function sameWordTypo(a: string, b: string): boolean {
	const distance = editDistance(a, b);
	return distance <= 1 || (distance <= 2 && Math.min(a.length, b.length) >= 6);
}

function keyWords(tokens: string[]): string[] {
	return tokens.filter((token) => /^\p{L}[\p{L}\p{M}]+$/u.test(token) && token.length >= 3 && !GENERIC_WORDS.has(token));
}

/**
 * The key noun/material must agree: when the search has a key word the candidate
 * lacks AND the candidate has a key word the search lacks ("roof" vs "pipe"), the
 * two rows are most likely different things. Returns the clashing words, or null
 * when the description or any alias agrees.
 */
export function keyWordConflict(
	description: string,
	candidateDescription: string,
	aliases: string[] = [],
): { search: string[]; candidate: string[] } | null {
	const searchTokens = tokenize(description);
	let first: { search: string[]; candidate: string[] } | null = null;
	for (const target of [candidateDescription, ...aliases]) {
		const targetTokens = tokenize(target);
		const search = splitGluedTokens(searchTokens, targetTokens);
		const searchSet = new Set(search);
		const targetSet = new Set(targetTokens);
		const rawSearch = keyWords(search).filter((token) => !targetSet.has(token));
		const targetKeyWords = keyWords(targetTokens);
		// A target with no key words at all (sizes only, short Thai) neither agrees nor clashes.
		if (targetKeyWords.length === 0 && aliases.length > 0) continue;
		const rawCandidate = targetKeyWords.filter((token) => !searchSet.has(token));
		const leftSearch = rawSearch.filter((token) => !rawCandidate.some((other) => sameWordTypo(token, other)));
		const leftCandidate = rawCandidate.filter((token) => !rawSearch.some((other) => sameWordTypo(token, other)));
		if (leftSearch.length === 0 || leftCandidate.length === 0) return null;
		first ??= { search: leftSearch, candidate: leftCandidate };
	}
	return first;
}

function tokenOverlapScore(
	rawSearchTokens: string[],
	targetTokens: string[],
): number {
	if (rawSearchTokens.length === 0 || targetTokens.length === 0) return 0;
	const searchTokens = splitGluedTokens(rawSearchTokens, targetTokens);

	const target = new Set(targetTokens);
	let matches = 0;
	for (const token of searchTokens) {
		if (target.has(token)) matches++;
	}

	if (matches === 0) return 0;

	const coverage = matches / Math.max(searchTokens.length, targetTokens.length);
	return Math.round(coverage * 75);
}

// One point per agreeing size/spec: enough to order siblings, never enough on its
// own to lift an unrelated item over the suggestion threshold.
const SPEC_AGREEMENT_BOOST = 1;

type TextScore = {
	score: number;
	reason: "exact" | "alias" | "fuzzy";
	specAgreements: string[];
	specConflict: boolean;
};

/**
 * Text score with size/spec gating: a contradicting size or spec (2B vs 4B,
 * SUS304 vs SUS316, Sch10S vs Sch40, 0.47 vs 0.35 mm) rejects the candidate,
 * and each agreeing one adds a boost that also breaks ties between siblings.
 */
function scoreWithSpecs(
	searchText: string,
	searchSpecs: SpecTokens,
	candidateText: string,
	aliases: string[],
): TextScore {
	const base = scoreCandidate(searchText, candidateText, aliases);
	if (base.score === 0) return { ...base, specAgreements: [], specConflict: false };
	const { conflicts, agreements } = compareSpecTokens(
		searchSpecs,
		catalogSpecTokens(candidateText, aliases),
	);
	if (conflicts.length > 0) {
		return { score: 0, reason: base.reason, specAgreements: agreements, specConflict: true };
	}
	return {
		// Exact and alias hits keep their fixed tiers; only similar matches are boosted.
		score:
			base.reason === "fuzzy"
				? base.score + agreements.length * SPEC_AGREEMENT_BOOST
				: base.score,
		reason: base.reason,
		specAgreements: agreements,
		specConflict: false,
	};
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
	const { score, reason } = scoreWithSpecs(
		searchText,
		extractSpecTokens(searchText),
		candidateText,
		normalizedAliases,
	);
	return { score, reason };
}

export function rankCatalogMatches(
	description: string,
	unit: string,
	catalog: Array<CatalogEntry>,
	unitMap: Record<string, string>,
): CatalogMatchCandidate[] {
	if (catalog.length === 0) return [];

	const searchText = normalizeCatalogText(description);
	const searchSpecs = extractSpecTokens(searchText);
	const candidates = catalog.map((entry) => {
		const normalizedDescription = normalizeCatalogText(entry.description);
		const normalizedAliases = uniqueNormalized(entry.aliases);
		const unitCompatible = unitsCompatible(unit, entry.unit, unitMap);
		const {
			score: baseScore,
			reason,
			specAgreements,
			specConflict,
		} = scoreWithSpecs(
			searchText,
			searchSpecs,
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
			specAgreements,
			specConflict,
		};
	});

	return candidates.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		const descriptionComparison = a.description.localeCompare(b.description);
		if (descriptionComparison !== 0) return descriptionComparison;
		return a.id.localeCompare(b.id);
	});
}
