import assert from "node:assert/strict";
import test from "node:test";

import type { PreflightUpload } from "@/lib/boq-preflight-schema";
import type {
	PreflightCreateInput,
	PreflightUpdateConditions,
} from "@/lib/boq-preflight-storage";
import {
	createPreflightService,
	PreflightConsumptionConflictError,
} from "@/lib/boq-preflight-service";

type PreflightUpdatePatch = Partial<PreflightUpload> & {
	preserveForRetry?: boolean;
	importReservationToken?: string | null;
	importReservationLeaseExpiresAt?: string | null;
};

function mockPreflightUpload(
	overrides: Partial<PreflightUpload> = {},
): PreflightUpload {
	return {
		id: "preflight-1",
		fileName: "test.pdf",
		pageCount: 2,
		status: "ready",
		pages: [
			{
				page: 1,
				suggested: true,
				confidence: 0.85,
				reasons: ["thai_boq_terms"],
				textSource: "embedded",
			},
			{
				page: 2,
				suggested: false,
				confidence: 0.3,
				reasons: [],
				textSource: "embedded",
			},
		],
		confirmedPages: null,
		...overrides,
	};
}

function mockPreflightRecord(overrides: Partial<PreflightUpload> = {}) {
	return {
		...mockPreflightUpload(overrides),
		ownerId: "user-1",
		sourceDigest:
			"sha256:315d429b7714cedb6ad04ac31240145257692630457f3c88253c5beceac76027",
		sourceName: "test.pdf",
		sourceType: "application/pdf",
		sourceSize: 1234,
		expiresAt: "2026-07-27T12:00:00.000Z",
		createdAt: "2026-07-27T11:00:00.000Z",
		updatedAt: "2026-07-27T11:00:00.000Z",
	};
}

test("createPreflight validates file via requireSinglePdf", async () => {
	let validated = false;
	const service = createPreflightService({
		store: {
			create: async () => mockPreflightRecord({ status: "uploaded" }),
			getOwned: async () => null,
			update: async (_id, _ownerId, patch) =>
				mockPreflightRecord({ ...patch, status: "ready" }),
			deleteArtifacts: async () => false,
			claimExpired: async () => [],
		},
		storageAdapter: {
			saveSource: async () => "path/to/source.pdf",
			loadSource: async () =>
				new File([], "source.pdf", { type: "application/pdf" }),
		},
		analysisAdapter: {
			analyzePdf: async () => [
				{
					page: 1,
					embeddedText: "text",
					geometry: { tableCount: 0, numericTokenCount: 0 },
				},
				{
					page: 2,
					embeddedText: "text",
					geometry: { tableCount: 0, numericTokenCount: 0 },
				},
			],
		},
		requireSinglePdf: (file) => {
			validated = true;
			if (!(file instanceof File)) throw new TypeError("Not a File");
			return file;
		},
		createId: () => "preflight-1",
		now: () => new Date("2026-07-27T12:00:00.000Z"),
	});

	const file = new File([Buffer.from("%PDF")], "test.pdf", {
		type: "application/pdf",
	});
	await service.createPreflight(file, "user-1");

	assert.equal(validated, true);
});

test("createPreflight throws on invalid file", async () => {
	const service = createPreflightService({
		store: {
			create: async () => mockPreflightRecord({ status: "uploaded" }),
			getOwned: async () => null,
			update: async () => null,
			deleteArtifacts: async () => false,
			claimExpired: async () => [],
		},
		storageAdapter: {
			saveSource: async () => "path/to/source.pdf",
			loadSource: async () =>
				new File([], "source.pdf", { type: "application/pdf" }),
		},
		analysisAdapter: {
			analyzePdf: async () => [],
		},
		requireSinglePdf: () => {
			throw new TypeError("Invalid PDF");
		},
		createId: () => "preflight-1",
		now: () => new Date("2026-07-27T12:00:00.000Z"),
	});

	const file = new File([], "test.txt", { type: "text/plain" });
	await assert.rejects(
		async () => await service.createPreflight(file, "user-1"),
		{
			message: "Invalid PDF",
		},
	);
});

test("createPreflight stores source, runs analysis, and persists ready record", async () => {
	let createCalled = false;
	let storageSaveCalled = false;
	let analysisCalled = false;
	const statusUpdates: Array<string | undefined> = [];

	const store = {
		create: async (input: PreflightCreateInput) => {
			createCalled = true;
			assert.equal(input.ownerId, "user-1");
			assert.equal(input.fileName, "test.pdf");
			assert.equal(input.status, "uploaded");
			return mockPreflightRecord({ status: "uploaded", id: input.id });
		},
		getOwned: async () => null,
		update: async (
			_id: string,
			_ownerId: string,
			patch: PreflightUpdatePatch,
		) => {
			statusUpdates.push(patch.status);
			if (patch.status === "analyzing") {
				assert.equal(
					analysisCalled,
					false,
					"analyzing must be set before analysis runs",
				);
				return mockPreflightRecord({ status: "analyzing" });
			}
			assert.equal(patch.status, "ready");
			assert.ok(Array.isArray(patch.pages));
			assert.equal(patch.pages.length, 2);
			assert.equal(patch.pages[0]?.page, 1);
			assert.equal(patch.pages[0]?.suggested, true);
			return mockPreflightRecord({ ...patch, status: "ready" });
		},
		deleteArtifacts: async () => false,
		claimExpired: async () => [],
	};

	const storageAdapter = {
		saveSource: async (file: File, ownerId: string, id: string) => {
			storageSaveCalled = true;
			assert.ok(file instanceof File);
			return `preflight/${ownerId}/${id}/source.pdf`;
		},
		loadSource: async () =>
			new File([], "source.pdf", { type: "application/pdf" }),
	};

	const analysisAdapter = {
		analyzePdf: async (file: File) => {
			analysisCalled = true;
			assert.ok(file instanceof File);
			assert.deepEqual(statusUpdates, ["analyzing"]);
			return [
				{
					page: 1,
					embeddedText: "รายการ จำนวน หน่วย วัสดุ ค่าแรง รวม",
					geometry: { tableCount: 2, numericTokenCount: 10 },
				},
				{
					page: 2,
					embeddedText: "Description Quantity Material",
					geometry: { tableCount: 1, numericTokenCount: 5 },
				},
			];
		},
	};

	const service = createPreflightService({
		store,
		storageAdapter,
		analysisAdapter,
		requireSinglePdf: (f) => f,
		createId: () => "preflight-1",
		now: () => new Date("2026-07-27T12:00:00.000Z"),
	});

	const file = new File([Buffer.from("%PDF")], "test.pdf", {
		type: "application/pdf",
	});
	const result = await service.createPreflight(file, "user-1");

	assert.equal(createCalled, true, "store.create should be called first");
	assert.equal(
		storageSaveCalled,
		true,
		"storageAdapter.saveSource should be called",
	);
	assert.equal(
		analysisCalled,
		true,
		"analysisAdapter.analyzePdf should be called",
	);
	assert.deepEqual(statusUpdates, ["analyzing", "ready"]);
	assert.equal(result.id, "preflight-1");
	assert.equal(result.status, "ready");
	assert.equal(result.pages.length, 2);
});

test("createPreflight marks failed when analysis throws", async () => {
	const statusUpdates: Array<string | undefined> = [];
	const store = {
		create: async () => mockPreflightRecord({ status: "uploaded" }),
		getOwned: async () => null,
		update: async (
			_id: string,
			_ownerId: string,
			patch: PreflightUpdatePatch,
		) => {
			statusUpdates.push(patch.status);
			return mockPreflightRecord({
				...patch,
				status: patch.status ?? "failed",
			});
		},
		deleteArtifacts: async () => false,
		claimExpired: async () => [],
	};

	const service = createPreflightService({
		store,
		storageAdapter: {
			saveSource: async () => "path/to/source.pdf",
			loadSource: async () =>
				new File([], "source.pdf", { type: "application/pdf" }),
		},
		analysisAdapter: {
			analyzePdf: async () => {
				throw new Error("Analysis failed");
			},
		},
		requireSinglePdf: (f) => f,
		createId: () => "preflight-1",
		now: () => new Date("2026-07-27T12:00:00.000Z"),
	});

	const file = new File([Buffer.from("%PDF")], "test.pdf", {
		type: "application/pdf",
	});
	await assert.rejects(
		async () => await service.createPreflight(file, "user-1"),
		{
			message: "Analysis failed",
		},
	);

	assert.deepEqual(statusUpdates, ["analyzing", "failed"]);
});

test("consumePreflight validates ownership and status", async () => {
	const service = createPreflightService({
		store: {
			create: async () => mockPreflightRecord(),
			getOwned: async () => null,
			update: async () => null,
			deleteArtifacts: async () => false,
			claimExpired: async () => [],
		},
		storageAdapter: {
			saveSource: async () => "path/to/source.pdf",
			loadSource: async () =>
				new File([Buffer.from("%PDF")], "source.pdf", {
					type: "application/pdf",
				}),
		},
		analysisAdapter: {
			analyzePdf: async () => [],
		},
		requireSinglePdf: (f) => f,
		createId: () => "preflight-1",
		now: () => new Date("2026-07-27T12:00:00.000Z"),
	});

	await assert.rejects(
		async () =>
			await service.consumePreflight("preflight-1", "user-1", { pages: [1] }),
		{
			message: "Preflight not found",
		},
	);
});

test("consumePreflight validates page selection", async () => {
	const record = mockPreflightRecord({ status: "ready", pageCount: 2 });
	const service = createPreflightService({
		store: {
			create: async () => mockPreflightRecord(),
			getOwned: async () => record,
			update: async (
				_id: string,
				_ownerId: string,
				patch: PreflightUpdatePatch,
			) => {
				assert.equal(patch.status, "consumed");
				assert.deepEqual(patch.confirmedPages, [1]);
				return { ...record, ...patch };
			},
			consume: async () => "consumed" as const,
			deleteArtifacts: async () => false,
			claimExpired: async () => [],
		},
		storageAdapter: {
			saveSource: async () => "path/to/source.pdf",
			loadSource: async () =>
				new File([Buffer.from("%PDF")], "source.pdf", {
					type: "application/pdf",
				}),
		},
		analysisAdapter: {
			analyzePdf: async () => [],
		},
		requireSinglePdf: (f) => f,
		createId: () => "preflight-1",
		now: () => new Date("2026-07-27T12:00:00.000Z"),
	});

	const result = await service.consumePreflight("preflight-1", "user-1", {
		pages: [1],
	});

	assert.equal(result.preflightId, "preflight-1");
	assert.ok(result.file instanceof File);
	assert.deepEqual(result.pages, [1]);
});

test("consumePreflight throws on invalid page selection", async () => {
	const record = mockPreflightRecord({ status: "ready", pageCount: 2 });
	const service = createPreflightService({
		store: {
			create: async () => mockPreflightRecord(),
			getOwned: async () => record,
			update: async (
				_id: string,
				_ownerId: string,
				patch: PreflightUpdatePatch,
			) => {
				assert.equal(patch.status, "consumed");
				assert.deepEqual(patch.confirmedPages, [1]);
				return { ...record, ...patch };
			},
			consume: async () => "consumed" as const,
			deleteArtifacts: async () => false,
			claimExpired: async () => [],
		},
		storageAdapter: {
			saveSource: async () => "path/to/source.pdf",
			loadSource: async () =>
				new File([Buffer.from("%PDF")], "source.pdf", {
					type: "application/pdf",
				}),
		},
		analysisAdapter: {
			analyzePdf: async () => [],
		},
		requireSinglePdf: (f) => f,
		createId: () => "preflight-1",
		now: () => new Date("2026-07-27T12:00:00.000Z"),
	});

	// Test with invalid selection (empty array)
	await assert.rejects(
		async () => {
			await service.consumePreflight("preflight-1", "user-1", {
				pages: [] as number[],
			});
		},
		{ message: /at least one page must be selected/ },
	);
});

test("consumePreflight throws when status is not ready", async () => {
	const record = mockPreflightRecord({ status: "uploaded" });
	const service = createPreflightService({
		store: {
			create: async () => mockPreflightRecord(),
			getOwned: async () => record,
			update: async () => null,
			deleteArtifacts: async () => false,
			claimExpired: async () => [],
		},
		storageAdapter: {
			saveSource: async () => "path/to/source.pdf",
			loadSource: async () =>
				new File([Buffer.from("%PDF")], "source.pdf", {
					type: "application/pdf",
				}),
		},
		analysisAdapter: {
			analyzePdf: async () => [],
		},
		requireSinglePdf: (f) => f,
		createId: () => "preflight-1",
		now: () => new Date("2026-07-27T12:00:00.000Z"),
	});

	await assert.rejects(
		async () =>
			await service.consumePreflight("preflight-1", "user-1", { pages: [1] }),
		{
			message: "Preflight is not ready",
		},
	);
});

test("consumePreflight does NOT create Boq or ExtractionRun", async () => {
	let consumeCalled = false;
	const record = mockPreflightRecord({ status: "ready", pageCount: 2 });
	const service = createPreflightService({
		store: {
			create: async () => mockPreflightRecord(),
			getOwned: async () => record,
			update: async (
				_id: string,
				_ownerId: string,
				patch: PreflightUpdatePatch,
			) => {
				assert.equal(patch.status, "consumed");
				assert.ok(patch.confirmedPages !== undefined);
				assert.equal("createBoq" in patch, false);
				assert.equal("createRun" in patch, false);
				return { ...record, ...patch };
			},
			consume: async () => {
				consumeCalled = true;
				return "consumed" as const;
			},
			deleteArtifacts: async () => false,
			claimExpired: async () => [],
		},
		storageAdapter: {
			saveSource: async () => "path/to/source.pdf",
			loadSource: async () =>
				new File([Buffer.from("%PDF")], "source.pdf", {
					type: "application/pdf",
				}),
		},
		analysisAdapter: {
			analyzePdf: async () => [],
		},
		requireSinglePdf: (f) => f,
		createId: () => "preflight-1",
		now: () => new Date("2026-07-27T12:00:00.000Z"),
	});

	await service.consumePreflight("preflight-1", "user-1", { pages: [1] });

	assert.equal(consumeCalled, true);
});

test("operation-backed consumption restores a ready preflight when final import fails", async () => {
	const record = mockPreflightRecord({ status: "ready", pageCount: 2 });
	const statuses: string[] = [];
	const patches: PreflightUpdatePatch[] = [];
	const service = createPreflightService({
		store: {
			create: async () => record,
			getOwned: async () => record,
			update: async (
				_id: string,
				_ownerId: string,
				patch: PreflightUpdatePatch,
			) => {
				patches.push(patch);
				if (patch.status) statuses.push(patch.status);
				return { ...record, ...patch };
			},
			consume: async () => "consumed" as const,
			deleteArtifacts: async () => false,
			claimExpired: async () => [],
		},
		storageAdapter: {
			saveSource: async () => "path/to/source.pdf",
			loadSource: async () =>
				new File([Buffer.from("%PDF")], "source.pdf", {
					type: "application/pdf",
				}),
		},
		analysisAdapter: { analyzePdf: async () => [] },
		requireSinglePdf: (f) => f,
		createId: () => "preflight-1",
		now: () => new Date("2026-07-27T12:00:00.000Z"),
	});

	await assert.rejects(
		() =>
			service.consumePreflight(
				"preflight-1",
				"user-1",
				{ pages: [1] },
				async () => {
					throw new Error("Docling failed");
				},
			),
		/Docling failed/,
	);
	assert.deepEqual(statuses, ["analyzing", "ready"]);
	assert.deepEqual(patches[1]?.confirmedPages, [1]);
});

test("replaced preflight source is rejected before final import", async () => {
	const record = mockPreflightRecord({ status: "ready", pageCount: 2 });
	const patches: PreflightUpdatePatch[] = [];
	let operationCalled = false;
	const service = createPreflightService({
		store: {
			create: async () => record,
			getOwned: async () => record,
			update: async (
				_id: string,
				_ownerId: string,
				patch: PreflightUpdatePatch,
			) => {
				patches.push(patch);
				return { ...record, ...patch };
			},
			consume: async () => "consumed" as const,
			deleteArtifacts: async () => false,
			claimExpired: async () => [],
		},
		storageAdapter: {
			saveSource: async () => "path/to/source.pdf",
			loadSource: async () =>
				new File([Buffer.from("replaced")], "source.pdf", {
					type: "application/pdf",
				}),
		},
		analysisAdapter: { analyzePdf: async () => [] },
		requireSinglePdf: (f) => f,
		createId: () => "preflight-1",
		now: () => new Date("2026-07-27T12:00:00.000Z"),
	});
	await assert.rejects(
		() =>
			service.consumePreflight(
				"preflight-1",
				"user-1",
				{ pages: [1] },
				async () => {
					operationCalled = true;
					return "must not run";
				},
			),
		/integrity check/i,
	);
	assert.equal(operationCalled, false);
	assert.equal(patches.at(-1)?.status, "ready");
	assert.deepEqual(patches.at(-1)?.confirmedPages, [1]);
});

test("concurrent preloaded reservations yield one operation and one typed conflict", async () => {
	const record = mockPreflightRecord({ status: "ready", pageCount: 2 });
	let status: "ready" | "analyzing" | "consumed" = "ready";
	let reserveCalls = 0;
	let release!: () => void;
	const bothReserved = new Promise<void>((resolve) => {
		release = resolve;
	});
	const store = {
		create: async () => record,
		getOwned: async () => ({ ...record, status: "ready" as const }),
		update: async (
			_id: string,
			_ownerId: string,
			patch: PreflightUpdatePatch,
			conditions?: { expectedStatus?: string },
		) => {
			if (patch.status === "analyzing") {
				reserveCalls += 1;
				if (reserveCalls === 2) release();
				await bothReserved;
				if (status !== conditions?.expectedStatus) {
					throw new Error(
						`Preflight status compare-and-set failed: expected ready, got ${status}`,
					);
				}
				status = "analyzing";
				return { ...record, ...patch, status: "analyzing" as const };
			}
			if (patch.status === "consumed") {
				status = "consumed";
				return null;
			}
			return { ...record, ...patch };
		},
		deleteArtifacts: async () => false,
		claimExpired: async () => [],
	};
	const service = createPreflightService({
		store,
		storageAdapter: {
			saveSource: async () => "path/to/source.pdf",
			loadSource: async () =>
				new File([Buffer.from("%PDF")], "source.pdf", {
					type: "application/pdf",
				}),
		},
		analysisAdapter: { analyzePdf: async () => [] },
		requireSinglePdf: (f) => f,
		createId: () => "preflight-1",
		now: () => new Date("2026-07-27T12:00:00.000Z"),
	});
	let operationCalls = 0;
	const operation = async () => {
		operationCalls += 1;
		return "imported";
	};
	const results = await Promise.allSettled([
		service.consumePreflight(
			"preflight-1",
			"user-1",
			{ pages: [1] },
			operation,
		),
		service.consumePreflight(
			"preflight-1",
			"user-1",
			{ pages: [1] },
			operation,
		),
	]);
	assert.equal(operationCalls, 1);
	assert.equal(
		results.filter((result) => result.status === "fulfilled").length,
		1,
	);
	const rejected = results.find(
		(result): result is PromiseRejectedResult => result.status === "rejected",
	);
	assert.ok(rejected);
	assert.ok(rejected.reason instanceof PreflightConsumptionConflictError);
});

test("reservation CAS permits only one import and blocks cancellation races", async () => {
	let state = mockPreflightRecord({
		status: "ready",
		pageCount: 2,
	}) as ReturnType<typeof mockPreflightRecord> & {
		importReservationToken?: string | null;
	};
	let started = false;
	let release!: () => void;
	const store = {
		create: async () => state,
		getOwned: async () => state,
		update: async (
			_id: string,
			_ownerId: string,
			patch: PreflightUpdatePatch,
			conditions?: {
				expectedStatus?: string;
				expectedReservationToken?: string | null;
			},
		) => {
			if (
				conditions?.expectedStatus !== undefined &&
				state.status !== conditions.expectedStatus
			) {
				throw new Error(`status compare-and-set failed: ${state.status}`);
			}
			if (
				"expectedReservationToken" in (conditions ?? {}) &&
				(state.importReservationToken ?? null) !==
					conditions?.expectedReservationToken
			) {
				throw new Error("reservation compare-and-set failed");
			}
			state = { ...state, ...patch } as typeof state;
			return state.status === "consumed" ? null : state;
		},
		deleteArtifacts: async () => false,
		claimExpired: async () => [],
	};
	const service = createPreflightService({
		store,
		storageAdapter: {
			saveSource: async () => "path/to/source.pdf",
			loadSource: async () =>
				new File([Buffer.from("%PDF")], "source.pdf", {
					type: "application/pdf",
				}),
		},
		analysisAdapter: { analyzePdf: async () => [] },
		requireSinglePdf: (f) => f,
		createId: () => "preflight-1",
		now: () => new Date("2026-07-27T12:00:00.000Z"),
	});
	const first = service.consumePreflight(
		"preflight-1",
		"user-1",
		{ pages: [1] },
		async () => {
			started = true;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return "imported";
		},
	);
	while (!started) await new Promise((resolve) => setImmediate(resolve));

	await assert.rejects(
		() =>
			service.consumePreflight(
				"preflight-1",
				"user-1",
				{ pages: [1] },
				async () => "second",
			),
		/not ready/i,
	);
	await assert.rejects(
		() => service.cancelPreflight("preflight-1", "user-1"),
		/not ready/i,
	);
	release();
	const result = await first;
	assert.equal(result.operationResult, "imported");
	assert.equal(state.status, "consumed");
});

test("cancelPreflight marks record as cancelled", async () => {
	const record = mockPreflightRecord({ status: "ready" });
	const service = createPreflightService({
		store: {
			create: async () => mockPreflightRecord(),
			getOwned: async () => record,
			update: async (
				_id: string,
				_ownerId: string,
				patch: PreflightUpdatePatch,
			) => {
				assert.equal(patch.status, "cancelled");
				return { ...record, ...patch };
			},
			consume: async () => "consumed" as const,
			deleteArtifacts: async () => false,
			claimExpired: async () => [],
		},
		storageAdapter: {
			saveSource: async () => "path/to/source.pdf",
			loadSource: async () =>
				new File([Buffer.from("%PDF")], "source.pdf", {
					type: "application/pdf",
				}),
		},
		analysisAdapter: {
			analyzePdf: async () => [],
		},
		requireSinglePdf: (f) => f,
		createId: () => "preflight-1",
		now: () => new Date("2026-07-27T12:00:00.000Z"),
	});

	await service.cancelPreflight("preflight-1", "user-1");
});

test("cancelPreflight throws on ownership mismatch", async () => {
	const service = createPreflightService({
		store: {
			create: async () => mockPreflightRecord(),
			getOwned: async () => null,
			update: async () => null,
			deleteArtifacts: async () => false,
			claimExpired: async () => [],
		},
		storageAdapter: {
			saveSource: async () => "path/to/source.pdf",
			loadSource: async () =>
				new File([Buffer.from("%PDF")], "source.pdf", {
					type: "application/pdf",
				}),
		},
		analysisAdapter: {
			analyzePdf: async () => [],
		},
		requireSinglePdf: (f) => f,
		createId: () => "preflight-1",
		now: () => new Date("2026-07-27T12:00:00.000Z"),
	});

	await assert.rejects(
		async () => await service.cancelPreflight("preflight-1", "user-1"),
		{
			message: "Preflight not found",
		},
	);
});

test("consumePreflight returns operationResult even when the consumed cleanup throws", async () => {
	const record = mockPreflightRecord({ status: "ready", pageCount: 2 });
	let consumeUpdateCalled = false;
	const store = {
		create: async () => record,
		getOwned: async () => ({ ...record }),
		update: async (
			_id: string,
			_ownerId: string,
			patch: PreflightUpdatePatch,
			_conditions?: PreflightUpdateConditions,
		) => {
			// reserve: ready -> analyzing
			if (patch.status === "analyzing")
				return { ...record, ...patch, status: "analyzing" as const };
			// consumed transition: simulate cleanup failure (GCS delete error)
			if (patch.status === "consumed") {
				consumeUpdateCalled = true;
				throw new Error("GCS delete failed: source.pdf not found");
			}
			return { ...record, ...patch };
		},
		deleteArtifacts: async () => false,
		claimExpired: async () => [],
	} as unknown as Parameters<typeof createPreflightService>[0]["store"];

	const imported = { id: "boq-saved", project: "Saved" };
	const service = createPreflightService({
		store,
		storageAdapter: {
			saveSource: async () => "source.pdf",
			loadSource: async () =>
				new File([Buffer.from("%PDF")], "source.pdf", {
					type: "application/pdf",
				}),
		},
		analysisAdapter: { analyzePdf: async () => [] },
		requireSinglePdf: (file) => file,
		createId: () => "preflight-1",
		now: () => new Date("2026-07-29T12:00:00.000Z"),
	});

	// Suppress the best-effort console.error so test output stays pristine; verify it fired.
	const originalError = console.error;
	let logged = false;
	console.error = () => { logged = true; };
	try {
		const result = await service.consumePreflight(
			"preflight-1",
			"user-1",
			{ pages: [1] },
			async () => imported,
		);

		assert.equal(
			consumeUpdateCalled,
			true,
			"consumed transition must still be attempted",
		);
		assert.equal(
			result.operationResult,
			imported,
			"import result must be returned despite cleanup failure",
		);
		assert.equal(logged, true, "cleanup failure must be logged");
	} finally {
		console.error = originalError;
	}
});
