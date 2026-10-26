/* The no-op has two legitimate reasons, and every place the assembled prompt offers it names both: nothing in the change is worth a test, or DEV cannot show the change as it is. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EFFORT_BY_TIER,
  EFFORT_NO_OP_CLAUSE,
  LEAD_PLAN_SECTION_ID,
  buildPromptAssembled,
} from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { PROMPT_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
import { LEAD_PLAN_KIND } from "@kernel/coordination.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";


const NOTHING_WORTH_A_TEST = /nothing (?:here )?is worth a test/i;
const DEV_CANNOT_SHOW = /cannot be observed on DEV in its current state/i;

const input: OpencodeRunInput = {
  repo: "org/app",
  sha: "abc1234",
  diff: "diff --git a/src/a.ts b/src/a.ts\n+export const a = 1;\n",
  mirrorDir: "/mirrors/org__app",
  e2eRelDir: "e2e",
  namespace: "qa-bot-abc1234",
  needsReview: false,
  target: "e2e",
  mode: "diff",
  appName: "shop",
  baseUrl: "http://localhost:3000",
  intent: { type: "feat", breaking: false, message: "feat: a", changedFiles: ["src/a.ts"] },
};

test("the effort of every tier admits doing nothing for either reason of the no-op", () => {
  assert.match(EFFORT_NO_OP_CLAUSE, NOTHING_WORTH_A_TEST);
  assert.match(EFFORT_NO_OP_CLAUSE, DEV_CANNOT_SHOW);
  for (const tier of Object.values(EFFORT_BY_TIER)) assert.ok(tier.text.endsWith(`${EFFORT_NO_OP_CLAUSE}.`));
});

test("the no-op of a lead's plan names both reasons", () => {
  const assembled = buildPromptAssembled({ ...input, planning: { maxFlows: 5, maxParallel: 2, budgetMs: 240_000 } }, { budgetBytes: 0 });
  const bytes = Buffer.from(assembled.text, "utf8");
  let offset = 0;
  let plan = "";
  for (const [id, size] of Object.entries(assembled.sectionSizes)) {
    if (id === LEAD_PLAN_SECTION_ID) plan = bytes.subarray(offset, offset + size).toString("utf8");
    offset += size + 1;
  }
  const noop = plan.split("\n").find((line) => line.includes(`"kind":"${LEAD_PLAN_KIND.NOOP}"`)) ?? "";
  assert.match(noop, NOTHING_WORTH_A_TEST);
  assert.match(noop, DEV_CANNOT_SHOW);
  assert.match(noop, /the element and the evidence/i, "the unobservable reason is qualified: it names the element and the evidence");
});
