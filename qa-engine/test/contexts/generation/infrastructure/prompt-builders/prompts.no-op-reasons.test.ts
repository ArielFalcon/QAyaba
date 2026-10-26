/* The no-op has two legitimate reasons, and every place the assembled prompt offers it names both: nothing in the change is worth a test, or DEV cannot show the change as it is. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LEAD_PLAN_SECTION_ID,
  buildPromptAssembled,
} from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import {
  EFFORT_BY_TIER,
  EFFORT_NO_OP_CLAUSE,
  NO_OP_REASONS,
} from "@contexts/generation/infrastructure/prompt-builders/task-builders.ts";
import { PROMPT_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
import { LEAD_PLAN_KIND } from "@kernel/coordination.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";


const input: OpencodeRunInput = {
  repo: "org/app",
  sha: "abc1234",
  diff: "diff --git a/src/a.ts b/src/a.ts\n+export const a = 1;\n",
  mirrorDir: "/mirrors/org__app",
  e2eRelDir: "e2e",
  namespace: "qa-bot-abc1234",
  target: "e2e",
  mode: "diff",
  appName: "shop",
  baseUrl: "http://localhost:3000",
  intent: { type: "feat", breaking: false, message: "feat: a", changedFiles: ["src/a.ts"] },
};

test("the effort of every tier admits doing nothing for either reason of the no-op", () => {
  for (const reason of Object.values(NO_OP_REASONS)) assert.ok(EFFORT_NO_OP_CLAUSE.includes(reason), reason);
  for (const tier of Object.values(EFFORT_BY_TIER)) assert.ok(tier.text.endsWith(`${EFFORT_NO_OP_CLAUSE}.`));
});

test("the no-op of a lead's plan names both reasons", () => {
  const prompt = readFileSync(join(process.cwd(), "agents", "agent", "qa-lead.md"), "utf8");
  const noop = prompt.split("\n").find((line) => line.includes(`"kind":"${LEAD_PLAN_KIND.NOOP}"`)) ?? "";
  for (const reason of Object.values(NO_OP_REASONS)) assert.ok(noop.includes(reason), reason);
});
