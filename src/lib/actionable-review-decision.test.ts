import assert from "node:assert/strict";
import test from "node:test";
import {
  ActionableReviewDecisionError,
  parseActionableReviewDecisionRequest,
} from "./actionable-review-decision";

const FINGERPRINT = "sha256:" + "a".repeat(64);

const validItem = {
  sectionIndex: 0,
  desc: "Wall installation",
  unit: "m2",
  qty: 18,
  materialCost: 980,
  labourCost: 650,
};

test("parseActionableReviewDecisionRequest accepts closed dismiss body", () => {
  assert.deepEqual(
    parseActionableReviewDecisionRequest({
      action: "dismiss",
      expectedFingerprint: FINGERPRINT,
      note: "  covered by existing item  ",
    }),
    {
      action: "dismiss",
      expectedFingerprint: FINGERPRINT,
      note: "covered by existing item",
    },
  );
});

test("parseActionableReviewDecisionRequest omits blank dismiss note", () => {
  assert.deepEqual(
    parseActionableReviewDecisionRequest({
      action: "dismiss",
      expectedFingerprint: FINGERPRINT,
      note: "   ",
    }),
    {
      action: "dismiss",
      expectedFingerprint: FINGERPRINT,
    },
  );
});

test("parseActionableReviewDecisionRequest accepts closed restore body", () => {
  assert.deepEqual(
    parseActionableReviewDecisionRequest({
      action: "restore",
      expectedFingerprint: FINGERPRINT,
    }),
    {
      action: "restore",
      expectedFingerprint: FINGERPRINT,
    },
  );
});

test("parseActionableReviewDecisionRequest accepts closed add_pending_catalog body", () => {
  assert.deepEqual(
    parseActionableReviewDecisionRequest({
      action: "add_pending_catalog",
      expectedFingerprint: FINGERPRINT,
      item: validItem,
      correctionReason: "  adjusted labour  ",
    }),
    {
      action: "add_pending_catalog",
      expectedFingerprint: FINGERPRINT,
      item: {
        sectionIndex: 0,
        desc: "Wall installation",
        unit: "m2",
        qty: 18,
        materialCost: 980,
        labourCost: 650,
      },
      correctionReason: "adjusted labour",
    },
  );
});

test("parseActionableReviewDecisionRequest trims item strings via authoritative parser", () => {
  assert.deepEqual(
    parseActionableReviewDecisionRequest({
      action: "add_pending_catalog",
      expectedFingerprint: FINGERPRINT,
      item: {
        ...validItem,
        desc: "  Wall installation  ",
        unit: " m2 ",
      },
    }),
    {
      action: "add_pending_catalog",
      expectedFingerprint: FINGERPRINT,
      item: {
        sectionIndex: 0,
        desc: "Wall installation",
        unit: "m2",
        qty: 18,
        materialCost: 980,
        labourCost: 650,
      },
    },
  );
});

test("parseActionableReviewDecisionRequest enforces exact key allowlists per action", () => {
  const cases: unknown[] = [
    {
      action: "dismiss",
      expectedFingerprint: FINGERPRINT,
      note: "x",
      extra: true,
    },
    {
      action: "restore",
      expectedFingerprint: FINGERPRINT,
      note: "nope",
    },
    {
      action: "add_pending_catalog",
      expectedFingerprint: FINGERPRINT,
      item: validItem,
      note: "wrong field",
    },
    {
      action: "add_pending_catalog",
      expectedFingerprint: FINGERPRINT,
      item: validItem,
      correctionReason: "ok",
      sourceRowIds: ["row-1"],
    },
    { action: "dismiss" },
    { expectedFingerprint: FINGERPRINT },
    null,
    [],
    "dismiss",
  ];
  for (const payload of cases) {
    assert.throws(
      () => parseActionableReviewDecisionRequest(payload),
      ActionableReviewDecisionError,
    );
  }
});

test("parseActionableReviewDecisionRequest rejects overlong optional text fields", () => {
  assert.throws(
    () =>
      parseActionableReviewDecisionRequest({
        action: "dismiss",
        expectedFingerprint: FINGERPRINT,
        note: "x".repeat(501),
      }),
    ActionableReviewDecisionError,
  );
  assert.throws(
    () =>
      parseActionableReviewDecisionRequest({
        action: "add_pending_catalog",
        expectedFingerprint: FINGERPRINT,
        item: validItem,
        correctionReason: "y".repeat(501),
      }),
    ActionableReviewDecisionError,
  );
});

test("parseActionableReviewDecisionRequest accepts optional text at the 500-char bound", () => {
  const note = "n".repeat(500);
  const correctionReason = "c".repeat(500);
  assert.equal(
    parseActionableReviewDecisionRequest({
      action: "dismiss",
      expectedFingerprint: FINGERPRINT,
      note,
    }).action === "dismiss"
      ? (
          parseActionableReviewDecisionRequest({
            action: "dismiss",
            expectedFingerprint: FINGERPRINT,
            note,
          }) as { note?: string }
        ).note
      : undefined,
    note,
  );
  const add = parseActionableReviewDecisionRequest({
    action: "add_pending_catalog",
    expectedFingerprint: FINGERPRINT,
    item: validItem,
    correctionReason,
  });
  assert.equal(add.action, "add_pending_catalog");
  if (add.action === "add_pending_catalog") {
    assert.equal(add.correctionReason, correctionReason);
  }
});

test("parseActionableReviewDecisionRequest rejects invalid fingerprints and actions", () => {
  for (const payload of [
    { action: "skip", expectedFingerprint: FINGERPRINT },
    { action: "dismiss", expectedFingerprint: "" },
    { action: "dismiss", expectedFingerprint: "   " },
    { action: "dismiss", expectedFingerprint: "not-a-hash" },
    {
      action: "dismiss",
      expectedFingerprint: "sha256:" + "g".repeat(64),
    },
    {
      action: "dismiss",
      expectedFingerprint: "sha256:" + "a".repeat(63),
    },
  ]) {
    assert.throws(
      () => parseActionableReviewDecisionRequest(payload),
      ActionableReviewDecisionError,
    );
  }
});

test("parseActionableReviewDecisionRequest rejects client provenance and pricing fields on item", () => {
  const forbiddenItemFields = [
    "sourceRowIds",
    "sourceRowId",
    "sourceRef",
    "sourceCosts",
    "extractedPricing",
    "reviewerPricing",
    "catalogCandidates",
    "aiAdvice",
    "normalizedTotal",
    "conversionFactor",
    "rate",
    "total",
    "item",
  ];
  for (const field of forbiddenItemFields) {
    assert.throws(
      () =>
        parseActionableReviewDecisionRequest({
          action: "add_pending_catalog",
          expectedFingerprint: FINGERPRINT,
          item: { ...validItem, [field]: "client-supplied" },
        }),
      ActionableReviewDecisionError,
    );
  }
});

test("parseActionableReviewDecisionRequest rejects top-level client provenance fields", () => {
  const forbiddenTopLevel = [
    "sourceRowIds",
    "extractedPricing",
    "reviewerPricing",
    "catalogCandidates",
    "aiAdvice",
    "normalizedTotal",
    "conversionFactor",
    "snapshot",
    "suggestion",
  ];
  for (const field of forbiddenTopLevel) {
    assert.throws(
      () =>
        parseActionableReviewDecisionRequest({
          action: "dismiss",
          expectedFingerprint: FINGERPRINT,
          [field]: "client-supplied",
        }),
      ActionableReviewDecisionError,
    );
  }
});

test("parseActionableReviewDecisionRequest rejects malformed editable item values", () => {
  for (const item of [
    null,
    "not-an-object",
    { ...validItem, sectionIndex: -1 },
    { ...validItem, sectionIndex: 0.5 },
    { ...validItem, desc: "" },
    { ...validItem, desc: "   " },
    { ...validItem, unit: "" },
    { ...validItem, qty: -1 },
    { ...validItem, materialCost: 12.345 },
    { ...validItem, labourCost: Number.NaN },
    {
      sectionIndex: 0,
      item: {
        desc: "nested",
        unit: "m",
        qty: 1,
        materialCost: 0,
        labourCost: 0,
      },
    },
  ]) {
    assert.throws(
      () =>
        parseActionableReviewDecisionRequest({
          action: "add_pending_catalog",
          expectedFingerprint: FINGERPRINT,
          item,
        }),
      ActionableReviewDecisionError,
    );
  }
});
