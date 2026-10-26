/* The change pages a lead's plan left unvisited, stated to the lead when it authors the change alone: on a first pass of an e2e run that writes tests, never on the planning turn or a regeneration. Asserted on the section id and the pages taken from the input, never on prompt wording. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CHANGE_PAGES_SECTION_ID, buildPromptAssembled, type AssembledPrompt } from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import type { OpencodeRunInput } from "@contexts/generation/domain/opencode-run-input.ts";

function mkInput(overrides: Partial<OpencodeRunInput> = {}): OpencodeRunInput {
  return {
    repo: "org/app",
    sha: "abc1234",
    diff: "diff --git a/src/app/menu/menu.ts b/src/app/menu/menu.ts\n+export const copy = 'x';\n",
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234",
    needsReview: false,
    target: "e2e",
    mode: "diff",
    appName: "shop",
    baseUrl: "http://localhost:3000",
    intent: { type: "fix", breaking: false, message: "fix(menu): the copy", changedFiles: ["src/app/menu/menu.ts"] },
    ...overrides,
  };
}

const assemble = (over: Partial<OpencodeRunInput> = {}): AssembledPrompt => buildPromptAssembled(mkInput(over), { budgetBytes: 0 });

test("a lead that authors the change alone is told the change pages its plan left unvisited", () => {
  const assembled = assemble({ unvisitedChangePages: ["/shops/:province/:slug/menu", "/orders"] });
  assert.notEqual(assembled.sectionSizes[CHANGE_PAGES_SECTION_ID], undefined);
  assert.ok(assembled.text.includes("/shops/:province/:slug/menu"));
  assert.ok(assembled.text.includes("/orders"));
});

test("without unvisited pages, on the planning turn and on a code run, no change-pages section is rendered", () => {
  assert.equal(assemble().sectionSizes[CHANGE_PAGES_SECTION_ID], undefined);
  assert.equal(assemble({ unvisitedChangePages: [] }).sectionSizes[CHANGE_PAGES_SECTION_ID], undefined);
  assert.equal(assemble({ unvisitedChangePages: ["/orders"], planning: { maxFlows: 5, maxParallel: 2, budgetMs: 240_000 } }).sectionSizes[CHANGE_PAGES_SECTION_ID], undefined);
  assert.equal(assemble({ unvisitedChangePages: ["/orders"], target: "code" }).sectionSizes[CHANGE_PAGES_SECTION_ID], undefined);
});
