import type { PreflightPageInput } from "./boq-preflight-analysis";

export interface PdfjsPageText {
	pageNum: number;
	textItems: Array<{ str: string } | null | undefined> | null | undefined;
}

export interface PdfjsGeometrySignal {
	tableCount: number;
	numericTokenCount: number;
	/** True when the page has no usable text layer but paints a page image or
	 *  outlined (vector) glyphs: a scan that only OCR can read. */
	scanned?: boolean;
}

export interface PdfjsPositionedText {
	str?: string | null;
	/** pdfjs text item transform; index 5 is the baseline y. */
	transform?: readonly number[] | null;
}

/** Operator codes the geometry signal counts (pdfjs `OPS` values). */
export interface PdfjsOperatorCodes {
	images: ReadonlySet<number>;
	path: number;
}

const NUMERIC_TOKEN = /^\(?[-+]?\d[\d,]*(?:\.\d+)?\)?%?$/u;
/** Lines with at least this many numeric tokens look like priced table rows. */
const NUMERIC_ROW_MIN_TOKENS = 2;
const TABLE_MIN_NUMERIC_ROWS = 3;
/** Fewer embedded characters than this means the text layer is not usable. */
const SCANNED_MAX_TEXT_CHARS = 20;
/** Outlined-glyph scans paint hundreds of small paths and no text. */
const SCANNED_MIN_PATHS = 200;

/**
 * Real per-page geometry from pdfjs text items and the operator list:
 * numeric tokens, a table estimate (rows of numbers sharing a baseline), and
 * whether the page is a scan (image or outlined glyphs with no text layer).
 */
export function pdfjsPageGeometry(
	items: ReadonlyArray<PdfjsPositionedText | null | undefined>,
	fnArray: ReadonlyArray<number>,
	codes: PdfjsOperatorCodes,
): PdfjsGeometrySignal {
	let numericTokenCount = 0;
	let textChars = 0;
	const numericByLine = new Map<number, number>();
	for (const item of items) {
		const text = (item?.str ?? "").trim();
		if (!text) continue;
		textChars += text.replace(/\s+/gu, "").length;
		const numbers = text.split(/\s+/u).filter((token) => NUMERIC_TOKEN.test(token)).length;
		if (numbers === 0) continue;
		numericTokenCount += numbers;
		const y = item?.transform?.[5];
		if (typeof y === "number" && Number.isFinite(y)) {
			const line = Math.round(y / 3);
			numericByLine.set(line, (numericByLine.get(line) ?? 0) + numbers);
		}
	}
	const numericRows = [...numericByLine.values()].filter((count) => count >= NUMERIC_ROW_MIN_TOKENS).length;
	let imageOps = 0;
	let pathOps = 0;
	for (const fn of fnArray) {
		if (codes.images.has(fn)) imageOps += 1;
		else if (fn === codes.path) pathOps += 1;
	}
	return {
		tableCount: numericRows >= TABLE_MIN_NUMERIC_ROWS ? 1 : 0,
		numericTokenCount,
		scanned: textChars < SCANNED_MAX_TEXT_CHARS && (imageOps > 0 || pathOps >= SCANNED_MIN_PATHS),
	};
}

/**
 * Pure helper that maps pdfjs-dist per-page text output to analyzePreflightPages input format.
 * This function is pure and deterministic, making it easy to test without real PDFs.
 */
export function mapPdfjsToPreflightInput(
	pages: readonly PdfjsPageText[],
	geometrySignal: PdfjsGeometrySignal,
): PreflightPageInput[] {
	return pages.map((page) => {
		const textItems = page.textItems ?? [];
		const embeddedText = textItems
			.map((item) => (item?.str ?? "").trim())
			.filter(Boolean)
			.join(" ");

		return {
			page: page.pageNum,
			embeddedText,
			geometry: geometrySignal,
		};
	});
}

export interface PreflightAnalysisAdapter {
	analyzePdf(file: File, signal?: AbortSignal): Promise<PreflightPageInput[]>;
}

/**
 * Create a real adapter using pdfjs-dist to extract text from PDFs.
 * This adapter loads the PDF, extracts per-page text content, and maps it to the analysis input format.
 */
export function createPreflightAnalysisAdapter(): PreflightAnalysisAdapter {
	return {
		async analyzePdf(
			file: File,
			signal?: AbortSignal,
		): Promise<PreflightPageInput[]> {
			const bytes = await file.arrayBuffer();

			// pdfjs-dist is a browser library; its main entry references DOMMatrix and
			// is unusable in Node. pdfjs recommends the legacy build for server use.
			const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

			// In Node, pdfjs disables real Workers and runs a "fake worker" on the main
			// thread. That path does `import(GlobalWorkerOptions.workerSrc)`. Under
			// Next/Turbopack the resolved workerSrc is rewritten to a non-existent
			// "[project]/.../pdf.worker.mjs [app-route] (ecmascript)" module id, which
			// surfaces as: Setting up fake worker failed: Cannot find module ...
			//
			// pdfjs short-circuits the dynamic import when
			// globalThis.pdfjsWorker.WorkerMessageHandler is already present, so preload
			// the worker module via a normal package specifier (also externalized).
			const pdfjsWorker = await import(
				"pdfjs-dist/legacy/build/pdf.worker.mjs"
			);
			const globalWithPdfjsWorker = globalThis as typeof globalThis & {
				pdfjsWorker?: typeof pdfjsWorker;
			};
			globalWithPdfjsWorker.pdfjsWorker = pdfjsWorker;

			// Load the PDF document
			const loadingTask = pdfjsLib.getDocument({
				data: new Uint8Array(bytes),
				disableFontFace: true,
				useSystemFonts: true,
				useWorkerFetch: false,
			});

			// Support AbortSignal if provided
			if (signal) {
				signal.addEventListener("abort", () => loadingTask.destroy(), {
					once: true,
				});
			}

			const pdf = await loadingTask.promise;
			const { OPS } = pdfjsLib;
			const operatorCodes: PdfjsOperatorCodes = {
				images: new Set([
					OPS.paintImageXObject,
					OPS.paintInlineImageXObject,
					OPS.paintImageMaskXObject,
					OPS.paintImageXObjectRepeat,
					OPS.paintInlineImageXObjectGroup,
				]),
				path: OPS.constructPath,
			};
			const pageCount = pdf.numPages;

			const pages: PreflightPageInput[] = [];

			for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
				if (signal?.aborted) {
					throw new DOMException("Analysis aborted", "AbortError");
				}

				const page = await pdf.getPage(pageNum);
				const textContent = await page.getTextContent();
				const operatorList = await page.getOperatorList();

				const textItems = textContent.items.map((item) => ({
					str: "str" in item ? (item.str ?? "") : "",
					transform: "transform" in item ? item.transform : null,
				}));

				pages.push({
					page: pageNum,
					embeddedText: textItems.map((t) => t.str).join(" "),
					geometry: pdfjsPageGeometry(textItems, operatorList.fnArray, operatorCodes),
				});
				page.cleanup();
			}

			// Cleanup
			await loadingTask.destroy();

			return pages;
		},
	};
}
