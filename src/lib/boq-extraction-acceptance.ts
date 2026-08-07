import type { Boq, BoqSection } from "./boq-schema";
import { calculateBoqTotals } from "./boq-pricing";
import {
	stableCanonicalJson,
	type BoqExtractionRun,
} from "./boq-extraction-run";
import type {
	BoqSourceRowV3,
	DerivedPricedItemV3,
} from "./boq-extraction-schema";
import { buildExtractionCandidates } from "./boq-extraction-evidence";
import { reconstructSourceMappedItem } from "./boq-extraction-proposal-contract";
import {
	applyValidatedProposal,
	fingerprintCanonicalSections,
	normalizeSourceRowDispositionSuggestions,
	undoAcceptedProposal,
	validateProposal,
	type ExtractionProposal,
	type ProposalAcceptanceAudit,
	type ProposalSourceEvidence,
	type ProposalValidationFailureCode,
	type ProposedExtractionItem,
	type SourceRowDispositionSuggestion,
	type ValidatedProposal,
} from "./boq-extraction-proposals";

export type ExtractionProposalAuditStatus = "accepted" | "rejected" | "skipped";

/** Human decision for one source row, recorded only by a manual decision-batch
 *  acceptance. Add decisions bind to the generated BOQ item; ignore decisions
 *  carry an optional reviewer-authored note and never mutate sections. */
export type SourceRowAuditDecision =
	| { sourceRowId: string; action: "add"; itemId: string }
	| { sourceRowId: string; action: "ignore"; note?: string };

const SOURCE_ROW_AUDIT_DECISION_ADD_KEYS = new Set([
	"sourceRowId",
	"action",
	"itemId",
]);
const SOURCE_ROW_AUDIT_DECISION_IGNORE_KEYS = new Set([
	"sourceRowId",
	"action",
	"note",
]);
const MAX_AUDIT_IGNORE_NOTE_LENGTH = 500;

/** Normalizes human source-row decisions into a complete, unique, exact,
 *  proposal-ordered set against the audit's sourceRowIds. Returns null for any
 *  duplicate, missing, extra, unknown, invalid-action, blank-item-ID,
 *  overlong-note, out-of-order, or field-invalid block so a stored audit can be
 *  rejected without trusting its own metadata. */
export function normalizeSourceRowAuditDecisions(
	value: unknown,
	sourceRowIds: readonly string[],
): SourceRowAuditDecision[] | null {
	if (!Array.isArray(value) || value.length !== sourceRowIds.length)
		return null;
	const ordered: SourceRowAuditDecision[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < sourceRowIds.length; index += 1) {
		const entry = value[index];
		if (!entry || typeof entry !== "object" || Array.isArray(entry))
			return null;
		const record = entry as Record<string, unknown>;
		const action = record.action;
		if (action !== "add" && action !== "ignore") return null;
		const allowed =
			action === "add"
				? SOURCE_ROW_AUDIT_DECISION_ADD_KEYS
				: SOURCE_ROW_AUDIT_DECISION_IGNORE_KEYS;
		if (!Object.keys(record).every((key) => allowed.has(key))) return null;
		const sourceRowId = record.sourceRowId;
		if (typeof sourceRowId !== "string" || sourceRowId.trim() === "")
			return null;
		if (sourceRowId !== sourceRowIds[index]) return null;
		if (seen.has(sourceRowId)) return null;
		seen.add(sourceRowId);
		if (action === "add") {
			const itemId = record.itemId;
			if (typeof itemId !== "string" || itemId.trim() === "") return null;
			ordered.push({ sourceRowId, action: "add", itemId });
		} else {
			const note = record.note;
			if (note !== undefined) {
				if (typeof note !== "string") return null;
				if (note.trim().length > MAX_AUDIT_IGNORE_NOTE_LENGTH) return null;
			}
			const trimmed = typeof note === "string" ? note.trim() : "";
			ordered.push(
				trimmed
					? { sourceRowId, action: "ignore", note: trimmed }
					: { sourceRowId, action: "ignore" },
			);
		}
	}
	return ordered;
}

/** Append-only lifecycle event that reopens a rejected or skipped proposal. */
export interface ExtractionProposalReopenEvent {
	eventId: string;
	proposalId: string;
	extractionRunId: string;
	status: "reopened";
	previousStatus: "rejected" | "skipped";
	actorId: string;
	timestamp: string;
	sequence?: number;
}

/** Immutable audit payload stored with a proposal action, not with source evidence. */
export interface ExtractionProposalAudit {
	auditId: string;
	proposalId: string;
	extractionRunId: string;
	status: ExtractionProposalAuditStatus;
	actorId: string;
	timestamp: string;
	operation: ExtractionProposal["operation"];
	candidateItemIds?: string[];
	baseSectionsFingerprint?: string;
	destinationSectionIndex?: number;
	destinationItemIndex?: number;
	candidateSourceOrder?: number;
	/** Present when several proposals were accepted atomically. Individual undo
	 * is intentionally blocked because it would partially unwind the batch. */
	batchProposalIds?: string[];
	targetItemIds: string[];
	affectedItemFingerprints: Record<string, string>;
	confidence: number;
	explanation: string;
	sourceRowIds: string[];
	sourceRefs: Array<{
		sourceRowId: string;
		page: number;
		table: number;
		row: number;
	}>;
	proposedItems: ProposedExtractionItem[];
	sourceCellMapping?: ExtractionProposal["sourceCellMapping"];
	mappedCandidate?: ExtractionProposal["mappedCandidate"];
	reviewDraft?: ExtractionProposal["reviewDraft"];
	evidenceValid?: boolean;
	reconciled?: boolean;
	stale?: boolean;
	beforeSections: BoqSection[];
	beforeSectionsFingerprint: string;
	afterSections: BoqSection[];
	afterSectionsFingerprint: string;
	/** Exact BOQ returned by the initial accepted action; never rebuild retries from current metadata. */
	resultBoq?: Boq;
	/** Non-binding AI per-row disposition advice copied from the proposal when present. */
	sourceRowSuggestions?: SourceRowDispositionSuggestion[];
	/** Human per-row decisions, supplied only by a manual decision-batch acceptance. */
	sourceRowDecisions?: SourceRowAuditDecision[];
	/** Monotonic proposal-local sequence assigned by the action store. */
	sequence?: number;
}

/** Append-only event written separately from the accepted proposal audit. */
export interface ExtractionProposalUndoEvent {
	eventId: string;
	proposalId: string;
	extractionRunId: string;
	status: "undone";
	actorId: string;
	timestamp: string;
	sourceRowIds: string[];
	sourceRefs: Array<{
		sourceRowId: string;
		page: number;
		table: number;
		row: number;
	}>;
	beforeSections: BoqSection[];
	beforeSectionsFingerprint: string;
	afterSections: BoqSection[];
	afterSectionsFingerprint: string;
	resultTotalItems: number;
	resultGrandTotal: number;
	/** Exact BOQ returned by the initial undo action; never rebuild retries from current metadata. */
	resultBoq?: Boq;
	sequence?: number;
}

export type ProposalAcceptanceResult =
	| { kind: "accepted"; boq: Boq; audit: ExtractionProposalAudit }
	| { kind: "already_accepted"; boq: Boq; audit: ExtractionProposalAudit }
	| { kind: "rejected"; audit: ExtractionProposalAudit }
	| {
			kind: "invalid";
			code: ProposalValidationFailureCode | "needs_human_review";
	  };

export type ProposalUndoResult =
	| { kind: "undone"; boq: Boq; audit: ExtractionProposalUndoEvent }
	| { kind: "conflict" }
	| { kind: "not_accepted" };

function sourceEvidence(
	run: BoqExtractionRun,
): Record<string, ProposalSourceEvidence> {
	const evidence: Record<string, ProposalSourceEvidence> = {};
	for (const item of run.sections.flatMap((section) => section.items)) {
		if (item.pricingRole === "bundle_child" || item.sourceRowIds.length !== 1)
			continue;
		const priced = item as DerivedPricedItemV3;
		const sourceRowId = priced.sourceRowIds[0];
		const current = evidence[sourceRowId];
		evidence[sourceRowId] = {
			quotedTotal: (current?.quotedTotal ?? 0) + priced.total,
		};
		if (priced.sourceCosts) {
			evidence[sourceRowId].components = {
				material: { ...priced.sourceCosts.material },
				labour: { ...priced.sourceCosts.labour },
			};
		}
	}
	return evidence;
}

function sourceRefs(rows: readonly BoqSourceRowV3[], ids: readonly string[]) {
	const known = new Map(rows.map((row) => [row.id, row]));
	return ids.flatMap((id) => {
		const row = known.get(id);
		return row
			? [{ sourceRowId: id, page: row.page, table: row.table, row: row.row }]
			: [];
	});
}

function withTotals(boq: Boq, sections: BoqSection[]): Boq {
	const totals = calculateBoqTotals(sections);
	return {
		...boq,
		sections,
		totalItems: totals.totalItems,
		grandTotal: totals.grandTotal,
	};
}

function toAudit(
	input: {
		proposal: ExtractionProposal;
		actorId: string;
		now: string;
		sourceRows: readonly BoqSourceRowV3[];
	},
	status: ExtractionProposalAuditStatus,
	state: ProposalAcceptanceAudit & { sections?: BoqSection[] },
	resultBoq?: Boq,
): ExtractionProposalAudit {
	const afterSections = state.sections ?? state.beforeSections;
	const proposal = input.proposal as ExtractionProposal &
		Partial<ValidatedProposal>;
	return {
		auditId: `${input.proposal.id}:${input.now}`,
		proposalId: input.proposal.id,
		extractionRunId: input.proposal.extractionRunId,
		status,
		actorId: input.actorId,
		timestamp: input.now,
		operation: input.proposal.operation,
		...(input.proposal.candidateItemIds
			? { candidateItemIds: [...input.proposal.candidateItemIds] }
			: {}),
		...(input.proposal.baseSectionsFingerprint
			? { baseSectionsFingerprint: input.proposal.baseSectionsFingerprint }
			: {}),
		...(input.proposal.destinationSectionIndex === undefined
			? {}
			: { destinationSectionIndex: input.proposal.destinationSectionIndex }),
		...(input.proposal.destinationItemIndex === undefined
			? {}
			: { destinationItemIndex: input.proposal.destinationItemIndex }),
		...(input.proposal.candidateSourceOrder === undefined
			? {}
			: { candidateSourceOrder: input.proposal.candidateSourceOrder }),
		targetItemIds: [...input.proposal.targetItemIds],
		affectedItemFingerprints: { ...input.proposal.affectedItemFingerprints },
		confidence: input.proposal.confidence,
		explanation: input.proposal.explanation,
		sourceRowIds: [...input.proposal.sourceRowIds],
		sourceRefs: sourceRefs(input.sourceRows, input.proposal.sourceRowIds),
		proposedItems: structuredClone(input.proposal.proposedItems),
		...(input.proposal.sourceCellMapping
			? { sourceCellMapping: structuredClone(input.proposal.sourceCellMapping) }
			: {}),
		...(input.proposal.mappedCandidate
			? { mappedCandidate: structuredClone(input.proposal.mappedCandidate) }
			: {}),
		...(input.proposal.reviewDraft
			? { reviewDraft: structuredClone(input.proposal.reviewDraft) }
			: {}),
		...(input.proposal.sourceRowSuggestions
			? {
					sourceRowSuggestions: structuredClone(
						input.proposal.sourceRowSuggestions,
					),
				}
			: {}),
		...(proposal.evidenceValid === undefined
			? {}
			: { evidenceValid: proposal.evidenceValid }),
		...(proposal.reconciled === undefined
			? {}
			: { reconciled: proposal.reconciled }),
		...(proposal.stale === undefined ? {} : { stale: proposal.stale }),
		beforeSections: structuredClone(state.beforeSections),
		beforeSectionsFingerprint: state.beforeSectionsFingerprint,
		afterSections: structuredClone(afterSections),
		afterSectionsFingerprint: state.afterSectionsFingerprint,
		...(resultBoq ? { resultBoq: structuredClone(resultBoq) } : {}),
	};
}

/** Server-side validation shared by Accept and Reject; neither trusts client arithmetic. */
export function validateExtractionProposal(
	boq: Boq,
	run: BoqExtractionRun,
	sourceRows: readonly BoqSourceRowV3[],
	proposal: ExtractionProposal,
):
	| { valid: true; proposal: ValidatedProposal }
	| { valid: false; code: ProposalValidationFailureCode } {
	if (
		run.boqId !== boq.id ||
		run.status !== "ready" ||
		proposal.extractionRunId !== run.id
	) {
		return { valid: false, code: "run_identity_mismatch" };
	}
	const candidates = buildExtractionCandidates(run, sourceRows);
	const targetItems = new Map(
		boq.sections
			.flatMap((section) => section.items)
			.flatMap((item) => (item.id ? [[item.id, item] as const] : [])),
	);
	if (
		proposal.sourceCellMapping !== undefined ||
		proposal.mappedCandidate !== undefined
	) {
		if (!proposal.sourceCellMapping || !proposal.mappedCandidate)
			return { valid: false, code: "invalid_operation_shape" };
		const reconstruction = reconstructSourceMappedItem({
			mapping: proposal.sourceCellMapping,
			targetItemIds: proposal.targetItemIds,
			sourceRows,
			allowedSourceRowIds: new Set(proposal.sourceRowIds),
			sections: boq.sections,
			targetItems,
		});
		if (
			reconstruction.kind !== "candidate" ||
			stableCanonicalJson(reconstruction.mapping) !==
				stableCanonicalJson(proposal.sourceCellMapping) ||
			stableCanonicalJson(reconstruction.candidate) !==
				stableCanonicalJson(proposal.mappedCandidate)
		) {
			return { valid: false, code: "source_provenance_mismatch" };
		}
		candidates.set(reconstruction.candidate.id, {
			...reconstruction.candidate,
			sourceRefs:
				reconstruction.candidate.sourceRefs?.map((ref) => ({ ...ref })) ?? [],
		});
	}
	if (proposal.reviewDraft !== undefined) {
		const reconstruction = reconstructSourceMappedItem({
			mapping: proposal.reviewDraft.mapping,
			targetItemIds: proposal.targetItemIds,
			sourceRows,
			allowedSourceRowIds: new Set(proposal.sourceRowIds),
			sections: boq.sections,
			targetItems,
		});
		if (
			reconstruction.kind !== "draft" ||
			stableCanonicalJson(reconstruction.draft) !==
				stableCanonicalJson(proposal.reviewDraft)
		) {
			return { valid: false, code: "source_provenance_mismatch" };
		}
	}
	return validateProposal(proposal, {
		extractionRunId: run.id,
		sourceRows,
		sourceEvidence: sourceEvidence(run),
		sections: boq.sections,
		candidateItems: candidates,
	});
}

export function proposalMatchesAudit(
	proposal: ExtractionProposal,
	audit: ExtractionProposalAudit,
): boolean {
	const validated = proposal as ExtractionProposal & Partial<ValidatedProposal>;
	return (
		stableCanonicalJson({
			id: proposal.id,
			extractionRunId: proposal.extractionRunId,
			operation: proposal.operation,
			candidateItemIds: proposal.candidateItemIds,
			baseSectionsFingerprint: proposal.baseSectionsFingerprint,
			destinationSectionIndex: proposal.destinationSectionIndex,
			destinationItemIndex: proposal.destinationItemIndex,
			candidateSourceOrder: proposal.candidateSourceOrder,
			sourceRowIds: proposal.sourceRowIds,
			targetItemIds: proposal.targetItemIds,
			affectedItemFingerprints: proposal.affectedItemFingerprints,
			confidence: proposal.confidence,
			explanation: proposal.explanation,
			proposedItems: proposal.proposedItems,
			sourceCellMapping: proposal.sourceCellMapping,
			mappedCandidate: proposal.mappedCandidate,
			reviewDraft: proposal.reviewDraft,
			sourceRowSuggestions: normalizeSourceRowDispositionSuggestions(
				proposal.sourceRowSuggestions,
				proposal.sourceRowIds,
			),
			evidenceValid: validated.evidenceValid ?? true,
			reconciled: validated.reconciled ?? true,
			stale: validated.stale ?? false,
		}) ===
		stableCanonicalJson({
			id: audit.proposalId,
			extractionRunId: audit.extractionRunId,
			operation: audit.operation,
			candidateItemIds: audit.candidateItemIds,
			baseSectionsFingerprint: audit.baseSectionsFingerprint,
			destinationSectionIndex: audit.destinationSectionIndex,
			destinationItemIndex: audit.destinationItemIndex,
			candidateSourceOrder: audit.candidateSourceOrder,
			sourceRowIds: audit.sourceRowIds,
			targetItemIds: audit.targetItemIds,
			affectedItemFingerprints: audit.affectedItemFingerprints,
			confidence: audit.confidence,
			explanation: audit.explanation,
			proposedItems: audit.proposedItems,
			sourceCellMapping: audit.sourceCellMapping,
			mappedCandidate: audit.mappedCandidate,
			reviewDraft: audit.reviewDraft,
			sourceRowSuggestions: normalizeSourceRowDispositionSuggestions(
				audit.sourceRowSuggestions,
				audit.sourceRowIds,
			),
			evidenceValid: audit.evidenceValid ?? true,
			reconciled: audit.reconciled ?? true,
			stale: audit.stale ?? false,
		})
	);
}

export function acceptExtractionProposal(input: {
	boq: Boq;
	run: BoqExtractionRun;
	sourceRows: readonly BoqSourceRowV3[];
	proposal: ExtractionProposal;
	actorId: string;
	now: string;
	existingAudit: ExtractionProposalAudit | null;
	/** Batch proposals are all reconstructed against their shared canonical base revision. */
	validationBoq?: Boq;
	skipBaseRevisionCheck?: boolean;
}): ProposalAcceptanceResult {
	if (input.existingAudit) {
		if (!proposalMatchesAudit(input.proposal, input.existingAudit))
			return { kind: "invalid", code: "run_identity_mismatch" };
		if (input.existingAudit.status === "accepted") {
			if (!input.existingAudit.resultBoq)
				return { kind: "invalid", code: "run_identity_mismatch" };
			const replay = structuredClone(input.existingAudit.resultBoq);
			return {
				kind: "already_accepted",
				boq: replay,
				audit: input.existingAudit,
			};
		}
		if (input.existingAudit.status === "rejected")
			return { kind: "rejected", audit: input.existingAudit };
		return { kind: "invalid", code: "stale_item" };
	}
	const validation = validateExtractionProposal(
		input.validationBoq ?? input.boq,
		input.run,
		input.sourceRows,
		input.proposal,
	);
	if (!validation.valid) return { kind: "invalid", code: validation.code };
	if (validation.proposal.operation === "needs_human_review")
		return { kind: "invalid", code: "needs_human_review" };
	try {
		const accepted = applyValidatedProposal(
			input.boq.sections,
			validation.proposal,
			{
				skipBaseRevisionCheck: input.skipBaseRevisionCheck,
			},
		);
		const next = withTotals(input.boq, accepted.sections);
		const validatedInput = { ...input, proposal: validation.proposal };
		return {
			kind: "accepted",
			boq: next,
			audit: toAudit(
				validatedInput,
				"accepted",
				{ ...accepted.audit, sections: accepted.sections },
				next,
			),
		};
	} catch {
		return { kind: "invalid", code: "stale_item" };
	}
}

export function rejectExtractionProposal(input: {
	boq?: Boq;
	proposal: ExtractionProposal;
	actorId: string;
	now: string;
	existingAudit: ExtractionProposalAudit | null;
	sourceRows?: readonly BoqSourceRowV3[];
}):
	| { kind: "rejected"; audit: ExtractionProposalAudit }
	| { kind: "already_recorded"; audit: ExtractionProposalAudit }
	| { kind: "invalid"; code: "run_identity_mismatch" } {
	if (input.existingAudit) {
		if (!proposalMatchesAudit(input.proposal, input.existingAudit))
			return { kind: "invalid", code: "run_identity_mismatch" };
		return { kind: "already_recorded", audit: input.existingAudit };
	}
	const beforeSections = structuredClone(input.boq?.sections ?? []);
	// A rejection has no BOQ mutation, but records the exact proposal and action.
	const audit: ExtractionProposalAudit = {
		auditId: `${input.proposal.id}:${input.now}`,
		proposalId: input.proposal.id,
		extractionRunId: input.proposal.extractionRunId,
		status: "rejected",
		actorId: input.actorId,
		timestamp: input.now,
		operation: input.proposal.operation,
		confidence: input.proposal.confidence,
		explanation: input.proposal.explanation,
		...(input.proposal.candidateItemIds
			? { candidateItemIds: [...input.proposal.candidateItemIds] }
			: {}),
		...(input.proposal.baseSectionsFingerprint
			? { baseSectionsFingerprint: input.proposal.baseSectionsFingerprint }
			: {}),
		...(input.proposal.destinationSectionIndex === undefined
			? {}
			: { destinationSectionIndex: input.proposal.destinationSectionIndex }),
		...(input.proposal.destinationItemIndex === undefined
			? {}
			: { destinationItemIndex: input.proposal.destinationItemIndex }),
		...(input.proposal.candidateSourceOrder === undefined
			? {}
			: { candidateSourceOrder: input.proposal.candidateSourceOrder }),
		targetItemIds: [...input.proposal.targetItemIds],
		affectedItemFingerprints: { ...input.proposal.affectedItemFingerprints },
		sourceRowIds: [...input.proposal.sourceRowIds],
		sourceRefs: sourceRefs(input.sourceRows ?? [], input.proposal.sourceRowIds),
		proposedItems: structuredClone(input.proposal.proposedItems),
		...(input.proposal.sourceCellMapping
			? { sourceCellMapping: structuredClone(input.proposal.sourceCellMapping) }
			: {}),
		...(input.proposal.mappedCandidate
			? { mappedCandidate: structuredClone(input.proposal.mappedCandidate) }
			: {}),
		...(input.proposal.reviewDraft
			? { reviewDraft: structuredClone(input.proposal.reviewDraft) }
			: {}),
		...(input.proposal.sourceRowSuggestions
			? {
					sourceRowSuggestions: structuredClone(
						input.proposal.sourceRowSuggestions,
					),
				}
			: {}),
		...((input.proposal as Partial<ValidatedProposal>).evidenceValid ===
		undefined
			? {}
			: {
					evidenceValid: (input.proposal as Partial<ValidatedProposal>)
						.evidenceValid,
				}),
		...((input.proposal as Partial<ValidatedProposal>).reconciled === undefined
			? {}
			: {
					reconciled: (input.proposal as Partial<ValidatedProposal>).reconciled,
				}),
		...((input.proposal as Partial<ValidatedProposal>).stale === undefined
			? {}
			: { stale: (input.proposal as Partial<ValidatedProposal>).stale }),
		beforeSections,
		afterSections: structuredClone(beforeSections),
		beforeSectionsFingerprint: fingerprintCanonicalSections(beforeSections),
		afterSectionsFingerprint: fingerprintCanonicalSections(beforeSections),
	};
	return { kind: "rejected", audit };
}

export type ProposalSkipResult =
	| { kind: "skipped"; audit: ExtractionProposalAudit }
	| { kind: "already_recorded"; audit: ExtractionProposalAudit }
	| { kind: "invalid"; code: "run_identity_mismatch" | "not_incomplete" };

/**
 * Records an incomplete/exception proposal without applying any BOQ mutation.
 * Skip deliberately shares the immutable proposal payload with reject, but has
 * its own durable status so a reviewer can distinguish the two decisions.
 */
export function skipExtractionProposal(input: {
	boq: Boq;
	proposal: ExtractionProposal;
	actorId: string;
	now: string;
	existingAudit: ExtractionProposalAudit | null;
	sourceRows?: readonly BoqSourceRowV3[];
}): ProposalSkipResult {
	if (input.existingAudit) {
		if (!proposalMatchesAudit(input.proposal, input.existingAudit))
			return { kind: "invalid", code: "run_identity_mismatch" };
		if (input.existingAudit.status === "skipped")
			return { kind: "already_recorded", audit: input.existingAudit };
		return { kind: "invalid", code: "run_identity_mismatch" };
	}
	const validated = input.proposal as ExtractionProposal &
		Partial<ValidatedProposal>;
	const incomplete =
		input.proposal.operation === "needs_human_review" ||
		validated.evidenceValid !== true ||
		validated.reconciled !== true ||
		validated.stale === true;
	if (!incomplete) return { kind: "invalid", code: "not_incomplete" };
	const beforeSections = structuredClone(input.boq.sections);
	const audit: ExtractionProposalAudit = {
		auditId: `${input.proposal.id}:${input.now}`,
		proposalId: input.proposal.id,
		extractionRunId: input.proposal.extractionRunId,
		status: "skipped",
		actorId: input.actorId,
		timestamp: input.now,
		operation: input.proposal.operation,
		confidence: input.proposal.confidence,
		explanation: input.proposal.explanation,
		...(input.proposal.candidateItemIds
			? { candidateItemIds: [...input.proposal.candidateItemIds] }
			: {}),
		...(input.proposal.baseSectionsFingerprint
			? { baseSectionsFingerprint: input.proposal.baseSectionsFingerprint }
			: {}),
		...(input.proposal.destinationSectionIndex === undefined
			? {}
			: { destinationSectionIndex: input.proposal.destinationSectionIndex }),
		...(input.proposal.destinationItemIndex === undefined
			? {}
			: { destinationItemIndex: input.proposal.destinationItemIndex }),
		...(input.proposal.candidateSourceOrder === undefined
			? {}
			: { candidateSourceOrder: input.proposal.candidateSourceOrder }),
		targetItemIds: [...input.proposal.targetItemIds],
		affectedItemFingerprints: { ...input.proposal.affectedItemFingerprints },
		sourceRowIds: [...input.proposal.sourceRowIds],
		sourceRefs: sourceRefs(input.sourceRows ?? [], input.proposal.sourceRowIds),
		proposedItems: structuredClone(input.proposal.proposedItems),
		...(input.proposal.sourceCellMapping
			? { sourceCellMapping: structuredClone(input.proposal.sourceCellMapping) }
			: {}),
		...(input.proposal.mappedCandidate
			? { mappedCandidate: structuredClone(input.proposal.mappedCandidate) }
			: {}),
		...(input.proposal.reviewDraft
			? { reviewDraft: structuredClone(input.proposal.reviewDraft) }
			: {}),
		...(input.proposal.sourceRowSuggestions
			? {
					sourceRowSuggestions: structuredClone(
						input.proposal.sourceRowSuggestions,
					),
				}
			: {}),
		...(validated.evidenceValid === undefined
			? {}
			: { evidenceValid: validated.evidenceValid }),
		...(validated.reconciled === undefined
			? {}
			: { reconciled: validated.reconciled }),
		...(validated.stale === undefined ? {} : { stale: validated.stale }),
		beforeSections,
		afterSections: structuredClone(beforeSections),
		beforeSectionsFingerprint: fingerprintCanonicalSections(beforeSections),
		afterSectionsFingerprint: fingerprintCanonicalSections(beforeSections),
	};
	return { kind: "skipped", audit };
}

export function reopenExtractionProposal(input: {
	proposal: ExtractionProposal;
	actorId: string;
	now: string;
	existingAudit: ExtractionProposalAudit | null;
}):
	| { kind: "reopened"; event: ExtractionProposalReopenEvent }
	| { kind: "already_pending" }
	| { kind: "invalid"; code: "run_identity_mismatch" | "not_reopenable" } {
	const audit = input.existingAudit;
	if (!audit || !proposalMatchesAudit(input.proposal, audit))
		return { kind: "invalid", code: "run_identity_mismatch" };
	if (audit.status !== "rejected" && audit.status !== "skipped")
		return { kind: "invalid", code: "not_reopenable" };
	return {
		kind: "reopened",
		event: {
			eventId: `${input.proposal.id}:reopen:${input.now}`,
			proposalId: input.proposal.id,
			extractionRunId: input.proposal.extractionRunId,
			status: "reopened",
			previousStatus: audit.status,
			actorId: input.actorId,
			timestamp: input.now,
		},
	};
}

export function undoExtractionProposal(input: {
	boq: Boq;
	audit: ExtractionProposalAudit;
	actorId: string;
	now: string;
	sourceRefs?: ExtractionProposalUndoEvent["sourceRefs"];
}): ProposalUndoResult {
	if (input.audit.status !== "accepted") return { kind: "not_accepted" };
	try {
		const sections = undoAcceptedProposal(input.boq.sections, {
			proposalId: input.audit.proposalId,
			operation: input.audit.operation,
			beforeSections: input.audit.beforeSections,
			beforeSectionsFingerprint: input.audit.beforeSectionsFingerprint,
			afterSectionsFingerprint: input.audit.afterSectionsFingerprint,
		});
		const next = withTotals(input.boq, sections);
		return {
			kind: "undone",
			boq: next,
			audit: {
				eventId: `${input.audit.proposalId}:undo:${input.now}`,
				proposalId: input.audit.proposalId,
				extractionRunId: input.audit.extractionRunId,
				status: "undone",
				actorId: input.actorId,
				timestamp: input.now,
				sourceRowIds: [...input.audit.sourceRowIds],
				sourceRefs: structuredClone(input.sourceRefs ?? []),
				beforeSections: structuredClone(input.boq.sections),
				beforeSectionsFingerprint: fingerprintCanonicalSections(
					input.boq.sections,
				),
				afterSections: structuredClone(next.sections),
				afterSectionsFingerprint: fingerprintCanonicalSections(next.sections),
				resultTotalItems: next.totalItems,
				resultGrandTotal: next.grandTotal,
				resultBoq: structuredClone(next),
			},
		};
	} catch {
		return { kind: "conflict" };
	}
}
