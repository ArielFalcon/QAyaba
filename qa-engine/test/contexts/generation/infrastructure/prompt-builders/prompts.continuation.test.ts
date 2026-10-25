import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPromptAssembled } from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import type { OpencodeRunInput } from "@contexts/generation/application/ports/generation-ports.ts";
import { STEP_MILESTONE_SECTION_ID } from "@contexts/generation/domain/step-limit.ts";
import { setAgentsConfigPath } from "@contexts/generation/infrastructure/prompt-builders/model-window-catalog";
import { rosterFixturePath } from "../../../../support/roster-fixture.ts";

/* The roster is an input here: window budgets resolve from the roster fixture, never the deployable agents/opencode.json. */
setAgentsConfigPath(rosterFixturePath());

function mkInput(overrides: Partial<OpencodeRunInput> = {}): OpencodeRunInput {
  return {
    repo: "org/app", sha: "abc1234", diff: "diff --git a/src/foo.ts b/src/foo.ts\n+export function foo() {}\n",
    mirrorDir: "/mirrors/org__app", e2eRelDir: "e2e", namespace: "qa-bot-abc1234", needsReview: true,
    target: "e2e", mode: "diff", appName: "testapp", baseUrl: "http://localhost:3000",
    contextPack: "## Context Pack\n- /owners: button \"Add owner\"",
    learnedRules: "- prefer getByRole over CSS",
    stepLimit: 40,
    ...overrides,
  };
}

const regen = (over: Partial<OpencodeRunInput> = {}): OpencodeRunInput =>
  mkInput({ fixCases: [{ name: "owners list", status: "fail", detail: "locator not found", file: "flows/owners.spec.ts" }], deliveredSpecs: [{ file: "flows/owners.spec.ts", flow: "owners", objective: "lists the owners" }], ...over });

/* What the session already holds from the turn that opened it. */
const HELD_BY_THE_SESSION = ["working-rules", "context-pack", "learned-rules", "regen-discipline"];

test("a continuation leaves out what the session already holds and keeps what this turn must act on", () => {
  const full = buildPromptAssembled(regen());
  const continuation = buildPromptAssembled(regen(), { continuation: true });

  for (const id of HELD_BY_THE_SESSION) {
    assert.ok(full.sectionSizes[id] !== undefined, `the full regeneration prompt carries ${id}`);
    assert.equal(continuation.sectionSizes[id], undefined, `the continuation leaves out ${id}`);
  }
  for (const id of ["fix-cases", "task", STEP_MILESTONE_SECTION_ID]) {
    assert.ok(continuation.sectionSizes[id] !== undefined, `the continuation keeps ${id}`);
  }
  assert.ok(continuation.text.length < full.text.length);
});

test("every regeneration signal reaches a continuation", () => {
  const continuation = buildPromptAssembled(regen({
    selectorContradictions: ["getByRole('button', { name: 'Save' }) is not in the tree"],
    reviewCorrections: ["the assertion checks the wrong total"],
    coverageGap: "- src/foo.ts: lines 3-5",
  }), { continuation: true });
  for (const id of ["fix-cases", "selector-contradictions", "reviewer-corrections", "coverage-gap"]) {
    assert.ok(continuation.sectionSizes[id] !== undefined, id);
  }
});

test("a first pass is never a continuation: the flag changes nothing there", () => {
  assert.equal(buildPromptAssembled(mkInput(), { continuation: true }).text, buildPromptAssembled(mkInput()).text);
});

test("a continuation renders the failing case's evidence (HTTP status, final URL, page errors)", () => {
  const text = buildPromptAssembled(mkInput({
    fixCases: [{ name: "owners list", status: "fail", detail: "timeout", httpStatus: 503, finalUrl: "https://dev.example.com/owners", runtimeErrors: [{ type: "pageerror", text: "TypeError: cannot read properties of undefined" }] }],
  }), { continuation: true }).text;
  assert.match(text, /HTTP 503/);
  assert.ok(text.includes("https://dev.example.com/owners"));
  assert.match(text, /\[pageerror\] TypeError: cannot read properties of undefined/);
});
