/* The generator's and the reviewer's prompts open with a stable prefix: the sections whose bytes do not vary per run. Two runs of the same app and turn shape with different facts (run id, namespace, sha, diff, DOM, findings) share that prefix byte for byte, and it is not empty. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPromptAssembled, buildReviewerPromptAssembled, type AssembledPrompt } from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";
import type { ReviewInput } from "@contexts/generation/domain/generation-input.ts";

const prefixOf = (prompt: AssembledPrompt): string => Buffer.from(prompt.text, "utf8").subarray(0, prompt.stablePrefixBytes).toString("utf8");

function assertSharedPrefix(a: AssembledPrompt, b: AssembledPrompt, label: string): void {
  assert.ok(a.stablePrefixBytes > 0, `${label}: the prompt opens with a stable prefix`);
  assert.equal(prefixOf(a), prefixOf(b), `${label}: the stable prefix is byte-identical across runs`);
  assert.notEqual(a.text, b.text, `${label}: the two runs differ in their facts`);
}

/* One run's facts; two calls with different numbers are two runs of the same app. */
function run(n: number, overrides: Partial<OpencodeRunInput> = {}): OpencodeRunInput {
  return {
    repo: "org/app",
    sha: `${n}${n}${n}feed${n}`,
    diff: `diff --git a/src/cart${n}.ts b/src/cart${n}.ts\n+export const total${n} = () => ${n};\n`,
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    namespace: `qa-run-${n}-r0`,
    target: "e2e",
    mode: "diff",
    appName: "shop",
    baseUrl: "http://localhost:3000",
    intent: { type: n % 2 ? "feat" : "fix", breaking: false, message: `change ${n}`, changedFiles: [`src/cart${n}.ts`] },
    domSnapshot: `route /cart:\n  button: Pay ${n}`,
    learnedRules: `## Learned rules\n- rule ${n}`,
    ...overrides,
  };
}

const PLANNING = { capacity: 5, maxParallel: 2, budgetMs: 240_000 };

const shapes: Record<string, (n: number) => Partial<OpencodeRunInput>> = {
  "author, diff first pass": () => ({}),
  "author, regeneration": (n) => ({ fixCases: [{ name: `case ${n}`, status: "fail", detail: `locator ${n} not found` }], reviewCorrections: [`[other] fix ${n}`] }),
  "lead, planning turn": () => ({ planning: PLANNING }),
  "author, manual": (n) => ({ mode: "manual", guidance: `test the cart ${n}` }),
  "author, code target": () => ({ target: "code" }),
  "context run": () => ({ mode: "context" }),
};

for (const [shape, facts] of Object.entries(shapes)) {
  test(`the generator prompt (${shape}) opens with a stable prefix that two runs share byte for byte`, () => {
    const a = buildPromptAssembled(run(1, facts(1)), { budgetBytes: 0 });
    const b = buildPromptAssembled(run(2, facts(2)), { budgetBytes: 0 });
    assertSharedPrefix(a, b, shape);
  });
}

test("the test-data prefix, which carries the run id, is outside the generator's stable prefix", () => {
  const prompt = buildPromptAssembled(run(1), { budgetBytes: 0 });
  assert.ok(prompt.text.includes("qa-run-1-r0"));
  assert.ok(!prefixOf(prompt).includes("qa-run-1-r0"));
});

function review(n: number, overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    diff: `diff --git a/src/cart${n}.ts b/src/cart${n}.ts\n+export const total${n} = () => ${n};\n`,
    specs: [`flows/cart-${n}.spec.ts`],
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    appName: "shop",
    mode: "diff",
    baseUrl: "http://localhost:3000",
    intent: { type: n % 2 ? "feat" : "fix", breaking: false, message: `change ${n}`, changedFiles: [`src/cart${n}.ts`] },
    domSnapshot: `route /cart:\n  button: Pay ${n}`,
    executionResult: `## Execution\n- GET /cart ${200 + n}`,
    ...overrides,
  };
}

const reviewShapes: Record<string, (n: number) => Partial<ReviewInput>> = {
  "first round": () => ({}),
  "second round": (n) => ({ priorCorrections: [`[other] fix ${n}`], specChanges: `+ expect(${n})` }),
  manual: (n) => ({ mode: "manual", guidance: `test the cart ${n}` }),
};

for (const [shape, facts] of Object.entries(reviewShapes)) {
  test(`the reviewer prompt (${shape}) opens with a stable prefix that two runs share byte for byte`, () => {
    const a = buildReviewerPromptAssembled(review(1, facts(1)));
    const b = buildReviewerPromptAssembled(review(2, facts(2)));
    assertSharedPrefix(a, b, shape);
  });
}

test("the reviewer's run type, a fact of the run, is outside its stable prefix", () => {
  const prompt = buildReviewerPromptAssembled(review(1));
  assert.ok(prompt.text.includes("Run type: feat"));
  assert.ok(!prefixOf(prompt).includes("Run type"));
});
