import type { PreflightUpload } from "@/lib/boq-preflight-schema";
import { parseConfirmedPageSelection } from "@/lib/boq-preflight-schema";
import type {
	PreflightImportContext,
	PreflightImportOperation,
} from "@/lib/boq-preflight-service";
import { resolveActorId } from "@/lib/auth-actor";

interface AuthUser {
	id?: string;
}

export interface PreflightApiDependencies {
	authenticate: () => Promise<{ user?: AuthUser } | null>;
	createPreflight: (file: File, actorId: string) => Promise<PreflightUpload>;
	getPreflight: (
		id: string,
		ownerId: string,
	) => Promise<PreflightUpload | null>;
	consumePreflight: (
		id: string,
		actorId: string,
		selection: { pages: number[] },
		operation?: PreflightImportOperation,
	) => Promise<PreflightImportContext & { operationResult?: unknown }>;
	cancelPreflight: (id: string, actorId: string) => Promise<void>;
	requireSinglePdf?: (formData: File) => File;
	parseConfirmedPageSelection?: (
		value: unknown,
		pageCount: number,
	) => { pages: number[] };
}

export function createPreflightHandlers(
	dependencies: PreflightApiDependencies,
) {
	const {
		authenticate,
		createPreflight,
		getPreflight,
		consumePreflight,
		cancelPreflight,
		requireSinglePdf = (file: File) => file,
	} = dependencies;

	async function POST(request: Request): Promise<Response> {
		// CRITICAL: Authenticate BEFORE reading multipart bytes
		const session = await authenticate();
		if (!session?.user) {
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}

		let file: File;
		try {
			const formData = await request.formData();
			const rawFile = formData.get("file");
			if (!(rawFile instanceof File)) {
				throw new TypeError("Invalid PDF");
			}
			file = requireSinglePdf(rawFile);
		} catch {
			return Response.json(
				{ error: "Upload one PDF between 1 byte and 20 MB." },
				{ status: 400 },
			);
		}

		try {
			const actorId = resolveActorId(session);
			if (!actorId) {
				return Response.json({ error: "Unauthorized" }, { status: 401 });
			}
			const result = await createPreflight(file, actorId);

			// Return safe metadata only (no sourceDigest)
			return Response.json(
				{
					id: result.id,
					fileName: result.fileName,
					pageCount: result.pageCount,
					status: result.status,
					pages: result.pages,
					confirmedPages: result.confirmedPages,
				},
				{ status: 201 },
			);
		} catch (error) {
			console.error("Preflight creation failed:", error);
			return Response.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Preflight creation failed",
				},
				{ status: 500 },
			);
		}
	}
	type GETContext = { params: Promise<{ id: string }> };

	async function GET(request: Request, context: GETContext): Promise<Response> {
		const session = await authenticate();
		if (!session?.user) {
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { id } = await context.params;
		const actorId = resolveActorId(session);
		if (!actorId) {
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}

		try {
			const result = await getPreflight(id, actorId);
			if (!result) {
				return Response.json({ error: "Preflight not found" }, { status: 404 });
			}

			// Return safe metadata only (no sourceDigest, no storage path)
			return Response.json({
				id: result.id,
				fileName: result.fileName,
				pageCount: result.pageCount,
				status: result.status,
				pages: result.pages,
				confirmedPages: result.confirmedPages,
			});
		} catch (error) {
			console.error("Preflight GET failed:", error);
			return Response.json({ error: "Internal server error" }, { status: 500 });
		}
	}

	async function PATCH(
		request: Request,
		context: GETContext,
	): Promise<Response> {
		const session = await authenticate();
		if (!session?.user) {
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { id } = await context.params;
		const actorId = resolveActorId(session);
		if (!actorId) {
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}

		try {
			const body = await request.json();
			let selection: { pages: number[] };

			// Get page count from the preflight record for validation
			const preflight = await getPreflight(id, actorId);
			if (!preflight) {
				return Response.json({ error: "Preflight not found" }, { status: 404 });
			}
			const pageCount = preflight.pageCount;

			try {
				selection = parseConfirmedPageSelection(body, pageCount);
			} catch (error) {
				return Response.json(
					{
						error:
							error instanceof Error ? error.message : "Invalid page selection",
					},
					{ status: 400 },
				);
			}

			const result = await consumePreflight(id, actorId, selection);

			// Return safe response (no sourceDigest)
			return Response.json({
				preflightId: result.preflightId,
				pages: result.pages,
			});
		} catch (error) {
			console.error("Preflight consumption failed:", error);
			const message =
				error instanceof Error ? error.message : "Preflight consumption failed";
			if (message.includes("consumption conflict")) {
				return Response.json({ error: message }, { status: 409 });
			}
			if (message.includes("not found") || message.includes("not ready")) {
				return Response.json({ error: message }, { status: 404 });
			}
			return Response.json({ error: "Internal server error" }, { status: 500 });
		}
	}

	async function DELETE(
		request: Request,
		context: GETContext,
	): Promise<Response> {
		const session = await authenticate();
		if (!session?.user) {
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { id } = await context.params;
		const actorId = resolveActorId(session);
		if (!actorId) {
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}

		try {
			await cancelPreflight(id, actorId);
			return new Response(null, { status: 204 });
		} catch (error) {
			console.error("Preflight cancellation failed:", error);
			const message =
				error instanceof Error
					? error.message
					: "Preflight cancellation failed";
			if (message.includes("not found")) {
				return Response.json({ error: message }, { status: 404 });
			}
			return Response.json({ error: "Internal server error" }, { status: 500 });
		}
	}

	return { POST, GET, PATCH, DELETE };
}
