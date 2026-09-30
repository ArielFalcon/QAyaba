/* Scaffold rules of the generator prompt that must not depend on what happens to be in the prompt: the login section, the runtime-signals rule, the review flag and the size line. Asserted on claims and on carried data, never on wording. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPrompt,
  buildPromptAssembled,
  setExplorationBriefCollaborators,
  type AssembledPrompt,
} from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { PACK_HEADINGS } from "@contexts/generation/infrastructure/context-pack.ts";
import type { FactId, PromptClaim } from "@contexts/generation/domain/prompt-contract-lint.ts";
import type { OpencodeRunInput, ExplorationBrief } from "@contexts/generation/application/ports/generation-ports.ts";

setExplorationBriefCollaborators({
  parseExplorationBrief: () => null,
  coerceExplorationBrief: () => null,
  renderExplorationBrief: (brief: ExplorationBrief) => `## Exploration brief\nObjective: ${brief.objective}`,
});

const SEEDED_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,4 @@",
  "-old",
  "+new one",
  "+new two",
  "+new three",
  "diff --git a/src/b.ts b/src/b.ts",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -1 +1 @@",
  "-b old",
  "+b new",
  "",
].join("\n");

function mkInput(overrides: Partial<OpencodeRunInput> = {}): OpencodeRunInput {
  return {
    repo: "org/app",
    sha: "abc1234",
    diff: SEEDED_DIFF,
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234",
    needsReview: true,
    target: "e2e",
    mode: "diff",
    appName: "shop",
    baseUrl: "http://localhost:3000",
    intent: { type: "feat", breaking: false, message: "feat: show the total", changedFiles: ["src/a.ts", "src/b.ts"] },
    ...overrides,
  };
}

const claimsOf = (a: AssembledPrompt, id: string): readonly PromptClaim[] => a.claims[id] ?? [];
const directs = (a: AssembledPrompt, id: string, action: string, target?: FactId): boolean =>
  claimsOf(a, id).some((c) => c.kind === "directs" && c.action === action && (target === undefined || c.target === target));

const DOM_PACK = `## ${PACK_HEADINGS.pack}\n\n### ${PACK_HEADINGS.liveDom} (x)\n  heading: Login`;
const CONTRACTS_PACK = `## ${PACK_HEADINGS.pack}\n\n### ${PACK_HEADINGS.contracts} (x)\n- a`;
const TREE = "  heading: Cart\n  button: Apply";

/* ── the login section never depends on the pack ── */

test("the login section never consults the pack's live DOM, and always sends the rewrite to the login page itself", () => {
  for (const contextPack of [undefined, DOM_PACK, CONTRACTS_PACK]) {
    const a = buildPromptAssembled(mkInput({ authSeedUnauthored: true, ...(contextPack ? { contextPack } : {}) }));
    assert.ok(a.sectionSizes["app-login"] !== undefined, "the section is rendered");
    assert.equal(directs(a, "app-login", "consult"), false, String(contextPack?.slice(0, 20)));
    const text = a.text.slice(a.text.indexOf("## App login"));
    assert.match(text.slice(0, text.search(/\n\n|\n#/) === -1 ? undefined : text.search(/\n\n|\n#/)), /Playwright MCP/);
  }
});

/* ── the runtime-signals rule only belongs where no DOM tree is available ── */

test("the runtime-signals rule is present only when no DOM tree is in the prompt", () => {
  const withRule = (extra: Partial<OpencodeRunInput>): boolean =>
    directs(buildPromptAssembled(mkInput(extra)), "working-rules", "use-runtime-signals");
  assert.equal(withRule({}), true, "no grounding");
  assert.equal(withRule({ contextPack: CONTRACTS_PACK }), true, "a pack without a live DOM is not a tree");
  assert.equal(withRule({ contextPack: DOM_PACK }), false, "a pack with a live DOM");
  assert.equal(withRule({ domSnapshot: TREE }), false, "a captured tree");
  assert.equal(withRule({ domSnapshot: TREE, failureSourced: true, fixCases: [{ name: "t", status: "fail" }] }), false, "a failure tree");
});

test("code and context runs never carry the runtime-signals rule", () => {
  assert.equal(directs(buildPromptAssembled(mkInput({ target: "code" })), "working-rules", "use-runtime-signals"), false);
  assert.equal(directs(buildPromptAssembled(mkInput({ mode: "context" })), "working-rules", "use-runtime-signals"), false);
});

test("the prompt names the runtime-signals tools exactly when it directs the rule", () => {
  const tools = /browser_console_messages/;
  assert.match(buildPrompt(mkInput()), tools);
  assert.doesNotMatch(buildPrompt(mkInput({ contextPack: DOM_PACK })), tools);
  assert.doesNotMatch(buildPrompt(mkInput({ domSnapshot: TREE })), tools);
});

/* ── the prompt cannot leak the run's review flag ── */

test("the same input assembles an identical prompt whether or not review is enabled", () => {
  const shapes: Array<Partial<OpencodeRunInput>> = [
    {},
    { target: "code" },
    { mode: "context" },
    { mode: "manual", guidance: "cover the form" },
    { fixCases: [{ name: "t", status: "fail", detail: "boom" }] },
    { contextPack: DOM_PACK, domSnapshot: TREE },
  ];
  for (const shape of shapes) {
    assert.equal(
      buildPrompt(mkInput({ ...shape, needsReview: true })),
      buildPrompt(mkInput({ ...shape, needsReview: false })),
      JSON.stringify(Object.keys(shape)),
    );
  }
});

/* ── the size line is the diff's real size ── */

test("the scope budget states the real number of files and changed lines of the diff", () => {
  const text = buildPrompt(mkInput());
  const budget = text.slice(text.indexOf("## Scope budget"));
  assert.match(budget, /\b2 files?\b/);
  assert.match(budget, /\+4\b/);
  assert.match(budget, /-2\b/);
});

test("the scope budget claims neither a single commit nor a commit count", () => {
  const text = buildPrompt(mkInput());
  assert.doesNotMatch(text, /ONE commit|single-commit|one commit/i);
});

test("the size figures follow the diff, not a constant", () => {
  const small = buildPrompt(mkInput({ diff: "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n", intent: { type: "fix", breaking: false, message: "fix: x", changedFiles: ["x.ts"] } }));
  const budget = small.slice(small.indexOf("## Scope budget"));
  assert.match(budget, /\b1 files?\b/);
  assert.match(budget, /\+1\b/);
  assert.match(budget, /-1\b/);
});
