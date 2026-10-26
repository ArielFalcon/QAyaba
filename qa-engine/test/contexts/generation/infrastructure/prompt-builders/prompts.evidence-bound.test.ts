/*
 * D6 (evidence-bound reviewer): what the two prompts may tell the agents about the judgment. The
 * orchestrator owns acceptance, so no prompt calls the reviewer's word authoritative, no prompt orders
 * blind compliance with every item, and the reviewer is given the run's own execution result to weigh
 * an app defect against a test defect. The static layer is read from disk: it is what each runtime
 * actually ships.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildPromptAssembled,
  buildReviewerPromptAssembled,
  renderExecutionResult,
} from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import {
  lintCell,
  BLIND_COMPLIANCE_PHRASES,
  DELEGATED_AUTHORITY_PHRASES,
  type LintSection,
} from "@contexts/generation/domain/prompt-contract-lint.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";
import type { ReviewInput } from "@contexts/generation/domain/generation-input.ts";
import { setAgentsConfigPath } from "@contexts/generation/infrastructure/prompt-builders/model-window-catalog";
import { rosterFixturePath } from "../../../../support/roster-fixture.ts";

/* The roster is an input here: window budgets resolve from the roster fixture, never the deployable agents/opencode.json. */
setAgentsConfigPath(rosterFixturePath());

const ROOT = join(import.meta.dirname, "..", "..", "..", "..", "..", "..");

function staticSection(id: string, path: string): LintSection {
  return { id, layer: "static", text: readFileSync(join(ROOT, path), "utf8"), claims: [] };
}

const assembled = (id: string, text: string): LintSection => ({ id, layer: "assembled", text, claims: [] });

function reviewerInput(over: Partial<ReviewInput> = {}): ReviewInput {
  return {
    diff: "diff --git a/src/cart.ts b/src/cart.ts\n+export const discount = 0.1;\n",
    specs: ["flows/checkout.spec.ts"],
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    appName: "shop",
    mode: "diff",
    ...over,
  };
}

function correctionTurn(over: Partial<OpencodeRunInput> = {}): OpencodeRunInput {
  return {
    repo: "org/app",
    sha: "abc1234",
    diff: "diff --git a/src/cart.ts b/src/cart.ts\n+export const discount = 0.1;\n",
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234",
    target: "e2e",
    mode: "diff",
    appName: "shop",
    baseUrl: "http://localhost:3000",
    reviewCorrections: ["[wrong-objective] checkout.spec.ts: the discount is never asserted"],
    ...over,
  };
}

test("D6: the reviewer and generator role files neither hand judgment to a model nor order compliance with every item", () => {
  for (const path of ["agents/agent/qa-generator.md", "agents/agent/qa-reviewer.md"]) {
    const findings = lintCell({ name: "static", regen: false, sections: [staticSection("role", path)] });
    assert.deepEqual(findings.filter((finding) => finding.rule === "R15"), [], path);
  }
});

test("D6: the assembled reviewer prompt carries no authorization wording and states that an empty finding list is valid", () => {
  const text = buildReviewerPromptAssembled(reviewerInput()).text;
  for (const pattern of [...BLIND_COMPLIANCE_PHRASES, ...DELEGATED_AUTHORITY_PHRASES]) {
    assert.doesNotMatch(text, pattern);
  }
  assert.match(text, /never invent a finding to look thorough/);
});

test("D6: a reviewer-correction turn addresses each finding instead of ordering compliance with every item", () => {
  const text = buildPromptAssembled(correctionTurn()).text;
  assert.doesNotMatch(text, /\bfix +each\b/i);
  assert.match(text, /Address each finding below/);
});

test("D6: the reviewer prompt carries the run's execution result when the run supplies it", () => {
  const evidence = renderExecutionResult({
    verdict: "pass",
    cases: [{ name: "checkout", httpStatus: 500, finalUrl: "http://dev/checkout" }],
  });
  const text = buildReviewerPromptAssembled(reviewerInput({ executionResult: evidence })).text;
  assert.match(text, /RUNTIME EXECUTION RESULT/);
  assert.match(text, /httpStatus: 500/);
  assert.doesNotMatch(text, /\bauthoritative\b/i, "the execution result is evidence, not an authority");
});

test("D6: without an execution result the reviewer prompt carries no empty section", () => {
  const text = buildReviewerPromptAssembled(reviewerInput()).text;
  assert.doesNotMatch(text, /RUNTIME EXECUTION RESULT/);
});
