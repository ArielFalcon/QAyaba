/* The assembled flow brief carries exactly one closing contract: the sidekick result, never the run author's `specs` verdict. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDelegationBrief } from "@contexts/coordination/application/delegation-brief.ts";
import { renderSidekickBrief } from "@contexts/coordination/application/sidekick-prompt.ts";
import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";

const redaction = new PatternRedactionAdapter();

test("the assembled flow brief holds one closing JSON contract and no author verdict", () => {
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

  const closingContracts = text.match(/\{"delegationId":"d1","runId":"r1","status":/g) ?? [];
  assert.equal(closingContracts.length, 1);
  assert.equal(/\{\s*"specs"\s*:/.test(text), false);
});
