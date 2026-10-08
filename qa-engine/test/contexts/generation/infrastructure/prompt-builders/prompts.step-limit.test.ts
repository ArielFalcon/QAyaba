/* The step limit a prompt states when its runtime enforces one. A generator prompt carries it in a section of its own that provides the fact and holds nothing else, in every mode and target and on a first pass and on a regeneration; a turn that writes tests also carries a milestone, a second section that names the step by which something should be written. Neither section renders without a limit. Asserted on section ids, claims, the declared milestone data, numbers computed from imported constants and lint findings, never on prompt wording. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RUN_MODES, type RunMode, type TestTarget } from "@kernel/run-mode.ts";
import {
  MILESTONE_OUTCOME_PHRASES,
  REVIEWER_STEP_LIMIT_SECTION_ID,
  buildExplorerPrompt,
  buildPromptAssembled,
  buildReviewerPromptAssembled,
  setExplorationBriefCollaborators,
  type AssembledPrompt,
} from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { PROMPT_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
import { ARTIFACT_REFERENCES } from "@contexts/generation/domain/prompt-artifact-references.ts";
import {
  STEP_LIMIT_SECTION_ID,
  countDirectives,
  lintCell,
  type FactId,
  type LintSection,
} from "@contexts/generation/domain/prompt-contract-lint.ts";
import {
  STEP_MILESTONE_SECTION_ID,
  isTestWritingTurn,
  stepMidpoint,
  stepMilestone,
  type MilestoneOutcome,
} from "@contexts/generation/domain/step-limit.ts";
import type { ExplorationBrief, OpencodeRunInput, ReviewInput } from "@contexts/generation/application/ports/generation-ports.ts";

setExplorationBriefCollaborators({
  parseExplorationBrief: () => null,
  coerceExplorationBrief: () => null,
  renderExplorationBrief: (brief: ExplorationBrief) => `## ${PROMPT_HEADINGS.explorationBrief}\nObjective: ${brief.objective}`,
});

/* The limit the runtime reports in these tests, and a second one whose midpoint differs from it. */
const LIMIT = 40;
const OTHER_LIMIT = 25;

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

/* The assembled prompt of a turn, without the byte budget (nothing is shed), with a limit or without one. */
const assemble = (over: Partial<OpencodeRunInput>, stepLimit?: number): AssembledPrompt =>
  buildPromptAssembled(mkInput({ ...over, ...(stepLimit !== undefined ? { stepLimit } : {}) }), { budgetBytes: 0 });

const FIX = { fixCases: [{ name: "cart total", status: "fail" as const, detail: "boom" }] };

/* One signal of each kind that turns a first pass into a regeneration. */
const REGEN_SIGNALS: ReadonlyArray<readonly [string, Partial<OpencodeRunInput>]> = [
  ["failing cases", FIX],
  ["reviewer corrections", { reviewCorrections: ["[fragile-selector] cart.spec.ts: scope the coupon button to the cart form"] }],
  ["a coverage gap", { coverageGap: "src/cart.ts: lines 10-14 were not executed" }],
  ["selector contradictions", { selectorContradictions: ["button:Apply is NOT in the captured tree"] }],
];

interface Turn {
  label: string;
  mode: RunMode;
  target: TestTarget;
  over: Partial<OpencodeRunInput>;
  regen: boolean;
}

/* Every kind of turn a generator prompt is built for: the first pass of each mode in each target that has it, and each kind of regeneration. */
function turns(): Turn[] {
  const out: Turn[] = [];
  for (const target of ["e2e", "code"] as const) {
    for (const mode of RUN_MODES) {
      if (mode === "context" && target === "code") continue;
      const over: Partial<OpencodeRunInput> = { mode, target, ...(mode === "manual" ? { guidance: "cover the coupon form" } : {}), ...(target === "code" ? { baseUrl: undefined } : {}) };
      out.push({ label: `${mode}/${target} first pass`, mode, target, over, regen: false });
      if (mode === "context") continue;
      for (const [signal, extra] of REGEN_SIGNALS) {
        out.push({ label: `${mode}/${target} regeneration (${signal})`, mode, target, over: { ...over, ...extra }, regen: true });
      }
    }
  }
  return out;
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

const providersOf = (a: AssembledPrompt, fact: FactId): string[] =>
  Object.entries(a.claims)
    .filter(([, claims]) => claims.some((c) => c.kind === "provides" && c.fact === fact))
    .map(([id]) => id)
    .sort();

/* The lint's view of the cell, as the matrix builds it: the step limit is facts only and the diff is captured data. */
const lintSectionsOf = (a: AssembledPrompt): LintSection[] =>
  Object.keys(a.sectionSizes).map((id) => ({
    id,
    layer: "assembled" as const,
    text: sectionText(a, id),
    claims: a.claims[id] ?? [],
    ...(id === "diff" ? { verbatim: true } : {}),
    ...(id === STEP_LIMIT_SECTION_ID ? { factsOnly: true } : {}),
  }));

const findingsOf = (sections: LintSection[], regen: boolean) =>
  lintCell({ name: "seeded", regen, sections }, { artifactReferences: ARTIFACT_REFERENCES });

/* The directive words the lint counts over the cell, read through its public budget rule: a limit below zero is breached by any total. */
const directivesIn = (sections: LintSection[]): number =>
  lintCell({ name: "seeded", regen: false, sections }, { budget: { maxDirectives: -1 } }).find((f) => f.rule === "R9" && f.budget === "directives")?.measured ?? 0;

/* ── the number ── */

test("with a limit, a generator prompt of every kind of turn has exactly one step-limit section, which provides the fact and carries the limit", () => {
  for (const turn of turns()) {
    const a = assemble(turn.over, LIMIT);
    assert.deepEqual(providersOf(a, "step-limit"), [STEP_LIMIT_SECTION_ID], turn.label);
    assert.ok(sectionText(a, STEP_LIMIT_SECTION_ID).includes(String(LIMIT)), `${turn.label}: the section carries the limit`);
    assert.ok(a.text.includes(sectionText(a, STEP_LIMIT_SECTION_ID)), `${turn.label}: and it is in the prompt`);
  }
});

test("the number follows the limit it is given", () => {
  const turn = { mode: "diff" as const };
  assert.ok(sectionText(assemble(turn, OTHER_LIMIT), STEP_LIMIT_SECTION_ID).includes(String(OTHER_LIMIT)));
  assert.equal(sectionText(assemble(turn, OTHER_LIMIT), STEP_LIMIT_SECTION_ID).includes(String(LIMIT)), false);
  assert.ok(sectionText(assemble(turn, LIMIT), STEP_LIMIT_SECTION_ID).includes(String(LIMIT)));
});

test("without a limit a generator prompt of every kind of turn has neither section, and nothing provides the fact", () => {
  for (const turn of turns()) {
    const a = assemble(turn.over);
    assert.equal(a.sectionSizes[STEP_LIMIT_SECTION_ID], undefined, turn.label);
    assert.equal(a.sectionSizes[STEP_MILESTONE_SECTION_ID], undefined, turn.label);
    assert.deepEqual(providersOf(a, "step-limit"), [], turn.label);
  }
});

test("the step-limit section is facts only: the lint, told so, finds nothing in it, and adds no finding to the cell it joins", () => {
  for (const turn of turns()) {
    const limited = lintSectionsOf(assemble(turn.over, LIMIT));
    const plain = lintSectionsOf(assemble(turn.over));
    assert.equal(limited.length - plain.length, isTestWritingTurn({ mode: turn.mode, ...turn.over }) ? 2 : 1, `${turn.label}: setup, the limit joins the cell`);
    const found = findingsOf(limited, turn.regen);
    assert.deepEqual(found, findingsOf(plain, turn.regen), `${turn.label}: the limit adds no finding`);
    assert.equal(found.some((f) => f.rule === "R6"), false, `${turn.label}: R6 reports nothing`);
  }
  assert.deepEqual(findingsOf(lintSectionsOf(assemble({}, LIMIT)), false), [], "a diff first pass is clean with it");
  assert.deepEqual(findingsOf(lintSectionsOf(assemble(FIX, LIMIT)), true), [], "so is a regeneration");
});

test("the facts-only reading is real: a directive word in the step-limit section would be reported", () => {
  const sections = lintSectionsOf(assemble({}, LIMIT)).map((s) => (s.id === STEP_LIMIT_SECTION_ID ? { ...s, text: `${s.text}\nYou must stop.` } : s));
  assert.deepEqual(findingsOf(sections, false).filter((f) => f.rule === "R6").map((f) => f.sections), [[STEP_LIMIT_SECTION_ID]]);
});

test("a limited prompt names every section it has, the statement and the milestone included: a nameless section would be a telemetry key of nothing", () => {
  for (const turn of turns()) {
    const ids = Object.keys(assemble(turn.over, LIMIT).sectionSizes);
    assert.ok(ids.includes(STEP_LIMIT_SECTION_ID), `${turn.label}: setup, the statement is a section of the prompt`);
    assert.deepEqual(ids.filter((id) => id.length === 0), [], turn.label);
  }
});

test("the limit statement and the milestone close the prompt, in that order, after everything else", () => {
  const ids = Object.keys(assemble({}, LIMIT).sectionSizes);
  assert.deepEqual(ids.slice(-2), [STEP_LIMIT_SECTION_ID, STEP_MILESTONE_SECTION_ID]);
  const idsWithoutMilestone = Object.keys(assemble({ mode: "complete" }, LIMIT).sectionSizes);
  assert.equal(idsWithoutMilestone.at(-1), STEP_LIMIT_SECTION_ID, "a turn with no milestone ends with the limit");
});

/* ── the milestone ── */

test("a turn that writes tests carries the milestone section, and every other turn carries the number alone", () => {
  for (const turn of turns()) {
    const a = assemble(turn.over, LIMIT);
    assert.equal(a.sectionSizes[STEP_MILESTONE_SECTION_ID] !== undefined, isTestWritingTurn({ mode: turn.mode, ...turn.over }), turn.label);
  }
});

test("the diff and manual first passes and every regeneration carry the milestone; the complete, exhaustive and context first passes do not", () => {
  const has = (over: Partial<OpencodeRunInput>): boolean => assemble(over, LIMIT).sectionSizes[STEP_MILESTONE_SECTION_ID] !== undefined;
  assert.equal(has({ mode: "diff" }), true);
  assert.equal(has({ mode: "manual", guidance: "cover the coupon form" }), true);
  assert.equal(has({ mode: "diff", target: "code" }), true);
  assert.equal(has({ mode: "complete", ...FIX }), true, "a regeneration of a complete run writes tests");
  assert.equal(has({ mode: "exhaustive", ...FIX }), true);
  assert.equal(has({ mode: "complete" }), false);
  assert.equal(has({ mode: "exhaustive" }), false);
  assert.equal(has({ mode: "context" }), false);
  assert.ok(assemble({ mode: "context" }, LIMIT).sectionSizes[STEP_LIMIT_SECTION_ID] !== undefined, "and each of them still states the limit");
});

test("the milestone names the midpoint of the limit the prompt states, and follows that limit", () => {
  assert.notEqual(stepMidpoint(LIMIT), stepMidpoint(OTHER_LIMIT), "setup: the two limits have different midpoints");
  for (const limit of [LIMIT, OTHER_LIMIT]) {
    const a = assemble({}, limit);
    assert.ok(sectionText(a, STEP_MILESTONE_SECTION_ID).includes(String(stepMidpoint(limit))), `limit ${limit}`);
    assert.equal(sectionText(a, STEP_MILESTONE_SECTION_ID).includes(String(limit)), false, `limit ${limit}: the milestone does not restate the limit`);
  }
  const regen = assemble(FIX, OTHER_LIMIT);
  assert.ok(sectionText(regen, STEP_MILESTONE_SECTION_ID).includes(String(stepMidpoint(OTHER_LIMIT))), "a regeneration too");
});

test("the milestone provides, frames and directs nothing the lint reads", () => {
  for (const turn of turns().filter((t) => isTestWritingTurn({ mode: t.mode, ...t.over }))) {
    const a = assemble(turn.over, LIMIT);
    assert.ok(a.sectionSizes[STEP_MILESTONE_SECTION_ID] !== undefined, `${turn.label}: setup, the milestone is in the prompt`);
    assert.equal(a.claims[STEP_MILESTONE_SECTION_ID], undefined, turn.label);
  }
});

test("two cells that differ only by the milestone differ in directive count by exactly the milestone's own count", () => {
  for (const turn of turns().filter((t) => isTestWritingTurn({ mode: t.mode, ...t.over }))) {
    const a = assemble(turn.over, LIMIT);
    const withMilestone = lintSectionsOf(a);
    const own = countDirectives(sectionText(a, STEP_MILESTONE_SECTION_ID));
    const without = withMilestone.filter((s) => s.id !== STEP_MILESTONE_SECTION_ID);
    assert.equal(withMilestone.length - without.length, 1, `${turn.label}: setup, the milestone is the one section that differs`);
    assert.equal(directivesIn(withMilestone) - directivesIn(without), own, turn.label);
  }
});

test("the lint counts a directive word of the milestone in the cell's total, as it counts one of any section that is not facts only", () => {
  const a = assemble({}, LIMIT);
  const sections = lintSectionsOf(a);
  const stern = sections.map((s) => (s.id === STEP_MILESTONE_SECTION_ID ? { ...s, text: `${s.text} You must not stop early, never.` } : s));
  assert.equal(directivesIn(stern) - directivesIn(sections), 2);
  assert.equal(findingsOf(stern, false).some((f) => f.rule === "R6"), false, "the milestone is not read as facts only");
});

test("the milestone says what its declared outcomes say: a first pass offers the first spec and the no-op, a regeneration the first correction and the reason none applies, and never the no-op", () => {
  for (const turn of turns().filter((t) => isTestWritingTurn({ mode: t.mode, ...t.over }))) {
    const text = sectionText(assemble(turn.over, LIMIT), STEP_MILESTONE_SECTION_ID);
    const declared = stepMilestone({ mode: turn.mode, ...turn.over }, LIMIT)?.outcomes;
    assert.deepEqual(declared, turn.regen ? ["first-correction", "reason-none-applies"] : ["first-spec", "no-op"], turn.label);
    for (const outcome of Object.keys(MILESTONE_OUTCOME_PHRASES) as MilestoneOutcome[]) {
      assert.equal(text.includes(MILESTONE_OUTCOME_PHRASES[outcome]), declared?.includes(outcome), `${turn.label}: ${outcome}`);
    }
  }
});

test("the milestone offers its declared outcomes in the order it declares them, each set apart from the one before it", () => {
  for (const turn of turns().filter((t) => isTestWritingTurn({ mode: t.mode, ...t.over }))) {
    const text = sectionText(assemble(turn.over, LIMIT), STEP_MILESTONE_SECTION_ID);
    const declared = stepMilestone({ mode: turn.mode, ...turn.over }, LIMIT)?.outcomes ?? [];
    let from = 0;
    for (const [index, outcome] of declared.entries()) {
      const phrase = MILESTONE_OUTCOME_PHRASES[outcome];
      const at = text.indexOf(phrase, from);
      assert.ok(at >= from, `${turn.label}: ${outcome} comes after the outcome declared before it`);
      if (index > 0) {
        const between = text.slice(from, at);
        assert.ok(between.length > 0 && !/^[\p{L}\p{N}]/u.test(between), `${turn.label}: ${outcome} is set apart from the outcome before it`);
      }
      from = at + phrase.length;
    }
    assert.ok(declared.length > 0, `${turn.label}: setup, the turn declares an outcome`);
  }
});

/* ── the explorer ── */

/* The lines under a title, up to the next title or blank line, the title first; undefined when the prompt has no such title. */
function blockUnder(text: string, heading: string): string[] | undefined {
  const lines = text.split("\n");
  const at = lines.indexOf(`## ${heading}`);
  if (at < 0) return undefined;
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((line) => line.startsWith("## ") || line.trim() === "");
  return [lines[at]!, ...(end < 0 ? rest : rest.slice(0, end))];
}

/* The two explorer prompts (a diff and a guided run), with and without the optional blocks they render. */
const EXPLORER_INPUTS: ReadonlyArray<readonly [string, Partial<OpencodeRunInput>]> = [
  ["diff", { explorer: true }],
  ["diff on a microservice", { explorer: true, service: { repo: "org/orders", mirrorDir: "/mirrors/org__orders-staged" } }],
  ["manual", { explorer: true, mode: "manual", guidance: "cover the coupon form" }],
  ["manual on a microservice", { explorer: true, mode: "manual", guidance: "cover the coupon form", service: { repo: "org/orders", mirrorDir: "/mirrors/org__orders-staged" } }],
];

test("an explorer prompt with a limit closes with a step-limit block before its output block, carrying the limit and no directive word", () => {
  for (const [label, over] of EXPLORER_INPUTS) {
    const text = buildExplorerPrompt(mkInput({ ...over, stepLimit: OTHER_LIMIT }));
    const block = blockUnder(text, PROMPT_HEADINGS.stepLimit);
    assert.ok(block, `${label}: the block is there`);
    assert.ok(block.join("\n").includes(String(OTHER_LIMIT)), `${label}: it carries the limit`);
    assert.equal(countDirectives(block.join("\n")), 0, `${label}: it holds no directive word`);
    const lines = text.split("\n");
    const outputAt = lines.findIndex((line) => line.startsWith("## Output"));
    assert.ok(outputAt > lines.indexOf(block[0]!) + block.length - 1, `${label}: it sits before the output block`);
    assert.equal(outputAt, lines.length - 1, `${label}: and the output block still closes the prompt`);
  }
});

test("an explorer prompt without a limit has no such block, and with one it gains that block and nothing else", () => {
  for (const [label, over] of EXPLORER_INPUTS) {
    const plain = buildExplorerPrompt(mkInput(over));
    const limited = buildExplorerPrompt(mkInput({ ...over, stepLimit: OTHER_LIMIT }));
    assert.equal(blockUnder(plain, PROMPT_HEADINGS.stepLimit), undefined, `${label}: no limit, no block`);
    const lines = limited.split("\n");
    const block = blockUnder(limited, PROMPT_HEADINGS.stepLimit)!;
    const at = lines.indexOf(block[0]!);
    assert.equal([...lines.slice(0, at), ...lines.slice(at + block.length + 1)].join("\n"), plain, `${label}: the rest is the prompt it had`);
    assert.equal(lines[at + block.length], "", `${label}: the block is set apart by a blank line`);
  }
});

test("the explorer states no milestone, whatever the turn: it asks for no outcome a milestone names", () => {
  for (const [label, over] of EXPLORER_INPUTS) {
    const text = buildExplorerPrompt(mkInput({ ...over, stepLimit: OTHER_LIMIT }));
    assert.ok(blockUnder(text, PROMPT_HEADINGS.stepLimit), `${label}: setup, the explorer states its limit`);
    for (const phrase of Object.values(MILESTONE_OUTCOME_PHRASES)) assert.equal(text.includes(phrase), false, `${label}: ${phrase}`);
  }
});

/* ── the reviewer ── */

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

test("a reviewer prompt with a limit has a step-limit section of its own that provides the fact, carries the limit and closes just before the verdict contract", () => {
  const a = buildReviewerPromptAssembled(mkReview({ stepLimit: 17 }));
  assert.deepEqual(providersOf(a, "step-limit"), [REVIEWER_STEP_LIMIT_SECTION_ID]);
  assert.ok(sectionText(a, REVIEWER_STEP_LIMIT_SECTION_ID).includes("17"));
  const ids = Object.keys(a.sectionSizes);
  assert.deepEqual(ids.slice(-2), [REVIEWER_STEP_LIMIT_SECTION_ID, "reviewer-output-contract"], "the verdict contract still ends the prompt");
  assert.deepEqual(ids.filter((id) => id.length === 0), [], "and no section of it is nameless");
});

test("the reviewer's step-limit section, linted as a cell of its own that may carry facts only, gives the lint nothing to report", () => {
  const a = buildReviewerPromptAssembled(mkReview({ stepLimit: 17 }));
  const section: LintSection = {
    id: REVIEWER_STEP_LIMIT_SECTION_ID,
    layer: "assembled",
    text: sectionText(a, REVIEWER_STEP_LIMIT_SECTION_ID),
    claims: a.claims[REVIEWER_STEP_LIMIT_SECTION_ID] ?? [],
    factsOnly: true,
  };
  assert.ok(section.text.length > 0, "setup: the section is in the prompt");
  assert.deepEqual(findingsOf([section], false), []);
  assert.deepEqual(findingsOf([{ ...section, text: `${section.text}\nYou must stop.` }], false).map((f) => f.rule), ["R6"], "and the lint would have said so");
});

test("a reviewer prompt without a limit has no such section, and with one it gains that section and nothing else", () => {
  const variants: ReadonlyArray<readonly [string, Partial<ReviewInput>]> = [
    ["a diff review", {}],
    ["a code review", { target: "code" }],
    ["a guided review", { mode: "manual", guidance: "cover the coupon form" }],
    ["a re-review", { priorCorrections: ["[fragile-selector] cart.spec.ts: scope the button"], domSnapshot: "heading: Cart", baseUrl: "http://localhost:3000" }],
  ];
  for (const [label, over] of variants) {
    const plain = buildReviewerPromptAssembled(mkReview(over));
    const limited = buildReviewerPromptAssembled(mkReview({ ...over, stepLimit: 17 }));
    assert.equal(plain.sectionSizes[REVIEWER_STEP_LIMIT_SECTION_ID], undefined, label);
    const { [REVIEWER_STEP_LIMIT_SECTION_ID]: added, ...rest } = limited.sectionSizes;
    assert.ok(added !== undefined && added > 0, `${label}: the section is added`);
    assert.deepEqual(rest, plain.sectionSizes, `${label}: every other section is the size it had`);
    assert.equal(limited.text.replace(`${sectionText(limited, REVIEWER_STEP_LIMIT_SECTION_ID)}\n`, ""), plain.text, `${label}: and the text is the text it had`);
  }
});
