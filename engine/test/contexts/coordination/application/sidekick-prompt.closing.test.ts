/* The assembled flow brief carries exactly one way to answer: the sidekick result tool, never the run author's specs tool. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDelegationBrief } from "@contexts/coordination/application/delegation-brief.ts";
import { renderSidekickBrief } from "@contexts/coordination/application/sidekick-prompt.ts";
import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";

const redaction = new PatternRedactionAdapter();

test("the assembled flow brief names the result tool as the one way to answer and offers no author verdict", () => {
  const brief = createDelegationBrief({
    redaction,
    delegationId: "d1",
    runId: "r1",
    objective: "o",
    task: "t",
    specRelDir: "e2e",
    scope: { readablePaths: ["."], writablePaths: ["e2e/flows/x.spec.ts"], allowedCommands: [] },
  });

  const { text } = renderSidekickBrief(redaction, brief);

  assert.match(text, /## Output contract\nDeliver your result by calling submit_result/);
  assert.equal(text.match(/submit_result is the only way to answer/g)?.length, 1);
  assert.equal(/\{\s*"specs"\s*:/.test(text), false);
  assert.equal(text.includes("submit_specs"), false, "the run author's tool is not offered to a flow's sidekick");
});
