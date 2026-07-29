import {
	doclingErrorResponse,
	invalidPdfResponse,
	requireSinglePdf,
} from "@/lib/boq-import-request";
import { DoclingClientError } from "@/lib/docling-client";
import type { ConfirmedImportSelection } from "@/lib/boq-import-service";
import type {
	PreflightImportContext,
	PreflightImportOperation,
} from "@/lib/boq-preflight-service";
import { resolveActorId } from "@/lib/auth-actor";

interface ImportHandlerDependencies {
	authenticate(): Promise<{ user?: unknown } | null>;
	createId(): string;
	importPdf(
		file: File,
		id: string,
		signal: AbortSignal,
		selection?: ConfirmedImportSelection,
	): Promise<unknown>;
	consumePreflight?(
		id: string,
		actorId: string,
		selection: { pages: number[] },
		operation?: PreflightImportOperation,
	): Promise<PreflightImportContext & { operationResult?: unknown }>;
}

function parseSelectionPages(value: FormDataEntryValue | null): number[] {
	if (typeof value !== "string")
		throw new TypeError("Invalid confirmed page selection");
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new TypeError("Invalid confirmed page selection");
	}
	if (!Array.isArray(parsed) || parsed.length === 0) {
		throw new TypeError("Invalid confirmed page selection");
	}
	if (parsed.some((page) => !Number.isInteger(page) || page < 1)) {
		throw new TypeError("Invalid confirmed page selection");
	}
	return [...new Set(parsed as number[])].sort((left, right) => left - right);
}

function preflightErrorResponse(error: unknown): Response | null {
	const message = error instanceof Error ? error.message : "";
	if (/Invalid confirmed page selection/i.test(message)) {
		return Response.json({ error: message }, { status: 400 });
	}
	if (/Preflight consumption conflict/i.test(message)) {
		return Response.json({ error: message }, { status: 409 });
	}
	if (/Preflight (?:not found|is not ready)/i.test(message)) {
		return Response.json({ error: message }, { status: 404 });
	}
	return null;
}

export function createImportHandler(dependencies: ImportHandlerDependencies) {
	return async function POST(request: Request): Promise<Response> {
		const session = await dependencies.authenticate();
		if (!session?.user)
			return Response.json({ error: "Unauthorized" }, { status: 401 });

		let formData: FormData;
		try {
			formData = await request.formData();
		} catch {
			return invalidPdfResponse();
		}

		const rawPreflightId = formData.get("preflightId");
		const preflightId =
			typeof rawPreflightId === "string" ? rawPreflightId.trim() : "";
		if (preflightId !== "") {
			// Must match preflight create ownership (resolveActorId), including the
			// anonymous fallback used when Auth.js omits session.user.id.
			const actorId = resolveActorId(session);
			if (!actorId || !dependencies.consumePreflight) {
				return Response.json({ error: "Unauthorized" }, { status: 401 });
			}

			let pages: number[];
			try {
				pages = parseSelectionPages(formData.get("pages"));
			} catch (error) {
				return Response.json(
					{
						error:
							error instanceof Error
								? error.message
								: "Invalid confirmed page selection",
					},
					{ status: 400 },
				);
			}

			try {
				const result = await dependencies.consumePreflight(
					preflightId,
					actorId,
					{ pages },
					async (context) =>
						dependencies.importPdf(
							context.file,
							dependencies.createId(),
							request.signal,
							{ preflightId: context.preflightId, pages: context.pages },
						),
				);
				return Response.json(result.operationResult, { status: 201 });
			} catch (error) {
				if (error instanceof DoclingClientError)
					return doclingErrorResponse(error);
				const preflightResponse = preflightErrorResponse(error);
				if (preflightResponse) return preflightResponse;
				console.error("BOQ import failed");
				return Response.json(
					{ error: "The BOQ import could not be saved. Try again." },
					{ status: 500 },
				);
			}
		}

		let file: File;
		try {
			file = requireSinglePdf(formData);
		} catch {
			return invalidPdfResponse();
		}

		try {
			const draft = await dependencies.importPdf(
				file,
				dependencies.createId(),
				request.signal,
			);
			return Response.json(draft, { status: 201 });
		} catch (error) {
			if (error instanceof DoclingClientError)
				return doclingErrorResponse(error);
			console.error("BOQ import failed");
			return Response.json(
				{ error: "The BOQ import could not be saved. Try again." },
				{ status: 500 },
			);
		}
	};
}
