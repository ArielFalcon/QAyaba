/* A regeneration turn is decided in one place and assembled as a correction turn: no first-pass whole-repository task, no diff re-embed, no reference to a tree that is not in the prompt. Asserted on claims, section presence and carried data, never on wording. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPromptAssembled,
  setExplorationBriefCollaborators,
  type AssembledPrompt,
} from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { PROMPT_HEADINGS } from "@contexts/generation/domain/prompt-headings.ts";
import type { PromptClaim } from "@contexts/generation/domain/prompt-contract-lint.ts";
import type { OpencodeRunInput, ExplorationBrief } from "@contexts/generation/application/ports/generation-ports.ts";

setExplorationBriefCollaborators({
  parseExplorationBrief: () => null,
  coerceExplorationBrief: () => null,
  renderExplorationBrief: (brief: ExplorationBrief) => `## ${PROMPT_HEADINGS.explorationBrief}\nObjective: ${brief.objective}`,
});

const SUBJECT = "feat(cart): SUBJECT-MARKER shows the total";
const BODY = "BODY-MARKER applies the coupon after the cart re-queries";
const CHANGED = ["src/app/cart/cart.service.ts", "src/app/cart/cart.component.ts"];
const GUIDANCE = "GUIDANCE-MARKER cover the coupon form";

function mkInput(overrides: Partial<OpencodeRunInput> = {}): OpencodeRunInput {
  return {
    repo: "org/app",
    sha: "abc1234",
    diff: "diff --git a/src/foo.ts b/src/foo.ts\n+export function foo() {}\n",
    mirrorDir: "/mirrors/org__app",
    e2eRelDir: "e2e",
    namespace: "qa-bot-abc1234",
    needsReview: false,
    target: "e2e",
    mode: "diff",
    appName: "shop",
    baseUrl: "http://localhost:3000",
    intent: { type: "feat", breaking: false, message: SUBJECT, body: BODY, changedFiles: CHANGED },
    ...overrides,
  };
}

const CONTRADICTIONS = ["button:Apply is NOT in the captured tree; present roles: button:Apply coupon"];

const claimsOf = (a: AssembledPrompt, id: string): readonly PromptClaim[] => a.claims[id] ?? [];
const directs = (a: AssembledPrompt, id: string, action: string): boolean =>
  claimsOf(a, id).some((c) => c.kind === "directs" && c.action === action);
const allClaims = (a: AssembledPrompt): PromptClaim[] => Object.values(a.claims).flat();
const provides = (a: AssembledPrompt, fact: string): boolean =>
  allClaims(a).some((c) => c.kind === "provides" && c.fact === fact);

/* ── one predicate decides regeneration ── */

test("each correction signal alone makes the turn a regeneration and a first pass is not one", () => {
  const signals: Array<Partial<OpencodeRunInput>> = [
    { fixCases: [{ name: "t", status: "fail", detail: "boom" }] },
    { reviewCorrections: ["[other] fix it"] },
    { coverageGap: "lines 1-2 were not executed" },
    { selectorContradictions: CONTRADICTIONS },
  ];
  for (const signal of signals) {
    const regen = buildPromptAssembled(mkInput(signal));
    assert.ok(regen.sectionSizes["regen-discipline"] !== undefined, `${Object.keys(signal)[0]} is a regeneration`);
    assert.equal(regen.sectionSizes["diff"], undefined, `${Object.keys(signal)[0]} does not re-embed the diff`);
  }
  const first = buildPromptAssembled(mkInput());
  assert.equal(first.sectionSizes["regen-discipline"], undefined);
  assert.ok(first.sectionSizes["diff"] !== undefined);
});

/* ── a regeneration is not the first-pass whole-repository task ── */

test("a regeneration triggered only by selector contradictions carries no whole-repository task in complete, exhaustive and manual mode", () => {
  for (const mode of ["complete", "exhaustive", "manual"] as const) {
    const first = buildPromptAssembled(mkInput({ mode, guidance: GUIDANCE }));
    const regen = buildPromptAssembled(mkInput({ mode, guidance: GUIDANCE, selectorContradictions: CONTRADICTIONS }));
    assert.ok(directs(first, "task", "analyze-repo"), `${mode}: the first pass analyzes the repository`);
    assert.equal(directs(regen, "task", "analyze-repo"), false, `${mode}: a regeneration does not`);
    assert.ok((regen.sectionSizes["task"] ?? 0) < (first.sectionSizes["task"] ?? 0), `${mode}: the regeneration task is smaller`);
  }
});

test("a regeneration keeps the acceptance-criterion instruction in every mode", () => {
  for (const mode of ["diff", "complete", "exhaustive", "manual"] as const) {
    const regen = buildPromptAssembled(mkInput({ mode, guidance: GUIDANCE, reviewCorrections: ["[other] fix it"] }));
    assert.ok(directs(regen, "task", "state-outcome"), mode);
  }
});

test("a manual regeneration keeps the guidance and a diff regeneration keeps the intent and the subject but not the body", () => {
  const manual = buildPromptAssembled(mkInput({ mode: "manual", guidance: GUIDANCE, selectorContradictions: CONTRADICTIONS }));
  assert.ok(manual.text.includes(GUIDANCE));

  const diff = buildPromptAssembled(mkInput({ selectorContradictions: CONTRADICTIONS }));
  assert.ok(diff.text.includes(SUBJECT), "the subject is kept");
  assert.ok(diff.text.includes(CHANGED[0]!), "the changed files are kept");
  assert.equal(diff.text.includes(BODY), false, "the body is not repeated");
  assert.ok(buildPromptAssembled(mkInput()).text.includes(BODY), "the first pass carries the body");
});

test("a regeneration of a cross-repo change keeps the service block", () => {
  const service = { repo: "org/orders", mirrorDir: "/mirrors/SERVICE-MARKER" };
  const regen = buildPromptAssembled(mkInput({ service, coverageGap: "lines 1-2 were not executed" }));
  assert.ok(regen.text.includes(service.mirrorDir));
});

test("a diff regeneration no longer repeats the first-pass scope budget, the regeneration discipline owns scope", () => {
  const first = buildPromptAssembled(mkInput());
  const regen = buildPromptAssembled(mkInput({ fixCases: [{ name: "t", status: "fail", detail: "boom" }] }));
  assert.ok(directs(first, "task", "orient"), "the first pass orients");
  assert.equal(directs(regen, "task", "orient"), false, "a regeneration does not");
  assert.equal(directs(regen, "task", "read"), false, "and does not send the agent to read the map again");
  assert.ok(regen.sectionSizes["regen-discipline"] !== undefined);
});

/* ── code target ── */

test("a code regeneration carries no whole-repository task, no diff, and keeps the changed files", () => {
  for (const mode of ["diff", "complete", "exhaustive", "manual"] as const) {
    const regen = buildPromptAssembled(
      mkInput({ target: "code", mode, guidance: GUIDANCE, reviewCorrections: ["[other] fix it"] }),
    );
    assert.equal(directs(regen, "task", "analyze-repo"), false, `${mode}: no whole-repository task`);
    assert.equal(provides(regen, "diff"), false, `${mode}: the diff is not re-embedded`);
    for (const file of CHANGED) assert.ok(regen.text.includes(file), `${mode}: keeps ${file}`);
  }
});

test("a code first pass still carries its task: the repository analysis in whole-repo modes and the diff in diff mode", () => {
  for (const mode of ["complete", "exhaustive", "manual"] as const) {
    assert.ok(directs(buildPromptAssembled(mkInput({ target: "code", mode, guidance: GUIDANCE })), "task", "analyze-repo"), mode);
  }
  assert.ok(provides(buildPromptAssembled(mkInput({ target: "code" })), "diff"));
});

test("a code regeneration keeps the guidance in manual mode", () => {
  const regen = buildPromptAssembled(mkInput({ target: "code", mode: "manual", guidance: GUIDANCE, coverageGap: "gap" }));
  assert.ok(regen.text.includes(GUIDANCE));
});

/* ── a regeneration never points at a tree that is not in the prompt ── */

/* Every fact a section consults must be provided by some section of the same prompt. */
function danglingConsults(a: AssembledPrompt): string[] {
  const provided = new Set(allClaims(a).flatMap((c) => (c.kind === "provides" ? [c.fact] : [])));
  return Object.entries(a.claims).flatMap(([id, claims]) =>
    claims.flatMap((c) => (c.kind === "directs" && c.action === "consult" && c.target && !provided.has(c.target) ? [`${id}->${c.target}`] : [])),
  );
}

const TREE = "  heading: Cart\n  button: Apply coupon";
const FIX = [{ name: "t", status: "fail" as const, detail: "boom" }];

test("a corrective regeneration without a captured tree refers to no tree", () => {
  const preExec = buildPromptAssembled(mkInput({ selectorContradictions: CONTRADICTIONS }));
  assert.equal(preExec.sectionSizes["dom-snapshot"], undefined);
  assert.deepEqual(danglingConsults(preExec), []);
  assert.equal(directs(preExec, "selector-contradictions", "consult"), false);
});

test("contradictions refer to the failure tree only when a failure tree is in the prompt", () => {
  const failure = buildPromptAssembled(mkInput({ selectorContradictions: CONTRADICTIONS, domSnapshot: TREE, failureSourced: true }));
  assert.ok(claimsOf(failure, "selector-contradictions").some((c) => c.kind === "directs" && c.target === "dom-failure"));
  assert.deepEqual(danglingConsults(failure), []);

  const live = buildPromptAssembled(mkInput({ selectorContradictions: CONTRADICTIONS, domSnapshot: TREE }));
  assert.equal(
    claimsOf(live, "selector-contradictions").some((c) => c.kind === "directs" && c.target === "dom-failure"),
    false,
    "a tree that is not failure-sourced is not called a failure tree",
  );
  assert.deepEqual(danglingConsults(live), []);
});

test("a failure-sourced flag without a captured tree adds no failure-tree reference to the fix section", () => {
  const regen = buildPromptAssembled(mkInput({ fixCases: FIX, failureSourced: true }));
  assert.equal(regen.sectionSizes["dom-snapshot"], undefined);
  assert.deepEqual(danglingConsults(regen), []);
  assert.equal(directs(regen, "fix-cases", "consult"), false);
});

test("the fix section consults the failure tree exactly when that tree is in the prompt", () => {
  const withTree = buildPromptAssembled(mkInput({ fixCases: FIX, failureSourced: true, domSnapshot: TREE }));
  assert.ok(directs(withTree, "fix-cases", "consult"));
  assert.deepEqual(danglingConsults(withTree), []);
});
