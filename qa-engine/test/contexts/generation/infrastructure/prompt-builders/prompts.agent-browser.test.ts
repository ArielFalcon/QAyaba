/* The authenticated browser budget a generator prompt states when the run granted the tools. The section provides the fact and holds nothing else, on a first pass and on every regeneration of an e2e run, in every mode that writes tests; without a grant it does not render, and the Codex layer is never given one. Asserted on section ids, claims, numbers from the input and lint findings, never on prompt wording. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_BROWSER_SECTION_ID,
  buildPromptAssembled,
  setExplorationBriefCollaborators,
  type AssembledPrompt,
} from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { PROMPT_HEADINGS, ASSEMBLED_ARTIFACT_NAMES } from "@contexts/generation/domain/prompt-headings.ts";
import { ARTIFACT_REFERENCES } from "@contexts/generation/domain/prompt-artifact-references.ts";
import { countDirectives, hasTrustLanguage, lintCell, type LintSection } from "@contexts/generation/domain/prompt-contract-lint.ts";
import type { ExplorationBrief, OpencodeRunInput } from "@contexts/generation/application/ports/generation-ports.ts";

setExplorationBriefCollaborators({
  parseExplorationBrief: () => null,
  coerceExplorationBrief: () => null,
  renderExplorationBrief: (brief: ExplorationBrief) => `## ${PROMPT_HEADINGS.explorationBrief}\nObjective: ${brief.objective}`,
});

const LIMITS = { maxCalls: 60, perCallMs: 25_000, leaseWaitMs: 10_000 };

function mkInput(overrides: Partial<OpencodeRunInput> = {}): OpencodeRunInput {
  return {
    repo: "org/app",
    sha: "abc1234",
    diff: "diff --git a/src/app/cart/cart.service.ts b/src/app/cart/cart.service.ts\n+export function total() {}\n",
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234",
    needsReview: false,
    target: "e2e",
    mode: "diff",
    appName: "shop",
    baseUrl: "http://localhost:3000",
    intent: { type: "feat", breaking: false, message: "feat(cart): show the total", changedFiles: ["src/app/cart/cart.service.ts"] },
    ...overrides,
  };
}

const assemble = (over: Partial<OpencodeRunInput> = {}): AssembledPrompt => buildPromptAssembled(mkInput(over), { budgetBytes: 0 });

function sectionOf(assembled: AssembledPrompt): { id: string; text: string } | undefined {
  const bytes = Buffer.from(assembled.text, "utf8");
  let offset = 0;
  for (const [id, size] of Object.entries(assembled.sectionSizes)) {
    if (id === AGENT_BROWSER_SECTION_ID) return { id, text: bytes.subarray(offset, offset + size).toString("utf8") };
    offset += size + 1;
  }
  return undefined;
}

const REGENERATIONS: ReadonlyArray<readonly [string, Partial<OpencodeRunInput>]> = [
  ["failing cases", { fixCases: [{ name: "cart total", status: "fail", detail: "boom" }] }],
  ["reviewer corrections", { reviewCorrections: ["[fragile-selector] cart.spec.ts: scope the coupon button"] }],
  ["a coverage gap", { coverageGap: "src/cart.ts: lines 10-14 were not executed" }],
];

test("a run that granted the tools states its budget in a section of its own, in every mode that writes tests", () => {
  for (const mode of ["diff", "manual", "complete", "exhaustive"] as const) {
    const section = sectionOf(assemble({ mode, agentBrowser: LIMITS }));
    assert.ok(section, mode);
    for (const n of [LIMITS.maxCalls, LIMITS.perCallMs / 1000]) assert.ok(section.text.includes(String(n)), `${mode}: ${n}`);
    assert.equal(section.text.includes(String(LIMITS.leaseWaitMs)), false, "the wait for the account is the orchestrator's, not the agent's");
  }
});

test("the budget is also stated on every regeneration, since each one is a new session", () => {
  for (const [label, over] of REGENERATIONS) assert.ok(sectionOf(assemble({ ...over, agentBrowser: LIMITS })), label);
});

test("no grant, no section: the prompt is what it always was", () => {
  const without = assemble();
  assert.equal(sectionOf(without), undefined);
  assert.equal(without.text, assemble({}).text);
  assert.equal(without.text.includes(PROMPT_HEADINGS.agentBrowser), false);
});

test("the section is facts only: it provides the fact, directs nothing and takes no side on trust", () => {
  const section = sectionOf(assemble({ agentBrowser: LIMITS }))!;
  assert.equal(countDirectives(section.text), 0);
  assert.equal(hasTrustLanguage(section.text), false);
  const claims = assemble({ agentBrowser: LIMITS }).claims[AGENT_BROWSER_SECTION_ID] ?? [];
  assert.deepEqual(claims, [{ kind: "provides", fact: "agent-browser" }]);
});

test("the heading is an assembled artifact static role text must not name, and the lint finds nothing in a granted prompt", () => {
  assert.ok(ASSEMBLED_ARTIFACT_NAMES.includes(PROMPT_HEADINGS.agentBrowser));
  const assembled = assemble({ agentBrowser: LIMITS });
  const bytes = Buffer.from(assembled.text, "utf8");
  const sections: LintSection[] = [];
  let offset = 0;
  for (const [id, size] of Object.entries(assembled.sectionSizes)) {
    sections.push({ id, layer: "assembled", text: bytes.subarray(offset, offset + size).toString("utf8"), claims: assembled.claims[id] ?? [], ...(id === AGENT_BROWSER_SECTION_ID ? { factsOnly: true } : {}) });
    offset += size + 1;
  }
  const findings = lintCell({ name: "granted", regen: false, sections }, { assembledArtifactNames: ASSEMBLED_ARTIFACT_NAMES, artifactReferences: ARTIFACT_REFERENCES });
  assert.deepEqual(findings.filter((f) => f.sections.includes(AGENT_BROWSER_SECTION_ID)), []);
});

test("a context run never states a budget, whatever it is handed", () => {
  assert.equal(sectionOf(assemble({ mode: "context", agentBrowser: LIMITS })), undefined);
});

test("a code run never states a budget, whatever it is handed", () => {
  assert.equal(sectionOf(assemble({ target: "code", baseUrl: undefined, agentBrowser: LIMITS })), undefined);
});

test("the browser section and the run_spec section are independent: each renders alone, and both can render together", () => {
  const both = assemble({ agentBrowser: LIMITS, closedLoop: { maxCalls: 8, perCallMs: 120_000, maxDevWrites: 20 } });
  assert.ok(sectionOf(both));
  assert.ok(Object.keys(both.sectionSizes).includes("closed-loop"));
  assert.equal(Object.keys(assemble({ agentBrowser: LIMITS }).sectionSizes).includes("closed-loop"), false);
});
