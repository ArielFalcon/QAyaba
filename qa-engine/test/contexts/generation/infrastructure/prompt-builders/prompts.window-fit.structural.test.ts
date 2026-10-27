/*
 * No fixed count cuts the structural block an author reads: every symbol the change reaches is listed while the prompt fits the
 * author's window, and over it the lists give way to the files they name (the last symbol list first), recorded as a window-fit omission.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPromptAssembled } from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";
import { renderBlastRadiusSignal } from "@contexts/change-analysis/infrastructure/adapters/blast-radius-signal.ts";
import { WINDOW_FIT_REASON } from "@kernel/prompt-sections.ts";
import type { PromptFit } from "@contexts/generation/infrastructure/prompt-builders/generator-context.ts";

const windowOf = (bytes: number): PromptFit => ({ bytes: size }) => (size <= bytes ? "fits" : "over");
const bytesOf = (text: string): number => Buffer.byteLength(text, "utf8");

/* Callers spread over 30 files, 20 symbols each, so a count by file is much smaller than the list. */
const impacted = [{ file: "src/cart/Cart.java", symbol: "total" }];
const callers = Array.from({ length: 600 }, (_, i) => ({ file: `src/callers/Caller${i % 30}.java`, symbol: `handler${i}` }));
const coupled = [{ file: "src/cart/CartTest.java", couplingScore: 0.8, coChanges: 5 }];
const staticSignal = renderBlastRadiusSignal({ impacted, callers, coupled });

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
  staticSignal,
  staticSignalHasSymbols: true,
  ...over,
});

test("the author reads every symbol the change reaches while the window is unknown or holds it", () => {
  for (const opts of [{}, { fit: windowOf(50_000_000) }]) {
    const prompt = buildPromptAssembled(author(), opts);
    assert.ok(prompt.text.includes("`handler599`"));
    assert.doesNotMatch(prompt.text, /truncated|symbol\(s\)/);
  }
});

test("over the author's window the callers give way to the files they name with their counts, the impacted symbols stay, and the omission is recorded", () => {
  const whole = buildPromptAssembled(author(), { fit: windowOf(50_000_000) });
  const prompt = buildPromptAssembled(author(), { fit: windowOf(bytesOf(whole.text) - 2_000) });
  assert.equal(prompt.windowFit?.outcome, "fits");
  assert.match(prompt.text, /Callers of the changed code \(600\)/);
  assert.ok(prompt.text.includes("- src/callers/Caller7.java: 20 symbol(s)"));
  assert.equal(prompt.text.includes("`handler599`"), false);
  assert.ok(prompt.text.includes("`total` (src/cart/Cart.java)"), "the symbols the change itself touches stay");
  assert.deepEqual(prompt.sectionItems["static-signal"]?.omissions, [{ class: "truncation", reason: WINDOW_FIT_REASON, count: 600 }]);
});
