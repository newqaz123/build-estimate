import assert from "node:assert/strict";
import test from "node:test";
import type { ActionableReviewDecisionRequest } from "@/lib/actionable-review-decision";
import {
  createActionableReviewDecisionHandlers,
  type ActionableReviewDecisionDependencies,
  type ActionableReviewDecisionResult,
} from "./[suggestionId]/decision/route";

const FINGERPRINT = "sha256:" + "a".repeat(64);

const context = {
  params: Promise.resolve({
    id: "boq-1",
    runId: "run-1",
    suggestionId: "sug-1",
  }),
};

const validItem = {
  sectionIndex: 0,
  desc: "Wall installation",
  unit: "m2",
  qty: 18,
  materialCost: 980,
  labourCost: 650,
};

function request(body: unknown) {
  return new Request("https://example.test/decision", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function handlers(
  overrides: Partial<ActionableReviewDecisionDependencies> = {},
) {
  return createActionableReviewDecisionHandlers({
    authenticate: async () => ({ user: { id: "user-1" } }),
    decide: async () => ({ status: 200, body: { status: "dismissed" } }),
    ...overrides,
  });
}

test("decision authenticates before parsing or store work", async () => {
  let decideCalls = 0;
  const response = await handlers({
    authenticate: async () => null,
    decide: async () => {
      decideCalls += 1;
      return { status: 500, body: { error: "no" } };
    },
  }).POST(
    request({
      action: "dismiss",
      expectedFingerprint: FINGERPRINT,
    }),
    context,
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Unauthorized" });
  assert.equal(decideCalls, 0);
});

test("decision rejects invalid opaque path ids before delegation", async () => {
  let decideCalls = 0;
  const action = handlers({
    decide: async () => {
      decideCalls += 1;
      return { status: 200, body: {} };
    },
  });
  for (const params of [
    { id: "", runId: "run-1", suggestionId: "sug-1" },
    { id: "boq-1", runId: "run/1", suggestionId: "sug-1" },
    { id: "boq-1", runId: "run-1", suggestionId: "sug/1" },
    {
      id: "x".repeat(241),
      runId: "run-1",
      suggestionId: "sug-1",
    },
  ]) {
    const response = await action.POST(
      request({
        action: "dismiss",
        expectedFingerprint: FINGERPRINT,
      }),
      { params: Promise.resolve(params) },
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "Invalid actionable review decision path",
    });
  }
  assert.equal(decideCalls, 0);
});

test("decision parses closed body and forwards only opaque ids plus parsed request", async () => {
  const calls: Array<{
    boqId: string;
    runId: string;
    suggestionId: string;
    request: ActionableReviewDecisionRequest;
    actorId: string;
  }> = [];
  const action = handlers({
    decide: async (boqId, runId, suggestionId, body, actorId) => {
      calls.push({ boqId, runId, suggestionId, request: body, actorId });
      return { status: 200, body: { status: "added_pending_catalog" } };
    },
  });
  const response = await action.POST(
    request({
      action: "add_pending_catalog",
      expectedFingerprint: FINGERPRINT,
      item: {
        ...validItem,
        sourceRowIds: ["client-row"],
        extractedPricing: { total: "999" },
        conversionFactor: "2",
      },
      correctionReason: "  labour adjusted  ",
    }),
    context,
  );
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);

  const ok = await action.POST(
    request({
      action: "add_pending_catalog",
      expectedFingerprint: FINGERPRINT,
      item: validItem,
      correctionReason: "  labour adjusted  ",
    }),
    context,
  );
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { status: "added_pending_catalog" });
  assert.deepEqual(calls, [
    {
      boqId: "boq-1",
      runId: "run-1",
      suggestionId: "sug-1",
      actorId: "user-1",
      request: {
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
        correctionReason: "labour adjusted",
      },
    },
  ]);
});

test("decision forwards dismiss and restore closed bodies through dependency injection", async () => {
  const calls: ActionableReviewDecisionRequest[] = [];
  const action = handlers({
    decide: async (_boqId, _runId, _suggestionId, body) => {
      calls.push(body);
      return { status: 200, body: { ok: true } };
    },
  });

  assert.equal(
    (
      await action.POST(
        request({
          action: "dismiss",
          expectedFingerprint: FINGERPRINT,
          note: "  covered  ",
        }),
        context,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await action.POST(
        request({
          action: "restore",
          expectedFingerprint: FINGERPRINT,
        }),
        context,
      )
    ).status,
    200,
  );
  assert.deepEqual(calls, [
    {
      action: "dismiss",
      expectedFingerprint: FINGERPRINT,
      note: "covered",
    },
    {
      action: "restore",
      expectedFingerprint: FINGERPRINT,
    },
  ]);
});

test("decision returns approved BOQ 409 from the decision dependency", async () => {
  const response = await handlers({
    decide: async () =>
      ({
        status: 409,
        body: { error: "Approved BOQs cannot be mutated." },
      }) satisfies ActionableReviewDecisionResult,
  }).POST(
    request({
      action: "dismiss",
      expectedFingerprint: FINGERPRINT,
    }),
    context,
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "Approved BOQs cannot be mutated.",
  });
});

test("decision returns stale fingerprint conflict from the decision dependency", async () => {
  const response = await handlers({
    decide: async () =>
      ({
        status: 409,
        body: { error: "Actionable review fingerprint is stale." },
      }) satisfies ActionableReviewDecisionResult,
  }).POST(
    request({
      action: "dismiss",
      expectedFingerprint: FINGERPRINT,
    }),
    context,
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "Actionable review fingerprint is stale.",
  });
});

test("decision rejects malformed JSON and non-object bodies before store work", async () => {
  let decideCalls = 0;
  const action = handlers({
    decide: async () => {
      decideCalls += 1;
      return { status: 200, body: {} };
    },
  });
  const invalidJson = await action.POST(
    new Request("https://example.test/decision", {
      method: "POST",
      body: "{",
    }),
    context,
  );
  assert.equal(invalidJson.status, 400);
  assert.deepEqual(await invalidJson.json(), {
    error: "Request body must be valid JSON.",
  });

  const arrayBody = await action.POST(request([]), context);
  assert.equal(arrayBody.status, 400);
  assert.equal(decideCalls, 0);
});

test("decision never decodes opaque path ids into business fields beyond lookup", async () => {
  const seen: string[] = [];
  const response = await handlers({
    decide: async (boqId, runId, suggestionId) => {
      seen.push(boqId, runId, suggestionId);
      return { status: 200, body: { status: "ok" } };
    },
  }).POST(
    request({
      action: "restore",
      expectedFingerprint: FINGERPRINT,
    }),
    {
      params: Promise.resolve({
        id: "opaque-boq",
        runId: "opaque-run",
        suggestionId: "opaque-suggestion",
      }),
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(seen, [
    "opaque-boq",
    "opaque-run",
    "opaque-suggestion",
  ]);
});
