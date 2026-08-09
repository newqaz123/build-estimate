import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";

const componentUrl = new URL(
  "./actionable-extraction-review.tsx",
  import.meta.url,
);
const detailUrl = new URL("./actionable-review-detail.tsx", import.meta.url);
const auditUrl = new URL(
  "./actionable-review-audit-drawer.tsx",
  import.meta.url,
);
const cssUrl = new URL("../app/globals.css", import.meta.url);

test("focused actionable extraction review component exists", () => {
  assert.equal(existsSync(componentUrl), true);
  assert.equal(existsSync(detailUrl), true);
  assert.equal(existsSync(auditUrl), true);
});

test("normal list renders only actionable suggestions", () => {
  const source = readFileSync(componentUrl, "utf8");
  assert.match(source, /data-od-id="review-queue"/);
  assert.match(source, /actionableItemSuggestions/);
  assert.match(
    source,
    /status\s*===\s*["']pending["']|["']pending["']\s*===\s*.*status|filter\([^\)]*pending/,
  );
  assert.doesNotMatch(
    source,
    /queue[\s\S]{0,200}dismissedEvidence\.map|dismissedEvidence\.map[\s\S]{0,200}queue/,
  );
});

test("counts expose verified prepared actionable dismissed and source-difference summaries", () => {
  const source = readFileSync(componentUrl, "utf8");
  assert.match(source, /data-od-id="review-status-summary"/);
  assert.match(source, /Verified/);
  assert.match(source, /Prepared/);
  assert.match(source, /Actionable/);
  assert.match(source, /Dismissed/);
  assert.match(source, /Source difference/);
  assert.match(source, /sourceTotalDifference|validationSummary/);
  assert.match(
    source,
    /added_matched|locallyPreparedCatalogCount|actionableCount|dismissedCount/,
  );
});

test("selected suggestion drives page table row source highlight", () => {
  const source = readFileSync(componentUrl, "utf8");
  assert.match(source, /data-od-id="source-evidence"/);
  assert.match(source, /sourceRefs|source-ref|data-source-page|highlight/);
  assert.match(
    source,
    /selectedSuggestion|selectedSuggestionId|data-od-id="evidence-row/,
  );
  assert.match(
    source,
    /page[\s\S]{0,40}table[\s\S]{0,40}row|sourceRefs\.map|active.*source|isSelected|aria-pressed/,
  );
});

test("dismissed and represented evidence appear only inside the audit drawer", () => {
  const shell = readFileSync(componentUrl, "utf8");
  const audit = readFileSync(auditUrl, "utf8");
  assert.match(shell, /ActionableReviewAuditDrawer|actionable-review-audit-drawer/);
  assert.match(shell, /dismissedEvidence/);
  assert.match(shell, /representedRows/);
  assert.match(audit, /dismissedEvidence/);
  assert.match(audit, /representedRows/);
  assert.doesNotMatch(
    shell,
    /data-od-id="review-queue"[\s\S]{0,800}dismissedEvidence\.map/,
  );
});

test("workspace uses desktop evidence-first split and mobile queue evidence detail drill-down", () => {
  const source = readFileSync(componentUrl, "utf8");
  const css = readFileSync(cssUrl, "utf8");
  assert.match(source, /data-od-id="split-workspace"/);
  assert.match(source, /data-od-id="decision-workspace"/);
  assert.match(source, /mobile|drill|queue.*evidence.*detail|mobilePane|mobile-step/);
  assert.match(css, /actionable-review-workspace|actionable-split-workspace/);
  assert.match(
    css,
    /@media[^{]+\{[\s\S]*actionable[\s\S]*mobile|actionable[\s\S]*@media/,
  );
  assert.doesNotMatch(source, /squeez/);
});

test("Stage 2 catalog-pending and approval blocking presentation are present", () => {
  const source = readFileSync(componentUrl, "utf8");
  assert.match(source, /data-od-id="review-stage-tabs"/);
  assert.match(source, /Extract & Verify|1 · Extract/);
  assert.match(source, /Catalog Ready|2 · Catalog/);
  assert.match(source, /added_pending_catalog|catalogPending|catalog-pending/);
  assert.match(source, /blocking approval|approvalBlocked|blockingCount|data-od-id="boq-status"/);
});

test("shell keeps projection logic outside React and uses capability callbacks", () => {
  const source = readFileSync(componentUrl, "utf8");
  assert.match(source, /normalizeActionableReviewResponse|ActionableReview/);
  assert.doesNotMatch(source, /generateActionableReview\(/);
  assert.doesNotMatch(source, /shortlistCatalogCandidates\(/);
  assert.doesNotMatch(source, /reconcileRepresentedRows\(/);
  assert.match(source, /onAddAndMatch\?:|onDoNotAdd\?:|callbacks/);
});
