/* The coordination prompts are assembled from registered section definitions: each reports its section sizes and hashes (the telemetry split), keeps the content and order it always had, and a delegation brief is held to its contract by the prompt-contract lint. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { lintCell, claim, type LintCell, type LintSection } from "@contexts/generation/application/index.ts";
import type { AssembledPrompt } from "@kernel/prompt-sections.ts";
import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { createDelegationBrief, type DelegationBrief } from "@contexts/coordination/application/delegation-brief.ts";
import { renderSidekickBrief } from "@contexts/coordination/application/sidekick-prompt.ts";
import { renderExploreBrief } from "@contexts/coordination/application/explore-kind.ts";
import { assembleLeadReview } from "@contexts/coordination/application/lead-review.ts";
import { assembleLeadCorrection, assembleRefusedCorrection } from "@contexts/coordination/application/lead-correction.ts";
import { assembleExploreOutcome } from "@contexts/coordination/application/explore-round.ts";
import { AUTHOR_BRIEF_SECTIONS, EXPLORE_BRIEF_SECTIONS } from "@contexts/coordination/application/coordination-sections/brief-sections.ts";
import { COORDINATION_PROMPTS } from "@contexts/coordination/application/coordination-sections/index.ts";
import { FLOW_OUTCOME } from "@contexts/coordination/application/flow-outcomes.ts";
import { assembleDefs } from "@kernel/prompt-sections.ts";

const redaction = new PatternRedactionAdapter();

const authorBrief = (): DelegationBrief =>
  createDelegationBrief({
    redaction,
    delegationId: "d1",
    runId: "r1",
    objective: "cover checkout",
    task: "write the spec",
    scope: { readablePaths: ["."], writablePaths: ["e2e/flows/checkout.spec.ts"], allowedCommands: [] },
    acceptanceCriteria: ["checkout completes"],
    tools: ["read", "write", "run_spec"],
  });

const exploreBrief = (): DelegationBrief =>
  createDelegationBrief({
    redaction,
    delegationId: "r1-explore-q1",
    runId: "r1",
    objective: "does the cart list items?",
    task: "Answer ONE question for the lead, read-only.",
    scope: { readablePaths: ["."], writablePaths: [], allowedCommands: [] },
    tools: ["read", "codegraph"],
  });

/* The assembled sections of a prompt, cut at the blank line the coordination prompts join them with. */
function lintSectionsOf(assembled: AssembledPrompt): LintSection[] {
  let offset = 0;
  const bytes = Buffer.from(assembled.text, "utf8");
  return Object.entries(assembled.sectionSizes).map(([id, size]) => {
    const text = bytes.subarray(offset, offset + size).toString("utf8");
    offset += size + 2;
    return { id, layer: "assembled" as const, text, claims: assembled.claims[id] ?? [] };
  });
}

const briefCell = (assembled: AssembledPrompt, delegation: LintCell["delegation"]): LintCell => ({ name: "brief", regen: false, sections: lintSectionsOf(assembled), ...(delegation ? { delegation } : {}) });

const asBrief = (defs: typeof AUTHOR_BRIEF_SECTIONS, brief: DelegationBrief): AssembledPrompt => assembleDefs(defs, { brief, scrub: (text) => redaction.redact(text) }, { separator: "\n\n" });

test("every coordination prompt reports a size and a hash for each section it carries, under the same ids", () => {
  const flows = [{ id: "one", objective: "o", acceptance: [], outcome: { kind: FLOW_OUTCOME.DELIVERED }, answer: { kind: "read", concerns: [] }, verified: true, sessionOpen: true, spec: "test()" }];
  const prompts: Record<string, AssembledPrompt> = {
    review: assembleLeadReview(redaction, flows as never, { turn: 1, maxTurns: 3 }),
    correction: assembleLeadCorrection(redaction, [{ id: "one", objective: "o", specFile: "flows/one.spec.ts", sessionOpen: true }], [{ text: "bad", spec: "flows/one.spec.ts" }]),
    refused: assembleRefusedCorrection([{ reason: "nope" }], 1),
    outcome: assembleExploreOutcome(redaction, { ran: true, questions: [{ id: "q1", question: "?", status: "answered", findings: [] }] }),
    author: asBrief(AUTHOR_BRIEF_SECTIONS, authorBrief()),
    explore: asBrief(EXPLORE_BRIEF_SECTIONS, exploreBrief()),
  };
  for (const [name, prompt] of Object.entries(prompts)) {
    assert.ok(Object.keys(prompt.sectionSizes).length > 0, name);
    assert.deepEqual(Object.keys(prompt.sectionHashes ?? {}), Object.keys(prompt.sectionSizes), `${name}: a hash for every sized section`);
  }
  assert.deepEqual(Object.keys(renderSidekickBrief(redaction, authorBrief()).sectionHashes), Object.keys(renderSidekickBrief(redaction, authorBrief()).sectionSizes));
  assert.deepEqual(Object.keys(renderExploreBrief(redaction, exploreBrief()).sectionHashes), Object.keys(renderExploreBrief(redaction, exploreBrief()).sectionSizes));
});

test("the flow author's brief keeps its sections in order, each once, with the boundary and the tools stated apart from the return shape", () => {
  const { text, sectionSizes } = renderSidekickBrief(redaction, authorBrief());
  assert.deepEqual(Object.keys(sectionSizes), ["task", "acceptance", "scope", "tools", "contract"]);
  const headings = text.split("\n").filter((line) => line.startsWith("## "));
  assert.deepEqual(headings, ["## Task", "## Acceptance criteria", "## Scope", "## Authority (frozen)", "## Tools", "## Output contract"]);
  assert.equal(text.split("Do NOT write outside writablePaths").length, 2, "the boundary rule is stated once");
  assert.match(text, /- read: /);
  assert.match(text, /- run_spec: /);
});

test("the explore brief keeps its question, task and return shape, and states that the sidekick writes nothing and which tools it holds", () => {
  const { text, sectionSizes } = renderExploreBrief(redaction, exploreBrief());
  assert.deepEqual(Object.keys(sectionSizes), ["question", "task", "boundary", "tools", "contract"]);
  assert.match(text, /You write no file/);
  assert.match(text, /- codegraph: /);
  assert.doesNotMatch(text, /authbrowser/);
});

test("a delegation brief that states its whole contract and only what its turn grants lints clean", () => {
  const author = briefCell(asBrief(AUTHOR_BRIEF_SECTIONS, authorBrief()), { tools: ["read", "write", "run_spec"], writes: true });
  const explore = briefCell(asBrief(EXPLORE_BRIEF_SECTIONS, exploreBrief()), { tools: ["read", "codegraph"], writes: false });
  assert.deepEqual(lintCell(author), []);
  assert.deepEqual(lintCell(explore), []);
});

test("a brief missing its return shape is a finding naming the part", () => {
  const without = AUTHOR_BRIEF_SECTIONS.filter((def) => def.id !== "contract");
  const findings = lintCell(briefCell(asBrief(without, authorBrief()), { tools: ["read", "write", "run_spec"], writes: true }));
  assert.deepEqual(findings.map((f) => [f.rule, f.part]), [["R17", "return-shape"]]);
});

test("a contract part stated in two sections is a finding naming both", () => {
  const twice = [...AUTHOR_BRIEF_SECTIONS, { id: "restated", tier: "task" as const, priority: 200, applies: () => true, render: () => ({ content: "## Again\nDo NOT write outside writablePaths.", claims: [claim.statesContract("boundary")] }) }];
  const findings = lintCell(briefCell(asBrief(twice, authorBrief()), { tools: ["read", "write", "run_spec"], writes: true }));
  assert.deepEqual(findings.map((f) => [f.rule, f.part, [...f.sections]]), [["R17", "boundary", ["restated", "scope"]]]);
});

test("a brief that names a tool its turn does not grant, or leaves one out, is a finding", () => {
  const brief = asBrief(AUTHOR_BRIEF_SECTIONS, authorBrief());
  const overstated = lintCell(briefCell(brief, { tools: ["read", "write"], writes: true }));
  assert.deepEqual(overstated.map((f) => [f.rule, f.part]), [["R18", "tool:run_spec"]]);
  const unstated = lintCell(briefCell(brief, { tools: ["read", "write", "run_spec", "authbrowser"], writes: true }));
  assert.deepEqual(unstated.map((f) => [f.rule, f.part]), [["R18", "tool:authbrowser"]]);
});

test("a brief that says the sidekick may write when its turn grants no write is a finding", () => {
  const findings = lintCell(briefCell(asBrief(AUTHOR_BRIEF_SECTIONS, authorBrief()), { tools: ["read", "write", "run_spec"], writes: false }));
  assert.deepEqual(findings.map((f) => [f.rule, f.part]), [["R18", "write"]]);
});

test("a read-only brief states no write: a scope with no writable path declares no write claim", () => {
  const readOnly = createDelegationBrief({ redaction, delegationId: "d2", runId: "r1", objective: "o", task: "t", scope: { readablePaths: ["."], writablePaths: [], allowedCommands: [] } });
  const prompt = asBrief(AUTHOR_BRIEF_SECTIONS, readOnly);
  assert.deepEqual(lintCell(briefCell(prompt, { tools: ["read"], writes: false })), []);
});

test("a brief that names no tools states what its scope grants by itself", () => {
  const { text } = renderSidekickBrief(redaction, createDelegationBrief({ redaction, delegationId: "d3", runId: "r1", objective: "o", task: "t", scope: { readablePaths: ["."], writablePaths: ["e2e/a.spec.ts"], allowedCommands: [] } }));
  assert.match(text, /- read: /);
  assert.match(text, /- write: /);
});

test("the registry names every coordination prompt and each of its sections once", () => {
  for (const [name, defs] of Object.entries(COORDINATION_PROMPTS)) {
    const ids = defs.map((def) => def.id);
    assert.equal(new Set(ids).size, ids.length, `${name}: duplicate section id`);
  }
  assert.deepEqual(Object.keys(COORDINATION_PROMPTS).sort(), ["explore-brief", "flow-author-brief", "lead-correction", "lead-correction-refused", "lead-explore-outcome", "lead-feedback", "lead-plan-rejected", "lead-replan", "lead-review"]);
});
