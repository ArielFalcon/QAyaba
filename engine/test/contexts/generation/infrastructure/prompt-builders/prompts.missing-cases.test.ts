/* The arms of the changed code no test ran, as the reviewer receives them: a section of their own, one line per arm with where it is and which arm, present only when the run measured some. Asserted on section ids, the arms' own data and lint findings, never on prompt wording. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { REVIEWER_MISSING_CASES_SECTION_ID, buildReviewerPromptAssembled, type AssembledPrompt } from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import type { ReviewInput } from "@contexts/generation/domain/generation-input.ts";

function mkReview(overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    diff: "diff --git a/src/cart.ts b/src/cart.ts\n+export const total = 1;\n",
    specs: ["cart.spec.ts"],
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    appName: "shop",
    mode: "diff",
    ...overrides,
  };
}

function sectionText(a: AssembledPrompt, id: string): string {
  const bytes = Buffer.from(a.text, "utf8");
  let offset = 0;
  for (const [sectionId, size] of Object.entries(a.sectionSizes)) {
    if (sectionId === id) return bytes.subarray(offset, offset + size).toString("utf8");
    offset += size + 1;
  }
  return "";
}

const ARMS = [
  { file: "src/cart.ts", line: 3, kind: "if", arm: "else" },
  { file: "src/cart.ts", line: 9, kind: "logical", arm: "?? short-circuited" },
];

test("the reviewer receives the arms no test ran in a section of their own, each with its file, line, kind and arm, and the citation that names one", () => {
  const a = buildReviewerPromptAssembled(mkReview({ untakenArms: ARMS }));
  const text = sectionText(a, REVIEWER_MISSING_CASES_SECTION_ID);
  for (const arm of ARMS) assert.ok(text.includes(`${arm.file}:${arm.line} ${arm.kind}: ${arm.arm}`), `${arm.file}:${arm.line}`);
  assert.ok(text.includes('"kind":"arm"'), "it says how a missing case is cited");
});

test("without arms the reviewer prompt has no such section", () => {
  assert.equal(REVIEWER_MISSING_CASES_SECTION_ID in buildReviewerPromptAssembled(mkReview()).sectionSizes, false);
  assert.equal(REVIEWER_MISSING_CASES_SECTION_ID in buildReviewerPromptAssembled(mkReview({ untakenArms: [] })).sectionSizes, false);
});

const AVAILABILITY = [
  { route: "/upload-menu/preview", outcome: { kind: "redirected" as const, to: "/home", mechanism: "client" as const }, sessionAttached: true, basis: { class: "change-introduced" as const, via: "route-guard" as const, at: "src/app.routes.ts:102" } },
];

test("the reviewer receives the run's route availability facts in a section of their own, with the citation that names one, and none without facts", () => {
  const text = sectionText(buildReviewerPromptAssembled(mkReview({ routeAvailability: AVAILABILITY })), "reviewer-route-availability");
  assert.ok(text.includes("/upload-menu/preview") && text.includes("/home") && text.includes("src/app.routes.ts:102"));
  assert.ok(text.includes('"kind":"availability"'), "it says how an availability fact is cited");
  assert.equal("reviewer-route-availability" in buildReviewerPromptAssembled(mkReview()).sectionSizes, false);
});
