/* test/contexts/generation/domain/generation-input.test.ts
   Structural unit test for the Seam-2 canonical input types. The real guard is tsc: the literal below
   must satisfy OpencodeRunInput with the full deterministic-signal field set. Imports only from @contexts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";
import type { ReviewInput } from "@contexts/generation/domain/generation-input.ts";

test("OpencodeRunInput accepts the full deterministic-signal field set (contextPack/domSnapshot/staticSignal/staticSignalHasSymbols)", () => {
  const input: OpencodeRunInput = {
    repo: "o/a", sha: "abc", diff: "d", mirrorDir: "/m", e2eRelDir: "e2e", namespace: "qa-bot-abc",
    needsReview: true, target: "e2e", mode: "diff", appName: "a",
    contextPack: "pack", domSnapshot: "dom", staticSignal: "sig", staticSignalHasSymbols: true,
  };
  assert.equal(input.target, "e2e"); /* compile-time is the real assertion; this keeps node:test happy */
});

test("ReviewInput accepts the full reviewer field set (specs/blockingCount inputs/executionResult)", () => {
  const input: ReviewInput = {
    diff: "d", specs: ["e2e/login.spec.ts"], mirrorDir: "/m", e2eRelDir: "e2e",
    appName: "a", mode: "diff", target: "e2e",
    domSnapshot: "dom", priorCorrections: ["fix selector"], executionResult: "500 on /login",
  };
  assert.equal(input.specs.length, 1);
});
