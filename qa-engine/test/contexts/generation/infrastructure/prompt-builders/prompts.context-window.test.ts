/* A prompt is budgeted by the run's window of the role it is for, read through the per-run ContextWindowPort: the lead's plan prompt by the lead's window, an authoring prompt by the author's, the reviewer's by the reviewer's. A window the run does not know cuts nothing and says so. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPromptAssembled, buildReviewerPromptAssembled } from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { PromptRenderingAdapter } from "@contexts/generation/infrastructure/prompt-rendering.adapter.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";
import type { ReviewInput } from "@contexts/generation/application/index.ts";
import { ContextBudget, assemblerBudgetBytes } from "@kernel/context-budget.ts";
import type { ContextWindowPort } from "@kernel/ports/context-window.port.ts";
import type { AgentRole } from "@kernel/agent-role.ts";
import { promptFactsOpts } from "@contexts/generation/domain/prompt-facts.ts";

const windows = (byRole: Partial<Record<AgentRole, number>>): ContextWindowPort => ({ windowTokens: (role) => byRole[role] });
const cold = { forRole: () => ({ growthTokensPerStep: 10, steps: 10, basis: "cold-start" as const, samples: 0 }) };

const input = (over: Partial<OpencodeRunInput> = {}): OpencodeRunInput => ({
  repo: "org/app",
  sha: "abc1234",
  diff: "diff --git a/src/cart.ts b/src/cart.ts\n+export function total() {}\n",
  mirrorDir: "/mirrors/org__app",
  e2eRelDir: "e2e",
  namespace: "qa-bot-abc1234",
  target: "e2e",
  mode: "diff",
  appName: "shop",
  baseUrl: "http://localhost:3000",
  intent: { type: "feat", breaking: false, message: "feat(cart): show the total", changedFiles: ["src/cart.ts"] },
  ...over,
});
const PLANNING = { maxFlows: 5, maxParallel: 2, budgetMs: 240_000 };
const review: ReviewInput = { diff: "+x\n", specs: ["flows/a.spec.ts"], mirrorDir: "/mirrors/org__app", e2eRelDir: "e2e", appName: "shop", mode: "diff" };

test("the lead's plan prompt is budgeted by the lead's own window, an authoring prompt by the author's", () => {
  const port = windows({ lead: 100_000, author: 400_000, reviewer: 50_000 });
  const opts = { windowTokens: (role: AgentRole) => port.windowTokens(role) };

  const plan = buildPromptAssembled(input({ planning: PLANNING }), opts);
  const authoring = buildPromptAssembled(input(), opts);

  assert.equal(plan.promptRole, "lead");
  assert.equal(plan.budgetBytes, assemblerBudgetBytes(100_000));
  assert.equal(authoring.promptRole, "author");
  assert.equal(authoring.budgetBytes, assemblerBudgetBytes(400_000));
  assert.equal(buildReviewerPromptAssembled(review, opts).budgetBytes, assemblerBudgetBytes(50_000));
});

test("a known window gives the budget the assembler has always applied: 0.75 of the window at 4 bytes a token", () => {
  assert.equal(assemblerBudgetBytes(200_000), 600_000);
  assert.equal(buildPromptAssembled(input(), { windowTokens: () => 200_000 }).budgetBytes, 600_000);
});

test("a window the run does not know cuts nothing and invents no budget", () => {
  assert.equal(assemblerBudgetBytes(undefined), undefined);
  assert.equal(assemblerBudgetBytes(0), undefined);
  assert.equal(buildPromptAssembled(input({ planning: PLANNING }), { windowTokens: () => undefined }).budgetBytes, undefined);
  assert.equal(buildPromptAssembled(input()).budgetBytes, undefined, "no source of windows at all");
  assert.equal(buildReviewerPromptAssembled(review).budgetBytes, undefined);
});

test("the rendering adapter budgets each prompt by its role's window and records the fit with the window and the working room", () => {
  const budget = new ContextBudget(windows({ lead: 100_000, author: 400_000, reviewer: 50_000 }), cold);
  const rendering = new PromptRenderingAdapter(
    { buildPromptAssembled, buildReviewerPromptAssembled, specFileForFlow: (flow) => flow },
    budget,
  );

  const plan = rendering.renderMain(input({ planning: PLANNING }));
  const reviewer = rendering.renderReviewer(review);

  assert.equal(plan.budgetBytes, assemblerBudgetBytes(100_000));
  assert.deepEqual([plan.contextFit?.outcome, plan.contextFit?.windowTokens, plan.contextFit?.workingRoomTokens, plan.contextFit?.roomBasis], ["fits", 100_000, 100, "cold-start"]);
  assert.equal(reviewer.contextFit?.windowTokens, 50_000);
  assert.deepEqual(promptFactsOpts(plan).contextFit, plan.contextFit, "the fit reaches the turn's trace");
});

test("a role whose window is unknown is rendered whole and recorded as unknown", () => {
  const rendering = new PromptRenderingAdapter(
    { buildPromptAssembled, buildReviewerPromptAssembled, specFileForFlow: (flow) => flow },
    new ContextBudget(windows({ author: 400_000 }), cold),
  );

  const plan = rendering.renderMain(input({ planning: PLANNING }));

  assert.equal(plan.budgetBytes, undefined);
  assert.equal(plan.contextFit?.outcome, "unknown");
  assert.equal(plan.contextFit?.windowTokens, undefined);
});

test("a host with no context budget renders as before and records no fit", () => {
  const rendering = new PromptRenderingAdapter({ buildPromptAssembled, buildReviewerPromptAssembled, specFileForFlow: (flow) => flow });

  const main = rendering.renderMain(input());

  assert.equal(main.budgetBytes, undefined);
  assert.equal(main.contextFit, undefined);
});

/* Model identities live in agents/ and the runtime configuration. The engine keeps no catalog of models and windows: every window comes through the per-run ContextWindowPort. */
test("the engine holds no model-window catalog and reads no window except through the port", () => {
  const engineSrc = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "src");
  assert.equal(existsSync(join(engineSrc, "contexts", "generation", "infrastructure", "prompt-builders", "model-window-catalog.ts")), false);
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".ts") && /model-window-catalog|setLiveModelWindows|roleWindowBytes|setRuntimeRoleModels/.test(readFileSync(path, "utf8"))) offenders.push(path);
    }
  };
  walk(engineSrc);
  assert.deepEqual(offenders, []);
});
