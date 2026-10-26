/* A flow sidekick's brief states the suite's harness and the specs the suite holds, as facts, within a bound. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDelegationBrief } from "@contexts/coordination/application/delegation-brief.ts";
import { renderSidekickBrief, BRIEF_MAX_SUITE_LINES } from "@contexts/coordination/application/sidekick-prompt.ts";
import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";

const redaction = new PatternRedactionAdapter();
const base = { redaction, delegationId: "d1", runId: "r1", objective: "o", task: "t", scope: { readablePaths: ["."], writablePaths: [], allowedCommands: [] } };

test("the harness facts and the suite listing reach the brief", () => {
  const brief = createDelegationBrief({
    ...base,
    specRelDir: "e2e",
    harnessFacts: { fixtures: { file: "fixtures.ts", exports: ["test", "expect", "ns"], signatures: ["export function ns(a: string): string"] }, playwright: { storageState: true, projects: [{ name: "desktop", device: "Desktop Chrome" }] } },
    suite: ["flows/cart.spec.ts — flow: cart, objective: totals"],
  });
  const { text, sectionSizes } = renderSidekickBrief(redaction, brief);
  assert.ok(sectionSizes["harness"] !== undefined && sectionSizes["suite"] !== undefined);
  for (const needle of ["e2e/fixtures.ts", "ns(a: string)", "desktop", "flows/cart.spec.ts"]) assert.ok(text.includes(needle), needle);
});

test("a brief with neither carries neither section", () => {
  const { sectionSizes } = renderSidekickBrief(redaction, createDelegationBrief(base));
  assert.equal(sectionSizes["harness"], undefined);
  assert.equal(sectionSizes["suite"], undefined);
});

test("the suite listing is bounded in lines, which are one line each and scrubbed", () => {
  const suite = Array.from({ length: BRIEF_MAX_SUITE_LINES + 7 }, (_, i) => `s${i}.spec.ts — flow: a\nsecond line sk-ant-api03-${"a".repeat(40)}`);
  const { text } = renderSidekickBrief(redaction, createDelegationBrief({ ...base, suite }));
  const lines = text.split("\n").filter((line) => line.startsWith("- s"));
  assert.equal(lines.length, BRIEF_MAX_SUITE_LINES);
  assert.ok(text.includes("(+7 more)"));
  assert.ok(!text.includes("sk-ant-api03-aaaa"));
});
