/*
 * No fixed character count cuts the commit diff of a prompt: the author's diff section, the code run's task and the reviewer's
 * objective carry it whole while the prompt fits its role's window, and over the window give hunks up as `path:start-end`
 * references, the lowest-ranked first, after naming every changed file. An unknown window cuts nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPromptAssembled, buildReviewerPromptAssembled } from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";
import type { ReviewInput } from "@contexts/generation/application/index.ts";
import { WINDOW_FIT_REASON } from "@kernel/prompt-sections.ts";
import { assemblerBudgetBytes } from "@kernel/context-budget.ts";
import type { PromptFit } from "@contexts/generation/infrastructure/prompt-builders/generator-context.ts";

const windowOf = (bytes: number): PromptFit => ({ bytes: size }) => (size <= bytes ? "fits" : "over");
const roomy = windowOf(50_000_000);
const bytesOf = (text: string): number => Buffer.byteLength(text, "utf8");

const FILES = 5;
const LINES = 3000;

/* A change comfortably over the 50,000 characters the diff used to be cut at: a source file per hunk, in rank order. */
function bigDiff(): string {
  const parts: string[] = [];
  for (let i = 0; i < FILES; i++) {
    parts.push(`diff --git a/src/big-file-${i}.ts b/src/big-file-${i}.ts`, `--- a/src/big-file-${i}.ts`, `+++ b/src/big-file-${i}.ts`, `@@ -1,1 +1,${LINES} @@`);
    for (let l = 0; l < LINES; l++) parts.push(`+const line${i}_${l} = "padding to blow the prompt budget";`);
  }
  return parts.join("\n");
}

const generator = (over: Partial<OpencodeRunInput> = {}): OpencodeRunInput => ({
  repo: "org/app",
  sha: "abc1234",
  diff: bigDiff(),
  mirrorDir: "/mirrors/org__app",
  e2eRelDir: "e2e",
  namespace: "qa-bot-abc1234",
  target: "e2e",
  mode: "diff",
  appName: "shop",
  baseUrl: "http://localhost:3000",
  intent: { type: "feat", breaking: false, message: "feat(cart): show the total", changedFiles: ["src/big-file-0.ts"] },
  ...over,
});

const review = (over: Partial<ReviewInput> = {}): ReviewInput => ({ diff: bigDiff(), specs: [], mirrorDir: "/mirrors/org__app", e2eRelDir: "e2e", appName: "shop", mode: "diff", target: "e2e", ...over });

const lastLine = (file: number): string => `const line${file}_${LINES - 1} `;

test("the author's diff reaches its prompt whole, however large, while the window is unknown or holds it", () => {
  for (const opts of [{}, { fit: roomy }]) {
    const prompt = buildPromptAssembled(generator(), opts);
    for (let i = 0; i < FILES; i++) assert.ok(prompt.text.includes(lastLine(i)), `file ${i} is whole`);
    assert.doesNotMatch(prompt.text, /diff truncated for the prompt/);
  }
});

test("the code run's diff reaches its prompt whole, however large, while the window holds it", () => {
  const prompt = buildPromptAssembled(generator({ target: "code" }), { fit: roomy });
  for (let i = 0; i < FILES; i++) assert.ok(prompt.text.includes(lastLine(i)), `file ${i} is whole`);
  assert.doesNotMatch(prompt.text, /diff truncated for the prompt/);
});

test("the reviewer's diff objective reaches its prompt whole, however large, while the window is unknown or holds it", () => {
  for (const opts of [{}, { fit: roomy }]) {
    const prompt = buildReviewerPromptAssembled(review(), opts);
    for (let i = 0; i < FILES; i++) assert.ok(prompt.text.includes(lastLine(i)), `file ${i} is whole`);
  }
});

test("the author's diff over its window names every changed file and shows the last-ranked hunks as path:start-end references", () => {
  const whole = buildPromptAssembled(generator(), { fit: roomy });
  const prompt = buildPromptAssembled(generator(), { fit: windowOf(bytesOf(whole.text) - 2 * 150_000) });
  for (let i = 0; i < FILES; i++) assert.ok(prompt.text.includes(`src/big-file-${i}.ts`), `file ${i} is named`);
  assert.ok(prompt.text.includes(lastLine(0)), "the first-ranked hunk is whole");
  assert.equal(prompt.text.includes(lastLine(FILES - 1)), false, "the last-ranked hunk gave way");
  assert.ok(prompt.text.includes(`src/big-file-${FILES - 1}.ts:1-${LINES}`), "it is named by file and range");
  const diff = prompt.sectionItems["diff"]?.omissions ?? [];
  assert.ok(diff.some((o) => o.reason === WINDOW_FIT_REASON && o.count > 0), "what it left out is recorded");
});

test("the code run's diff over its window gives hunks up as references", () => {
  const input = generator({ target: "code" });
  const whole = buildPromptAssembled(input, { fit: roomy });
  const prompt = buildPromptAssembled(input, { fit: windowOf(bytesOf(whole.text) - 2 * 150_000) });
  assert.equal(prompt.text.includes(lastLine(FILES - 1)), false);
  assert.ok(prompt.text.includes(`src/big-file-${FILES - 1}.ts:1-${LINES}`));
  assert.ok(prompt.text.includes(lastLine(0)));
});

test("the reviewer's diff objective over its window gives hunks up as references and records them", () => {
  const whole = buildReviewerPromptAssembled(review(), { fit: roomy });
  const prompt = buildReviewerPromptAssembled(review(), { fit: windowOf(bytesOf(whole.text) - 2 * 150_000) });
  assert.equal(prompt.text.includes(lastLine(FILES - 1)), false);
  assert.ok(prompt.text.includes(`src/big-file-${FILES - 1}.ts:1-${LINES}`));
  assert.ok(prompt.sectionItems["reviewer-objective"]?.omissions.some((o) => o.reason === WINDOW_FIT_REASON));
});

test("a giant diff given the reviewer's window never starves its specs or its DOM, and the prompt stays inside the reviewer's budget", () => {
  const budget = assemblerBudgetBytes(200_000)!;
  const { text, sectionSizes } = buildReviewerPromptAssembled(
    review({ specs: ["flows/checkout.spec.ts"], domSnapshot: "button: Submit\nheading: Checkout" }),
    { windowTokens: () => 200_000, fit: windowOf(budget) },
  );
  assert.notEqual(sectionSizes["reviewer-objective"], undefined, "the objective gives hunks up, it is not dropped");
  assert.notEqual(sectionSizes["reviewer-specs"], undefined);
  assert.notEqual(sectionSizes["reviewer-dom"], undefined);
  assert.ok(bytesOf(text) <= budget);
  for (let i = 0; i < FILES; i++) assert.ok(text.includes(`src/big-file-${i}.ts`), `file ${i} is named`);
});

test("a diff that fits is byte-identical whatever the window knows", () => {
  const small = "diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,1 +1,2 @@\n+export function foo() {}\n";
  const a = buildPromptAssembled(generator({ diff: small }));
  const b = buildPromptAssembled(generator({ diff: small }), { fit: roomy });
  assert.equal(a.text, b.text);
  assert.ok(a.text.includes(small.trimEnd()));
  const r = buildReviewerPromptAssembled(review({ diff: small }));
  assert.equal(r.text, buildReviewerPromptAssembled(review({ diff: small }), { fit: roomy }).text);
  assert.ok(r.text.includes(small.trimEnd()));
});
