/*
 * No fixed character count cuts the commit body a prompt carries: it is whole while the prompt fits its role's window (below the safety
 * bound on a committer's prose), and over the window it gives way, before the diff does, to the line that says how long it is and
 * where to read it. A body past the safety bound is cut with a marker the section records.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPromptAssembled } from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";
import { COMMIT_BODY_SAFETY_BOUND, EVIDENCE_SAFETY_BOUND_REASON } from "@contexts/generation/infrastructure/prompt-cap.ts";
import { WINDOW_FIT_REASON } from "@kernel/prompt-sections.ts";
import type { PromptFit } from "@contexts/generation/infrastructure/prompt-builders/generator-context.ts";

const windowOf = (bytes: number): PromptFit => ({ bytes: size }) => (size <= bytes ? "fits" : "over");
const bytesOf = (text: string): number => Buffer.byteLength(text, "utf8");

/* A body well over the 4,000 characters it used to be cut at, its last line distinct. */
const bodyOf = (lines: number): string => `${Array.from({ length: lines }, (_, i) => `Behavioural note number ${i} of the change.`).join("\n")}\nLast note: the refund is shown.`;

const author = (target: "e2e" | "code", body: string): OpencodeRunInput => ({
  repo: "org/app",
  sha: "abc1234",
  diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n+const total = 1;",
  mirrorDir: "/mirrors/org__app",
  e2eRelDir: "e2e",
  namespace: "qa-bot-abc1234",
  target,
  mode: "diff",
  appName: "shop",
  baseUrl: "http://localhost:3000",
  intent: { type: "feat", breaking: false, message: "feat(cart): show the total", body, changedFiles: ["src/a.ts"] },
});

for (const target of ["e2e", "code"] as const) {
  test(`a ${target} run's commit body reaches its prompt whole while it is under the safety bound and the window holds it`, () => {
    const body = bodyOf(160);
    assert.ok(body.length > 4_000 && body.length < COMMIT_BODY_SAFETY_BOUND);
    for (const opts of [{}, { fit: windowOf(50_000_000) }]) {
      const prompt = buildPromptAssembled(author(target, body), opts);
      assert.ok(prompt.text.includes("Last note: the refund is shown."));
      assert.doesNotMatch(prompt.text, /body truncated|git show/);
    }
  });

  test(`a ${target} run's commit body, over the window, gives way to the line that says where to read it, and the omission is recorded`, () => {
    const body = bodyOf(160);
    const whole = buildPromptAssembled(author(target, body), { fit: windowOf(50_000_000) });
    const prompt = buildPromptAssembled(author(target, body), { fit: windowOf(bytesOf(whole.text) - 1_000) });
    assert.equal(prompt.windowFit?.outcome, "fits");
    assert.equal(prompt.text.includes("Last note: the refund is shown."), false);
    assert.match(prompt.text, /\[The commit body \(161 line\(s\)\) is not shown here, to fit the window; read it with `git show abc1234`\.\]/);
    assert.ok(prompt.text.includes("feat(cart): show the total"), "the subject stays");
    assert.ok(prompt.windowFit?.degraded.some((d) => d.id === "task"), "the task gave the body up");
    assert.ok(prompt.sectionItems["task"]?.omissions.some((o) => o.reason === WINDOW_FIT_REASON && o.count === 161));
  });
}

test("a commit body past the safety bound is cut with a marker, and the section records it", () => {
  const body = bodyOf(1_000);
  assert.ok(body.length > COMMIT_BODY_SAFETY_BOUND);
  const prompt = buildPromptAssembled(author("e2e", body), {});
  assert.equal(prompt.text.includes("Last note: the refund is shown."), false);
  assert.match(prompt.text, /\[… cut: \d+ more chars, past the safety bound on the commit body\]/);
  assert.deepEqual(prompt.sectionItems["task"]?.omissions, [{ class: "truncation", reason: EVIDENCE_SAFETY_BOUND_REASON, count: 1 }]);
});
