/* A prompt is fitted to the run's window of the role it is for, read through the per-run ContextWindowPort: the lead's plan prompt to the lead's window, an authoring prompt to the author's, the reviewer's to the reviewer's. No share of a window cuts a prompt that fits it; a window the run does not know degrades nothing. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPromptAssembled, buildReviewerPromptAssembled } from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { PromptRenderingAdapter } from "@contexts/generation/infrastructure/prompt-rendering.adapter.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";
import type { ReviewInput } from "@contexts/generation/application/index.ts";
import { ContextBudget } from "@kernel/context-budget.ts";
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
const PLANNING = { capacity: 5, maxParallel: 2, budgetMs: 240_000 };
const review: ReviewInput = { diff: "+x\n", specs: ["flows/a.spec.ts"], mirrorDir: "/mirrors/org__app", e2eRelDir: "e2e", appName: "shop", mode: "diff" };

test("the lead's plan prompt is fitted to the lead's own window, an authoring prompt to the author's, the reviewer's to the reviewer's", () => {
  const asked: string[] = [];
  const opts = { fit: ({ role }: { role: AgentRole }) => { asked.push(role); return "fits" as const; } };

  const plan = buildPromptAssembled(input({ planning: PLANNING }), opts);
  const planAsked = [...asked];
  const authoring = buildPromptAssembled(input(), opts);
  buildReviewerPromptAssembled(review, opts);

  assert.equal(plan.promptRole, "lead");
  assert.equal(authoring.promptRole, "author");
  assert.deepEqual([...new Set(planAsked)], ["lead"], "the plan prompt asked only for the lead's window");
  assert.ok(asked.includes("author") && asked.includes("reviewer"));
});

test("no share of the window cuts a prompt that fits it: a prompt above 0.75 of its window reaches the agent whole", () => {
  const rule = "- rule: scope the coupon button to the cart form. ";
  const learnedRules = rule.repeat(Math.ceil(1_300_000 / rule.length));
  const rendering = new PromptRenderingAdapter(
    { buildPromptAssembled, buildReviewerPromptAssembled, specFileForFlow: (flow) => flow },
    new ContextBudget(windows({ author: 400_000 }), cold),
  );

  const main = rendering.renderMain(input({ learnedRules }));

  assert.ok(Buffer.byteLength(main.text, "utf8") > 0.75 * 400_000 * 4, "setup: the prompt is above three quarters of the window");
  assert.equal(main.contextFit?.outcome, "fits", "setup: it fits the window");
  assert.ok(main.text.includes(learnedRules.trim()), "the learned rules are whole");
  assert.doesNotMatch(main.text, /capped at|Budget: these context sections/);
});

test("the rendering adapter fits each prompt to its role's window and records the fit with the window and the working room", () => {
  const budget = new ContextBudget(windows({ lead: 100_000, author: 400_000, reviewer: 50_000 }), cold);
  const rendering = new PromptRenderingAdapter(
    { buildPromptAssembled, buildReviewerPromptAssembled, specFileForFlow: (flow) => flow },
    budget,
  );

  const plan = rendering.renderMain(input({ planning: PLANNING }));
  const reviewer = rendering.renderReviewer(review);

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

  assert.equal(plan.contextFit?.outcome, "unknown");
  assert.equal(plan.contextFit?.windowTokens, undefined);
});

test("a host with no context budget renders as before and records no fit", () => {
  const rendering = new PromptRenderingAdapter({ buildPromptAssembled, buildReviewerPromptAssembled, specFileForFlow: (flow) => flow });

  const main = rendering.renderMain(input());

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
