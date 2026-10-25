/**
 * Language-aware text, unit and size/spec helpers shared by every catalog
 * suggestion path (ranking, inline suggestions, the match modal and the
 * candidate shortlist).
 */

const SARA_AM_DECOMPOSED = /\u0e4d\u0e32/g;

/** NFC with Thai sara am recomposed; marks (vowels, tones) are kept. */
export function normalizeThai(value: string): string {
	return value.normalize("NFC").replace(SARA_AM_DECOMPOSED, "\u0e33");
}

const THAI_RUN = /[\u0e00-\u0e7f]+/g;
let thaiSegmenter: Intl.Segmenter | null | undefined;

function segmenter(): Intl.Segmenter | null {
	if (thaiSegmenter === undefined) {
		thaiSegmenter =
			typeof Intl !== "undefined" && "Segmenter" in Intl
				? new Intl.Segmenter("th", { granularity: "word" })
				: null;
	}
	return thaiSegmenter;
}

/** Splits Thai runs (which have no spaces) into dictionary words. */
export function segmentThaiWords(text: string): string {
	const seg = segmenter();
	if (!seg) return text;
	return text.replace(THAI_RUN, (run) =>
		[...seg.segment(run)]
			.filter((part) => part.isWordLike)
			.map((part) => part.segment)
			.join(" "),
	);
}

// ---------------------------------------------------------------- units

const UNIT_SYNONYMS: Record<string, string[]> = {
	ea: ["ea", "each", "no", "nos", "pcs", "pc", "ตัว", "ชิ้น", "อัน"],
	set: ["set", "sets", "ชุด"],
	lot: ["lot", "lots", "ls", "lumpsum", "เหมา", "job"],
	m: ["m", "ม", "เมตร", "meter", "meters", "metre", "metres"],
	m2: ["m2", "sqm", "ตรม", "ตารางเมตร"],
	m3: ["m3", "cum", "ลบม", "ลูกบาศก์เมตร"],
	kg: ["kg", "kgs", "กก", "กิโลกรัม"],
	bag: ["bag", "bags", "ถุง"],
};

/** Case-, space- and punctuation-insensitive unit key ("L/S" -> "ls", "ตร.ม." -> "ตรม"). */
export function unitSynonymKey(unit: string): string {
	return normalizeThai(unit)
		.toLowerCase()
		.replace(/²/g, "2")
		.replace(/³/g, "3")
		.replace(/[^\p{L}\p{M}\p{N}]/gu, "");
}

const UNIT_LOOKUP = new Map<string, string>();
for (const [canonical, variants] of Object.entries(UNIT_SYNONYMS)) {
	for (const variant of variants) UNIT_LOOKUP.set(unitSynonymKey(variant), canonical);
}

/** Built-in canonical unit for a known synonym, or null when the unit is not a known one. */
export function builtinUnit(unit: string): string | null {
	return UNIT_LOOKUP.get(unitSynonymKey(unit)) ?? null;
}

// ---------------------------------------------------------------- size / spec

/** Nominal pipe size: DN (mm) and JIS "A" sizes to inches. */
const DN_TO_INCH: Record<number, number> = {
	6: 0.125, 8: 0.25, 10: 0.375, 15: 0.5, 20: 0.75, 25: 1, 32: 1.25, 40: 1.5,
	50: 2, 65: 2.5, 80: 3, 90: 3.5, 100: 4, 125: 5, 150: 6, 200: 8, 250: 10,
	300: 12, 350: 14, 400: 16, 450: 18, 500: 20, 600: 24,
};

export type SpecCategory = "size" | "material" | "schedule" | "thickness" | "rebar" | "rating" | "process" | "dims";

export type SpecTokens = Partial<Record<SpecCategory, string>>;

const NUM = String.raw`\d+(?:\.\d+)?`;
const INCH_VALUE = String.raw`(?:\d{1,2}[ -]\d+/\d+|\d+/\d+|${NUM})`;
const INCH_SUFFIX = String.raw`(?:\s*(?:b|"|”|''|in|inch|inches|นิ้ว)(?![\p{L}\p{N}]))`;

function inchValue(raw: string): number | null {
	const text = raw.trim();
	const mixed = /^(\d+)[ -](\d+)\/(\d+)$/.exec(text);
	if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
	const fraction = /^(\d+)\/(\d+)$/.exec(text);
	if (fraction) return Number(fraction[1]) / Number(fraction[2]);
	const value = Number(text);
	return Number.isFinite(value) ? value : null;
}

function formatNumber(value: number): string {
	return String(Math.round(value * 1000) / 1000);
}

function sizeList(values: number[]): string {
	return values.map(formatNumber).join("x");
}

/**
 * Extracts comparable size/spec tokens. Works on raw or normalized text:
 * 2B = 2" = 2 inch = 2 นิ้ว = DN50 = 50A; reducers "4B x 2B" / "4x2";
 * SUS304, Sch40, THK 0.47mm / 2.3t, DB12 / RB9, JIS10K, ERW / SMLS.
 */
export function extractSpecTokens(input: string): SpecTokens {
	const text = normalizeThai(input).toLowerCase().replace(/[“”]/g, '"');
	const tokens: SpecTokens = {};
	const sizes: number[] = [];
	const metricThreads: string[] = [];
	let rest = text;

	const take = (pattern: RegExp, handle: (match: RegExpExecArray) => void) => {
		rest = rest.replace(pattern, (...args) => {
			handle(args.slice(0, -2) as unknown as RegExpExecArray);
			return " ";
		});
	};

	// Specs.
	take(/(?<![\p{L}\p{N}])(sus|sts|aisi|ss)\s*-?\s*(\d{3}l?)(?![\p{L}\p{N}])/gu, (m) => {
		// SS400/SS490/SS540 are carbon structural steels; SS304 etc. mean stainless.
		const structural = m[1] === "ss" && /^(400|490|540)$/.test(m[2]);
		tokens.material = `${structural ? "ss" : "sus"}${m[2]}`;
	});
	take(/(?<![\p{L}\p{N}])sch(?:edule)?\.?\s*(\d+s?|std|xs|xxs)(?![\p{L}\p{N}])/gu, (m) => {
		tokens.schedule = m[1];
	});
	take(/(?<![\p{L}\p{N}])(db|rb)\s*(\d{1,2})(?:\s*mm)?(?![\p{L}\p{N}])/gu, (m) => {
		const bar = `${m[1]}${Number(m[2])}`;
		tokens.rebar = tokens.rebar ? [...new Set([...tokens.rebar.split("+"), bar])].sort().join("+") : bar;
	});
	take(/(?<![\p{L}\p{N}])(?:jis\s*(\d+)\s*k|(\d+)\s*k(?=\s*(?:ff|rf)?(?![\p{L}\p{N}]))|pn\s*(\d+))(?![\p{L}\p{N}])|(?<![\p{L}])(?:class|cl)\s*#?\s*(\d{2,4})(?![\p{L}\p{N}])/gu, (m) => {
		tokens.rating = m[1] || m[2] ? `${m[1] ?? m[2]}k` : m[3] ? `pn${m[3]}` : `class${m[4]}`;
	});
	take(/(?<![\p{L}\p{N}])(erw|smls|seamless|welded)(?![\p{L}\p{N}])/gu, (m) => {
		tokens.process = m[1] === "seamless" ? "smls" : m[1] === "welded" ? "erw" : m[1];
	});
	// Nominal pipe sizes.
	take(new RegExp(String.raw`(?<![\p{L}\p{N}.])dn\s*(\d{1,3})(?![\p{N}])`, "gu"), (m) => {
		const inch = DN_TO_INCH[Number(m[1])];
		if (inch) sizes.push(inch);
	});
	take(new RegExp(String.raw`(?<![\p{L}\p{N}.])(\d{1,3})a(?![\p{L}\p{N}])`, "gu"), (m) => {
		const inch = DN_TO_INCH[Number(m[1])];
		if (inch) sizes.push(inch);
	});
	// Metric bolt threads (M16x50L) are sizes too, so they conflict with inch sizes.
	take(/(?<![\p{L}\p{N}])m(\d{1,2})(?=x|\s|$)/gu, (m) => {
		metricThreads.push(`m${Number(m[1])}`);
	});
	take(new RegExp(String.raw`(?<![\p{L}\p{N}./])(${INCH_VALUE})${INCH_SUFFIX}`, "gu"), (m) => {
		const value = inchValue(m[1]);
		if (value !== null && value > 0 && value <= 72) sizes.push(value);
	});

	take(new RegExp(String.raw`(?<![\p{L}\p{N}])(?:(?:thk|thick(?:ness)?|หนา)\.?\s*=?|t\s*=)\s*(${NUM})\s*(?:mm|มม)?(?![\p{L}\p{N}])`, "gu"), (m) => {
		tokens.thickness = formatNumber(Number(m[1]));
	});
	take(new RegExp(String.raw`(?<![\p{L}\p{N}.])(${NUM})\s*t(?![\p{L}\p{N}])`, "gu"), (m) => {
		tokens.thickness = formatNumber(Number(m[1]));
	});
	// Thickness written as "0.47 mm" right after a "thk"-less sheet description.
	take(new RegExp(String.raw`(?<![\p{L}\p{N}.x])(${NUM})\s*(?:mm|มม)(?![\p{L}\p{N}])`, "gu"), (m) => {
		if (!tokens.thickness && Number(m[1]) < 25) tokens.thickness = formatNumber(Number(m[1]));
	});

	// Bare "A x B (x C)": small whole/fractional numbers are a reducer size,
	// anything else is a section dimension.
	take(new RegExp(String.raw`(?<![\p{L}\p{N}.])(${INCH_VALUE})(?:\s*x\s*(${INCH_VALUE}))+(?![\p{L}\p{N}])`, "gu"), (m) => {
		const parts = m[0].split(/\s*x\s*/).map(inchValue).filter((v): v is number => v !== null);
		if (sizes.length === 0 && parts.length === 2 && parts.every((v) => v > 0 && v <= 24)) {
			sizes.push(...parts);
		} else {
			tokens.dims = sizeList(parts);
		}
	});

	const allSizes = [...sizes.map(formatNumber), ...metricThreads];
	if (allSizes.length > 0) tokens.size = allSizes.join("x");
	return tokens;
}

export interface SpecComparison {
	conflicts: SpecCategory[];
	agreements: SpecCategory[];
}

function sameSize(left: string, right: string): boolean {
	const sorted = (value: string) => value.split("x").sort().join("x");
	return sorted(left) === sorted(right);
}

export function compareSpecTokens(query: SpecTokens, candidate: SpecTokens): SpecComparison {
	const conflicts: SpecCategory[] = [];
	const agreements: SpecCategory[] = [];
	for (const key of Object.keys(query) as SpecCategory[]) {
		const left = query[key];
		const right = candidate[key];
		if (!left || !right) continue;
		const same = key === "size" ? sameSize(left, right) : left === right;
		(same ? agreements : conflicts).push(key);
	}
	return { conflicts, agreements };
}

/** Merges tokens from a catalog description and its aliases (description wins). */
export function catalogSpecTokens(description: string, aliases: readonly string[] = []): SpecTokens {
	const merged: SpecTokens = { ...extractSpecTokens(description) };
	for (const alias of aliases) {
		const tokens = extractSpecTokens(alias);
		for (const key of Object.keys(tokens) as SpecCategory[]) {
			merged[key] ??= tokens[key];
		}
	}
	return merged;
}

/** Canonical size tokens for word overlap: "2B", 2", "2 inch", "DN50", "50A" all become "2in". */
export function canonicalSizeWords(text: string): string {
	return text
		.replace(/(?<![\p{L}\p{N}])sch(?:edule)?\.?\s*(\d+s?)/gu, "sch$1")
		.replace(/(?<![\p{L}\p{N}.])dn\s*(\d{1,3})(?![\p{N}])/gu, (whole, mm) =>
			DN_TO_INCH[Number(mm)] ? ` ${formatNumber(DN_TO_INCH[Number(mm)])}in ` : whole)
		.replace(/(?<![\p{L}\p{N}.])(\d{1,3})a(?![\p{L}\p{N}])/gu, (whole, mm) =>
			DN_TO_INCH[Number(mm)] ? ` ${formatNumber(DN_TO_INCH[Number(mm)])}in ` : whole)
		.replace(new RegExp(String.raw`(?<![\p{L}\p{N}./])(${INCH_VALUE})${INCH_SUFFIX}`, "gu"), (whole, value) => {
			const inch = inchValue(value);
			return inch !== null && inch > 0 && inch <= 72 ? ` ${formatNumber(inch)}in ` : whole;
		});
}
