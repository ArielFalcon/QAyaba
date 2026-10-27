/*
 * No fixed count cuts the coverage gap an author reads: every file, arm and mutant is listed while the prompt fits the author's
 * window, and over it the gap is the files it is about and how many units each holds, recorded as a window-fit omission.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPromptAssembled } from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";
import { renderBranchGap, renderCoverageGap } from "@contexts/objective-signal/domain/render-coverage-gap.ts";
import { WINDOW_FIT_REASON } from "@kernel/prompt-sections.ts";
import type { PromptFit } from "@contexts/generation/infrastructure/prompt-builders/generator-context.ts";

const windowOf = (bytes: number): PromptFit => ({ bytes: size }) => (size <= bytes ? "fits" : "over");
const bytesOf = (text: string): number => Buffer.byteLength(text, "utf8");

const FILES = Array.from({ length: 40 }, (_, i) => `src/area-${i}/module-${i}.ts`);
const ARMS = FILES.flatMap((file, i) => [{ file, line: i + 1, kind: "if", arm: "else" }, { file, line: i + 50, kind: "switch", arm: "default" }]);
const gap = [renderCoverageGap(FILES.map((file) => ({ file, lines: [1, 2, 3] }))), renderBranchGap(ARMS)].join("\n\n");
const reference = FILES.map((file) => `- ${file}: 3 unit(s) (changed lines or decision arms no test ran)`).join("\n");

const author = (over: Partial<OpencodeRunInput> = {}): OpencodeRunInput => ({
  repo: "org/app",
  sha: "abc1234",
  diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n+const total = 1;",
  mirrorDir: "/mirrors/org__app",
  e2eRelDir: "e2e",
  namespace: "qa-bot-abc1234",
  target: "e2e",
  mode: "diff",
  appName: "shop",
  baseUrl: "http://localhost:3000",
  intent: { type: "feat", breaking: false, message: "feat(cart): show the total", changedFiles: ["src/a.ts"] },
  coverageGap: gap,
  coverageGapReference: reference,
  ...over,
});

test("the author reads every file and arm of a coverage gap, however many it has, while the window is unknown or holds it", () => {
  for (const opts of [{}, { fit: windowOf(50_000_000) }]) {
    const prompt = buildPromptAssembled(author(), opts);
    for (const arm of ARMS) assert.ok(prompt.text.includes(`${arm.file}:${arm.line} ${arm.kind}: ${arm.arm}`), `${arm.file}:${arm.line}`);
    assert.doesNotMatch(prompt.text, /more arm\(s\)|more file\(s\)/);
  }
});

test("over the author's window the coverage gap is the files it is about and how many units each holds, and the omission is recorded", () => {
  const whole = buildPromptAssembled(author(), { fit: windowOf(50_000_000) });
  const prompt = buildPromptAssembled(author(), { fit: windowOf(bytesOf(whole.text) - 1_000) });
  assert.equal(prompt.windowFit?.outcome, "fits");
  for (const file of FILES) assert.ok(prompt.text.includes(`- ${file}: 3 unit(s)`), file);
  assert.equal(prompt.text.includes("switch: default"), false);
  assert.deepEqual(prompt.sectionItems["coverage-gap"]?.omissions.map((o) => o.reason), [WINDOW_FIT_REASON]);
});
