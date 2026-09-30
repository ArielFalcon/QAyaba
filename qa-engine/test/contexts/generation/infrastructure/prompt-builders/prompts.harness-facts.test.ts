/* Harness facts reach the generator as data only, and the files whose content the prompt renders are listed by path so the efficiency tracker can tell a redundant re-read from a fresh one. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPromptAssembled,
  setExplorationBriefCollaborators,
  type AssembledPrompt,
} from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { countDirectives, hasTrustLanguage, HARNESS_FACTS_SECTION_ID } from "@contexts/generation/domain/prompt-contract-lint.ts";
import type { HarnessFacts } from "@contexts/generation/domain/harness-facts.ts";
import type { ArchitectureContext, OpencodeRunInput, ExplorationBrief } from "@contexts/generation/application/ports/generation-ports.ts";

setExplorationBriefCollaborators({
  parseExplorationBrief: () => null,
  coerceExplorationBrief: () => null,
  renderExplorationBrief: (brief: ExplorationBrief) => `## Exploration brief\nObjective: ${brief.objective}`,
});

function mkInput(overrides: Partial<OpencodeRunInput> = {}): OpencodeRunInput {
  return {
    repo: "org/app",
    sha: "abc1234",
    diff: "diff --git a/a.ts b/a.ts\n+x\n",
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "tests/e2e",
    namespace: "qa-bot-abc1234",
    needsReview: false,
    target: "e2e",
    mode: "diff",
    appName: "shop",
    baseUrl: "http://localhost:3000",
    ...overrides,
  };
}

const FACTS: HarnessFacts = { testIdAttribute: "data-cy", fixtures: { file: "fixtures.ts", exports: ["test", "expect", "authenticate"] } };
const MAP: ArchitectureContext = {
  builtAtSha: "abc1234",
  routes: [{ path: "/cart" }],
  api: [{ operationId: "applyCoupon", method: "POST", path: "/cart/coupon" }],
  feBe: [],
};

/* The text of one section, cut from the assembled prompt by the sizes the assembler reports in order. */
function sectionText(a: AssembledPrompt, id: string): string {
  const bytes = Buffer.from(a.text, "utf8");
  let offset = 0;
  for (const [key, size] of Object.entries(a.sectionSizes)) {
    if (key === id) return bytes.subarray(offset, offset + size).toString("utf8");
    offset += size + 1;
  }
  return "";
}

/* ── the facts section ── */

test("harness facts render as a section that names the attribute and the fixtures' exports", () => {
  const a = buildPromptAssembled(mkInput({ harnessFacts: FACTS }));
  const text = sectionText(a, HARNESS_FACTS_SECTION_ID);
  assert.ok(text.includes("data-cy"));
  for (const name of FACTS.fixtures!.exports) assert.ok(text.includes(name), name);
  assert.ok(text.includes("tests/e2e/fixtures.ts"), "the fixtures file is named by its path from the working copy");
  assert.deepEqual(a.claims[HARNESS_FACTS_SECTION_ID], [{ kind: "provides", fact: "harness-facts" }]);
});

test("the facts section is data only: no directive claim, no framing, no directive or trust language", () => {
  const text = sectionText(buildPromptAssembled(mkInput({ harnessFacts: FACTS })), HARNESS_FACTS_SECTION_ID);
  assert.equal(countDirectives(text), 0);
  assert.equal(hasTrustLanguage(text), false);
});

test("absent facts, or facts with nothing to state, render no section", () => {
  assert.equal(buildPromptAssembled(mkInput()).sectionSizes[HARNESS_FACTS_SECTION_ID], undefined);
  assert.equal(buildPromptAssembled(mkInput({ harnessFacts: {} })).sectionSizes[HARNESS_FACTS_SECTION_ID], undefined);
  assert.equal(buildPromptAssembled(mkInput({ harnessFacts: { fixtures: { file: "fixtures.ts", exports: [] } } })).sectionSizes[HARNESS_FACTS_SECTION_ID], undefined);
});

test("only the facts that exist are stated, and a lone attribute or a lone fixtures list still renders", () => {
  const onlyAttribute = sectionText(buildPromptAssembled(mkInput({ harnessFacts: { testIdAttribute: "data-cy" } })), HARNESS_FACTS_SECTION_ID);
  assert.ok(onlyAttribute.includes("data-cy") && !onlyAttribute.includes("fixtures"));
  const onlyFixtures = sectionText(buildPromptAssembled(mkInput({ harnessFacts: { fixtures: FACTS.fixtures! } })), HARNESS_FACTS_SECTION_ID);
  assert.ok(onlyFixtures.includes("authenticate") && !onlyFixtures.includes("testIdAttribute"));
});

test("a secret-shaped value in a fact never reaches the prompt raw", () => {
  const secret = "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const a = buildPromptAssembled(mkInput({ harnessFacts: { testIdAttribute: "data-cy", fixtures: { file: "fixtures.ts", exports: [secret] } } }));
  assert.equal(a.text.includes(secret), false);
});

test("code and context runs carry no harness facts section", () => {
  assert.equal(buildPromptAssembled(mkInput({ harnessFacts: FACTS, mode: "context" })).sectionSizes[HARNESS_FACTS_SECTION_ID], undefined);
});

/* ── the manifest of provided paths ── */

test("the architecture map's context.json and the fixtures file are listed as provided paths, relative to the working copy", () => {
  const a = buildPromptAssembled(mkInput({ harnessFacts: FACTS, contextMap: MAP }));
  assert.deepEqual([...(a.providedPaths ?? [])].sort(), ["tests/e2e/.qa/context.json", "tests/e2e/fixtures.ts"]);
});

test("a prompt that renders neither file lists no provided path", () => {
  assert.deepEqual(buildPromptAssembled(mkInput()).providedPaths, []);
  assert.deepEqual(buildPromptAssembled(mkInput({ harnessFacts: { testIdAttribute: "data-cy" } })).providedPaths, []);
});

test("a section shed by the byte budget contributes no provided path", () => {
  const input = mkInput({ harnessFacts: FACTS, contextMap: MAP });
  const full = buildPromptAssembled(input);
  assert.equal(full.providedPaths?.length, 2);
  const total = Buffer.byteLength(full.text, "utf8");
  const withoutMap = buildPromptAssembled(input, { budgetBytes: total - (full.sectionSizes["arch-map"] ?? 0) });
  assert.equal(withoutMap.sectionSizes["arch-map"], undefined, "the map was shed");
  assert.ok(withoutMap.sectionSizes[HARNESS_FACTS_SECTION_ID] !== undefined, "the facts survived");
  assert.deepEqual(withoutMap.providedPaths, ["tests/e2e/fixtures.ts"]);
});
