import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildDraftImport, parseDoclingResult } from "./boq-ingestion";
import {
	buildExtractionRun,
	checksumSourceRows,
	extractionRunIdentityFingerprint,
	fingerprintParserConfig,
	stableSourceRowFingerprint,
	type BoqExtractionRun,
} from "./boq-extraction-run";
import { createFirestoreExtractionProposalStore } from "./boq-extraction-proposal-store";
import { createFirestoreExtractionStore } from "./boq-extraction-storage";
import { buildExtractionCandidates } from "./boq-extraction-evidence";
import { prepareProviderProposalV2 } from "./boq-extraction-proposal-contract";
import {
	parseSourceBackedItemRequest,
	parseSourceBackedManualAddRequest,
	type SourceBackedItemRequest,
	type SourceBackedManualAddRequest,
} from "./boq-user-entry";
import { v3Fixture } from "./boq-extraction-test-fixtures";
import type { Boq, BoqPricedItem, BoqSection } from "./boq-schema";
import type { BoqSourceRowV3 } from "./boq-extraction-schema";
import {
	fingerprintCanonicalItem,
	fingerprintCanonicalSections,
	type ExtractionProposal,
	type ValidatedProposal,
} from "./boq-extraction-proposals";
import type { ExtractionProposalAudit } from "./boq-extraction-acceptance";
import type { ActionableReview } from "./actionable-review-projection";
import {
	actionableReviewSnapshotPath,
	actionableSuggestionDecisionPath,
	toSnapshotDocument,
} from "./actionable-review-storage";

type RecordData = Record<string, unknown>;

interface MemoryTransaction {
	get(
		ref: MemoryDoc | MemoryCollection,
	): Promise<MemorySnapshot | { docs: MemorySnapshot[] }>;
	getAll(...refs: MemoryDoc[]): Promise<MemorySnapshot[]>;
	create(ref: MemoryDoc, data: RecordData): void;
	update(ref: MemoryDoc, data: RecordData): void;
}

class MemorySnapshot {
	readonly exists: boolean;
	readonly id: string;
	constructor(
		readonly ref: MemoryDoc,
		private readonly value: RecordData | undefined,
	) {
		this.exists = value !== undefined;
		this.id = ref.id;
	}
	data(): RecordData | undefined {
		return this.value;
	}
}

class MemoryDoc {
	constructor(
		private readonly db: MemoryDb,
		readonly path: string,
	) {}
	get id(): string {
		return this.path.split("/").at(-1)!;
	}
	async get(): Promise<MemorySnapshot> {
		return new MemorySnapshot(this, this.db.docs.get(this.path));
	}
	collection(name: string): MemoryCollection {
		return new MemoryCollection(this.db, `${this.path}/${name}`);
	}
}

class MemoryCollection {
	constructor(
		private readonly db: MemoryDb,
		readonly path: string,
	) {}
	doc(id: string): MemoryDoc {
		return new MemoryDoc(this.db, `${this.path}/${id}`);
	}
	orderBy(): this {
		return this;
	}
	async get(): Promise<{ docs: MemorySnapshot[] }> {
		const prefix = `${this.path}/`;
		const docs = [...this.db.docs.entries()]
			.filter(
				([path]) =>
					path.startsWith(prefix) && !path.slice(prefix.length).includes("/"),
			)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(
				([path, value]) =>
					new MemorySnapshot(new MemoryDoc(this.db, path), value),
			);
		return { docs };
	}
}

class MemoryDb {
	readonly docs = new Map<string, RecordData>();
	transactionCount = 0;
	collection(name: string): MemoryCollection {
		return new MemoryCollection(this, name);
	}
	doc(path: string): MemoryDoc {
		return new MemoryDoc(this, path);
	}
	async runTransaction<T>(
		callback: (transaction: MemoryTransaction) => Promise<T>,
	): Promise<T> {
		this.transactionCount += 1;
		const writes: Array<{
			kind: "create" | "update";
			ref: MemoryDoc;
			data: RecordData;
		}> = [];
		const transaction = {
			get: async (ref: MemoryDoc) => ref.get(),
			getAll: async (...refs: MemoryDoc[]) =>
				Promise.all(refs.map((ref) => ref.get())),
			create: (ref: MemoryDoc, data: RecordData) =>
				writes.push({ kind: "create", ref, data: structuredClone(data) }),
			update: (ref: MemoryDoc, data: RecordData) =>
				writes.push({ kind: "update", ref, data: structuredClone(data) }),
		};
		const result = await callback(transaction);
		for (const write of writes) {
			if (write.kind === "create") {
				if (this.docs.has(write.ref.path))
					throw new Error(`Document already exists: ${write.ref.path}`);
				this.docs.set(write.ref.path, write.data);
			} else {
				this.docs.set(write.ref.path, {
					...(this.docs.get(write.ref.path) ?? {}),
					...write.data,
				});
			}
		}
		return result;
	}
}

function keepProposal(
	id: string,
	sourceRowId: string,
	targetId: string,
	target: Boq["sections"][number]["items"][number],
): ExtractionProposal {
	return {
		id,
		extractionRunId: "run-1",
		operation: "keep",
		sourceRowIds: [sourceRowId],
		targetItemIds: [targetId],
		affectedItemFingerprints: { [targetId]: fingerprintCanonicalItem(target) },
		confidence: 0.95,
		explanation: "Keep the validated deterministic row.",
		proposedItems: [],
	};
}

function proposal(): ExtractionProposal {
	return {
		id: "proposal-1",
		extractionRunId: "run-1",
		operation: "separate_components",
		sourceRowIds: ["row-4"],
		targetItemIds: ["combined"],
		affectedItemFingerprints: {},
		confidence: 0.95,
		explanation: "Separate quoted components.",
		proposedItems: [
			{
				id: "material",
				desc: "Combined material",
				pricingRole: "standard",
				sourceRowIds: ["row-4"],
				entryOrigin: "ai_accepted",
				unit: "set",
				qty: 1,
				rate: 40,
				total: 40,
				costComponent: "material",
			},
			{
				id: "labour",
				desc: "Combined labour",
				pricingRole: "standard",
				sourceRowIds: ["row-4"],
				entryOrigin: "ai_accepted",
				unit: "set",
				qty: 1,
				rate: 60,
				total: 60,
				costComponent: "labour",
			},
		],
	};
}

function harness(
	clock: () => Date = () => new Date("2026-07-20T12:00:00.000Z"),
) {
	const parsed = parseDoclingResult(v3Fixture());
	if (parsed.contractVersion !== 3) throw new Error("Expected v3 fixture");
	const draft = buildDraftImport(
		"boq-1",
		"boqs/boq-1/source.pdf",
		parsed,
		"run-1",
	);
	const built = buildExtractionRun({
		seed: draft.run!,
		sourceDigest: "sha256:pdf",
		parserConfigFingerprint: "sha256:config",
		now: new Date("2026-07-20T00:00:00.000Z"),
	});
	const run = { ...built, status: "ready" as const };
	const db = new MemoryDb();
	const runPath = "boqs/boq-1/extractionRuns/run-1";
	const runMetadata = { ...run } as RecordData;
	delete runMetadata.sections;
	runMetadata.identityFingerprint = extractionRunIdentityFingerprint(run);
	runMetadata.deterministicSections = {
		checksum: fingerprintParserConfig(run.sections),
		reference: `${runPath}/sectionSnapshots`,
		chunkCount: 1,
	};
	db.docs.set(runPath, runMetadata);
	db.docs.set(`${runPath}/sectionSnapshots/000000`, {
		order: 0,
		sectionIndex: 0,
		sectionChunkIndex: 0,
		sections: run.sections,
	});
	for (const row of parsed.sourceRows)
		db.docs.set(`${runPath}/sourceRows/${row.id}`, {
			...row,
			fingerprint: stableSourceRowFingerprint(row),
		});
	db.docs.set("boqs/boq-1", {
		...draft.boq,
		createdAt: "2026-07-20T00:00:00.000Z",
		updatedAt: "2026-07-20T00:00:00.000Z",
	});
	const target = draft.boq.sections
		.flatMap((section) => section.items)
		.find((item) => item.id === "combined")!;
	return {
		db,
		store: createFirestoreExtractionProposalStore(db as never, clock),
		boq: db.docs.get("boqs/boq-1") as unknown as Boq,
		run,
		sourceRows: parsed.sourceRows,
		runPath,
		proposal: {
			...proposal(),
			affectedItemFingerprints: { combined: fingerprintCanonicalItem(target) },
			evidenceValid: true,
			reconciled: true,
			stale: false,
		} as ValidatedProposal,
	};
}

function mappedStoreHarness() {
	const fixture = harness();
	const boq = fixture.db.docs.get("boqs/boq-1")! as unknown as Boq;
	const sectionHeader = boq.sections[0].header;
	const row: BoqSourceRowV3 = {
		id: "mapped-row",
		page: 9,
		table: 1,
		row: 1,
		section: sectionHeader,
		headers: [],
		rawCells: [
			{
				column: 1,
				rawText: "Mapped valve",
				lines: ["Mapped valve"],
				rowSpan: 1,
				columnSpan: 1,
				startRowOffset: 0,
				endRowOffset: 1,
				startColumnOffset: 1,
				endColumnOffset: 2,
				columnHeader: false,
				rowHeader: false,
				rowSection: false,
				carried: false,
			},
			{
				column: 2,
				rawText: "pcs",
				lines: ["pcs"],
				rowSpan: 1,
				columnSpan: 1,
				startRowOffset: 0,
				endRowOffset: 1,
				startColumnOffset: 2,
				endColumnOffset: 3,
				columnHeader: false,
				rowHeader: false,
				rowSection: false,
				carried: false,
			},
			{
				column: 3,
				rawText: "2",
				lines: ["2"],
				rowSpan: 1,
				columnSpan: 1,
				startRowOffset: 0,
				endRowOffset: 1,
				startColumnOffset: 3,
				endColumnOffset: 4,
				columnHeader: false,
				rowHeader: false,
				rowSection: false,
				carried: false,
			},
			{
				column: 4,
				rawText: "50",
				lines: ["50"],
				rowSpan: 1,
				columnSpan: 1,
				startRowOffset: 0,
				endRowOffset: 1,
				startColumnOffset: 4,
				endColumnOffset: 5,
				columnHeader: false,
				rowHeader: false,
				rowSection: false,
				carried: false,
			},
			{
				column: 5,
				rawText: "100",
				lines: ["100"],
				rowSpan: 1,
				columnSpan: 1,
				startRowOffset: 0,
				endRowOffset: 1,
				startColumnOffset: 5,
				endColumnOffset: 6,
				columnHeader: false,
				rowHeader: false,
				rowSection: false,
				carried: false,
			},
		],
		rawText: "Mapped valve | pcs | 2 | 50 | 100",
		classification: "unknown",
		confidence: 0.96,
		warnings: [],
	};
	const sourceRows = [...fixture.sourceRows, row];
	const run = {
		...fixture.run,
		sourceRowCount: sourceRows.length,
		sourceRowChecksum: checksumSourceRows(sourceRows),
	};
	const runRecord = fixture.db.docs.get(fixture.runPath)!;
	runRecord.sourceRowCount = run.sourceRowCount;
	runRecord.sourceRowChecksum = run.sourceRowChecksum;
	runRecord.identityFingerprint = extractionRunIdentityFingerprint(run);
	fixture.db.docs.set(`${fixture.runPath}/sourceRows/${row.id}`, {
		...row,
		fingerprint: stableSourceRowFingerprint(row),
	});
	const targetItems = new Map(
		boq.sections
			.flatMap((section) => section.items)
			.flatMap((entry) => (entry.id ? [[entry.id, entry] as const] : [])),
	);
	const decision = {
		id: "mapped-store",
		operation: "map_source_item",
		sourceRowIds: [row.id],
		targetItemIds: [],
		confidence: 0.96,
		explanation: "Mapped from retained source cells.",
		cellMapping: {
			sourceRowIds: [row.id],
			description: [{ sourceRowId: row.id, column: 1 }],
			unit: { sourceRowId: row.id, column: 2 },
			quantity: { sourceRowId: row.id, column: 3 },
			rate: { sourceRowId: row.id, column: 4 },
			total: { sourceRowId: row.id, column: 5 },
		},
	};
	const context = {
		extractionRunId: run.id,
		sections: boq.sections,
		targetItems,
		candidateItems: buildExtractionCandidates(run, sourceRows),
		sourceRows,
		allowedSourceRowIds: new Set([row.id]),
	};
	return { ...fixture, boq, run, row, sourceRows, decision, context };
}

interface SurasakFixture {
	sourceRows: BoqSourceRowV3[];
	expectedSections: BoqExtractionRun["sections"];
	expectedReconciliation: BoqExtractionRun["reconciliation"];
}

function surasakHarness(
	clock: () => Date = () => new Date("2026-07-20T12:00:00.000Z"),
) {
	const fixture = JSON.parse(
		readFileSync(
			new URL(
				"../../py-sidecar/fixtures/compound/surasak-unit-price.json",
				import.meta.url,
			),
			"utf8",
		),
	) as SurasakFixture;
	const run: BoqExtractionRun = {
		id: "run-surasak",
		boqId: "boq-surasak",
		contractVersion: 3,
		status: "ready",
		createdAt: "2026-07-20T00:00:00.000Z",
		updatedAt: "2026-07-20T00:00:00.000Z",
		stagingExpiresAt: null,
		sourceFile: {
			path: "boqs/boq-surasak/source.pdf",
			name: "surasak.pdf",
			digest: "sha256:surasak",
		},
		parser: {
			name: "docling",
			contractVersion: 3,
			configFingerprint: "sha256:config",
		},
		metadataCandidates: {
			vendor: {
				value: "SURASAK ENGINEERING CO.,LTD.",
				confidence: 1,
				source: "fixture",
			},
			project: {
				value: "MODIFY STAGE FLOOR",
				confidence: 1,
				source: "fixture",
			},
			date: { value: "2026-01-15", confidence: 1, source: "fixture" },
			workType: { value: "MEP", confidence: 1, source: "fixture" },
		},
		metadataConfidence: { vendor: 1, project: 1, date: 1, workType: 1 },
		sourceRowCount: fixture.sourceRows.length,
		sourceRowChecksum: checksumSourceRows(fixture.sourceRows),
		reconciliation: fixture.expectedReconciliation,
		warnings: [],
		sections: fixture.expectedSections,
		totalItems: 19,
		aiReviewStatus: "queued",
		reviewTargeting: {
			candidateRowIds: [],
			candidateCount: 0,
			unreconciled: false,
		},
	};
	const candidates = buildExtractionCandidates(run, fixture.sourceRows);
	const retainedIds = new Set([
		"di-sr-surasak-7-combined-1",
		"di-sr-surasak-8-combined-1",
		"di-sr-surasak-24-standard-1",
	]);
	const toCanonical = (
		candidate: ReturnType<typeof buildExtractionCandidates> extends Map<
			string,
			infer T
		>
			? T
			: never,
	): BoqPricedItem => ({
		id: candidate.id,
		desc: candidate.desc,
		pricingRole: "standard",
		sourceRowId: candidate.sourceRowIds[0],
		sourceRowIds: [...candidate.sourceRowIds],
		sourceRef: candidate.sourceRefs[0],
		entryOrigin: "docling",
		unit: candidate.unit,
		qty: candidate.qty,
		rate: candidate.rate,
		total: candidate.total,
		type: candidate.costComponent === "lump_sum" ? "lump_sum" : "unit",
		costComponent: candidate.costComponent as BoqPricedItem["costComponent"],
		...(candidate.sourceCosts
			? {
					sourceCosts: {
						material: {
							...candidate.sourceCosts.material,
							present: true as const,
						},
						labour: { ...candidate.sourceCosts.labour, present: true as const },
					},
				}
			: {}),
		stdStatus: "unmatched",
	});
	const staleSections: BoqSection[] = fixture.expectedSections.map(
		(section) => ({
			header: section.header,
			items: section.items
				.filter((item) => retainedIds.has(item.id))
				.map((item) => toCanonical(candidates.get(item.id)!)),
		}),
	);
	const staleTotal = staleSections
		.flatMap((section) => section.items)
		.reduce((sum, item) => sum + ("total" in item ? item.total : 0), 0);
	const boq: Boq = {
		id: "boq-surasak",
		project: "MODIFY STAGE FLOOR",
		vendor: "SURASAK ENGINEERING CO.,LTD.",
		workType: "MEP",
		date: "2026-01-15",
		status: "draft",
		stdStatus: "none",
		sections: staleSections,
		totalItems: 3,
		grandTotal: staleTotal,
		sourceTotal: 47000,
		sourceFileName: "surasak.pdf",
		sourceStoragePath: "boqs/boq-surasak/source.pdf",
		activeExtractionRunId: run.id,
		createdAt: "2026-07-20T00:00:00.000Z",
		updatedAt: "2026-07-20T00:00:00.000Z",
	};
	const db = new MemoryDb();
	const runPath = "boqs/boq-surasak/extractionRuns/run-surasak";
	const runMetadata = { ...run } as RecordData;
	delete runMetadata.sections;
	runMetadata.identityFingerprint = extractionRunIdentityFingerprint(run);
	runMetadata.deterministicSections = {
		checksum: fingerprintParserConfig(run.sections),
		reference: `${runPath}/sectionSnapshots`,
		chunkCount: run.sections.length,
	};
	db.docs.set(runPath, runMetadata);
	run.sections.forEach((section, sectionIndex) => {
		db.docs.set(
			`${runPath}/sectionSnapshots/${String(sectionIndex).padStart(6, "0")}`,
			{
				order: sectionIndex,
				sectionIndex,
				sectionChunkIndex: 0,
				sections: [section],
			},
		);
	});
	for (const row of fixture.sourceRows) {
		db.docs.set(`${runPath}/sourceRows/${row.id}`, {
			...row,
			fingerprint: stableSourceRowFingerprint(row),
		});
	}
	db.docs.set(
		"boqs/boq-surasak",
		structuredClone(boq) as unknown as RecordData,
	);
	return {
		db,
		run,
		runPath,
		sourceRows: fixture.sourceRows,
		candidates,
		staleSections,
		expectedSections: fixture.expectedSections,
		store: createFirestoreExtractionProposalStore(db as never, clock),
	};
}

test("incomplete proposals can be skipped and reopened without mutating BOQ sections or totals", async () => {
	const fixture = harness();
	const incomplete = {
		...fixture.proposal,
		id: "incomplete",
		operation: "needs_human_review" as const,
		proposedItems: [],
	};
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [incomplete]);
	const before = structuredClone(fixture.db.docs.get("boqs/boq-1"));

	const skipped = await fixture.store.skip(
		"boq-1",
		"run-1",
		"incomplete",
		"user-1",
	);
	assert.equal(skipped.status, 200);
	assert.equal(skipped.body.status, "skipped");
	assert.deepEqual(fixture.db.docs.get("boqs/boq-1"), before);
	assert.equal(
		fixture.db.docs.get(`${fixture.runPath}/proposalAudits/incomplete`)?.status,
		"skipped",
	);

	let state = await fixture.store.getReviewState("boq-1", "run-1");
	assert.equal(state?.proposalStatuses.incomplete?.status, "skipped");
	assert.equal(
		state?.auditEvents.some(
			(event) =>
				event.proposalId === "incomplete" && event.status === "skipped",
		),
		true,
	);

	const reopened = await fixture.store.reopen(
		"boq-1",
		"run-1",
		"incomplete",
		"user-1",
	);
	assert.equal(reopened.status, 200);
	assert.equal(reopened.body.status, "pending");
	assert.deepEqual(fixture.db.docs.get("boqs/boq-1"), before);
	state = await fixture.store.getReviewState("boq-1", "run-1");
	assert.equal(state?.proposalStatuses.incomplete?.status, "pending");
	assert.equal(
		state?.auditEvents.some(
			(event) =>
				event.proposalId === "incomplete" && event.status === "reopened",
		),
		true,
	);
	assert.equal(
		(await fixture.store.skip("boq-1", "run-1", "incomplete", "user-1")).status,
		200,
	);
	assert.equal(
		(await fixture.store.getReviewState("boq-1", "run-1"))?.proposalStatuses
			.incomplete?.status,
		"skipped",
	);
});

test("reopened rejected complete proposals can be accepted through a new append-only audit event", async () => {
	const fixture = harness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	assert.equal(
		(await fixture.store.reject("boq-1", "run-1", "proposal-1", "user-1"))
			.status,
		200,
	);
	assert.equal(
		(await fixture.store.reopen("boq-1", "run-1", "proposal-1", "user-1"))
			.status,
		200,
	);
	const accepted = await fixture.store.accept(
		"boq-1",
		"run-1",
		"proposal-1",
		"user-1",
	);
	assert.equal(accepted.status, 200);
	const lifecycleAudits = [...fixture.db.docs.entries()].filter(
		([path, value]) =>
			path.includes(`${fixture.runPath}/proposalAudits/proposal-1`) &&
			value.status === "accepted",
	);
	assert.equal(lifecycleAudits.length, 1);
	assert.equal(
		(await fixture.store.getReviewState("boq-1", "run-1"))?.proposalStatuses[
			"proposal-1"
		]?.status,
		"accepted",
	);
	assert.equal(
		(await fixture.store.undo("boq-1", "run-1", "proposal-1", "user-1")).status,
		200,
	);
});

test("lifecycle sequence supports repeated decisions, fresh acceptance after undo, and rejects invalid reopen transitions", async () => {
	const fixture = harness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);

	assert.equal(
		(await fixture.store.reject("boq-1", "run-1", "proposal-1", "user-1"))
			.status,
		200,
	);
	assert.equal(
		(await fixture.store.reopen("boq-1", "run-1", "proposal-1", "user-1"))
			.status,
		200,
	);
	assert.equal(
		(await fixture.store.reject("boq-1", "run-1", "proposal-1", "user-1"))
			.status,
		200,
	);
	let state = await fixture.store.getReviewState("boq-1", "run-1");
	assert.equal(state?.proposalStatuses["proposal-1"]?.status, "rejected");
	assert.equal(
		(await fixture.store.reopen("boq-1", "run-1", "proposal-1", "user-1"))
			.status,
		200,
	);
	assert.equal(
		(await fixture.store.accept("boq-1", "run-1", "proposal-1", "user-1"))
			.status,
		200,
	);
	state = await fixture.store.getReviewState("boq-1", "run-1");
	assert.equal(state?.proposalStatuses["proposal-1"]?.status, "accepted");
	assert.equal(state?.proposalStatuses["proposal-1"]?.canUndo, true);
	assert.equal(
		(await fixture.store.reopen("boq-1", "run-1", "proposal-1", "user-1"))
			.status,
		409,
	);
	assert.equal(
		(await fixture.store.undo("boq-1", "run-1", "proposal-1", "user-1")).status,
		200,
	);
	assert.equal(
		(await fixture.store.reopen("boq-1", "run-1", "proposal-1", "user-1"))
			.status,
		409,
	);
	const reaccepted = await fixture.store.accept(
		"boq-1",
		"run-1",
		"proposal-1",
		"user-1",
	);
	assert.equal(reaccepted.status, 200);
	assert.equal(
		(await fixture.store.getReviewState("boq-1", "run-1"))?.proposalStatuses[
			"proposal-1"
		]?.status,
		"accepted",
	);
});

test("batch acceptance derives pending state after reopen and appends fresh decisions", async () => {
	const fixture = harness();
	const bundle = fixture.boq.sections
		.flatMap((section) => section.items)
		.find((item) => item.id === "bundle")!;
	const option = fixture.boq.sections
		.flatMap((section) => section.items)
		.find((item) => item.id === "option")!;
	const proposals = [
		keepProposal("batch-bundle", "row-1", "bundle", bundle),
		keepProposal("batch-option", "row-3", "option", option),
	];
	await fixture.store.saveValidatedProposals(
		"boq-1",
		"run-1",
		proposals as never,
	);
	assert.equal(
		(await fixture.store.reject("boq-1", "run-1", "batch-bundle", "user-1"))
			.status,
		200,
	);
	assert.equal(
		(await fixture.store.reject("boq-1", "run-1", "batch-option", "user-1"))
			.status,
		200,
	);
	assert.equal(
		(await fixture.store.reopen("boq-1", "run-1", "batch-bundle", "user-1"))
			.status,
		200,
	);
	assert.equal(
		(await fixture.store.reopen("boq-1", "run-1", "batch-option", "user-1"))
			.status,
		200,
	);
	const accepted = await fixture.store.acceptBatch(
		"boq-1",
		"run-1",
		proposals.map((proposal) => proposal.id),
		"user-1",
	);
	assert.equal(accepted.status, 200);
	const state = await fixture.store.getReviewState("boq-1", "run-1");
	assert.equal(state?.proposalStatuses["batch-bundle"]?.status, "accepted");
	assert.equal(state?.proposalStatuses["batch-option"]?.status, "accepted");
});

test("malformed or misbound child lifecycle events fail closed during reload and mutation", async () => {
	const fixture = harness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	fixture.db.docs.set(
		`${fixture.runPath}/proposalAudits/proposal-1/events/1-rejected`,
		{
			proposalId: "other-proposal",
			extractionRunId: "run-1",
			status: "rejected",
		},
	);
	await assert.rejects(
		fixture.store.getReviewState("boq-1", "run-1"),
		/lifecycle (event|root audit)/,
	);
	assert.equal(
		(await fixture.store.reject("boq-1", "run-1", "proposal-1", "user-1"))
			.status,
		409,
	);
});

test("batch replay returns canonical current BOQ for separately accepted proposals regardless of caller order", async () => {
	const fixture = harness();
	const bundle = fixture.boq.sections
		.flatMap((section) => section.items)
		.find((item) => item.id === "bundle")!;
	const option = fixture.boq.sections
		.flatMap((section) => section.items)
		.find((item) => item.id === "option")!;
	const proposals = [
		keepProposal("separate-bundle", "row-1", "bundle", bundle),
		keepProposal("separate-option", "row-3", "option", option),
	];
	await fixture.store.saveValidatedProposals(
		"boq-1",
		"run-1",
		proposals as never,
	);
	assert.equal(
		(await fixture.store.accept("boq-1", "run-1", "separate-bundle", "user-1"))
			.status,
		200,
	);
	assert.equal(
		(await fixture.store.accept("boq-1", "run-1", "separate-option", "user-1"))
			.status,
		200,
	);
	const replay = await fixture.store.acceptBatch(
		"boq-1",
		"run-1",
		["separate-option", "separate-bundle"],
		"user-1",
	);
	assert.equal(replay.status, 200);
	assert.deepEqual(replay.body.boq, fixture.db.docs.get("boqs/boq-1"));
});

test("transaction lifecycle head version rejects a stale concurrent transition", async () => {
	const fixture = harness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	assert.equal(
		(await fixture.store.reject("boq-1", "run-1", "proposal-1", "user-1"))
			.status,
		200,
	);
	fixture.db.docs.set(
		`${fixture.runPath}/proposalAudits/proposal-1/events/2-reopened`,
		{
			eventId: "proposal-1:reopen:stale",
			proposalId: "proposal-1",
			extractionRunId: "run-1",
			status: "reopened",
			previousStatus: "rejected",
			actorId: "user-2",
			timestamp: "2026-07-20T12:00:01.000Z",
			sequence: 2,
		},
	);
	assert.equal(
		(await fixture.store.reopen("boq-1", "run-1", "proposal-1", "user-1"))
			.status,
		409,
	);
});

test("lifecycle reducer rejects sequence gaps, duplicates, nonpositive values, key mismatches, and illegal reopen history", async () => {
	const cases = [
		{ key: "4-reopened", sequence: 4, previousStatus: "rejected" as const },
		{ key: "1-reopened", sequence: 1, previousStatus: "rejected" as const },
		{ key: "0-reopened", sequence: 0, previousStatus: "rejected" as const },
		{ key: "2-skipped", sequence: 2, previousStatus: "rejected" as const },
		{ key: "2-reopened", sequence: 2, previousStatus: "skipped" as const },
	];
	for (const event of cases) {
		const fixture = harness();
		await fixture.store.saveValidatedProposals("boq-1", "run-1", [
			fixture.proposal,
		]);
		assert.equal(
			(await fixture.store.reject("boq-1", "run-1", "proposal-1", "user-1"))
				.status,
			200,
		);
		fixture.db.docs.set(
			`${fixture.runPath}/proposalAudits/proposal-1/events/${event.key}`,
			{
				eventId: `proposal-1:${event.key}`,
				proposalId: "proposal-1",
				extractionRunId: "run-1",
				status: "reopened",
				previousStatus: event.previousStatus,
				actorId: "user-1",
				timestamp: "2026-07-20T12:00:01.000Z",
				sequence: event.sequence,
			},
		);
		await assert.rejects(fixture.store.getReviewState("boq-1", "run-1"));
	}
});

test("legacy roots establish an implicit sequence base before modern append events", async () => {
	const rejected = harness();
	await rejected.store.saveValidatedProposals("boq-1", "run-1", [
		rejected.proposal,
	]);
	assert.equal(
		(await rejected.store.reject("boq-1", "run-1", "proposal-1", "user-1"))
			.status,
		200,
	);
	delete rejected.db.docs.get(`${rejected.runPath}/proposalAudits/proposal-1`)!
		.sequence;
	delete rejected.db.docs.get(`${rejected.runPath}/proposals/proposal-1`)!
		.lifecycleRevision;
	assert.equal(
		(await rejected.store.reopen("boq-1", "run-1", "proposal-1", "user-1"))
			.status,
		200,
	);
	assert.equal(
		(await rejected.store.getReviewState("boq-1", "run-1"))?.proposalStatuses[
			"proposal-1"
		]?.status,
		"pending",
	);

	const skipped = harness();
	const incomplete = {
		...skipped.proposal,
		operation: "needs_human_review" as const,
		proposedItems: [],
	};
	await skipped.store.saveValidatedProposals("boq-1", "run-1", [incomplete]);
	assert.equal(
		(await skipped.store.skip("boq-1", "run-1", "proposal-1", "user-1")).status,
		200,
	);
	delete skipped.db.docs.get(`${skipped.runPath}/proposalAudits/proposal-1`)!
		.sequence;
	delete skipped.db.docs.get(`${skipped.runPath}/proposals/proposal-1`)!
		.lifecycleRevision;
	assert.equal(
		(await skipped.store.reopen("boq-1", "run-1", "proposal-1", "user-1"))
			.status,
		200,
	);
	assert.equal(
		(await skipped.store.getReviewState("boq-1", "run-1"))?.proposalStatuses[
			"proposal-1"
		]?.status,
		"pending",
	);

	const accepted = harness();
	await accepted.store.saveValidatedProposals("boq-1", "run-1", [
		accepted.proposal,
	]);
	assert.equal(
		(await accepted.store.accept("boq-1", "run-1", "proposal-1", "user-1"))
			.status,
		200,
	);
	delete accepted.db.docs.get(`${accepted.runPath}/proposalAudits/proposal-1`)!
		.sequence;
	delete accepted.db.docs.get(`${accepted.runPath}/proposals/proposal-1`)!
		.lifecycleRevision;
	assert.equal(
		(await accepted.store.undo("boq-1", "run-1", "proposal-1", "user-1"))
			.status,
		200,
	);
	assert.equal(
		(await accepted.store.getReviewState("boq-1", "run-1"))?.proposalStatuses[
			"proposal-1"
		]?.status,
		"undone",
	);
	assert.equal(
		(await accepted.store.accept("boq-1", "run-1", "proposal-1", "user-1"))
			.status,
		200,
	);
	const state = await accepted.store.getReviewState("boq-1", "run-1");
	assert.equal(state?.proposalStatuses["proposal-1"]?.status, "accepted");
	assert.equal(state?.proposalStatuses["proposal-1"]?.canUndo, true);
});

test("store undo fences immutable evidence and replays exact accepted/undo BOQ snapshots", async () => {
	const fixture = harness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	const firstAccept = await fixture.store.accept(
		"boq-1",
		"run-1",
		"proposal-1",
		"user-1",
	);
	assert.equal(firstAccept.status, 200);
	if (firstAccept.status !== 200) return;
	const firstAcceptedBoq = firstAccept.body.boq;

	const edited = fixture.db.docs.get("boqs/boq-1")!;
	edited.project = "User-edited project";
	edited.updatedAt = "2026-07-20T12:01:00.000Z";
	const acceptRetry = await fixture.store.accept(
		"boq-1",
		"run-1",
		"proposal-1",
		"user-1",
	);
	assert.equal(acceptRetry.status, 200);
	if (acceptRetry.status !== 200) return;
	assert.deepEqual(acceptRetry.body.boq, firstAcceptedBoq);
	assert.equal(
		fixture.db.docs.get("boqs/boq-1")!.project,
		"User-edited project",
	);

	const run = fixture.db.docs.get(fixture.runPath)! as {
		deterministicSections: { checksum: string };
	};
	run.deterministicSections.checksum = "sha256:changed";
	const fencedUndo = await fixture.store.undo(
		"boq-1",
		"run-1",
		"proposal-1",
		"user-1",
	);
	assert.equal(fencedUndo.status, 409);
	const snapshot = fixture.db.docs.get(
		`${fixture.runPath}/sectionSnapshots/000000`,
	)! as { sections: unknown };
	run.deterministicSections.checksum = fingerprintParserConfig(
		snapshot.sections,
	);

	const firstUndo = await fixture.store.undo(
		"boq-1",
		"run-1",
		"proposal-1",
		"user-1",
	);
	assert.equal(firstUndo.status, 200);
	if (firstUndo.status !== 200) return;
	const firstUndoneBoq = firstUndo.body.boq;
	const undoPath =
		"boqs/boq-1/extractionRuns/run-1/proposalAudits/proposal-1/events/undo";
	const undoEvent = fixture.db.docs.get(undoPath)!;
	delete undoEvent.resultBoq;
	const malformedRetry = await fixture.store.undo(
		"boq-1",
		"run-1",
		"proposal-1",
		"user-1",
	);
	assert.equal(malformedRetry.status, 409);
	undoEvent.resultBoq = structuredClone(firstUndoneBoq);
	fixture.db.docs.get("boqs/boq-1")!.project = "Edited again";
	fixture.db.docs.get("boqs/boq-1")!.updatedAt = "2026-07-20T12:03:00.000Z";
	const undoRetry = await fixture.store.undo(
		"boq-1",
		"run-1",
		"proposal-1",
		"user-1",
	);
	assert.equal(undoRetry.status, 200);
	if (undoRetry.status !== 200) return;
	assert.deepEqual(undoRetry.body.boq, firstUndoneBoq);
	assert.equal(fixture.db.docs.get("boqs/boq-1")!.project, "Edited again");
});

test("store refuses malformed existing audit records before canonical mutation", async () => {
	const fixture = harness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	fixture.db.docs.set(
		"boqs/boq-1/extractionRuns/run-1/proposalAudits/proposal-1",
		{
			proposalId: "proposal-1",
			status: "accepted",
			targetItemIds: ["combined"],
		},
	);
	const before = structuredClone(fixture.db.docs.get("boqs/boq-1"));
	const result = await fixture.store.accept(
		"boq-1",
		"run-1",
		"proposal-1",
		"user-1",
	);
	assert.equal(result.status, 409);
	assert.deepEqual(fixture.db.docs.get("boqs/boq-1"), before);
});

test("validated proposals persist durably and action status is reconstructed from audits", async () => {
	const fixture = harness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	let state = await fixture.store.getReviewState("boq-1", "run-1");
	assert.deepEqual(
		state?.proposals.map((entry) => entry.id),
		["proposal-1"],
	);
	assert.deepEqual(state?.proposalStatuses, {
		"proposal-1": {
			status: "pending",
			canUndo: false,
			stale: false,
			eligible: false,
		},
	});

	const accepted = await fixture.store.accept(
		"boq-1",
		"run-1",
		"proposal-1",
		"user-1",
	);
	assert.equal(accepted.status, 200);
	state = await fixture.store.getReviewState("boq-1", "run-1");
	assert.equal(state?.proposalStatuses["proposal-1"]?.status, "accepted");
	assert.equal(state?.proposalStatuses["proposal-1"]?.canUndo, true);
	assert.equal(state?.auditEvents.length, 1);
});

test("mapped proposal metadata persists, reloads, and is revalidated on acceptance", async () => {
	const fixture = mappedStoreHarness();
	const prepared = prepareProviderProposalV2(fixture.decision, fixture.context);
	assert.equal(prepared.ok, true);
	if (!prepared.ok) return;
	const proposal = {
		...prepared.proposal,
		evidenceValid: true as const,
		reconciled: true as const,
		stale: false,
	};
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [proposal]);
	const state = await fixture.store.getReviewState("boq-1", "run-1");
	assert.deepEqual(
		state?.proposals[0].sourceCellMapping,
		proposal.sourceCellMapping,
	);
	assert.deepEqual(
		state?.proposals[0].mappedCandidate,
		proposal.mappedCandidate,
	);
	const result = await fixture.store.accept(
		"boq-1",
		"run-1",
		proposal.id,
		"user-1",
	);
	assert.equal(result.status, 200);
	assert.equal(
		(fixture.db.docs.get("boqs/boq-1") as unknown as Boq).sections
			.flatMap((section) => section.items)
			.some((item) => item.id === proposal.mappedCandidate?.id),
		true,
	);
});

test("stored mapped candidate tampering is rejected before canonical mutation", async () => {
	const fixture = mappedStoreHarness();
	const prepared = prepareProviderProposalV2(fixture.decision, fixture.context);
	assert.equal(prepared.ok, true);
	if (!prepared.ok) return;
	const proposal = {
		...prepared.proposal,
		evidenceValid: true as const,
		reconciled: true as const,
		stale: false,
	};
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [proposal]);
	const path = `${fixture.runPath}/proposals/${proposal.id}`;
	const stored = fixture.db.docs.get(path)! as { proposal: typeof proposal };
	stored.proposal.mappedCandidate = {
		...stored.proposal.mappedCandidate!,
		total: 999,
	};
	const before = structuredClone(fixture.db.docs.get("boqs/boq-1"));
	const result = await fixture.store.accept(
		"boq-1",
		"run-1",
		proposal.id,
		"user-1",
	);
	assert.equal(result.status, 404);
	assert.deepEqual(fixture.db.docs.get("boqs/boq-1"), before);
});

test("source-backed review draft persists but remains non-acceptable", async () => {
	const fixture = mappedStoreHarness();
	const incomplete = {
		...fixture.decision,
		cellMapping: {
			sourceRowIds: ["mapped-row"],
			description: [{ sourceRowId: "mapped-row", column: 1 }],
			unit: { sourceRowId: "mapped-row", column: 2 },
			quantity: { sourceRowId: "mapped-row", column: 3 },
		},
	};
	const prepared = prepareProviderProposalV2(incomplete, fixture.context);
	assert.equal(prepared.ok, true);
	if (!prepared.ok) return;
	const proposal = {
		...prepared.proposal,
		evidenceValid: true as const,
		reconciled: true as const,
		stale: false,
	};
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [proposal]);
	const state = await fixture.store.getReviewState("boq-1", "run-1");
	assert.deepEqual(state?.proposals[0].reviewDraft, proposal.reviewDraft);
	assert.equal(
		(await fixture.store.accept("boq-1", "run-1", proposal.id, "user-1"))
			.status,
		400,
	);
});

function reviewDraftHarness() {
	const fixture = mappedStoreHarness();
	const incomplete = {
		...fixture.decision,
		cellMapping: {
			sourceRowIds: ["mapped-row"],
			description: [{ sourceRowId: "mapped-row", column: 1 }],
			unit: { sourceRowId: "mapped-row", column: 2 },
			quantity: { sourceRowId: "mapped-row", column: 3 },
		},
	};
	const prepared = prepareProviderProposalV2(incomplete, fixture.context);
	if (!prepared.ok) throw new Error("reviewDraft preparation failed");
	const proposal = {
		...prepared.proposal,
		evidenceValid: true as const,
		reconciled: true as const,
		stale: false,
	};
	const userValues = parseSourceBackedItemRequest({
		sectionIndex: 0,
		item: {
			desc: "Wall installation",
			unit: "pcs",
			qty: 2,
			materialCost: 50,
			labourCost: 50,
		},
	});
	return { ...fixture, proposal, userValues };
}

function evidenceOnlyReviewHarness() {
	const fixture = mappedStoreHarness();
	const prepared = prepareProviderProposalV2(
		{
			id: "proposal-evidence-only",
			operation: "needs_human_review",
			sourceRowIds: ["mapped-row"],
			targetItemIds: [],
			candidateItemIds: [],
			confidence: 0.72,
			explanation:
				"The source row is relevant, but its component columns remain ambiguous.",
		},
		fixture.context,
	);
	if (!prepared.ok)
		throw new Error("evidence-only proposal preparation failed");
	const proposal = {
		...prepared.proposal,
		evidenceValid: true as const,
		reconciled: true as const,
		stale: false,
	};
	const userValues = parseSourceBackedItemRequest({
		sectionIndex: 0,
		item: {
			desc: "Valve installation",
			unit: "Lot",
			qty: 1,
			materialCost: 3000,
			labourCost: 3000,
		},
	});
	return { ...fixture, proposal, userValues };
}

function single(value: SourceBackedItemRequest): SourceBackedManualAddRequest {
	return { mode: "single", value };
}

function multiRowEvidenceHarness() {
	const fixture = harness();
	const boq = fixture.db.docs.get("boqs/boq-1")! as unknown as Boq;
	const sectionHeader = boq.sections[0].header;
	const makeRow = (id: string, tableRow: number): BoqSourceRowV3 => ({
		id,
		page: 9,
		table: 1,
		row: tableRow,
		section: sectionHeader,
		headers: [],
		rawCells: [
			{
				column: 1,
				rawText: `${id} desc`,
				lines: [`${id} desc`],
				rowSpan: 1,
				columnSpan: 1,
				startRowOffset: 0,
				endRowOffset: 1,
				startColumnOffset: 1,
				endColumnOffset: 2,
				columnHeader: false,
				rowHeader: false,
				rowSection: false,
				carried: false,
			},
			{
				column: 2,
				rawText: "pcs",
				lines: ["pcs"],
				rowSpan: 1,
				columnSpan: 1,
				startRowOffset: 0,
				endRowOffset: 1,
				startColumnOffset: 2,
				endColumnOffset: 3,
				columnHeader: false,
				rowHeader: false,
				rowSection: false,
				carried: false,
			},
		],
		rawText: `${id} | pcs`,
		classification: "unknown",
		confidence: 0.72,
		warnings: [],
	});
	const row1 = makeRow("mapped-row", 1);
	const row2 = makeRow("mapped-row-2", 2);
	const row3 = makeRow("mapped-row-3", 3);
	const sourceRows = [...fixture.sourceRows, row1, row2, row3];
	const run = {
		...fixture.run,
		sourceRowCount: sourceRows.length,
		sourceRowChecksum: checksumSourceRows(sourceRows),
	};
	const runRecord = fixture.db.docs.get(fixture.runPath)!;
	runRecord.sourceRowCount = run.sourceRowCount;
	runRecord.sourceRowChecksum = run.sourceRowChecksum;
	runRecord.identityFingerprint = extractionRunIdentityFingerprint(run);
	fixture.db.docs.set(`${fixture.runPath}/sourceRows/${row1.id}`, {
		...row1,
		fingerprint: stableSourceRowFingerprint(row1),
	});
	fixture.db.docs.set(`${fixture.runPath}/sourceRows/${row2.id}`, {
		...row2,
		fingerprint: stableSourceRowFingerprint(row2),
	});
	fixture.db.docs.set(`${fixture.runPath}/sourceRows/${row3.id}`, {
		...row3,
		fingerprint: stableSourceRowFingerprint(row3),
	});
	const targetItems = new Map(
		boq.sections
			.flatMap((section) => section.items)
			.flatMap((entry) => (entry.id ? [[entry.id, entry] as const] : [])),
	);
	const context = {
		extractionRunId: run.id,
		sections: boq.sections,
		targetItems,
		candidateItems: buildExtractionCandidates(run, sourceRows),
		sourceRows,
		allowedSourceRowIds: new Set([row1.id, row2.id, row3.id]),
	};
	const prepared = prepareProviderProposalV2(
		{
			id: "proposal-multi-row",
			operation: "needs_human_review",
			sourceRowIds: ["mapped-row", "mapped-row-2", "mapped-row-3"],
			targetItemIds: [],
			candidateItemIds: [],
			confidence: 0.72,
			explanation:
				"Multiple source rows need manual review with no automatic correction.",
			sourceRowSuggestions: [
				{
					sourceRowId: "mapped-row",
					suggestedAction: "add",
					reasonCode: "missing_priced_item",
					reason: "Row needs a manual item.",
					confidence: 0.8,
				},
				{
					sourceRowId: "mapped-row-2",
					suggestedAction: "ignore",
					reasonCode: "summary_or_tax",
					reason: "Looks like a summary line.",
					confidence: 0.7,
				},
				{
					sourceRowId: "mapped-row-3",
					suggestedAction: "add",
					reasonCode: "uncertain",
					reason: "Ambiguous but plausibly priced.",
					confidence: 0.6,
				},
			],
		},
		context,
	);
	if (!prepared.ok) throw new Error("multi-row proposal preparation failed");
	const proposal = {
		...prepared.proposal,
		evidenceValid: true as const,
		reconciled: true as const,
		stale: false,
	};
	return { ...fixture, boq, run, sourceRows, proposal };
}

test("addSourceItem writes a user-origin item with source provenance, audit, and accepted lifecycle", async () => {
	const fixture = reviewDraftHarness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	const before = structuredClone(fixture.db.docs.get("boqs/boq-1")!);

	const result = await fixture.store.addSourceItem(
		"boq-1",
		"run-1",
		fixture.proposal.id,
		single(fixture.userValues),
		"user-7",
	);
	assert.equal(result.status, 200);
	if (result.status !== 200) return;

	const stored = fixture.db.docs.get("boqs/boq-1") as unknown as Boq;
	const previous = (before as unknown as Boq).sections[0].items.length;
	const added = stored.sections[0].items[previous] as BoqPricedItem | undefined;
	assert.ok(added, "a user-origin item was appended");
	assert.equal(added.entryOrigin, "user");
	assert.equal(added.sourceRowId, "mapped-row");
	assert.deepEqual(added.sourceRowIds, ["mapped-row"]);
	assert.equal(added.costAllocation?.origin, "manual");
	assert.equal(added.costAllocation?.material, 50);
	assert.equal(added.costAllocation?.labour, 50);
	assert.equal(added.rate, 100);
	assert.equal(added.total, 200);
	assert.equal(stored.totalItems, (before as unknown as Boq).totalItems + 1);
	assert.equal(stored.grandTotal, (before as unknown as Boq).grandTotal + 200);

	const proposalRecord = fixture.db.docs.get(
		`${fixture.runPath}/proposals/${fixture.proposal.id}`,
	)!;
	assert.equal(proposalRecord.lifecycleStatus, "accepted");

	const audit = fixture.db.docs.get(
		`${fixture.runPath}/proposalAudits/${fixture.proposal.id}`,
	)!;
	assert.equal(audit.status, "accepted");
	assert.equal(audit.actorId, "user-7");
	assert.equal(audit.operation, "needs_human_review");
	assert.deepEqual(audit.proposedItems, []);
	assert.ok(
		audit.reviewDraft,
		"audit preserves the source-derived review draft",
	);
	assert.ok(
		audit.beforeSections && audit.afterSections,
		"audit records before/after sections",
	);
	assert.ok(audit.resultBoq, "audit pins the exact accepted BOQ");
	assert.equal((audit.resultBoq as Boq).grandTotal, stored.grandTotal);
});

test("addSourceItem is idempotent when retried with the same accepted proposal", async () => {
	const fixture = reviewDraftHarness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	const first = await fixture.store.addSourceItem(
		"boq-1",
		"run-1",
		fixture.proposal.id,
		single(fixture.userValues),
		"user-7",
	);
	assert.equal(first.status, 200);
	const firstBoq = (first.body as { boq: Boq }).boq;

	const edited = fixture.db.docs.get("boqs/boq-1")!;
	(edited as { project: string }).project = "User-edited project";
	(edited as { updatedAt: string }).updatedAt = "2026-07-20T12:01:00.000Z";
	const retry = await fixture.store.addSourceItem(
		"boq-1",
		"run-1",
		fixture.proposal.id,
		single(fixture.userValues),
		"user-7",
	);
	assert.equal(retry.status, 200);
	assert.deepEqual((retry.body as { boq: Boq }).boq, firstBoq);
	assert.equal((retry.body as { idempotent?: boolean }).idempotent, true);
	assert.equal(
		(fixture.db.docs.get("boqs/boq-1") as { project: string }).project,
		"User-edited project",
	);
});

test("addSourceItem rejects approved BOQs, missing drafts, stale evidence, and missing proposals", async () => {
	const fixture = reviewDraftHarness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);

	fixture.db.docs.get("boqs/boq-1")!.status = "approved";
	const approvedBefore = structuredClone(fixture.db.docs.get("boqs/boq-1")!);
	const approved = await fixture.store.addSourceItem(
		"boq-1",
		"run-1",
		fixture.proposal.id,
		single(fixture.userValues),
		"user-7",
	);
	assert.equal(approved.status, 409);
	assert.deepEqual(fixture.db.docs.get("boqs/boq-1"), approvedBefore);
	fixture.db.docs.get("boqs/boq-1")!.status = "draft";

	const missing = await fixture.store.addSourceItem(
		"boq-1",
		"run-1",
		"no-such-proposal",
		single(fixture.userValues),
		"user-7",
	);
	assert.equal(missing.status, 404);

	const runRecord = fixture.db.docs.get(fixture.runPath)! as {
		deterministicSections: { checksum: string };
	};
	const savedChecksum = runRecord.deterministicSections.checksum;
	runRecord.deterministicSections.checksum = "sha256:changed";
	const stale = await fixture.store.addSourceItem(
		"boq-1",
		"run-1",
		fixture.proposal.id,
		single(fixture.userValues),
		"user-7",
	);
	assert.equal(stale.status, 409);
	runRecord.deterministicSections.checksum = savedChecksum;
});

test("addSourceItem rejects target and non-human operations without a source-backed review draft", async () => {
	const fixture = harness();
	const userValues = parseSourceBackedItemRequest({
		sectionIndex: 0,
		item: {
			desc: "Wall",
			unit: "pcs",
			qty: 1,
			materialCost: 10,
			labourCost: 5,
		},
	});
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	const before = structuredClone(fixture.db.docs.get("boqs/boq-1")!);
	const result = await fixture.store.addSourceItem(
		"boq-1",
		"run-1",
		fixture.proposal.id,
		single(userValues),
		"user-7",
	);
	assert.equal(result.status, 409);
	assert.deepEqual(fixture.db.docs.get("boqs/boq-1"), before);
});

test("addSourceItem rejects invalid section destinations and bad arithmetic as 400 errors", async () => {
	const fixture = reviewDraftHarness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	const before = structuredClone(fixture.db.docs.get("boqs/boq-1")!);

	const badSection = await fixture.store.addSourceItem(
		"boq-1",
		"run-1",
		fixture.proposal.id,
		single({ ...fixture.userValues, sectionIndex: 99 }),
		"user-7",
	);
	assert.equal(badSection.status, 400);

	const badCosts = await fixture.store.addSourceItem(
		"boq-1",
		"run-1",
		fixture.proposal.id,
		single({ ...fixture.userValues, materialCost: Number.NaN }),
		"user-7",
	);
	assert.equal(badCosts.status, 400);

	assert.deepEqual(fixture.db.docs.get("boqs/boq-1"), before);
	const proposalRecord = fixture.db.docs.get(
		`${fixture.runPath}/proposals/${fixture.proposal.id}`,
	)!;
	assert.notEqual(proposalRecord.lifecycleStatus, "accepted");
	assert.equal(
		fixture.db.docs.has(
			`${fixture.runPath}/proposalAudits/${fixture.proposal.id}`,
		),
		false,
	);
});

test("addSourceItem conflicts with a prior skipped audit until reopened", async () => {
	const fixture = reviewDraftHarness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	await fixture.store.skip("boq-1", "run-1", fixture.proposal.id, "user-1");
	const before = structuredClone(fixture.db.docs.get("boqs/boq-1")!);
	const result = await fixture.store.addSourceItem(
		"boq-1",
		"run-1",
		fixture.proposal.id,
		single(fixture.userValues),
		"user-7",
	);
	assert.equal(result.status, 409);
	assert.deepEqual(fixture.db.docs.get("boqs/boq-1"), before);
	assert.equal(
		(
			await fixture.store.reopen(
				"boq-1",
				"run-1",
				fixture.proposal.id,
				"user-1",
			)
		).status,
		200,
	);
	const reopened = await fixture.store.addSourceItem(
		"boq-1",
		"run-1",
		fixture.proposal.id,
		single(fixture.userValues),
		"user-7",
	);
	assert.equal(reopened.status, 200);
});

test("addSourceItem adds a user item from immutable evidence when a no-target human-review proposal has no draft", async () => {
	const fixture = evidenceOnlyReviewHarness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);

	const result = await fixture.store.addSourceItem(
		"boq-1",
		"run-1",
		fixture.proposal.id,
		single(fixture.userValues),
		"user-7",
	);

	assert.equal(result.status, 200);
	const stored = fixture.db.docs.get("boqs/boq-1") as unknown as Boq;
	const added = stored.sections[0].items.at(-1) as BoqPricedItem;
	assert.equal(added.entryOrigin, "user");
	assert.deepEqual(added.sourceRowIds, ["mapped-row"]);
	assert.deepEqual(added.sourceRef, { page: 9, table: 1, row: 1 });
	assert.equal(added.rate, 6000);
	assert.equal(added.total, 6000);

	const audit = fixture.db.docs.get(
		`${fixture.runPath}/proposalAudits/${fixture.proposal.id}`,
	)!;
	assert.equal(audit.status, "accepted");
	assert.equal(audit.reviewDraft, undefined);
	assert.deepEqual(audit.proposedItems, []);
});

test("retrying an accepted evidence-only proposal returns idempotent without a second item", async () => {
	const fixture = evidenceOnlyReviewHarness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	const first = await fixture.store.addSourceItem(
		"boq-1",
		"run-1",
		fixture.proposal.id,
		single(fixture.userValues),
		"user-7",
	);
	assert.equal(first.status, 200);
	if (first.status !== 200) return;
	const firstBoq = first.body.boq as Boq;
	const firstItemCount = firstBoq.sections[0].items.length;

	const retry = await fixture.store.addSourceItem(
		"boq-1",
		"run-1",
		fixture.proposal.id,
		single(fixture.userValues),
		"user-7",
	);
	assert.equal(retry.status, 200);
	assert.deepEqual((retry.body as { boq: Boq }).boq, firstBoq);
	assert.equal((retry.body as { idempotent?: boolean }).idempotent, true);
	const stored = fixture.db.docs.get("boqs/boq-1") as unknown as Boq;
	assert.equal(stored.sections[0].items.length, firstItemCount);
});

test("addSourceItem conflicts when a no-draft human-review proposal targets an existing item", async () => {
	const fixture = evidenceOnlyReviewHarness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	const stored = fixture.db.docs.get(
		`${fixture.runPath}/proposals/${fixture.proposal.id}`,
	)! as {
		proposal: {
			targetItemIds: string[];
			affectedItemFingerprints: Record<string, string>;
		};
	};
	const target = (fixture.db.docs.get("boqs/boq-1") as unknown as Boq).sections
		.flatMap((section) => section.items)
		.find((item) => item.id)!;
	stored.proposal.targetItemIds = [target.id!];
	stored.proposal.affectedItemFingerprints = {
		[target.id!]: fingerprintCanonicalItem(target),
	};

	const before = structuredClone(fixture.db.docs.get("boqs/boq-1")!);
	const result = await fixture.store.addSourceItem(
		"boq-1",
		"run-1",
		fixture.proposal.id,
		single(fixture.userValues),
		"user-7",
	);
	assert.equal(result.status, 409);
	assert.deepEqual(fixture.db.docs.get("boqs/boq-1"), before);
});

test("addSourceItem rejects an evidence-only proposal after the canonical BOQ sections change", async () => {
	const fixture = evidenceOnlyReviewHarness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	const boq = fixture.db.docs.get("boqs/boq-1")! as unknown as Boq;
	boq.sections[0]!.items[0]!.desc = "Editor changed the canonical section";
	const before = structuredClone(fixture.db.docs.get("boqs/boq-1")!);
	const result = await fixture.store.addSourceItem(
		"boq-1",
		"run-1",
		fixture.proposal.id,
		single(fixture.userValues),
		"user-7",
	);
	assert.equal(result.status, 409);
	assert.deepEqual(fixture.db.docs.get("boqs/boq-1"), before);
});

test("evidence-only manual inserts remain blocked for approved BOQs and a terminal skipped lifecycle", async () => {
	const fixture = evidenceOnlyReviewHarness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);

	fixture.db.docs.get("boqs/boq-1")!.status = "approved";
	const approvedBefore = structuredClone(fixture.db.docs.get("boqs/boq-1")!);
	assert.equal(
		(
			await fixture.store.addSourceItem(
				"boq-1",
				"run-1",
				fixture.proposal.id,
				single(fixture.userValues),
				"user-7",
			)
		).status,
		409,
	);
	assert.deepEqual(fixture.db.docs.get("boqs/boq-1"), approvedBefore);
	fixture.db.docs.get("boqs/boq-1")!.status = "draft";

	assert.equal(
		(await fixture.store.skip("boq-1", "run-1", fixture.proposal.id, "user-1"))
			.status,
		200,
	);
	const skippedBefore = structuredClone(fixture.db.docs.get("boqs/boq-1")!);
	assert.equal(
		(
			await fixture.store.addSourceItem(
				"boq-1",
				"run-1",
				fixture.proposal.id,
				single(fixture.userValues),
				"user-7",
			)
		).status,
		409,
	);
	assert.deepEqual(fixture.db.docs.get("boqs/boq-1"), skippedBefore);
	assert.equal(
		(
			await fixture.store.reopen(
				"boq-1",
				"run-1",
				fixture.proposal.id,
				"user-1",
			)
		).status,
		200,
	);
	const reopened = await fixture.store.addSourceItem(
		"boq-1",
		"run-1",
		fixture.proposal.id,
		single(fixture.userValues),
		"user-7",
	);
	assert.equal(reopened.status, 200);
});

test("decision batch creates one item per added row in proposal order with ordered audit decisions", async () => {
	const fixture = multiRowEvidenceHarness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	const before = structuredClone(
		fixture.db.docs.get("boqs/boq-1")!,
	) as unknown as Boq;
	const validItem = (desc: string) => ({
		desc,
		unit: "Lot",
		qty: 1,
		materialCost: 1000,
		labourCost: 0,
	});

	const batchRequest = parseSourceBackedManualAddRequest({
		decisions: [
			{
				sourceRowId: "mapped-row-3",
				action: "ignore",
				note: "  Summary row  ",
			},
			{
				sourceRowId: "mapped-row-2",
				action: "add",
				sectionIndex: 0,
				item: validItem("Second"),
			},
			{
				sourceRowId: "mapped-row",
				action: "add",
				sectionIndex: 0,
				item: validItem("First"),
			},
		],
	});

	const result = await fixture.store.addSourceItem(
		"boq-1",
		"run-1",
		fixture.proposal.id,
		batchRequest,
		"user-7",
	);
	assert.equal(result.status, 200);
	if (result.status !== 200) return;
	const stored = fixture.db.docs.get("boqs/boq-1") as unknown as Boq;

	// Exactly two items are created, in proposal row order (First then Second).
	const added = stored.sections[0].items.slice(
		before.sections[0].items.length,
	) as BoqPricedItem[];
	assert.equal(added.length, 2);
	assert.deepEqual(
		added.map((item) => item.desc),
		["First", "Second"],
	);

	// Each created item carries only its own single-row provenance and PDF sourceRef.
	assert.equal(added[0]!.sourceRowId, "mapped-row");
	assert.deepEqual(added[0]!.sourceRowIds, ["mapped-row"]);
	assert.deepEqual(added[0]!.sourceRef, { page: 9, table: 1, row: 1 });
	assert.equal(added[1]!.sourceRowId, "mapped-row-2");
	assert.deepEqual(added[1]!.sourceRowIds, ["mapped-row-2"]);
	assert.deepEqual(added[1]!.sourceRef, { page: 9, table: 1, row: 2 });

	// The ignored row creates no item; one BOQ write carries the aggregate total.
	assert.equal(stored.totalItems, before.totalItems + 2);
	assert.equal(stored.grandTotal, before.grandTotal + 2000);

	const audit = fixture.db.docs.get(
		`${fixture.runPath}/proposalAudits/${fixture.proposal.id}`,
	)! as {
		status: string;
		sequence: number;
		sourceRowDecisions: Array<{
			sourceRowId: string;
			action: string;
			itemId?: string;
			note?: string;
		}>;
		sourceRowSuggestions: Array<{
			sourceRowId: string;
			suggestedAction: string;
			reason: string;
			confidence: number;
		}>;
	};
	assert.equal(audit.status, "accepted");

	// Audit decisions are ordered in proposal order and bind to generated item IDs.
	const decisions = audit.sourceRowDecisions;
	assert.deepEqual(
		decisions.map((decision) => decision.sourceRowId),
		["mapped-row", "mapped-row-2", "mapped-row-3"],
	);
	assert.equal(decisions[0]!.action, "add");
	assert.equal(decisions[0]!.itemId, added[0]!.id);
	assert.equal(decisions[1]!.action, "add");
	assert.equal(decisions[1]!.itemId, added[1]!.id);
	assert.equal(decisions[2]!.action, "ignore");
	assert.equal(decisions[2]!.note, "Summary row");

	// AI suggestions and final human choices remain separate.
	assert.ok(
		audit.sourceRowSuggestions,
		"audit preserves the AI advisory suggestions",
	);
	assert.equal(audit.sourceRowSuggestions.length, 3);
	assert.notDeepEqual(
		audit.sourceRowSuggestions.map((suggestion) => suggestion.suggestedAction),
		decisions.map((decision) => decision.action),
	);

	// One accepted audit / lifecycle update occurs.
	assert.equal(audit.sequence, 1);
	assert.equal(
		fixture.db.docs.get(`${fixture.runPath}/proposals/${fixture.proposal.id}`)!
			.lifecycleStatus,
		"accepted",
	);
});

test("retrying an accepted multi-row decision batch returns the original result without duplicates", async () => {
	const fixture = multiRowEvidenceHarness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	const batchRequest = parseSourceBackedManualAddRequest({
		decisions: [
			{ sourceRowId: "mapped-row-2", action: "ignore" },
			{
				sourceRowId: "mapped-row",
				action: "add",
				sectionIndex: 0,
				item: {
					desc: "Tooling",
					unit: "Lot",
					qty: 1,
					materialCost: 6000,
					labourCost: 0,
				},
			},
			{ sourceRowId: "mapped-row-3", action: "ignore", note: "Skip" },
		],
	});
	const first = await fixture.store.addSourceItem(
		"boq-1",
		"run-1",
		fixture.proposal.id,
		batchRequest,
		"user-7",
	);
	assert.equal(first.status, 200);
	if (first.status !== 200) return;
	const firstBoq = (first.body as { boq: Boq }).boq;
	const firstAudit = (first.body as { audit: ExtractionProposalAudit }).audit;

	const edited = fixture.db.docs.get("boqs/boq-1")!;
	(edited as { project: string }).project = "User-edited project";
	(edited as { updatedAt: string }).updatedAt = "2026-07-20T12:01:00.000Z";
	const retry = await fixture.store.addSourceItem(
		"boq-1",
		"run-1",
		fixture.proposal.id,
		batchRequest,
		"user-7",
	);
	assert.equal(retry.status, 200);
	assert.deepEqual((retry.body as { boq: Boq }).boq, firstBoq);
	assert.deepEqual(
		(retry.body as { audit: ExtractionProposalAudit }).audit,
		firstAudit,
	);
	assert.equal((retry.body as { idempotent?: boolean }).idempotent, true);
	const stored = fixture.db.docs.get("boqs/boq-1") as unknown as Boq;
	assert.equal(
		stored.sections[0].items.length,
		firstBoq.sections[0].items.length,
	);
});

test("undo removes only the created decision-batch items", async () => {
	const fixture = multiRowEvidenceHarness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	const before = structuredClone(
		fixture.db.docs.get("boqs/boq-1")!,
	) as unknown as Boq;
	const batchRequest = parseSourceBackedManualAddRequest({
		decisions: [
			{
				sourceRowId: "mapped-row",
				action: "add",
				sectionIndex: 0,
				item: {
					desc: "Only add",
					unit: "Lot",
					qty: 1,
					materialCost: 5000,
					labourCost: 0,
				},
			},
			{ sourceRowId: "mapped-row-2", action: "ignore" },
			{ sourceRowId: "mapped-row-3", action: "ignore" },
		],
	});
	const accepted = await fixture.store.addSourceItem(
		"boq-1",
		"run-1",
		fixture.proposal.id,
		batchRequest,
		"user-7",
	);
	assert.equal(accepted.status, 200);

	const undone = await fixture.store.undo(
		"boq-1",
		"run-1",
		fixture.proposal.id,
		"user-7",
	);
	assert.equal(undone.status, 200);
	const stored = fixture.db.docs.get("boqs/boq-1") as unknown as Boq;
	assert.deepEqual(stored.sections, before.sections);
	assert.equal(stored.totalItems, before.totalItems);
	assert.equal(stored.grandTotal, before.grandTotal);
});

test("an all-ignore decision batch accepts with unchanged sections and totals and a complete audit", async () => {
	const fixture = multiRowEvidenceHarness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	const before = structuredClone(
		fixture.db.docs.get("boqs/boq-1")!,
	) as unknown as Boq;
	const batchRequest = parseSourceBackedManualAddRequest({
		decisions: [
			{ sourceRowId: "mapped-row-3", action: "ignore", note: "Summary" },
			{ sourceRowId: "mapped-row", action: "ignore" },
			{ sourceRowId: "mapped-row-2", action: "ignore" },
		],
	});

	const result = await fixture.store.addSourceItem(
		"boq-1",
		"run-1",
		fixture.proposal.id,
		batchRequest,
		"user-7",
	);
	assert.equal(result.status, 200);
	if (result.status !== 200) return;
	const stored = fixture.db.docs.get("boqs/boq-1") as unknown as Boq;
	assert.deepEqual(stored.sections, before.sections);
	assert.equal(stored.totalItems, before.totalItems);
	assert.equal(stored.grandTotal, before.grandTotal);

	const audit = fixture.db.docs.get(
		`${fixture.runPath}/proposalAudits/${fixture.proposal.id}`,
	)! as {
		status: string;
		sourceRowDecisions: Array<{ action: string; sourceRowId: string }>;
	};
	assert.equal(audit.status, "accepted");
	assert.deepEqual(
		audit.sourceRowDecisions.map((decision) => [
			decision.sourceRowId,
			decision.action,
		]),
		[
			["mapped-row", "ignore"],
			["mapped-row-2", "ignore"],
			["mapped-row-3", "ignore"],
		],
	);
	assert.equal(
		fixture.db.docs.get(`${fixture.runPath}/proposals/${fixture.proposal.id}`)!
			.lifecycleStatus,
		"accepted",
	);
});

test("addSourceItem rejects a single request for a multi-row proposal with decision_batch_required", async () => {
	const fixture = multiRowEvidenceHarness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	const before = structuredClone(fixture.db.docs.get("boqs/boq-1")!);
	const result = await fixture.store.addSourceItem(
		"boq-1",
		"run-1",
		fixture.proposal.id,
		single(
			parseSourceBackedItemRequest({
				sectionIndex: 0,
				item: {
					desc: "Tooling",
					unit: "Lot",
					qty: 1,
					materialCost: 6000,
					labourCost: 0,
				},
			}),
		),
		"user-7",
	);
	assert.equal(result.status, 409);
	assert.equal(
		(result.body as { error?: string }).error,
		"decision_batch_required",
	);
	assert.deepEqual(fixture.db.docs.get("boqs/boq-1"), before);
});

test("addSourceItem rejects a batch request for a one-row proposal with single_required", async () => {
	const fixture = evidenceOnlyReviewHarness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	const before = structuredClone(fixture.db.docs.get("boqs/boq-1")!);
	const batchRequest = parseSourceBackedManualAddRequest({
		decisions: [
			{
				sourceRowId: "mapped-row",
				action: "add",
				sectionIndex: 0,
				item: {
					desc: "Valve",
					unit: "Lot",
					qty: 1,
					materialCost: 3000,
					labourCost: 3000,
				},
			},
		],
	});
	const result = await fixture.store.addSourceItem(
		"boq-1",
		"run-1",
		fixture.proposal.id,
		batchRequest,
		"user-7",
	);
	assert.equal(result.status, 409);
	assert.equal((result.body as { error?: string }).error, "single_required");
	assert.deepEqual(fixture.db.docs.get("boqs/boq-1"), before);
});

test("addSourceItem rejects a decision-batch request for a mapped review-draft proposal with single_required", async () => {
	const fixture = reviewDraftHarness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	const before = structuredClone(fixture.db.docs.get("boqs/boq-1")!);
	const batchRequest = parseSourceBackedManualAddRequest({
		decisions: [
			{
				sourceRowId: "mapped-row",
				action: "add",
				sectionIndex: 0,
				item: {
					desc: "Wall",
					unit: "pcs",
					qty: 2,
					materialCost: 50,
					labourCost: 50,
				},
			},
		],
	});
	const result = await fixture.store.addSourceItem(
		"boq-1",
		"run-1",
		fixture.proposal.id,
		batchRequest,
		"user-7",
	);
	assert.equal(result.status, 409);
	assert.equal((result.body as { error?: string }).error, "single_required");
	assert.deepEqual(fixture.db.docs.get("boqs/boq-1"), before);
});

test("addSourceItem rejects a decision batch with a wrong source-row set and mutates nothing", async () => {
	const fixture = multiRowEvidenceHarness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	const before = structuredClone(fixture.db.docs.get("boqs/boq-1")!);

	const extraRow = parseSourceBackedManualAddRequest({
		decisions: [
			{
				sourceRowId: "mapped-row",
				action: "add",
				sectionIndex: 0,
				item: {
					desc: "A",
					unit: "Lot",
					qty: 1,
					materialCost: 1,
					labourCost: 0,
				},
			},
			{ sourceRowId: "mapped-row-2", action: "ignore" },
			{ sourceRowId: "mapped-row-3", action: "ignore" },
			{
				sourceRowId: "unknown-row",
				action: "add",
				sectionIndex: 0,
				item: {
					desc: "B",
					unit: "Lot",
					qty: 1,
					materialCost: 2,
					labourCost: 0,
				},
			},
		],
	});
	assert.equal(
		(
			await fixture.store.addSourceItem(
				"boq-1",
				"run-1",
				fixture.proposal.id,
				extraRow,
				"user-7",
			)
		).status,
		409,
	);
	assert.deepEqual(fixture.db.docs.get("boqs/boq-1"), before);

	const missingRow = parseSourceBackedManualAddRequest({
		decisions: [
			{
				sourceRowId: "mapped-row",
				action: "add",
				sectionIndex: 0,
				item: {
					desc: "A",
					unit: "Lot",
					qty: 1,
					materialCost: 1,
					labourCost: 0,
				},
			},
		],
	});
	assert.equal(
		(
			await fixture.store.addSourceItem(
				"boq-1",
				"run-1",
				fixture.proposal.id,
				missingRow,
				"user-7",
			)
		).status,
		409,
	);
	assert.deepEqual(fixture.db.docs.get("boqs/boq-1"), before);
});

test("a later failed add rolls back the whole decision batch with no BOQ, audit, or lifecycle write", async () => {
	const fixture = multiRowEvidenceHarness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	const before = structuredClone(
		fixture.db.docs.get("boqs/boq-1")!,
	) as unknown as Boq;

	const badBatch = parseSourceBackedManualAddRequest({
		decisions: [
			{
				sourceRowId: "mapped-row",
				action: "add",
				sectionIndex: 0,
				item: {
					desc: "Tooling",
					unit: "Lot",
					qty: 1,
					materialCost: 6000,
					labourCost: 0,
				},
			},
			{
				sourceRowId: "mapped-row-2",
				action: "add",
				sectionIndex: 99,
				item: {
					desc: "Expense",
					unit: "Lot",
					qty: 1,
					materialCost: 61616,
					labourCost: 0,
				},
			},
			{ sourceRowId: "mapped-row-3", action: "ignore" },
		],
	});
	const result = await fixture.store.addSourceItem(
		"boq-1",
		"run-1",
		fixture.proposal.id,
		badBatch,
		"user-7",
	);
	assert.equal(result.status, 400);

	const stored = fixture.db.docs.get("boqs/boq-1") as unknown as Boq;
	assert.equal(
		stored.sections[0].items.length,
		before.sections[0].items.length,
	);
	assert.equal(stored.grandTotal, before.grandTotal);
	const proposalRecord = fixture.db.docs.get(
		`${fixture.runPath}/proposals/${fixture.proposal.id}`,
	)!;
	assert.notEqual(proposalRecord.lifecycleStatus, "accepted");
	assert.equal(
		fixture.db.docs.has(
			`${fixture.runPath}/proposalAudits/${fixture.proposal.id}`,
		),
		false,
	);
});

test("multi-row decision batches remain blocked for approved BOQs and a terminal skipped lifecycle", async () => {
	const fixture = multiRowEvidenceHarness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	const batchRequest = parseSourceBackedManualAddRequest({
		decisions: [
			{
				sourceRowId: "mapped-row",
				action: "add",
				sectionIndex: 0,
				item: {
					desc: "Tooling",
					unit: "Lot",
					qty: 1,
					materialCost: 6000,
					labourCost: 0,
				},
			},
			{ sourceRowId: "mapped-row-2", action: "ignore" },
			{ sourceRowId: "mapped-row-3", action: "ignore" },
		],
	});

	fixture.db.docs.get("boqs/boq-1")!.status = "approved";
	const approvedBefore = structuredClone(fixture.db.docs.get("boqs/boq-1")!);
	assert.equal(
		(
			await fixture.store.addSourceItem(
				"boq-1",
				"run-1",
				fixture.proposal.id,
				batchRequest,
				"user-7",
			)
		).status,
		409,
	);
	assert.deepEqual(fixture.db.docs.get("boqs/boq-1"), approvedBefore);
	fixture.db.docs.get("boqs/boq-1")!.status = "draft";

	assert.equal(
		(await fixture.store.skip("boq-1", "run-1", fixture.proposal.id, "user-1"))
			.status,
		200,
	);
	const skippedBefore = structuredClone(fixture.db.docs.get("boqs/boq-1")!);
	assert.equal(
		(
			await fixture.store.addSourceItem(
				"boq-1",
				"run-1",
				fixture.proposal.id,
				batchRequest,
				"user-7",
			)
		).status,
		409,
	);
	assert.deepEqual(fixture.db.docs.get("boqs/boq-1"), skippedBefore);
	assert.equal(
		(
			await fixture.store.reopen(
				"boq-1",
				"run-1",
				fixture.proposal.id,
				"user-1",
			)
		).status,
		200,
	);
	// After reopen the proposal is pending again, so a valid decision batch accepts.
	assert.equal(
		(
			await fixture.store.addSourceItem(
				"boq-1",
				"run-1",
				fixture.proposal.id,
				batchRequest,
				"user-7",
			)
		).status,
		200,
	);
});

test("store reload and acceptance reject mapped provenance with an unused declared row", async () => {
	const fixture = mappedStoreHarness();
	const prepared = prepareProviderProposalV2(fixture.decision, fixture.context);
	assert.equal(prepared.ok, true);
	if (!prepared.ok) return;
	const proposal = {
		...prepared.proposal,
		evidenceValid: true as const,
		reconciled: true as const,
		stale: false,
	};
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [proposal]);
	const path = `${fixture.runPath}/proposals/${proposal.id}`;
	const stored = fixture.db.docs.get(path)! as { proposal: typeof proposal };
	stored.proposal.sourceRowIds = ["mapped-row", fixture.sourceRows[0].id];
	stored.proposal.sourceCellMapping = {
		...stored.proposal.sourceCellMapping!,
		sourceRowIds: ["mapped-row", fixture.sourceRows[0].id],
	};
	const before = structuredClone(fixture.db.docs.get("boqs/boq-1"));
	await assert.rejects(
		() => fixture.store.getReviewState("boq-1", "run-1"),
		/Stored proposal record is invalid/,
	);
	assert.equal(
		(await fixture.store.accept("boq-1", "run-1", proposal.id, "user-1"))
			.status,
		404,
	);
	assert.deepEqual(fixture.db.docs.get("boqs/boq-1"), before);
});

test("store reload rejects malformed source-backed mapping and candidate metadata", async () => {
	for (const mutate of [
		(proposal: Record<string, unknown>) => {
			const mapping = proposal.sourceCellMapping as {
				unit: Record<string, unknown>;
			};
			mapping.unit.column = "bad";
		},
		(proposal: Record<string, unknown>) => {
			const candidate = proposal.mappedCandidate as Record<string, unknown>;
			candidate.total = "100";
		},
	]) {
		const fixture = mappedStoreHarness();
		const prepared = prepareProviderProposalV2(
			fixture.decision,
			fixture.context,
		);
		assert.equal(prepared.ok, true);
		if (!prepared.ok) continue;
		const proposal = {
			...prepared.proposal,
			evidenceValid: true as const,
			reconciled: true as const,
			stale: false,
		};
		await fixture.store.saveValidatedProposals("boq-1", "run-1", [proposal]);
		const stored = fixture.db.docs.get(
			`${fixture.runPath}/proposals/${proposal.id}`,
		)! as { proposal: Record<string, unknown> };
		mutate(stored.proposal);
		await assert.rejects(
			() => fixture.store.getReviewState("boq-1", "run-1"),
			/Stored proposal record is invalid/,
		);
	}
});

test("store reload rejects malformed source-backed review draft metadata", async () => {
	const fixture = mappedStoreHarness();
	const prepared = prepareProviderProposalV2(
		{
			...fixture.decision,
			cellMapping: {
				sourceRowIds: ["mapped-row"],
				description: [{ sourceRowId: "mapped-row", column: 1 }],
				unit: { sourceRowId: "mapped-row", column: 2 },
				quantity: { sourceRowId: "mapped-row", column: 3 },
			},
		},
		fixture.context,
	);
	assert.equal(prepared.ok, true);
	if (!prepared.ok) return;
	const proposal = {
		...prepared.proposal,
		evidenceValid: true as const,
		reconciled: true as const,
		stale: false,
	};
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [proposal]);
	const stored = fixture.db.docs.get(
		`${fixture.runPath}/proposals/${proposal.id}`,
	)! as {
		proposal: { reviewDraft: { missingFields: string[] } };
	};
	stored.proposal.reviewDraft.missingFields = ["provider-authored-field"];
	await assert.rejects(
		() => fixture.store.getReviewState("boq-1", "run-1"),
		/Stored proposal record is invalid/,
	);
});

test("store reload rejects unexpected proposal fields instead of exposing stored provider data", async () => {
	const fixture = mappedStoreHarness();
	const prepared = prepareProviderProposalV2(fixture.decision, fixture.context);
	assert.equal(prepared.ok, true);
	if (!prepared.ok) return;
	const proposal = {
		...prepared.proposal,
		evidenceValid: true as const,
		reconciled: true as const,
		stale: false,
	};
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [proposal]);
	const stored = fixture.db.docs.get(
		`${fixture.runPath}/proposals/${proposal.id}`,
	)! as {
		proposal: Record<string, unknown>;
	};
	stored.proposal.providerResponse = { text: "must not reach the client" };
	await assert.rejects(
		() => fixture.store.getReviewState("boq-1", "run-1"),
		/Stored proposal record is invalid/,
	);
});

test("single actions reload the stored proposal and reject approved BOQ mutation", async () => {
	const fixture = harness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	fixture.db.docs.get("boqs/boq-1")!.status = "approved";
	const before = structuredClone(fixture.db.docs.get("boqs/boq-1"));
	const result = await fixture.store.accept(
		"boq-1",
		"run-1",
		"proposal-1",
		"user-1",
	);
	assert.equal(result.status, 409);
	assert.deepEqual(fixture.db.docs.get("boqs/boq-1"), before);
	assert.equal(
		fixture.db.docs.has(`${fixture.runPath}/proposalAudits/proposal-1`),
		false,
	);
});

test("approved BOQs also reject undo without changing the accepted audit", async () => {
	const fixture = harness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	assert.equal(
		(await fixture.store.accept("boq-1", "run-1", "proposal-1", "user-1"))
			.status,
		200,
	);
	fixture.db.docs.get("boqs/boq-1")!.status = "approved";
	const before = structuredClone(fixture.db.docs.get("boqs/boq-1"));
	const result = await fixture.store.undo(
		"boq-1",
		"run-1",
		"proposal-1",
		"user-1",
	);
	assert.equal(result.status, 409);
	assert.deepEqual(fixture.db.docs.get("boqs/boq-1"), before);
	assert.equal(
		fixture.db.docs.has(
			`${fixture.runPath}/proposalAudits/proposal-1/events/undo`,
		),
		false,
	);
});

test("batch acceptance is one transaction and leaves BOQ and audits unchanged on any failure", async () => {
	const fixture = harness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	const before = structuredClone(fixture.db.docs.get("boqs/boq-1"));
	const result = await fixture.store.acceptBatch(
		"boq-1",
		"run-1",
		["proposal-1", "missing"],
		"user-1",
	);
	assert.equal(result.status, 404);
	assert.deepEqual(fixture.db.docs.get("boqs/boq-1"), before);
	assert.equal(
		fixture.db.docs.has(`${fixture.runPath}/proposalAudits/proposal-1`),
		false,
	);
});

test("batch acceptance atomically restores multiple targetless source-backed inserts in source order", async () => {
	const fixture = harness();
	const candidates = buildExtractionCandidates(fixture.run, fixture.sourceRows);
	const missing = [...candidates.values()]
		.filter((candidate) => candidate.pricingRole === "standard")
		.slice(0, 2);
	assert.equal(missing.length, 2);
	const boqRecord = fixture.db.docs.get("boqs/boq-1")! as unknown as Boq;
	const missingIds = new Set(missing.map((candidate) => candidate.id));
	boqRecord.sections = boqRecord.sections.map((section) => ({
		...section,
		items: section.items.filter((item) => !missingIds.has(item.id ?? "")),
	}));
	const targetItems = new Map(
		boqRecord.sections
			.flatMap((section) => section.items)
			.flatMap((item) => (item.id ? [[item.id, item] as const] : [])),
	);
	const proposals = missing.map((candidate, index) => {
		const prepared = prepareProviderProposalV2(
			{
				id: `insert-${index}`,
				operation: "insert_missing_item",
				sourceRowIds: candidate.sourceRowIds,
				targetItemIds: [],
				candidateItemIds: [candidate.id],
				confidence: 0.95,
				explanation: "Restore immutable source candidate.",
			},
			{
				extractionRunId: fixture.run.id,
				sections: boqRecord.sections,
				targetItems,
				candidateItems: candidates,
			},
		);
		assert.equal(prepared.ok, true);
		if (!prepared.ok) throw new Error("Preparation failed");
		return {
			...prepared.proposal,
			evidenceValid: true as const,
			reconciled: true as const,
			stale: false,
		};
	});
	await fixture.store.saveValidatedProposals("boq-1", "run-1", proposals);
	const beforeTransactions = fixture.db.transactionCount;
	const result = await fixture.store.acceptBatch(
		"boq-1",
		"run-1",
		proposals.map((proposal) => proposal.id),
		"user-1",
	);
	assert.equal(result.status, 200);
	assert.equal(fixture.db.transactionCount - beforeTransactions, 1);
	const restored = fixture.db.docs.get("boqs/boq-1")! as unknown as Boq;
	const restoredIds = restored.sections
		.flatMap((section) => section.items)
		.map((item) => item.id);
	for (const candidate of missing)
		assert.equal(restoredIds.includes(candidate.id), true);
	assert.ok(
		restoredIds.indexOf(missing[0].id) < restoredIds.indexOf(missing[1].id),
	);
});

test("Surasak stale 3-item draft atomically accepts 16 inserts into 19 source-ordered items totaling 47,000", async () => {
	const fixture = surasakHarness();
	const canonicalSourceRows = new Set(
		fixture.staleSections
			.flatMap((section) => section.items)
			.flatMap((item) => item.sourceRowIds ?? []),
	);
	const missing = [...fixture.candidates.values()]
		.filter(
			(candidate) =>
				!candidate.sourceRowIds.some((id) => canonicalSourceRows.has(id)),
		)
		.sort((left, right) => left.sourceOrder - right.sourceOrder);
	assert.equal(missing.length, 16);
	const current = fixture.db.docs.get("boqs/boq-surasak")! as unknown as Boq;
	const targetItems = new Map(
		current.sections
			.flatMap((section) => section.items)
			.flatMap((item) => (item.id ? [[item.id, item] as const] : [])),
	);
	const proposals = missing.map((candidate, index) => {
		const prepared = prepareProviderProposalV2(
			{
				id: `insert-surasak-${index + 1}`,
				operation: "insert_missing_item",
				sourceRowIds: candidate.sourceRowIds,
				targetItemIds: [],
				candidateItemIds: [candidate.id],
				confidence: 0.99,
				explanation: "Restore immutable source-backed quotation row.",
			},
			{
				extractionRunId: fixture.run.id,
				sections: current.sections,
				targetItems,
				candidateItems: fixture.candidates,
			},
		);
		assert.equal(prepared.ok, true);
		if (!prepared.ok) throw new Error("Surasak proposal preparation failed");
		return {
			...prepared.proposal,
			evidenceValid: true as const,
			reconciled: true as const,
			stale: false,
		};
	});
	const immutableStore = createFirestoreExtractionStore(fixture.db as never);
	const loaded = await immutableStore.getReadyImport(
		"boq-surasak",
		fixture.run.id,
	);
	assert.ok(loaded);
	assert.equal(
		extractionRunIdentityFingerprint(loaded.run),
		extractionRunIdentityFingerprint(fixture.run),
	);
	assert.equal(
		fingerprintParserConfig(loaded.run.sections),
		fingerprintParserConfig(fixture.run.sections),
	);
	assert.equal(
		(await immutableStore.getSourceRows("boq-surasak", fixture.run.id)).length,
		fixture.sourceRows.length,
	);
	await fixture.store.saveValidatedProposals(
		"boq-surasak",
		fixture.run.id,
		proposals,
	);
	const transactionsBefore = fixture.db.transactionCount;
	const result = await fixture.store.acceptBatch(
		"boq-surasak",
		fixture.run.id,
		proposals.map((proposal) => proposal.id),
		"user-1",
	);
	assert.equal(result.status, 200);
	assert.equal(fixture.db.transactionCount - transactionsBefore, 1);
	const accepted = fixture.db.docs.get("boqs/boq-surasak")! as unknown as Boq;
	assert.equal(accepted.totalItems, 19);
	assert.equal(accepted.grandTotal, 47000);
	assert.deepEqual(
		accepted.sections
			.flatMap((section) => section.items)
			.map((item) => item.id),
		fixture.expectedSections
			.flatMap((section) => section.items)
			.map((item) => item.id),
	);
	for (const id of [
		"di-sr-surasak-7-combined-1",
		"di-sr-surasak-8-combined-1",
	]) {
		const combined = accepted.sections
			.flatMap((section) => section.items)
			.find((item) => item.id === id) as BoqPricedItem;
		assert.equal(combined.costComponent, "combined");
		assert.ok(combined.sourceCosts);
	}
	for (const proposal of proposals) {
		const audit = fixture.db.docs.get(
			`${fixture.runPath}/proposalAudits/${proposal.id}`,
		)!;
		assert.equal(Array.isArray(audit.beforeSections), true);
		assert.equal(Array.isArray(audit.afterSections), true);
		assert.equal((audit.batchProposalIds as string[]).length, 16);
		assert.equal((audit.resultBoq as Boq).totalItems, 19);
		assert.equal((audit.resultBoq as Boq).grandTotal, 47000);
	}
	const beforeUnsafeUndo = structuredClone(
		fixture.db.docs.get("boqs/boq-surasak"),
	);
	const undo = await fixture.store.undo(
		"boq-surasak",
		fixture.run.id,
		proposals[0].id,
		"user-1",
	);
	assert.equal(undo.status, 409);
	assert.deepEqual(fixture.db.docs.get("boqs/boq-surasak"), beforeUnsafeUndo);
});

test("batch acceptance rejects legacy no-op and restructuring proposals", async () => {
	const fixture = harness();
	const bundle = fixture.boq.sections
		.flatMap((section) => section.items)
		.find((item) => item.id === "bundle")!;
	const option = fixture.boq.sections
		.flatMap((section) => section.items)
		.find((item) => item.id === "option")!;
	const proposals = [
		keepProposal("keep-bundle", "row-1", "bundle", bundle),
		keepProposal("keep-option", "row-3", "option", option),
		fixture.proposal,
	];
	await fixture.store.saveValidatedProposals(
		"boq-1",
		"run-1",
		proposals as never,
	);
	const before = structuredClone(fixture.db.docs.get("boqs/boq-1"));
	const result = await fixture.store.acceptBatch(
		"boq-1",
		"run-1",
		proposals.map((proposal) => proposal.id),
		"user-1",
	);
	assert.equal(result.status, 400);
	assert.deepEqual(fixture.db.docs.get("boqs/boq-1"), before);
	for (const proposal of proposals)
		assert.equal(
			fixture.db.docs.has(`${fixture.runPath}/proposalAudits/${proposal.id}`),
			false,
		);
});

test("a refreshed row supersedes old pending proposals and safely versions a reused model id", async () => {
	const fixture = harness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	const refreshed = {
		...fixture.proposal,
		explanation: "Fresh evidence review.",
	};
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [refreshed]);
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [refreshed]);
	const state = await fixture.store.getReviewState("boq-1", "run-1");
	assert.equal(state?.proposals.length, 2);
	assert.equal(state?.proposals[1]?.explanation, "Fresh evidence review.");
	assert.notEqual(state?.proposals[1]?.id, "proposal-1");
	const stored = [...fixture.db.docs.entries()].filter(([path]) =>
		path.includes("/proposals/"),
	);
	assert.equal(stored.length, 2);
	assert.equal(
		stored.filter(([, value]) => value.lifecycleStatus === "superseded").length,
		1,
	);
});

test("a refreshed row with no new suggestion still supersedes its old pending proposals", async () => {
	const fixture = harness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [], ["row-4"]);
	const state = await fixture.store.getReviewState("boq-1", "run-1");
	assert.deepEqual(
		state?.proposals.map((entry) => entry.id),
		["proposal-1"],
	);
	assert.equal(state?.proposalStatuses["proposal-1"]?.status, "superseded");
	assert.equal(
		fixture.db.docs.get(`${fixture.runPath}/proposals/proposal-1`)
			?.lifecycleStatus,
		"superseded",
	);
});

test("refresh never supersedes an accepted legacy proposal whose lifecycle marker is absent", async () => {
	const fixture = harness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	await fixture.store.accept("boq-1", "run-1", "proposal-1", "user-1");
	delete fixture.db.docs.get(`${fixture.runPath}/proposals/proposal-1`)!
		.lifecycleStatus;
	const acceptedBoq = fixture.db.docs.get("boqs/boq-1") as unknown as Boq;
	const material = acceptedBoq.sections[0]!.items.find(
		(item) => item.id === "material",
	)!;
	const refreshed = keepProposal("proposal-1", "row-4", "material", material);
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		{
			...refreshed,
			evidenceValid: true,
			reconciled: true,
			stale: false,
		} as ValidatedProposal,
	]);
	assert.notEqual(
		fixture.db.docs.get(`${fixture.runPath}/proposals/proposal-1`)!
			.lifecycleStatus,
		"superseded",
	);
});

test("review reload recomputes pending staleness and disables unsafe eligibility", async () => {
	const fixture = harness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	const canonical = fixture.db.docs.get("boqs/boq-1") as unknown as Boq;
	canonical.sections[0]!.items.find((item) => item.id === "combined")!.desc =
		"User changed after review";
	const state = await fixture.store.getReviewState("boq-1", "run-1");
	const proposalId = state?.proposals[0]?.id ?? "";
	assert.equal(state?.proposals[0]?.stale, true);
	assert.deepEqual(state?.proposalStatuses[proposalId], {
		status: "pending",
		canUndo: false,
		stale: true,
		eligible: false,
	});
});

test("approved BOQs reject proposal rejection to keep review state immutable", async () => {
	const fixture = harness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	fixture.db.docs.get("boqs/boq-1")!.status = "approved";
	const state = await fixture.store.getReviewState("boq-1", "run-1");
	const proposalId = state?.proposals[0]?.id ?? "";
	const result = await fixture.store.reject(
		"boq-1",
		"run-1",
		proposalId,
		"user-1",
	);
	assert.equal(result.status, 409);
	assert.equal(
		fixture.db.docs.has(`${fixture.runPath}/proposalAudits/${proposalId}`),
		false,
	);
});

test("review leases serialize dispatch, recover after expiry, and persist completion", async () => {
	let current = new Date("2026-07-20T12:00:00.000Z");
	const fixture = harness(() => current);
	const first = await fixture.store.acquireReviewLease(
		"boq-1",
		"run-1",
		"request-1",
		"lease-1",
		1_000,
		false,
	);
	assert.equal(first.kind, "acquired");
	const concurrent = await fixture.store.acquireReviewLease(
		"boq-1",
		"run-1",
		"request-1",
		"lease-2",
		1_000,
		false,
	);
	assert.equal(concurrent.kind, "busy");
	current = new Date("2026-07-20T12:00:02.000Z");
	const recovered = await fixture.store.acquireReviewLease(
		"boq-1",
		"run-1",
		"request-1",
		"lease-3",
		1_000,
		false,
	);
	assert.equal(recovered.kind, "acquired");
	await fixture.store.completeReviewLease(
		"boq-1",
		"run-1",
		"lease-3",
		"completed",
		[],
	);
	assert.equal(
		(fixture.db.docs.get(fixture.runPath)!.reviewRun as { status: string })
			.status,
		"completed",
	);
	assert.equal(
		(
			await fixture.store.acquireReviewLease(
				"boq-1",
				"run-1",
				"request-1",
				"lease-4",
				1_000,
				false,
			)
		).kind,
		"complete",
	);
});

test("late expired lease cannot persist or supersede proposals after the replacement lease completes", async () => {
	let current = new Date("2026-07-20T12:00:00.000Z");
	const fixture = harness(() => current);
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	const proposalB = {
		...fixture.proposal,
		id: "proposal-b",
		explanation: "Replacement lease result.",
	};
	const proposalA = {
		...fixture.proposal,
		id: "proposal-a",
		explanation: "Expired lease result.",
	};

	await fixture.store.acquireReviewLease(
		"boq-1",
		"run-1",
		"request-1",
		"lease-a",
		1_000,
		false,
	);
	current = new Date("2026-07-20T12:00:02.000Z");
	await fixture.store.acquireReviewLease(
		"boq-1",
		"run-1",
		"request-1",
		"lease-b",
		1_000,
		false,
	);
	await fixture.store.completeReviewLease(
		"boq-1",
		"run-1",
		"lease-b",
		"completed",
		[proposalB],
		["row-4"],
	);

	await assert.rejects(
		fixture.store.completeReviewLease(
			"boq-1",
			"run-1",
			"lease-a",
			"completed",
			[proposalA],
			["row-4"],
		),
		/lease was lost/,
	);

	const state = await fixture.store.getReviewState("boq-1", "run-1");
	assert.deepEqual(
		state?.proposals.map((entry) => entry.id),
		["proposal-1", "proposal-b"],
	);
	assert.equal(
		fixture.db.docs.has(`${fixture.runPath}/proposals/proposal-a`),
		false,
	);
	assert.equal(
		fixture.db.docs.get(`${fixture.runPath}/proposals/proposal-1`)
			?.lifecycleStatus,
		"superseded",
	);
	assert.equal(
		(fixture.db.docs.get(fixture.runPath)?.reviewRun as { status?: string })
			.status,
		"completed",
	);
});

test("lease completion with zero proposals still atomically supersedes refreshed-row suggestions", async () => {
	const fixture = harness();
	await fixture.store.saveValidatedProposals("boq-1", "run-1", [
		fixture.proposal,
	]);
	await fixture.store.acquireReviewLease(
		"boq-1",
		"run-1",
		"request-1",
		"lease-1",
		1_000,
		false,
	);

	await fixture.store.completeReviewLease(
		"boq-1",
		"run-1",
		"lease-1",
		"completed",
		[],
		["row-4"],
	);

	assert.deepEqual(
		(await fixture.store.getReviewState("boq-1", "run-1"))?.proposals.map(
			(entry) => entry.id,
		),
		["proposal-1"],
	);
	assert.equal(
		(await fixture.store.getReviewState("boq-1", "run-1"))?.proposalStatuses[
			"proposal-1"
		]?.status,
		"superseded",
	);
	assert.equal(
		fixture.db.docs.get(`${fixture.runPath}/proposals/proposal-1`)
			?.lifecycleStatus,
		"superseded",
	);
	assert.equal(
		(fixture.db.docs.get(fixture.runPath)?.reviewRun as { status?: string })
			.status,
		"completed",
	);
});

test("review lease completion durably unions rows reviewed without proposals", async () => {
	const fixture = harness();
	await fixture.store.acquireReviewLease(
		"boq-1",
		"run-1",
		"request-1",
		"lease-1",
		1_000,
		false,
	);
	await fixture.store.completeReviewLease(
		"boq-1",
		"run-1",
		"lease-1",
		"completed",
		[],
		["row-4"],
	);
	await fixture.store.acquireReviewLease(
		"boq-1",
		"run-1",
		"request-2",
		"lease-2",
		1_000,
		true,
	);
	await fixture.store.completeReviewLease(
		"boq-1",
		"run-1",
		"lease-2",
		"completed",
		[],
		["row-5"],
	);

	assert.deepEqual(
		(await fixture.store.getReviewState("boq-1", "run-1"))?.reviewRun
			.reviewedSourceRowIds,
		["row-4", "row-5"],
	);
});

test("review leases preserve reason-specific targeting through completion and reload", async () => {
	const fixture = harness();
	fixture.db.docs.get(fixture.runPath)!.reviewTargeting = {
		candidateRowIds: ["row-compound", "row-ambiguous", "row-unreconciled"],
		candidateCount: 3,
		ambiguousRowIds: ["row-ambiguous"],
		unreconciledRowIds: ["row-unreconciled"],
		unreconciled: true,
	};

	const acquired = await fixture.store.acquireReviewLease(
		"boq-1",
		"run-1",
		"request-1",
		"lease-1",
		1_000,
		false,
	);
	assert.deepEqual(acquired.reviewRun.reviewTargeting, {
		candidateRowIds: ["row-compound", "row-ambiguous", "row-unreconciled"],
		ambiguousRowIds: ["row-ambiguous"],
		unreconciledRowIds: ["row-unreconciled"],
		unreconciled: true,
	});
	await fixture.store.completeReviewLease(
		"boq-1",
		"run-1",
		"lease-1",
		"completed",
		[],
	);
	assert.deepEqual(
		(await fixture.store.getReviewState("boq-1", "run-1"))?.reviewRun
			.reviewTargeting,
		{
			candidateRowIds: ["row-compound", "row-ambiguous", "row-unreconciled"],
			ambiguousRowIds: ["row-ambiguous"],
			unreconciledRowIds: ["row-unreconciled"],
			unreconciled: true,
		},
	);
});

test("durable review failure prevents immediate automatic retry but permits retry after backoff", async () => {
	let current = new Date("2026-07-20T12:00:00.000Z");
	const fixture = harness(() => current);
	await fixture.store.acquireReviewLease(
		"boq-1",
		"run-1",
		"request-1",
		"lease-1",
		1_000,
		false,
	);
	await fixture.store.failReviewLease(
		"boq-1",
		"run-1",
		"lease-1",
		"timeout",
		30_000,
	);
	assert.equal(
		(
			await fixture.store.acquireReviewLease(
				"boq-1",
				"run-1",
				"request-1",
				"lease-2",
				1_000,
				false,
			)
		).kind,
		"failed",
	);
	current = new Date("2026-07-20T12:00:31.000Z");
	assert.equal(
		(
			await fixture.store.acquireReviewLease(
				"boq-1",
				"run-1",
				"request-1",
				"lease-3",
				1_000,
				false,
			)
		).kind,
		"acquired",
	);
});

test("reviewRun summary omits unexpected stored fields that could leak provider payloads or source data", async () => {
	const fixture = harness();
	const runRecord = fixture.db.docs.get(fixture.runPath) as RecordData;
	runRecord.reviewRun = {
		status: "completed",
		updatedAt: "2026-07-20T12:00:00.000Z",
		reviewedSourceRowIds: ["row-1"],
		rawProviderResponse: { choices: [{ message: { content: "LEAK" } }] },
		sourceDataBlob: "private-source",
		internalDebugTrace: ["sensitive-trace"],
	};
	runRecord.aiReviewStatus = "completed";

	const state = await fixture.store.getReviewState("boq-1", "run-1");
	const summary = state?.reviewRun as unknown as Record<string, unknown>;
	assert.equal(summary?.status, "completed");
	assert.deepEqual(summary?.reviewedSourceRowIds, ["row-1"]);
	assert.equal(summary?.rawProviderResponse, undefined);
	assert.equal(summary?.sourceDataBlob, undefined);
	assert.equal(summary?.internalDebugTrace, undefined);
});

// ---------------------------------------------------------------------------
// Actionable review decisions
// ---------------------------------------------------------------------------

const SUGGESTION_ID = "sha256:" + "b".repeat(64);
const FINGERPRINT = "sha256:" + "a".repeat(64);

function actionableHarness(
	clock: () => Date = () => new Date("2026-08-08T12:00:00.000Z"),
) {
	const fixture = harness(clock);
	const boq = fixture.db.docs.get("boqs/boq-1")! as unknown as Boq;
	const firstRow = fixture.sourceRows[0]!;
	const boqFp = fingerprintCanonicalSections(boq.sections);
	const versions = {
		extractionFingerprint: "sha256:extract",
		boqSectionsFingerprint: boqFp,
		catalogFingerprint: "sha256:catalog",
		conversionFingerprint: "sha256:conversion",
		promptVersion: "actionable-review-ai-v1",
	};
	const snapshot: ActionableReview = {
		id: FINGERPRINT,
		extractionRunId: "run-1",
		mode: "focused",
		generatedAt: "2026-08-08T12:00:00.000Z",
		versions,
		actionableItemSuggestions: [
			{
				id: SUGGESTION_ID,
				extractionRunId: "run-1",
				sourceRowIds: [firstRow.id],
				sourceRefs: [
					{ page: firstRow.page, table: firstRow.table, row: firstRow.row },
				],
				rowRole: "priced_item",
				deterministicReasons: ["structural_item"],
				suggestedSectionIndex: 0,
				extractedItem: {
					description: "Ready mix concrete",
					unit: "m3",
					quantity: "2",
					materialRate: "50",
					labourRate: "0",
					total: "100",
				},
				catalogCandidates: [],
				aiAdvice: {
					sourceRowId: firstRow.id,
					decision: "uncertain",
					confidence: 0.4,
					reason: "no safe match",
				},
				status: "pending",
				versions,
			},
			{
				id: "sha256:" + "c".repeat(64),
				extractionRunId: "run-1",
				sourceRowIds: [fixture.sourceRows[1]?.id ?? firstRow.id],
				sourceRefs: [
					{
						page: fixture.sourceRows[1]?.page ?? 1,
						table: fixture.sourceRows[1]?.table ?? 0,
						row: fixture.sourceRows[1]?.row ?? 2,
					},
				],
				rowRole: "priced_item",
				deterministicReasons: ["structural_item"],
				suggestedSectionIndex: 0,
				extractedItem: {
					description: "Second item",
					unit: "ea",
					quantity: "1",
					materialRate: "10",
					labourRate: "0",
					total: "10",
				},
				catalogCandidates: [],
				status: "pending",
				versions,
			},
		],
		dismissedEvidence: [],
		representedRows: [],
		validationSummary: {
			rawRowCount: 2,
			actionableCount: 2,
			dismissedCount: 0,
			representedCount: 0,
			locallyPreparedCatalogCount: 0,
			aiReviewedCount: 1,
			sourceTotalDifference: "0",
			rejectedReasonCounts: {},
		},
	};
	const path = actionableReviewSnapshotPath("boq-1", "run-1", FINGERPRINT);
	fixture.db.docs.set(path, toSnapshotDocument(snapshot));
	return { ...fixture, snapshot, firstRow, path, boqFp };
}

const matchingItem = {
	sectionIndex: 0,
	desc: "Ready mix concrete",
	unit: "m3",
	qty: 2,
	materialCost: 50,
	labourCost: 0,
};

test("decideActionableSuggestion add_pending_catalog creates one catalog-pending item with distinct pricing audit",
	async () => {
		const fixture = actionableHarness();
		const beforeItems = (
			fixture.db.docs.get("boqs/boq-1") as unknown as Boq
		).sections[0].items.length;

		const result = await fixture.store.decideActionableSuggestion(
			"boq-1",
			"run-1",
			SUGGESTION_ID,
			{
				action: "add_pending_catalog",
				expectedFingerprint: FINGERPRINT,
				item: matchingItem,
			},
			"user-1",
		);
		assert.equal(result.status, 200);
		if (result.status !== 200) return;

		const body = result.body as {
			status: string;
			audit: Record<string, unknown>;
			snapshot: ActionableReview;
			boq: Boq;
			itemId: string;
		};
		assert.equal(body.status, "added_pending_catalog");
		assert.equal(body.audit.humanDecision, "add_pending_catalog");
		assert.notEqual(body.audit.humanDecision, (body.audit.aiAdvice as { decision: string })?.decision);
		assert.deepEqual(body.audit.extractedItem, {
			description: "Ready mix concrete",
			unit: "m3",
			quantity: "2",
			materialRate: "50",
			labourRate: "0",
			total: "100",
		});
		const reviewer = body.audit.reviewerPricing as {
			confirmedBy: string;
			confirmedAt: string;
			total: string;
		};
		assert.equal(reviewer.confirmedBy, "user-1");
		assert.equal(reviewer.confirmedAt, "2026-08-08T12:00:00.000Z");
		assert.equal(reviewer.total, "100");

		const stored = fixture.db.docs.get("boqs/boq-1") as unknown as Boq;
		assert.equal(stored.sections[0].items.length, beforeItems + 1);
		const added = stored.sections[0].items[beforeItems] as BoqPricedItem;
		assert.equal(added.entryOrigin, "user");
		assert.equal(added.stdStatus, "unmatched");
		assert.equal(added.sourceRowId, fixture.firstRow.id);
		assert.deepEqual(added.sourceRowIds, [fixture.firstRow.id]);
		assert.ok(added.sourceRef);

		const snap = body.snapshot.actionableItemSuggestions.find(
			(s) => s.id === SUGGESTION_ID,
		);
		assert.equal(snap?.status, "added_pending_catalog");
		assert.equal(body.snapshot.id, FINGERPRINT);
		assert.equal(
			body.snapshot.validationSummary.locallyPreparedCatalogCount,
			1,
		);

		const decisionPath = actionableSuggestionDecisionPath(
			"boq-1",
			"run-1",
			SUGGESTION_ID,
		);
		assert.ok(fixture.db.docs.has(decisionPath));
	},
);

test("decideActionableSuggestion add requires correctionReason on numeric divergence and writes field deltas",
	async () => {
		const fixture = actionableHarness();
		const missing = await fixture.store.decideActionableSuggestion(
			"boq-1",
			"run-1",
			SUGGESTION_ID,
			{
				action: "add_pending_catalog",
				expectedFingerprint: FINGERPRINT,
				item: { ...matchingItem, qty: 3, materialCost: 50, labourCost: 0 },
			},
			"user-1",
		);
		assert.equal(missing.status, 400);
		assert.equal(
			fixture.db.docs.has(
				actionableSuggestionDecisionPath("boq-1", "run-1", SUGGESTION_ID),
			),
			false,
		);

		const ok = await fixture.store.decideActionableSuggestion(
			"boq-1",
			"run-1",
			SUGGESTION_ID,
			{
				action: "add_pending_catalog",
				expectedFingerprint: FINGERPRINT,
				item: { ...matchingItem, qty: 3, materialCost: 50, labourCost: 0 },
				correctionReason: "Takeoff correction",
			},
			"user-1",
		);
		assert.equal(ok.status, 200);
		if (ok.status !== 200) return;
		const audit = (ok.body as { audit: { fieldDeltas: Array<{ field: string }>; correctionReason: string } }).audit;
		assert.equal(audit.correctionReason, "Takeoff correction");
		assert.ok(audit.fieldDeltas.some((d) => d.field === "quantity"));
	},
);

test("decideActionableSuggestion dismiss writes audit/status and creates no item",
	async () => {
		const fixture = actionableHarness();
		const before = structuredClone(fixture.db.docs.get("boqs/boq-1")!);
		const result = await fixture.store.decideActionableSuggestion(
			"boq-1",
			"run-1",
			SUGGESTION_ID,
			{
				action: "dismiss",
				expectedFingerprint: FINGERPRINT,
				note: "covered elsewhere",
			},
			"user-1",
		);
		assert.equal(result.status, 200);
		if (result.status !== 200) return;
		assert.equal((result.body as { status: string }).status, "dismissed");
		assert.deepEqual(fixture.db.docs.get("boqs/boq-1"), before);
		const snap = (result.body as { snapshot: ActionableReview }).snapshot;
		assert.equal(
			snap.actionableItemSuggestions.find((s) => s.id === SUGGESTION_ID)
				?.status,
			"dismissed",
		);
		assert.equal(snap.validationSummary.dismissedCount, 1);
		const audit = (result.body as { audit: { note: string; humanDecision: string } }).audit;
		assert.equal(audit.humanDecision, "dismiss");
		assert.equal(audit.note, "covered elsewhere");
	},
);

test("decideActionableSuggestion restore returns dismissed to pending and rejects represented rows",
	async () => {
		const fixture = actionableHarness();
		await fixture.store.decideActionableSuggestion(
			"boq-1",
			"run-1",
			SUGGESTION_ID,
			{ action: "dismiss", expectedFingerprint: FINGERPRINT },
			"user-1",
		);
		const restored = await fixture.store.decideActionableSuggestion(
			"boq-1",
			"run-1",
			SUGGESTION_ID,
			{ action: "restore", expectedFingerprint: FINGERPRINT },
			"user-1",
		);
		assert.equal(restored.status, 200);
		if (restored.status !== 200) return;
		assert.equal((restored.body as { status: string }).status, "pending");
		const snap = (restored.body as { snapshot: ActionableReview }).snapshot;
		assert.equal(
			snap.actionableItemSuggestions.find((s) => s.id === SUGGESTION_ID)
				?.status,
			"pending",
		);

		// Represented rows cannot restore.
		const path = fixture.path;
		const raw = fixture.db.docs.get(path)!;
		const suggestions = raw.actionableItemSuggestions as Array<
			Record<string, unknown>
		>;
		suggestions[0] = { ...suggestions[0]!, status: "dismissed" };
		raw.representedRows = [
			{
				sourceRowIds: [fixture.firstRow.id],
				boqItemId: "existing",
				reason: "source_identity",
				sourceRefs: [
					{
						page: fixture.firstRow.page,
						table: fixture.firstRow.table,
						row: fixture.firstRow.row,
					},
				],
			},
		];
		const blocked = await fixture.store.decideActionableSuggestion(
			"boq-1",
			"run-1",
			SUGGESTION_ID,
			{ action: "restore", expectedFingerprint: FINGERPRINT },
			"user-1",
		);
		assert.equal(blocked.status, 409);
		assert.match(
			String((blocked.body as { error: string }).error),
			/represented/i,
		);
	},
);

test("decideActionableSuggestion is idempotent and never duplicates items on retry",
	async () => {
		const fixture = actionableHarness();
		const first = await fixture.store.decideActionableSuggestion(
			"boq-1",
			"run-1",
			SUGGESTION_ID,
			{
				action: "add_pending_catalog",
				expectedFingerprint: FINGERPRINT,
				item: matchingItem,
			},
			"user-1",
		);
		assert.equal(first.status, 200);
		if (first.status !== 200) return;
		const firstBoq = (first.body as { boq: Boq }).boq;
		const firstItemId = (first.body as { itemId: string }).itemId;

		const retry = await fixture.store.decideActionableSuggestion(
			"boq-1",
			"run-1",
			SUGGESTION_ID,
			{
				action: "add_pending_catalog",
				expectedFingerprint: FINGERPRINT,
				item: matchingItem,
			},
			"user-1",
		);
		assert.equal(retry.status, 200);
		assert.equal((retry.body as { idempotent?: boolean }).idempotent, true);
		assert.equal((retry.body as { itemId: string }).itemId, firstItemId);
		const stored = fixture.db.docs.get("boqs/boq-1") as unknown as Boq;
		assert.equal(
			stored.sections[0].items.length,
			firstBoq.sections[0].items.length,
		);
	},
);

test("decideActionableSuggestion rejects approved, stale fingerprint, changed BOQ fingerprint, non-pending, and invalid fields without partial writes",
	async () => {
		const fixture = actionableHarness();
		const snapshotBefore = structuredClone(fixture.db.docs.get(fixture.path)!);
		const boqBefore = structuredClone(fixture.db.docs.get("boqs/boq-1")!);

		fixture.db.docs.get("boqs/boq-1")!.status = "approved";
		const approved = await fixture.store.decideActionableSuggestion(
			"boq-1",
			"run-1",
			SUGGESTION_ID,
			{ action: "dismiss", expectedFingerprint: FINGERPRINT },
			"user-1",
		);
		assert.equal(approved.status, 409);
		fixture.db.docs.get("boqs/boq-1")!.status = "draft";

		const staleFp = await fixture.store.decideActionableSuggestion(
			"boq-1",
			"run-1",
			SUGGESTION_ID,
			{
				action: "dismiss",
				expectedFingerprint: "sha256:" + "f".repeat(64),
			},
			"user-1",
		);
		assert.equal(staleFp.status, 409);

		// Change live BOQ sections fingerprint vs snapshot versions.
		const boqDoc = fixture.db.docs.get("boqs/boq-1")! as unknown as Boq;
		boqDoc.sections = [
			...boqDoc.sections,
			{ header: "Extra", items: [] },
		];
		const staleBoq = await fixture.store.decideActionableSuggestion(
			"boq-1",
			"run-1",
			SUGGESTION_ID,
			{ action: "dismiss", expectedFingerprint: FINGERPRINT },
			"user-1",
		);
		assert.equal(staleBoq.status, 409);
		// restore boq
		fixture.db.docs.set("boqs/boq-1", structuredClone(boqBefore));

		// non-pending
		const raw = fixture.db.docs.get(fixture.path)!;
		(raw.actionableItemSuggestions as Array<{ status: string }>)[0]!.status =
			"dismissed";
		const nonPending = await fixture.store.decideActionableSuggestion(
			"boq-1",
			"run-1",
			SUGGESTION_ID,
			{
				action: "add_pending_catalog",
				expectedFingerprint: FINGERPRINT,
				item: matchingItem,
			},
			"user-1",
		);
		assert.equal(nonPending.status, 409);
		(raw.actionableItemSuggestions as Array<{ status: string }>)[0]!.status =
			"pending";

		// invalid fields
		const invalid = await fixture.store.decideActionableSuggestion(
			"boq-1",
			"run-1",
			SUGGESTION_ID,
			{
				action: "add_pending_catalog",
				expectedFingerprint: FINGERPRINT,
				item: { ...matchingItem, sectionIndex: 99 },
			},
			"user-1",
		);
		assert.equal(invalid.status, 400);

		assert.deepEqual(fixture.db.docs.get(fixture.path), snapshotBefore);
		assert.equal(
			fixture.db.docs.has(
				actionableSuggestionDecisionPath("boq-1", "run-1", SUGGESTION_ID),
			),
			false,
		);
	},
);

test("decideActionableSuggestion simulated final-write failure leaves no partial writes",
	async () => {
		const fixture = actionableHarness();
		const beforeBoq = structuredClone(fixture.db.docs.get("boqs/boq-1")!);
		const beforeSnap = structuredClone(fixture.db.docs.get(fixture.path)!);
		const originalRun = fixture.db.runTransaction.bind(fixture.db);
		fixture.db.runTransaction = async (callback) => {
			const result = await originalRun(async (tx) => {
				const wrapped = {
					...tx,
					create: (ref: MemoryDoc, data: RecordData) => {
						tx.create(ref, data);
						if (String(ref.path).includes("actionableSuggestionDecisions")) {
							throw new Error("injected final write failure");
						}
					},
				};
				return callback(wrapped as never);
			});
			return result;
		};

		const result = await fixture.store.decideActionableSuggestion(
			"boq-1",
			"run-1",
			SUGGESTION_ID,
			{
				action: "add_pending_catalog",
				expectedFingerprint: FINGERPRINT,
				item: matchingItem,
			},
			"user-1",
		);
		assert.equal(result.status, 500);
		assert.deepEqual(fixture.db.docs.get("boqs/boq-1"), beforeBoq);
		assert.deepEqual(fixture.db.docs.get(fixture.path), beforeSnap);
		assert.equal(
			fixture.db.docs.has(
				actionableSuggestionDecisionPath("boq-1", "run-1", SUGGESTION_ID),
			),
			false,
		);
	},
);

test("decideActionableSuggestion rejects changed source checksum without writes",
	async () => {
		const fixture = actionableHarness();
		// Tamper identity inside TX verification without failing outer loadImmutable.
		const runRecord = fixture.db.docs.get(fixture.runPath)! as {
			identityFingerprint: string;
		};
		runRecord.identityFingerprint = "sha256:tampered-identity";
		const before = structuredClone(fixture.db.docs.get("boqs/boq-1")!);
		const beforeSnap = structuredClone(fixture.db.docs.get(fixture.path)!);
		const result = await fixture.store.decideActionableSuggestion(
			"boq-1",
			"run-1",
			SUGGESTION_ID,
			{ action: "dismiss", expectedFingerprint: FINGERPRINT },
			"user-1",
		);
		assert.equal(result.status, 409);
		assert.deepEqual(fixture.db.docs.get("boqs/boq-1"), before);
		assert.deepEqual(fixture.db.docs.get(fixture.path), beforeSnap);
	},
);

const SUGGESTION_ID_B = "sha256:" + "c".repeat(64);

const matchingItemB = {
	sectionIndex: 0,
	desc: "Second item",
	unit: "ea",
	qty: 1,
	materialCost: 10,
	labourCost: 0,
};

test("decideActionableSuggestion add updates BOQ fingerprint in-place so a later decision on B succeeds",
	async () => {
		const fixture = actionableHarness();
		const addA = await fixture.store.decideActionableSuggestion(
			"boq-1",
			"run-1",
			SUGGESTION_ID,
			{
				action: "add_pending_catalog",
				expectedFingerprint: FINGERPRINT,
				item: matchingItem,
			},
			"user-1",
		);
		assert.equal(addA.status, 200);
		if (addA.status !== 200) return;

		const bodyA = addA.body as {
			snapshot: ActionableReview;
			boq: Boq;
			audit: { afterSectionsFingerprint: string };
		};
		const afterFp = fingerprintCanonicalSections(bodyA.boq.sections);
		assert.equal(bodyA.snapshot.id, FINGERPRINT);
		assert.equal(bodyA.snapshot.versions.boqSectionsFingerprint, afterFp);
		assert.equal(bodyA.audit.afterSectionsFingerprint, afterFp);
		for (const suggestion of bodyA.snapshot.actionableItemSuggestions) {
			assert.equal(suggestion.versions.boqSectionsFingerprint, afterFp);
		}

		const dismissB = await fixture.store.decideActionableSuggestion(
			"boq-1",
			"run-1",
			SUGGESTION_ID_B,
			{
				action: "dismiss",
				expectedFingerprint: bodyA.snapshot.id,
			},
			"user-1",
		);
		assert.equal(dismissB.status, 200);
		if (dismissB.status !== 200) return;
		assert.equal(
			(dismissB.body as { status: string }).status,
			"dismissed",
		);

		// Fresh fixture path for add-B after add-A
		const fixtureAdd = actionableHarness();
		const firstAdd = await fixtureAdd.store.decideActionableSuggestion(
			"boq-1",
			"run-1",
			SUGGESTION_ID,
			{
				action: "add_pending_catalog",
				expectedFingerprint: FINGERPRINT,
				item: matchingItem,
			},
			"user-1",
		);
		assert.equal(firstAdd.status, 200);
		if (firstAdd.status !== 200) return;
		const snapAfterA = (firstAdd.body as { snapshot: ActionableReview })
			.snapshot;
		const addB = await fixtureAdd.store.decideActionableSuggestion(
			"boq-1",
			"run-1",
			SUGGESTION_ID_B,
			{
				action: "add_pending_catalog",
				expectedFingerprint: snapAfterA.id,
				item: matchingItemB,
			},
			"user-1",
		);
		assert.equal(addB.status, 200);
		if (addB.status !== 200) return;
		assert.equal(
			(addB.body as { status: string }).status,
			"added_pending_catalog",
		);
		const stored = fixtureAdd.db.docs.get("boqs/boq-1") as unknown as Boq;
		assert.equal(stored.sections[0].items.length >= 2, true);
	},
);

test("decideActionableSuggestion dismiss/restore lifecycle is append-only and re-decidable",
	async () => {
		const fixture = actionableHarness();
		const decisionPath = actionableSuggestionDecisionPath(
			"boq-1",
			"run-1",
			SUGGESTION_ID,
		);

		const dismissed = await fixture.store.decideActionableSuggestion(
			"boq-1",
			"run-1",
			SUGGESTION_ID,
			{
				action: "dismiss",
				expectedFingerprint: FINGERPRINT,
				note: "first dismiss",
			},
			"user-1",
		);
		assert.equal(dismissed.status, 200);
		if (dismissed.status !== 200) return;
		const dismissAudit = (
			dismissed.body as { audit: { sequence: number; note?: string } }
		).audit;
		assert.equal(dismissAudit.sequence, 1);
		assert.equal(dismissAudit.note, "first dismiss");
		assert.ok(fixture.db.docs.has(`${decisionPath}/events/1-dismiss`));

		const restored = await fixture.store.decideActionableSuggestion(
			"boq-1",
			"run-1",
			SUGGESTION_ID,
			{ action: "restore", expectedFingerprint: FINGERPRINT },
			"user-1",
		);
		assert.equal(restored.status, 200);
		if (restored.status !== 200) return;
		const restoreAudit = (restored.body as { audit: { sequence: number } })
			.audit;
		assert.equal(restoreAudit.sequence, 2);
		assert.ok(fixture.db.docs.has(`${decisionPath}/events/2-restore`));
		// Original dismiss event preserved after restore overwrites head.
		assert.ok(fixture.db.docs.has(`${decisionPath}/events/1-dismiss`));
		const headAfterRestore = fixture.db.docs.get(decisionPath) as {
			humanDecision: string;
			sequence: number;
		};
		assert.equal(headAfterRestore.humanDecision, "restore");
		assert.equal(headAfterRestore.sequence, 2);

		const reDismiss = await fixture.store.decideActionableSuggestion(
			"boq-1",
			"run-1",
			SUGGESTION_ID,
			{
				action: "dismiss",
				expectedFingerprint: FINGERPRINT,
				note: "second dismiss",
			},
			"user-1",
		);
		assert.equal(reDismiss.status, 200);
		if (reDismiss.status !== 200) return;
		const reDismissAudit = (
			reDismiss.body as { audit: { sequence: number; note?: string } }
		).audit;
		assert.equal(reDismissAudit.sequence, 3);
		assert.equal(reDismissAudit.note, "second dismiss");
		assert.ok(fixture.db.docs.has(`${decisionPath}/events/3-dismiss`));
		const head = fixture.db.docs.get(decisionPath) as {
			humanDecision: string;
			sequence: number;
			note?: string;
		};
		assert.equal(head.humanDecision, "dismiss");
		assert.equal(head.sequence, 3);
		assert.equal(head.note, "second dismiss");

		// Same-terminal retry remains idempotent and does not append.
		const retry = await fixture.store.decideActionableSuggestion(
			"boq-1",
			"run-1",
			SUGGESTION_ID,
			{
				action: "dismiss",
				expectedFingerprint: FINGERPRINT,
				note: "second dismiss",
			},
			"user-1",
		);
		assert.equal(retry.status, 200);
		assert.equal((retry.body as { idempotent?: boolean }).idempotent, true);
		assert.equal(
			[...fixture.db.docs.keys()].filter((path) =>
				path.startsWith(`${decisionPath}/events/`),
			).length,
			3,
		);

		// dismiss → restore → add on a fresh fixture
		const fixtureAdd = actionableHarness();
		const decisionPathAdd = actionableSuggestionDecisionPath(
			"boq-1",
			"run-1",
			SUGGESTION_ID,
		);
		assert.equal(
			(
				await fixtureAdd.store.decideActionableSuggestion(
					"boq-1",
					"run-1",
					SUGGESTION_ID,
					{ action: "dismiss", expectedFingerprint: FINGERPRINT },
					"user-1",
				)
			).status,
			200,
		);
		assert.equal(
			(
				await fixtureAdd.store.decideActionableSuggestion(
					"boq-1",
					"run-1",
					SUGGESTION_ID,
					{ action: "restore", expectedFingerprint: FINGERPRINT },
					"user-1",
				)
			).status,
			200,
		);
		const added = await fixtureAdd.store.decideActionableSuggestion(
			"boq-1",
			"run-1",
			SUGGESTION_ID,
			{
				action: "add_pending_catalog",
				expectedFingerprint: FINGERPRINT,
				item: matchingItem,
			},
			"user-1",
		);
		assert.equal(added.status, 200);
		if (added.status !== 200) return;
		const addAudit = (added.body as { audit: { sequence: number } }).audit;
		assert.equal(addAudit.sequence, 3);
		assert.ok(
			fixtureAdd.db.docs.has(`${decisionPathAdd}/events/3-add_pending_catalog`),
		);
		assert.ok(fixtureAdd.db.docs.has(`${decisionPathAdd}/events/1-dismiss`));
		assert.ok(fixtureAdd.db.docs.has(`${decisionPathAdd}/events/2-restore`));
		const headAdd = fixtureAdd.db.docs.get(decisionPathAdd) as {
			humanDecision: string;
			sequence: number;
		};
		assert.equal(headAdd.humanDecision, "add_pending_catalog");
		assert.equal(headAdd.sequence, 3);
	},
);
