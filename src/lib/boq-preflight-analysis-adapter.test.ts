import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PreflightPageInput } from "@/lib/boq-preflight-analysis";
import { analyzePreflightPages } from "@/lib/boq-preflight-analysis";
import {
	createPreflightAnalysisAdapter,
	mapPdfjsToPreflightInput,
} from "@/lib/boq-preflight-analysis-adapter";

const adapterSourcePath = join(
	dirname(fileURLToPath(import.meta.url)),
	"boq-preflight-analysis-adapter.ts",
);

test("mapPdfjsToPreflightInput converts pdfjs-dist output to analyzePreflightPages format", async () => {
	const pages: Array<{ pageNum: number; textItems: Array<{ str: string }> }> = [
		{
			pageNum: 1,
			textItems: [{ str: "รายการ จำนวน หน่วย วัสดุ ค่าแรง รวม" }],
		},
		{
			pageNum: 2,
			textItems: [{ str: "Description Quantity Material Labour Total" }],
		},
		{
			pageNum: 3,
			textItems: [{ str: "No text here" }],
		},
		{
			pageNum: 4,
			textItems: [],
		},
	];

	const geometrySignal = {
		tableCount: 2,
		numericTokenCount: 10,
	};

	const result = mapPdfjsToPreflightInput(pages, geometrySignal);

	assert.deepEqual(result, [
		{
			page: 1,
			embeddedText: "รายการ จำนวน หน่วย วัสดุ ค่าแรง รวม",
			geometry: { tableCount: 2, numericTokenCount: 10 },
		},
		{
			page: 2,
			embeddedText: "Description Quantity Material Labour Total",
			geometry: { tableCount: 2, numericTokenCount: 10 },
		},
		{
			page: 3,
			embeddedText: "No text here",
			geometry: { tableCount: 2, numericTokenCount: 10 },
		},
		{
			page: 4,
			embeddedText: "",
			geometry: { tableCount: 2, numericTokenCount: 10 },
		},
	] as PreflightPageInput[]);
});

test("mapPdfjsToPreflightInput handles undefined/null text items gracefully", async () => {
	const pages: Array<{
		pageNum: number;
		textItems: Array<{ str: string }> | undefined;
	}> = [
		{
			pageNum: 1,
			textItems: undefined,
		},
	];

	const geometrySignal = {
		tableCount: 0,
		numericTokenCount: 0,
	};

	const result = mapPdfjsToPreflightInput(pages, geometrySignal);

	assert.deepEqual(result, [
		{
			page: 1,
			embeddedText: "",
			geometry: { tableCount: 0, numericTokenCount: 0 },
		},
	] as PreflightPageInput[]);
});

test("mapPdfjsToPreflightInput concatenates multiple text items per page", async () => {
	const pages: Array<{ pageNum: number; textItems: Array<{ str: string }> }> = [
		{
			pageNum: 1,
			textItems: [{ str: "รายการ" }, { str: " " }, { str: "จำนวน" }],
		},
	];

	const geometrySignal = {
		tableCount: 1,
		numericTokenCount: 5,
	};

	const result = mapPdfjsToPreflightInput(pages, geometrySignal);

	assert.equal(result[0]?.embeddedText, "รายการ จำนวน");
});

test("analyzePreflightPages integrates with mapped pdfjs output", async () => {
	const pages: Array<{ pageNum: number; textItems: Array<{ str: string }> }> = [
		{
			pageNum: 1,
			textItems: [{ str: "รายการ จำนวน หน่วย วัสดุ ค่าแรง รวม" }],
		},
		{
			pageNum: 2,
			textItems: [{ str: "Description Quantity Material Labour Total" }],
		},
		{
			pageNum: 3,
			textItems: [],
		},
	];

	const geometrySignal = {
		tableCount: 2,
		numericTokenCount: 10,
	};

	const mapped = mapPdfjsToPreflightInput(pages, geometrySignal);
	const result = analyzePreflightPages(mapped);

	assert.equal(result.length, 3);
	assert.equal(result[0]?.page, 1);
	assert.equal(result[0]?.textSource, "embedded");
	assert.equal(result[0]?.suggested, true);
	assert.ok(result[0]?.confidence >= 0.6);
	assert.ok(result[0]?.reasons.includes("thai_boq_terms"));

	assert.equal(result[1]?.page, 2);
	assert.equal(result[1]?.textSource, "embedded");
	assert.equal(result[1]?.suggested, true);
	assert.ok(result[1]?.reasons.includes("english_boq_terms"));

	assert.equal(result[2]?.page, 3);
	assert.equal(result[2]?.textSource, "unavailable");
	assert.equal(result[2]?.suggested, false);
});

test("createPreflightAnalysisAdapter preloads pdfjs worker onto globalThis (avoids Turbopack fake-worker path rewrite)", () => {
	const source = readFileSync(adapterSourcePath, "utf8");

	// Next/Turbopack rewrites dynamic import(workerSrc) inside pdfjs fake-worker setup
	// to a non-existent "[project]/...pdf.worker.mjs [app-route]" path. pdfjs skips that
	// import when globalThis.pdfjsWorker.WorkerMessageHandler is already present.
	assert.match(source, /pdfjs-dist\/legacy\/build\/pdf\.worker\.mjs/);
	assert.match(source, /globalThis[\s\S]*pdfjsWorker/);
	assert.doesNotMatch(source, /GlobalWorkerOptions\.workerSrc\s*=/);
	assert.doesNotMatch(
		source,
		/require\.resolve\(\s*['"]pdfjs-dist\/legacy\/build\/pdf\.worker/,
	);
});

test("createPreflightAnalysisAdapter extracts embedded text from a real PDF under Node", async () => {
	const minimalPdf = `%PDF-1.1
1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj
2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj
3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources<< /Font<< /F1 5 0 R >> >> >>endobj
4 0 obj<< /Length 44 >>stream
BT /F1 12 Tf 50 150 Td (Hello BOQ) Tj ET
endstream endobj
5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj
xref
0 6
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000266 00000 n
0000000362 00000 n
trailer<< /Size 6 /Root 1 0 R >>
startxref
441
%%EOF
`;

	const file = new File([minimalPdf], "sample.pdf", {
		type: "application/pdf",
	});
	const pages = await createPreflightAnalysisAdapter().analyzePdf(file);

	assert.equal(pages.length, 1);
	assert.equal(pages[0]?.page, 1);
	assert.match(pages[0]?.embeddedText ?? "", /Hello BOQ/);
});
