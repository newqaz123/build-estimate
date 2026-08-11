import {
  MissingBoqItemError,
  parseSourceBackedItemRequest,
  type SourceBackedItemRequest,
} from "./boq-user-entry";

export type ActionableReviewDecisionRequest =
  | {
      action: "add_pending_catalog";
      expectedFingerprint: string;
      item: SourceBackedItemRequest;
      correctionReason?: string;
    }
  | {
      action: "add_and_match";
      expectedFingerprint: string;
      catalogId: string;
      conversionRuleId?: string;
      item: SourceBackedItemRequest;
      correctionReason?: string;
    }
  | {
      action: "dismiss";
      expectedFingerprint: string;
      note?: string;
    }
  | {
      action: "restore";
      expectedFingerprint: string;
    };

export class ActionableReviewDecisionError extends TypeError {}

const MAX_NOTE_LENGTH = 500;
const FINGERPRINT_RE = /^sha256:[a-f0-9]{64}$/;

const DISMISS_KEYS = new Set(["action", "expectedFingerprint", "note"]);
const RESTORE_KEYS = new Set(["action", "expectedFingerprint"]);
const ADD_KEYS = new Set([
  "action",
  "expectedFingerprint",
  "item",
  "correctionReason",
]);
const ADD_AND_MATCH_KEYS = new Set([
  "action",
  "expectedFingerprint",
  "catalogId",
  "conversionRuleId",
  "item",
  "correctionReason",
]);
const MAX_ID_LENGTH = 240;
const FLATTENED_ITEM_KEYS = new Set([
  "sectionIndex",
  "desc",
  "unit",
  "qty",
  "materialCost",
  "labourCost",
]);

function requireBoundedId(
  field: "catalogId" | "conversionRuleId",
  value: unknown,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ActionableReviewDecisionError(
      `${field} must be a non-empty string.`,
    );
  }
  if (value.length > MAX_ID_LENGTH) {
    throw new ActionableReviewDecisionError(
      `${field} must not exceed ${MAX_ID_LENGTH} characters.`,
    );
  }
  if (value.includes("/")) {
    throw new ActionableReviewDecisionError(
      `${field} must not contain a slash.`,
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireFingerprint(value: unknown): string {
  if (typeof value !== "string" || !FINGERPRINT_RE.test(value)) {
    throw new ActionableReviewDecisionError(
      "expectedFingerprint must be a sha256 fingerprint.",
    );
  }
  return value;
}

function requireOptionalTrimmedText(
  field: "note" | "correctionReason",
  value: unknown,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ActionableReviewDecisionError(`${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_NOTE_LENGTH) {
    throw new ActionableReviewDecisionError(
      `${field} must not exceed ${MAX_NOTE_LENGTH} characters.`,
    );
  }
  return trimmed === "" ? undefined : trimmed;
}

function parseFlattenedItem(value: unknown): SourceBackedItemRequest {
  if (!isRecord(value)) {
    throw new ActionableReviewDecisionError(
      "item must be an object with editable values.",
    );
  }
  for (const key of Object.keys(value)) {
    if (!FLATTENED_ITEM_KEYS.has(key)) {
      throw new ActionableReviewDecisionError(`Unexpected item field: ${key}.`);
    }
  }
  try {
    return parseSourceBackedItemRequest({
      sectionIndex: value.sectionIndex,
      item: {
        desc: value.desc,
        unit: value.unit,
        qty: value.qty,
        materialCost: value.materialCost,
        labourCost: value.labourCost,
      },
    });
  } catch (error) {
    if (error instanceof MissingBoqItemError) {
      throw new ActionableReviewDecisionError(error.message);
    }
    throw error;
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ActionableReviewDecisionError(`Unexpected request field: ${key}.`);
    }
  }
}

/**
 * Parse only the closed actionable-review decision body.
 * Client provenance/pricing fields are rejected; editable values are validated
 * through `parseSourceBackedItemRequest`.
 */
export function parseActionableReviewDecisionRequest(
  value: unknown,
): ActionableReviewDecisionRequest {
  if (!isRecord(value)) {
    throw new ActionableReviewDecisionError("Request body must be an object.");
  }

  const action = value.action;
  if (
    action !== "dismiss" &&
    action !== "restore" &&
    action !== "add_pending_catalog" &&
    action !== "add_and_match"
  ) {
    throw new ActionableReviewDecisionError(
      "action must be 'dismiss', 'restore', 'add_pending_catalog', or 'add_and_match'.",
    );
  }

  if (action === "dismiss") {
    assertExactKeys(value, DISMISS_KEYS);
    const expectedFingerprint = requireFingerprint(value.expectedFingerprint);
    const note = requireOptionalTrimmedText("note", value.note);
    return note
      ? { action: "dismiss", expectedFingerprint, note }
      : { action: "dismiss", expectedFingerprint };
  }

  if (action === "restore") {
    assertExactKeys(value, RESTORE_KEYS);
    return {
      action: "restore",
      expectedFingerprint: requireFingerprint(value.expectedFingerprint),
    };
  }

  if (action === "add_and_match") {
    assertExactKeys(value, ADD_AND_MATCH_KEYS);
    const expectedFingerprint = requireFingerprint(value.expectedFingerprint);
    const catalogId = requireBoundedId("catalogId", value.catalogId);
    const conversionRuleId =
      value.conversionRuleId === undefined
        ? undefined
        : requireBoundedId("conversionRuleId", value.conversionRuleId);
    const item = parseFlattenedItem(value.item);
    const correctionReason = requireOptionalTrimmedText(
      "correctionReason",
      value.correctionReason,
    );
    const result: {
      action: "add_and_match";
      expectedFingerprint: string;
      catalogId: string;
      conversionRuleId?: string;
      item: SourceBackedItemRequest;
      correctionReason?: string;
    } = {
      action: "add_and_match",
      expectedFingerprint,
      catalogId,
      item,
    };
    if (conversionRuleId !== undefined) {
      result.conversionRuleId = conversionRuleId;
    }
    if (correctionReason !== undefined) {
      result.correctionReason = correctionReason;
    }
    return result;
  }

  assertExactKeys(value, ADD_KEYS);
  const expectedFingerprint = requireFingerprint(value.expectedFingerprint);
  const item = parseFlattenedItem(value.item);
  const correctionReason = requireOptionalTrimmedText(
    "correctionReason",
    value.correctionReason,
  );
  return correctionReason
    ? {
        action: "add_pending_catalog",
        expectedFingerprint,
        item,
        correctionReason,
      }
    : {
        action: "add_pending_catalog",
        expectedFingerprint,
        item,
      };
}
