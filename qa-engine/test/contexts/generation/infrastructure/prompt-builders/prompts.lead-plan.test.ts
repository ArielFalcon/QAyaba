/* The plan contract a lead's prompt carries on the one turn it is asked for a plan. The section states the shapes a plan may take and the limits it will be held to, on a first pass of an e2e run that writes tests; without a planning turn it does not render and the prompt is what it always was. Asserted on section ids, claims, the shapes and numbers taken from the input and the kernel, and lint findings, never on prompt wording. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LEAD_PLAN_SECTION_ID,
  buildPromptAssembled,
  type AssembledPrompt,
} from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { PROMPT_HEADINGS, ASSEMBLED_ARTIFACT_NAMES } from "@contexts/generation/domain/prompt-headings.ts";
import { ARTIFACT_REFERENCES } from "@contexts/generation/domain/prompt-artifact-references.ts";
import { lintCell, type LintSection } from "@contexts/generation/domain/prompt-contract-lint.ts";
import { LEAD_PLAN_KIND } from "@kernel/coordination.ts";
import type { OpencodeRunInput } from "@contexts/generation/application/generation-input.ts";


const PLANNING = { maxFlows: 5, maxParallel: 2, budgetMs: 240_000 };

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
    if (id === LEAD_PLAN_SECTION_ID) return { id, text: bytes.subarray(offset, offset + size).toString("utf8") };
    offset += size + 1;
  }
  return undefined;
}

test("a planning turn carries the plan contract in a section of its own, in every mode that writes tests", () => {
  for (const mode of ["diff", "manual", "complete", "exhaustive"] as const) {
    const section = sectionOf(assemble({ mode, planning: PLANNING }));
    assert.ok(section, mode);
    assert.ok(section.text.includes(PROMPT_HEADINGS.leadPlan), mode);
  }
});

test("the contract names every shape a plan may take and the limits the orchestrator holds it to", () => {
  const section = sectionOf(assemble({ planning: PLANNING }))!;
  for (const kind of Object.values(LEAD_PLAN_KIND)) assert.ok(section.text.includes(`"${kind}"`), kind);
  for (const n of [PLANNING.maxFlows, PLANNING.maxParallel]) assert.ok(section.text.includes(String(n)), String(n));
  for (const key of ["plan", "kind", "flows", "id", "objective", "acceptance", "routes"]) assert.ok(section.text.includes(`"${key}"`), key);
});

test("the pages the change is linked to are named in the contract, and a contract without them names none", () => {
  const changeRoutes = ["/order", "/upload-menu/:step"];
  const named = sectionOf(assemble({ planning: { ...PLANNING, changeRoutes } }))!;
  for (const route of changeRoutes) assert.ok(named.text.includes(route), route);
  const plain = sectionOf(assemble({ planning: PLANNING }))!;
  assert.equal(plain.text.includes("/order"), false);
});

test("no planning turn, no section: the prompt is what it always was", () => {
  const without = assemble();
  assert.equal(sectionOf(without), undefined);
  assert.equal(without.text.includes(PROMPT_HEADINGS.leadPlan), false);
  assert.equal(without.text, assemble({ planning: undefined }).text);
});

test("the section provides the plan contract and the lint finds nothing in a planning prompt", () => {
  assert.ok(ASSEMBLED_ARTIFACT_NAMES.includes(PROMPT_HEADINGS.leadPlan));
  const assembled = assemble({ planning: PLANNING });
  assert.deepEqual(assembled.claims[LEAD_PLAN_SECTION_ID], [{ kind: "provides", fact: "lead-plan" }]);
  const bytes = Buffer.from(assembled.text, "utf8");
  const sections: LintSection[] = [];
  let offset = 0;
  for (const [id, size] of Object.entries(assembled.sectionSizes)) {
    sections.push({ id, layer: "assembled", text: bytes.subarray(offset, offset + size).toString("utf8"), claims: assembled.claims[id] ?? [] });
    offset += size + 1;
  }
  const findings = lintCell({ name: "planning", regen: false, sections }, { assembledArtifactNames: ASSEMBLED_ARTIFACT_NAMES, artifactReferences: ARTIFACT_REFERENCES });
  assert.deepEqual(findings.filter((f) => f.sections.includes(LEAD_PLAN_SECTION_ID)), []);
});

test("a context run and a code run never carry the contract, whatever they are handed", () => {
  assert.equal(sectionOf(assemble({ mode: "context", planning: PLANNING })), undefined);
  assert.equal(sectionOf(assemble({ target: "code", baseUrl: undefined, planning: PLANNING })), undefined);
});

test("a regeneration never carries the contract: only the first pass is planned", () => {
  for (const over of [{ fixCases: [{ name: "cart total", status: "fail" as const, detail: "boom" }] }, { reviewCorrections: ["[fragile-selector] scope the button"] }, { coverageGap: "src/cart.ts: lines 10-14" }]) {
    assert.equal(sectionOf(assemble({ ...over, planning: PLANNING })), undefined);
  }
});

test("a planning turn's diff leaves out the bodies of the app's own test files and still names them; any other turn shows them whole", () => {
  const testBody = "+it('totals the cart', () => expect(total()).toBe(3));";
  const diff = "diff --git a/src/app/cart/cart.service.ts b/src/app/cart/cart.service.ts\n+export function total() {}\n" +
    `diff --git a/src/app/cart/cart.service.spec.ts b/src/app/cart/cart.service.spec.ts\n${testBody}\n`;
  const planned = assemble({ diff, planning: PLANNING }).text;
  assert.ok(planned.includes("+export function total() {}"));
  assert.ok(!planned.includes(testBody));
  assert.ok(planned.includes("src/app/cart/cart.service.spec.ts"));
  assert.ok(assemble({ diff }).text.includes(testBody));
});

test("a planning turn names no browser tool: its session is denied one, so it plans from the pack and the code", () => {
  const BROWSER_TOOL = /\b(browser_navigate|browser_snapshot|authbrowser_navigate|authbrowser_snapshot)\b/;
  const planning = assemble({ planning: PLANNING });
  assert.doesNotMatch(planning.text, BROWSER_TOOL);
  assert.doesNotMatch(planning.text, /Playwright MCP/);
  /* The same input without a planning turn is an authoring turn, which reads the live page. */
  assert.match(assemble().text, BROWSER_TOOL);
});
