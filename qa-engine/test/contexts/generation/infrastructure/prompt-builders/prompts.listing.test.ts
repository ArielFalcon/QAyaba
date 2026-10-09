/* The listing of the suite in the prompt of a regeneration, the question of the outcome and the rule against weakening a test. Asserted on section ids, claims, counts of the constants the builder renders with, and carried data; never on wording. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANTI_WEAKENING_RULE,
  FIX_STEPS,
  OBJECTIVE_HEADING,
  OBJECTIVE_QUESTION,
  buildFollowupPrompt,
  buildPromptAssembled,
  setExplorationBriefCollaborators,
  type AssembledPrompt,
} from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { PROMPT_HEADINGS, ASSEMBLED_ARTIFACT_NAMES, SUITE_LISTING_LABELS } from "@contexts/generation/domain/prompt-headings.ts";
import { ARTIFACT_REFERENCES } from "@contexts/generation/domain/prompt-artifact-references.ts";
import { everyDeliveredLine, leftOutLine, PLAIN_LISTING_NOTE } from "@contexts/generation/domain/suite-listing-render.ts";
import { LISTING_MAX_DO_NOT_REWRITE, LISTING_MAX_ENTRY_CHARS, LISTING_MAX_UNNAMED_EDITABLE } from "@contexts/generation/domain/suite-listing.ts";
import { countDirectives, lintCell, type LintSection, type PromptClaim } from "@contexts/generation/domain/prompt-contract-lint.ts";
import { isTestWritingTurn } from "@contexts/generation/domain/step-limit.ts";
import { REDACTED } from "@kernel/ports/redaction.port.ts";
import type { DeliveredSpec } from "@kernel/delivered-spec.ts";
import type { QaCase } from "@kernel/qa-case.ts";
import type { OpencodeRunInput, ExplorationBrief } from "@contexts/generation/application/ports/generation-ports.ts";

setExplorationBriefCollaborators({
  parseExplorationBrief: () => null,
  coerceExplorationBrief: () => null,
  renderExplorationBrief: (brief: ExplorationBrief) => `## ${PROMPT_HEADINGS.explorationBrief}\nObjective: ${brief.objective}`,
});

const SUITE_ID = PROMPT_HEADINGS.existingSuiteManifest;
const GUIDANCE = "cover the coupon form";

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
    ...overrides,
  };
}

/* Specs this run delivered, a lead's with the objective it declared and a sidekick's by path alone; and a spec the suite had before the run, as the grounding folded it. */
const A: DeliveredSpec = { file: "flows/a.spec.ts", flow: "a flow", objective: "a objective" };
const B: DeliveredSpec = { file: "flows/b.spec.ts", flow: "b flow", objective: "b objective" };
const SIDEKICK: DeliveredSpec = { file: "flows/d.spec.ts" };
const C_LINE = "flows/c.spec.ts — flow: c flow, objective: c objective";
const failing = (file?: string, detail = "boom") => ({ name: "a failing test", status: "fail" as const, detail, ...(file !== undefined ? { file } : {}) });

const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

function sectionText(a: AssembledPrompt, id: string): string {
  const bytes = Buffer.from(a.text, "utf8");
  let offset = 0;
  for (const [sectionId, size] of Object.entries(a.sectionSizes)) {
    if (sectionId === id) return bytes.subarray(offset, offset + size).toString("utf8");
    offset += size + 1;
  }
  return "";
}

/* The lines under a label, up to the next label or the end of the section. */
function groupUnder(section: string, label: string, nextLabels: readonly string[]): string[] {
  const lines = section.split("\n");
  const from = lines.indexOf(label);
  if (from < 0) return [];
  const rest = lines.slice(from + 1);
  const end = rest.findIndex((line) => nextLabels.includes(line));
  return (end < 0 ? rest : rest.slice(0, end)).filter((line) => line.startsWith("- "));
}
const editableIn = (section: string): string[] => groupUnder(section, SUITE_LISTING_LABELS.editable, [SUITE_LISTING_LABELS.doNotRewrite]);
const doNotRewriteIn = (section: string): string[] => groupUnder(section, SUITE_LISTING_LABELS.doNotRewrite, [SUITE_LISTING_LABELS.editable]);
const mentions = (lines: readonly string[], file: string): boolean => lines.some((line) => line.includes(file));

const lintSectionsOf = (a: AssembledPrompt): LintSection[] =>
  Object.keys(a.sectionSizes).map((id) => ({
    id,
    layer: "assembled" as const,
    text: sectionText(a, id),
    claims: a.claims[id] ?? [],
    ...(id === "diff" ? { verbatim: true } : {}),
  }));
const findingsOf = (a: AssembledPrompt, regen: boolean) =>
  lintCell({ name: "seeded", regen, sections: lintSectionsOf(a) }, { assembledArtifactNames: ASSEMBLED_ARTIFACT_NAMES, artifactReferences: ARTIFACT_REFERENCES });
const directs = (a: AssembledPrompt, id: string, action: string, target?: string): boolean =>
  (a.claims[id] ?? []).some((c: PromptClaim) => c.kind === "directs" && c.action === action && (target === undefined || c.target === target));

/* ── the listing of a regeneration ── */

test("a FixLoop turn lists the specs of the run and of the suite: the ones that failed are editable, the one that passed is not", () => {
  const a = buildPromptAssembled(mkInput({ existingSpecFiles: [C_LINE], deliveredSpecs: [A, B], fixCases: [failing("flows/a.spec.ts"), failing("flows/c.spec.ts")] }));
  const section = sectionText(a, SUITE_ID);
  assert.ok(mentions(editableIn(section), "flows/a.spec.ts"));
  assert.ok(mentions(editableIn(section), "flows/c.spec.ts"), "a spec the suite had before the run is editable when it failed");
  assert.equal(mentions(editableIn(section), "flows/b.spec.ts"), false);
  assert.ok(mentions(doNotRewriteIn(section), "flows/b.spec.ts"), "the spec that passed is left as it is");
  assert.deepEqual(a.claims[SUITE_ID], [{ kind: "provides", fact: "existing-suite" }]);
});

test("the editable label is the one place a regeneration is told to read the specs it changes, and the fix section no longer has its own read step", () => {
  const signals: Array<[string, Partial<OpencodeRunInput>]> = [
    ["a FixLoop turn", { fixCases: [failing("flows/a.spec.ts")] }],
    ["a reviewer correction", { reviewCorrections: ["flows/a.spec.ts: weak assertion"] }],
    ["a coverage gap", { coverageGap: "src/cart.ts: lines 10-14" }],
    ["a selector contradiction", { selectorContradictions: ["button:Apply is NOT in the captured tree"], attributedSpecFiles: ["flows/a.spec.ts"] }],
  ];
  for (const target of ["e2e", "code"] as const) {
    for (const [what, signal] of signals) {
      const a = buildPromptAssembled(mkInput({ target, deliveredSpecs: [A, B], ...signal }));
      assert.equal(countOf(a.text, SUITE_LISTING_LABELS.editable), 1, `${target}, ${what}: one read directive for the specs to change`);
      assert.equal(countOf(a.text, FIX_STEPS.readTestFile), 0, `${target}, ${what}: no read step beside it`);
    }
  }
});

test("a contradiction that names no spec never widens a FixLoop turn that has a failing file", () => {
  const a = buildPromptAssembled(
    mkInput({ deliveredSpecs: [A, B], fixCases: [failing("flows/a.spec.ts")], selectorContradictions: ["a selector the page does not have"], attributedSpecFiles: ["flows/b.spec.ts"] }),
  );
  const section = sectionText(a, SUITE_ID);
  assert.equal(editableIn(section).length, 1);
  assert.ok(mentions(editableIn(section), "flows/a.spec.ts"));
});

/* A fix turn tells the agent to fix only the tests that failed and to leave alone the ones that passed, so its listing must invite the edit of no spec that passed. */
const staticGate = (detail: string): QaCase => ({ name: "static-gate", status: "fail", detail });

test("a fix turn lists as editable only the specs its failing cases name: none that passed, whatever the cases carry and whatever else the run delivered", () => {
  const fixes: Array<[string, QaCase[], string[]]> = [
    ["a failing file", [failing("flows/a.spec.ts")], ["flows/a.spec.ts"]],
    ["two failing files", [failing("flows/a.spec.ts"), failing("flows/c.spec.ts")], ["flows/a.spec.ts", "flows/c.spec.ts"]],
    ["an error text that names a spec", [failing(undefined, "flows/a.spec.ts › checkout works")], ["flows/a.spec.ts"]],
    ["an error text that names none", [failing(undefined, "the page timed out")], []],
    ["no file and no error text", [{ name: "a failing test", status: "fail" }], []],
    ["a static gate whose output names a spec", [staticGate("e2e/flows/a.spec.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.")], ["flows/a.spec.ts"]],
    ["a static gate whose output names none", [staticGate("error TS2322: Type 'string' is not assignable to type 'number'.")], []],
  ];
  const everySpec = ["flows/a.spec.ts", "flows/b.spec.ts", "flows/c.spec.ts", "flows/d.spec.ts"];
  for (const target of ["e2e", "code"] as const) {
    for (const mode of ["diff", "manual", "exhaustive"] as const) {
      for (const [what, fixCases, editable] of fixes) {
        const label = `${target}, ${mode}, ${what}`;
        const a = buildPromptAssembled(mkInput({ target, mode, guidance: GUIDANCE, existingSpecFiles: [C_LINE], deliveredSpecs: [A, B, SIDEKICK], fixCases }));
        assert.ok(a.sectionSizes["fix-cases"] !== undefined, `${label}: setup, the turn tells the agent to fix only the failing tests`);
        const listed = editableIn(sectionText(a, SUITE_ID));
        for (const file of everySpec) assert.equal(mentions(listed, file), editable.includes(file), `${label}: ${file}`);
        assert.equal(listed.length, editable.length, label);
        assert.equal(countOf(a.text, SUITE_LISTING_LABELS.editable), editable.length > 0 ? 1 : 0, label);
      }
    }
  }
});

test("a corrective regeneration makes editable the specs the checks attributed the contradictions to, and no other", () => {
  const a = buildPromptAssembled(mkInput({ deliveredSpecs: [A, B], selectorContradictions: ["button:Apply is NOT in the captured tree"], attributedSpecFiles: ["flows/b.spec.ts"] }));
  const section = sectionText(a, SUITE_ID);
  assert.equal(editableIn(section).length, 1);
  assert.ok(mentions(editableIn(section), "flows/b.spec.ts"));
  assert.ok(mentions(doNotRewriteIn(section), "flows/a.spec.ts"));
});

test("a reviewer correction that names only the basename of a carried spec makes that entry editable", () => {
  const a = buildPromptAssembled(mkInput({ deliveredSpecs: [{ file: "x/a.spec.ts", objective: "an objective" }, B], reviewCorrections: ["a.spec.ts: assert the discounted total"] }));
  const section = sectionText(a, SUITE_ID);
  assert.ok(mentions(editableIn(section), "x/a.spec.ts"));
  assert.equal(mentions(editableIn(section), "flows/b.spec.ts"), false);
});

test("a coverage regeneration makes every spec the run delivered editable and the suite's own do-not-rewrite", () => {
  const a = buildPromptAssembled(mkInput({ existingSpecFiles: [C_LINE], deliveredSpecs: [A, B], coverageGap: "src/cart.ts: lines 10-14" }));
  const section = sectionText(a, SUITE_ID);
  assert.ok(mentions(editableIn(section), "flows/a.spec.ts") && mentions(editableIn(section), "flows/b.spec.ts"));
  assert.ok(mentions(doNotRewriteIn(section), "flows/c.spec.ts"));
});

test("a sidekick's spec is listed by its path alone, and a lead's keeps the flow and objective it declared", () => {
  const a = buildPromptAssembled(mkInput({ deliveredSpecs: [A, SIDEKICK], coverageGap: "src/cart.ts: lines 10-14" }));
  const lines = editableIn(sectionText(a, SUITE_ID));
  assert.ok(lines.some((line) => line.includes(A.flow!) && line.includes(A.objective!)));
  assert.deepEqual(lines.filter((line) => line.includes(SIDEKICK.file)), [`- ${SIDEKICK.file}`]);
});

test("an exhaustive regeneration lists at most the cap of do-not-rewrite entries, states how many it left out and lists every editable entry", () => {
  const total = LISTING_MAX_DO_NOT_REWRITE + 6;
  const delivered = Array.from({ length: total }, (_, index): DeliveredSpec => ({ file: `flows/s${String(index).padStart(3, "0")}.spec.ts`, objective: "an objective" }));
  const a = buildPromptAssembled(mkInput({ mode: "exhaustive", deliveredSpecs: delivered, fixCases: [failing("flows/s000.spec.ts"), failing("flows/s001.spec.ts")] }));
  const section = sectionText(a, SUITE_ID);
  assert.equal(editableIn(section).length, 2);
  assert.equal(doNotRewriteIn(section).length, LISTING_MAX_DO_NOT_REWRITE);
  assert.equal(countOf(section, leftOutLine(total - 2 - LISTING_MAX_DO_NOT_REWRITE)), 1);
  assert.deepEqual(findingsOf(a, true), []);
});

test("a turn with nothing editable keeps the plain list of the suite, the way the first pass writes it", () => {
  const lines = ["flows/cart.spec.ts", "flows/login.spec.ts — flow: login, objective: the user signs in"];
  const expected = [`## ${SUITE_ID} (2 spec file(s)${PLAIN_LISTING_NOTE})`, ...lines.map((line) => `- ${line}`)].join("\n");
  assert.equal(sectionText(buildPromptAssembled(mkInput({ existingSpecFiles: lines })), SUITE_ID), expected, "a first pass");
  const regen = buildPromptAssembled(mkInput({ existingSpecFiles: lines, fixCases: [failing(undefined, "error TS2322")] }));
  assert.equal(sectionText(regen, SUITE_ID), expected, "a regeneration whose error names no spec of a run that delivered none");
  assert.equal(countOf(regen.text, SUITE_LISTING_LABELS.editable), 0);
  assert.equal(countOf(regen.text, FIX_STEPS.readTestFile), 1, "with no editable header the fix section keeps its own read step");
});

test("a run that lists no spec renders no listing section, even on a regeneration that names none; a failing file is listed as an editable entry of its own", () => {
  assert.equal(buildPromptAssembled(mkInput()).sectionSizes[SUITE_ID], undefined);
  const bare = buildPromptAssembled(mkInput({ reviewCorrections: ["the checkout flow asserts nothing"] }));
  assert.equal(bare.sectionSizes[SUITE_ID], undefined, "no spec to name, none delivered, none in the suite");
  const named = buildPromptAssembled(mkInput({ fixCases: [failing("flows/a.spec.ts")] }));
  assert.ok(mentions(editableIn(sectionText(named, SUITE_ID)), "flows/a.spec.ts"));
});

test("complete and exhaustive first passes list no suite, and context mode never does, whatever the input carries", () => {
  for (const mode of ["complete", "exhaustive", "context"] as const) {
    const a = buildPromptAssembled(mkInput({ mode, existingSpecFiles: [C_LINE] }));
    assert.equal(a.sectionSizes[SUITE_ID], undefined, mode);
  }
  const context = buildPromptAssembled(mkInput({ mode: "context", existingSpecFiles: [C_LINE], deliveredSpecs: [A], fixCases: [failing("flows/a.spec.ts")] }));
  assert.equal(context.sectionSizes[SUITE_ID], undefined, "a context run, even handed the signals of a regeneration");
});

test("no spec source is inlined and the paths of the listing are not provided paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-listing-"));
  try {
    mkdirSync(join(dir, "e2e", "flows"), { recursive: true });
    writeFileSync(join(dir, "e2e", "flows", "a.spec.ts"), "const SOURCE_MARKER = 1;");
    const a = buildPromptAssembled(mkInput({ mirrorDir: dir, deliveredSpecs: [A, B], fixCases: [failing("flows/a.spec.ts")] }));
    assert.equal(a.text.includes("SOURCE_MARKER"), false);
    assert.deepEqual((a.providedPaths ?? []).filter((path) => path.includes("a.spec.ts") || path.includes("b.spec.ts")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── what reaches the prompt is sanitized ── */

const SECRET = "sk_live_a1b2c3d4e5f6g7h8i9j0";

test("the text of every entry is sanitized, the first pass's included", () => {
  const first = buildPromptAssembled(mkInput({ existingSpecFiles: [`flows/pay.spec.ts — flow: pay, objective: use ${SECRET} to pay`] }));
  assert.equal(sectionText(first, SUITE_ID).includes(SECRET), false);
  assert.ok(sectionText(first, SUITE_ID).includes(REDACTED));
  const regen = buildPromptAssembled(mkInput({ deliveredSpecs: [{ file: "flows/pay.spec.ts", objective: `use ${SECRET} to pay` }], fixCases: [failing("flows/pay.spec.ts")] }));
  assert.equal(regen.text.includes(SECRET), false);
  assert.ok(sectionText(regen, SUITE_ID).includes(REDACTED));
});

test("an entry is redacted the way model-bound text is: the shapes of prose and code about a password are left, a literal one is not", () => {
  const delivered = [{ file: "flows/login.spec.ts", objective: `the password: string field rejects an empty value, and password: "${SECRET}" is never shown` }];
  const section = sectionText(buildPromptAssembled(mkInput({ deliveredSpecs: delivered, fixCases: [failing("flows/login.spec.ts")] })), SUITE_ID);
  assert.ok(section.includes("password: string"), "a type annotation is not a secret");
  assert.equal(section.includes(SECRET), false);
  assert.ok(section.includes(REDACTED));
});

test("an entry is one line of at most the cap: what the agent wrote with a line break or at length is folded and cut", () => {
  const long = "x".repeat(LISTING_MAX_ENTRY_CHARS * 2);
  const a = buildPromptAssembled(mkInput({ existingSpecFiles: ["flows/a.spec.ts — flow: a\nflow, objective: b", `flows/b.spec.ts — objective: ${long}`] }));
  const lines = sectionText(a, SUITE_ID).split("\n").slice(1);
  assert.equal(lines.length, 2, "a line break inside an entry does not start another line");
  assert.ok(lines.every((line) => line.startsWith("- ") && [...line].length <= LISTING_MAX_ENTRY_CHARS + 2));
});

/* The cases of a fix come out of the test run, not out of the harness: what a case reports crosses the model boundary like any other text from a run. */
const FAILED_CASE: QaCase = {
  name: "a failing test",
  status: "fail",
  detail: "boom",
  file: "flows/a.spec.ts",
  httpStatus: 500,
  finalUrl: "https://dev.example.com/pay",
  runtimeErrors: [{ type: "pageerror", text: "TypeError: cannot read properties of undefined" }],
};
const builders: Array<[string, (fixCases: QaCase[]) => string]> = [
  ["the fix section of the prompt", (fixCases) => buildPromptAssembled(mkInput({ deliveredSpecs: [A], fixCases })).text],
  ["the continuation prompt", (fixCases) => buildFollowupPrompt(mkInput({ fixCases }))],
];

test("what a failing case reports is redacted before it reaches the prompt: its name, its error, the page it ended on and the errors the page raised", () => {
  const leaking: Array<[string, Partial<QaCase>]> = [
    ["name", { name: `pays with ${SECRET}` }],
    ["error", { detail: `Error: expected ${SECRET} to be hidden` }],
    ["final URL", { finalUrl: `https://dev.example.com/pay?token=${SECRET}` }],
    ["runtime error", { runtimeErrors: [{ type: "pageerror", text: `TypeError at ${SECRET}` }] }],
  ];
  for (const [where, build] of builders) {
    assert.equal(build([FAILED_CASE]).includes(REDACTED), false, `setup: ${where} carries no secret to redact`);
    for (const [field, overrides] of leaking) {
      const text = build([{ ...FAILED_CASE, ...overrides }]);
      assert.equal(text.includes(SECRET), false, `${where}, ${field}`);
      assert.ok(text.includes(REDACTED), `${where}, ${field}: redacted, not dropped`);
    }
  }
});

test("a failing case's error and runtime errors are redacted before they are cut, so a secret at the cut is never left in part", () => {
  /* A key the redaction knows only whole (a prefix of it is not one), which starts ten characters before the limit of the error and of each runtime error. The filler is words, so that the key is not part of one long token. */
  const AWS_ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE";
  const cut: Array<[string, Partial<QaCase>]> = [
    ["error", { detail: `${"y ".repeat(245)}${AWS_ACCESS_KEY}` }],
    ["runtime error", { runtimeErrors: [{ type: "pageerror", text: `${"z ".repeat(95)}${AWS_ACCESS_KEY}` }] }],
  ];
  for (const [where, build] of builders) {
    assert.ok(build([{ ...FAILED_CASE, detail: AWS_ACCESS_KEY }]).includes(REDACTED), `${where}: setup, the key is redacted whole`);
    for (const [field, overrides] of cut) {
      const text = build([{ ...FAILED_CASE, ...overrides }]);
      assert.equal(text.includes("AKIA"), false, `${where}, ${field}`);
      assert.ok(text.includes(REDACTED), `${where}, ${field}: redacted, not dropped`);
    }
  }
});

test("a failing case that reports no error text is listed, and not as one whose error is empty", () => {
  for (const [where, build] of builders) {
    const missing = build([{ ...FAILED_CASE, detail: undefined }]);
    assert.ok(missing.includes(FAILED_CASE.name), where);
    assert.notEqual(missing, build([{ ...FAILED_CASE, detail: "" }]), `${where}: a missing error text is not an empty one`);
  }
});

test("a failing case is still shown as it was reported once there is nothing to redact: the error cut at its limit, the page, the status and the errors the page raised", () => {
  const detail = "Error: expected 'Total: 10' but received 'Total: 12'";
  for (const [where, build] of builders) {
    const text = build([{ ...FAILED_CASE, name: "cart applies a coupon", detail: `${detail}${"!".repeat(600)}` }]);
    assert.ok(text.includes("cart applies a coupon"), where);
    assert.ok(text.includes(`${detail}${"!".repeat(500 - detail.length)}`) && !text.includes(`${detail}${"!".repeat(501 - detail.length)}`), `${where}: the error is cut at 500 characters`);
    for (const carried of ["500", "https://dev.example.com/pay", "pageerror", "TypeError: cannot read properties of undefined"]) assert.ok(text.includes(carried), `${where}: ${carried}`);
  }
});

/* ── the question of the outcome and the rule against weakening a test ── */

const TURN_SIGNALS: Array<[string, Partial<OpencodeRunInput>]> = [
  ["a failing case", { fixCases: [failing("flows/a.spec.ts")] }],
  ["a reviewer correction", { reviewCorrections: ["flows/a.spec.ts: weak assertion"] }],
  ["a coverage gap", { coverageGap: "src/cart.ts: lines 10-14" }],
  ["a selector contradiction", { selectorContradictions: ["button:Apply is NOT in the captured tree"] }],
];

test("the rule against weakening a test is on every turn that writes tests, once, in both targets, and on no other", () => {
  const first: Array<[string, Partial<OpencodeRunInput>, number]> = [
    ["a diff run", {}, 1],
    ["a manual run", { mode: "manual", guidance: GUIDANCE }, 1],
    ["a complete run", { mode: "complete" }, 0],
    ["an exhaustive run", { mode: "exhaustive" }, 0],
    ["a context run", { mode: "context" }, 0],
  ];
  for (const target of ["e2e", "code"] as const) {
    for (const [what, extra, expected] of first) {
      if (target === "code" && extra.mode === "context") continue;
      const a = buildPromptAssembled(mkInput({ target, ...extra }));
      assert.equal(countOf(a.text, ANTI_WEAKENING_RULE), expected, `${target}, first pass of ${what}`);
    }
    for (const mode of ["diff", "manual", "complete", "exhaustive"] as const) {
      for (const [what, signal] of TURN_SIGNALS) {
        const a = buildPromptAssembled(mkInput({ target, mode, guidance: GUIDANCE, deliveredSpecs: [A], ...signal }));
        assert.equal(countOf(a.text, ANTI_WEAKENING_RULE), 1, `${target}, ${mode} regeneration with ${what}`);
        assert.equal(countOf(sectionText(a, "task"), ANTI_WEAKENING_RULE), 1, `${target}, ${mode} regeneration with ${what}: the task owns it`);
      }
    }
  }
});

test("the rule against weakening a test is on exactly the turns the domain says write tests, in every mode and target", () => {
  const signals: Array<Partial<OpencodeRunInput>> = [{}, ...TURN_SIGNALS.map(([, signal]) => signal)];
  for (const target of ["e2e", "code"] as const) {
    for (const mode of ["diff", "manual", "complete", "exhaustive", "context"] as const) {
      if (mode === "context" && target === "code") continue;
      for (const signal of signals) {
        const input = mkInput({ target, mode, guidance: GUIDANCE, deliveredSpecs: [A], ...signal });
        const expected = isTestWritingTurn(input) ? 1 : 0;
        assert.equal(countOf(buildPromptAssembled(input).text, ANTI_WEAKENING_RULE), expected, `${target}, ${mode}, ${Object.keys(signal).join("+") || "first pass"}`);
      }
    }
  }
});

test("the first pass of a diff or manual e2e run, and of a manual code run, asks for the outcome; a code diff run's first pass does not", () => {
  const asks: Array<[string, Partial<OpencodeRunInput>, boolean]> = [
    ["e2e diff", {}, true],
    ["e2e manual", { mode: "manual", guidance: GUIDANCE }, true],
    ["code manual", { target: "code", mode: "manual", guidance: GUIDANCE }, true],
    ["code diff", { target: "code" }, false],
    ["e2e complete", { mode: "complete" }, false],
    ["code exhaustive", { target: "code", mode: "exhaustive" }, false],
  ];
  for (const [what, extra, asked] of asks) {
    const a = buildPromptAssembled(mkInput(extra));
    assert.equal(countOf(a.text, OBJECTIVE_QUESTION), asked ? 1 : 0, what);
    assert.equal(countOf(a.text, OBJECTIVE_HEADING), asked ? 1 : 0, `${what}: the heading goes with the question`);
    assert.equal(directs(a, "task", "state-outcome"), asked, `${what}: the claim goes with the question`);
  }
});

test("a regeneration whose specs under correction all have an objective their lead declared, undisputed, does not ask for the outcome again, and still states the rule", () => {
  for (const target of ["e2e", "code"] as const) {
    for (const [what, signal] of TURN_SIGNALS) {
      const a = buildPromptAssembled(mkInput({ target, deliveredSpecs: [A, B], ...signal }));
      assert.equal(countOf(a.text, OBJECTIVE_QUESTION), 0, `${target}, ${what}`);
      assert.equal(countOf(a.text, OBJECTIVE_HEADING), 0, `${target}, ${what}: no heading without the question`);
      assert.equal(directs(a, "task", "state-outcome"), false, `${target}, ${what}`);
      assert.equal(countOf(a.text, ANTI_WEAKENING_RULE), 1, `${target}, ${what}`);
    }
  }
});

test("a regeneration asks for the outcome again when a spec under correction has none declared, was in the suite, or is flagged, and when none is under correction", () => {
  const asked: Array<[string, Partial<OpencodeRunInput>]> = [
    ["a spec the suite had before the run", { existingSpecFiles: [C_LINE], deliveredSpecs: [A], fixCases: [failing("flows/c.spec.ts")] }],
    ["a sidekick's spec", { deliveredSpecs: [A, SIDEKICK], fixCases: [failing("flows/d.spec.ts")] }],
    ["a spec flagged with the wrong objective", { deliveredSpecs: [A], reviewCorrections: ["[wrong-objective] flows/a.spec.ts: tests an unrelated flow"] }],
    ["a spec flagged as a false positive", { deliveredSpecs: [A], reviewCorrections: ["[false-positive] flows/a.spec.ts: asserts nothing"] }],
    ["a failing file no entry matches", { deliveredSpecs: [A], fixCases: [failing("flows/new.spec.ts")] }],
    ["no spec under correction", { fixCases: [failing(undefined, "the page timed out")] }],
  ];
  for (const target of ["e2e", "code"] as const) {
    for (const [what, signal] of asked) {
      const a = buildPromptAssembled(mkInput({ target, ...signal }));
      assert.equal(countOf(a.text, OBJECTIVE_QUESTION), 1, `${target}, ${what}`);
      assert.equal(directs(a, "task", "state-outcome"), true, `${target}, ${what}`);
      assert.equal(countOf(a.text, ANTI_WEAKENING_RULE), 1, `${target}, ${what}`);
    }
  }
});

test("the rule against weakening a test is stated by the task alone: the fix section keeps its steps and no restatement of it", () => {
  const a = buildPromptAssembled(mkInput({ deliveredSpecs: [A], fixCases: [failing("flows/a.spec.ts")] }));
  assert.equal(countOf(sectionText(a, "fix-cases"), ANTI_WEAKENING_RULE), 0);
  assert.equal(countOf(sectionText(a, "fix-cases"), FIX_STEPS.changeOnlyWhatIsBroken), 1);
});

/* ── the specs only the fallback made editable, and the allowance of a new spec ── */

test("a coverage regeneration states once, in its listing, that a new spec is allowed for a flow nothing listed covers, and no other turn does", () => {
  for (const target of ["e2e", "code"] as const) {
    for (const mode of ["diff", "manual", "complete", "exhaustive"] as const) {
      const a = buildPromptAssembled(mkInput({ target, mode, guidance: GUIDANCE, existingSpecFiles: [C_LINE], deliveredSpecs: [A, B], coverageGap: "src/cart.ts: lines 10-14" }));
      assert.equal(countOf(a.text, SUITE_LISTING_LABELS.newSpec), 1, `${target}, ${mode}`);
      assert.equal(countOf(sectionText(a, SUITE_ID), SUITE_LISTING_LABELS.newSpec), 1, `${target}, ${mode}: the listing owns it, so it goes with the listing`);
      for (const [what, signal] of TURN_SIGNALS) {
        if (signal.coverageGap !== undefined) continue;
        const other = buildPromptAssembled(mkInput({ target, mode, guidance: GUIDANCE, existingSpecFiles: [C_LINE], deliveredSpecs: [A, B], ...signal }));
        assert.equal(countOf(other.text, SUITE_LISTING_LABELS.newSpec), 0, `${target}, ${mode}, ${what}`);
      }
    }
  }
});

test("a first pass and a coverage turn that has nothing editable say nothing of a new spec", () => {
  assert.equal(countOf(buildPromptAssembled(mkInput({ existingSpecFiles: [C_LINE] })).text, SUITE_LISTING_LABELS.newSpec), 0, "a first pass");
  const bare = buildPromptAssembled(mkInput({ existingSpecFiles: [C_LINE], coverageGap: "src/cart.ts: lines 10-14" }));
  assert.equal(countOf(bare.text, SUITE_LISTING_LABELS.newSpec), 0, "a coverage turn of a run that delivered nothing keeps the plain list");
});

test("the lines the listing adds for the specs only the fallback made editable and for a new spec carry no directive, so they add nothing to the directive budget", () => {
  assert.equal(countDirectives(SUITE_LISTING_LABELS.newSpec), 0);
  assert.equal(countDirectives(everyDeliveredLine(LISTING_MAX_UNNAMED_EDITABLE)), 0);
});

test("a turn that could not say which spec to change lists every spec the run delivered under one summary, the first ones up to the cap, and counts the rest", () => {
  const delivered = Array.from({ length: LISTING_MAX_UNNAMED_EDITABLE + 9 }, (_, index): DeliveredSpec => ({ file: `flows/m${String(index).padStart(3, "0")}.spec.ts`, flow: `flow ${index}`, objective: `objective ${index}` }));
  const unsure: Array<[string, Partial<OpencodeRunInput>]> = [
    ["a coverage gap", { coverageGap: "src/cart.ts: lines 10-14" }],
    ["a correction that names no spec", { reviewCorrections: ["the checkout flow asserts nothing"] }],
    ["a contradiction attributed to none", { selectorContradictions: ["a selector the page does not have"] }],
  ];
  for (const [what, signal] of unsure) {
    const a = buildPromptAssembled(mkInput({ existingSpecFiles: [C_LINE], deliveredSpecs: delivered, ...signal }));
    const section = sectionText(a, SUITE_ID);
    const lines = section.split("\n");
    assert.equal(countOf(section, everyDeliveredLine(delivered.length)), 1, `${what}: one summary`);
    assert.equal(editableIn(section).length, LISTING_MAX_UNNAMED_EDITABLE, `${what}: the cap's worth`);
    assert.equal(countOf(section, leftOutLine(9)), 1, `${what}: the rest counted`);
    assert.ok(lines.indexOf(everyDeliveredLine(delivered.length)) < lines.indexOf(SUITE_LISTING_LABELS.doNotRewrite), `${what}: the summary is in the editable group`);
    assert.deepEqual(findingsOf(a, true), [], what);
  }
});

/* ── the steps of a fix ── */

const stepNumbers = (section: string): number[] => section.split("\n").flatMap((line) => (/^(\d+)\. /.exec(line)?.[1] ? [Number(/^(\d+)\. /.exec(line)![1])] : []));

/* A fix whose failing file the listing marks editable, and one whose error names no spec of a run that listed none: the first has the editable label to read the tests by, the second keeps a read step of its own. */
const FIX_WITH_EDITABLE: Partial<OpencodeRunInput> = { deliveredSpecs: [A], fixCases: [failing("flows/a.spec.ts")] };
const FIX_WITHOUT_EDITABLE: Partial<OpencodeRunInput> = { fixCases: [failing(undefined, "boom")] };

test("the steps of a fix are numbered from one without a gap, with or without the read step, in every branch", () => {
  const branches: Array<[string, Partial<OpencodeRunInput>]> = [
    ["a failure tree", { domSnapshot: "  button: Apply coupon", failureSourced: true }],
    ["a live tree", { domSnapshot: "  button: Apply coupon" }],
    ["no tree", {}],
    ["a code run", { target: "code" }],
  ];
  for (const [what, extra] of branches) {
    for (const [variant, fix] of [["editable", FIX_WITH_EDITABLE], ["not editable", FIX_WITHOUT_EDITABLE]] as const) {
      const section = sectionText(buildPromptAssembled(mkInput({ ...fix, ...extra })), "fix-cases");
      const numbers = stepNumbers(section);
      assert.deepEqual(numbers, numbers.map((_, index) => index + 1), `${what}, ${variant}: consecutive`);
      assert.ok(numbers.length >= 3, `${what}, ${variant}: the steps are there`);
      assert.equal(countOf(section, FIX_STEPS.changeOnlyWhatIsBroken), 1, `${what}, ${variant}: the last step`);
      assert.equal(countOf(section, FIX_STEPS.readTestFile), variant === "editable" ? 0 : 1, `${what}, ${variant}: the read step is there when the listing does not carry the read`);
    }
  }
});

test("a code fix keeps the read of the code under test whether or not the listing carries the read of the tests", () => {
  for (const fix of [FIX_WITH_EDITABLE, FIX_WITHOUT_EDITABLE]) {
    const a = buildPromptAssembled(mkInput({ target: "code", ...fix }));
    assert.equal(countOf(sectionText(a, "fix-cases"), FIX_STEPS.readCodeUnderTest), 1);
  }
  const e2e = buildPromptAssembled(mkInput(FIX_WITH_EDITABLE));
  assert.equal(countOf(e2e.text, FIX_STEPS.readCodeUnderTest), 0, "an e2e run reads no code under test");
});

/* ── the listing is never shed silently ── */

const withoutBudget = { budgetBytes: 0 } as const;

/* The assembler says so on the console each time it sheds; these tests shed on purpose. */
function quietly<T>(run: () => T): T {
  const original = console.warn;
  console.warn = () => {};
  try {
    return run();
  } finally {
    console.warn = original;
  }
}

/* The room the read-the-suite lines of a task need once no listing supplies the suite. */
const ROOM_FOR_THE_READ = 400;

test("a first pass whose listing the byte budget sheds is sent to read the suite instead, and the lint stays clean", () => {
  const lines = Array.from({ length: 20 }, (_, index) => `flows/f${index}.spec.ts — flow: f${index}, objective: o${index}`);
  const variants: Array<Partial<OpencodeRunInput>> = [{}, { mode: "manual", guidance: GUIDANCE, e2eRelDir: "qa-suite" }];
  for (const extra of variants) {
    const input = mkInput({ existingSpecFiles: lines, ...extra });
    const whole = buildPromptAssembled(input, withoutBudget);
    assert.equal(directs(whole, "task", "read", "existing-suite"), false, "kept: the listing supplies the suite");
    const listing = whole.sectionSizes[SUITE_ID] ?? 0;
    assert.ok(listing > ROOM_FOR_THE_READ, "setup: the listing is larger than the room the read needs");
    const budgetBytes = Buffer.byteLength(whole.text, "utf8") - listing - 1 + ROOM_FOR_THE_READ;
    const shed = quietly(() => buildPromptAssembled(input, { budgetBytes }));
    assert.equal(shed.sectionSizes[SUITE_ID], undefined, "setup: the byte budget sheds the listing");
    assert.equal(directs(shed, "task", "read", "existing-suite"), true, "shed: the task reads the suite");
    assert.deepEqual(Object.keys(shed.sectionSizes), Object.keys(whole.sectionSizes).filter((id) => id !== SUITE_ID), "nothing else is lost to the read");
    assert.ok(shed.text.split("\n").at(-1)!.includes(SUITE_ID), "the budget notice names the section");
    assert.deepEqual(findingsOf(shed, false), []);
    assert.ok((shed.sectionSizes["task"] ?? 0) > (whole.sectionSizes["task"] ?? 0), "the task says more once the listing is gone");
  }
});

/* The sections of a regeneration that the byte budget sheds before it sheds anything of the suite's: the failure and its evidence. */
const VOLATILE_SECTIONS = ["dom-snapshot", "selector-contradictions", "fix-cases", "reviewer-corrections", "learned-rules"] as const;

test("a regeneration keeps its listing until every volatile section is gone, and the listing comes before the failure it is about", () => {
  const corrections = Array.from({ length: 40 }, (_, index) => `flows/a.spec.ts: correction ${index} with enough words to take room in the prompt`);
  const input = mkInput({
    deliveredSpecs: [A, B],
    existingSpecFiles: [C_LINE],
    fixCases: [failing("flows/a.spec.ts")],
    reviewCorrections: corrections,
    selectorContradictions: ["button:Apply is NOT in the captured tree"],
    learnedRules: "## Learned rules\n- scope the coupon button to the cart form",
    domSnapshot: "  button: Apply coupon",
    failureSourced: true,
  });
  const whole = buildPromptAssembled(input, withoutBudget);
  const order = Object.keys(whole.sectionSizes);
  for (const id of VOLATILE_SECTIONS) {
    assert.ok(whole.sectionSizes[id] !== undefined, `setup: the turn carries ${id}`);
    assert.ok(order.indexOf(SUITE_ID) < order.indexOf(id), `the listing comes before ${id}`);
  }
  const total = Buffer.byteLength(whole.text, "utf8");
  let withVolatile = 0;
  quietly(() => {
    for (let budgetBytes = total; budgetBytes > 800; budgetBytes -= 37) {
      const a = buildPromptAssembled(input, { budgetBytes });
      const standing = VOLATILE_SECTIONS.filter((id) => a.sectionSizes[id] !== undefined);
      if (standing.length > 0) withVolatile += 1;
      if (a.sectionSizes[SUITE_ID] === undefined) assert.deepEqual(standing, [], `budget ${budgetBytes}: the listing is gone while ${standing.join(", ")} stand`);
    }
  });
  assert.ok(withVolatile > 20, "setup: the budgets tried leave volatile sections standing many times");
});

/* ── a listing that does not fit is cut, not lost ── */

const padded = (index: number): string => String(index).padStart(3, "0");
const bytesOf = (text: string): number => Buffer.byteLength(text, "utf8");

/* A run that delivered many specs over a suite of many: the coverage turn that follows takes every delivered spec, so it lists the largest groups the section can have. Every spec has the objective its lead declared. */
const MANY_DELIVERED = Array.from({ length: LISTING_MAX_UNNAMED_EDITABLE + 10 }, (_, index): DeliveredSpec => ({
  file: `flows/m${padded(index)}.spec.ts`,
  flow: `flow number ${index}`,
  objective: `the outcome of flow number ${index} is shown`,
}));
const MANY_EXISTING = Array.from({ length: LISTING_MAX_DO_NOT_REWRITE + 10 }, (_, index) => `suite/s${padded(index)}.spec.ts — flow: suite flow ${index}, objective: the suite outcome ${index} is shown`);
/* A sidekick's spec has no objective its lead declared: a turn that has it to change asks for the outcome whatever the budget does. */
const SIDEKICK_AT_THE_END: DeliveredSpec = { file: "flows/zz-sidekick.spec.ts" };
const bigCoverage = (extra: readonly DeliveredSpec[] = []): OpencodeRunInput =>
  mkInput({ existingSpecFiles: MANY_EXISTING, deliveredSpecs: [...MANY_DELIVERED, ...extra], coverageGap: "src/cart.ts: lines 10-14" });

/* What a prompt holds besides its listing, in bytes: a budget of this plus a room is a budget that leaves the listing that room. */
const aroundTheListing = (whole: AssembledPrompt): number => bytesOf(whole.text) - (whole.sectionSizes[SUITE_ID] ?? 0);

/* A section the assembler cut ends with a marker line of its own; what precedes it is the head of the whole section. */
const headOf = (cut: string): string => cut.split("\n").slice(0, -1).join("\n");

/* The room the marker the assembler ends a cut section with takes, and a few entries' worth over it. */
const MARKER_AND_A_FEW_ENTRIES = 200;

test("a listing that does not fit is cut from its end: the do-not-rewrite group first, then the specs only the fallback added, and the label and the summary stay", () => {
  const asking = (): OpencodeRunInput => bigCoverage([SIDEKICK_AT_THE_END]);
  const whole = buildPromptAssembled(asking(), withoutBudget);
  assert.equal(countOf(whole.text, OBJECTIVE_QUESTION), 1, "setup: the turn asks for the outcome with or without a cut, so a cut changes nothing else of the task");
  const wholeSection = sectionText(whole, SUITE_ID);
  const wholeLines = wholeSection.split("\n");
  const summary = everyDeliveredLine(MANY_DELIVERED.length + 1);
  const through = (line: string): number => bytesOf(wholeLines.slice(0, wholeLines.indexOf(line) + 1).join("\n"));
  const cutTo = (room: number): string => sectionText(quietly(() => buildPromptAssembled(asking(), { budgetBytes: aroundTheListing(whole) + room })), SUITE_ID);

  const inDoNotRewrite = cutTo(through(SUITE_LISTING_LABELS.doNotRewrite) + MARKER_AND_A_FEW_ENTRIES);
  assert.ok(wholeSection.startsWith(headOf(inDoNotRewrite)), "what is left is the head of the section");
  assert.equal(editableIn(inDoNotRewrite).length, LISTING_MAX_UNNAMED_EDITABLE, "every spec the fallback added is still there");
  assert.ok(inDoNotRewrite.includes(summary));
  assert.ok(doNotRewriteIn(inDoNotRewrite).length < LISTING_MAX_DO_NOT_REWRITE, "the do-not-rewrite group is shorter");

  const inFallback = cutTo(through(summary) + MARKER_AND_A_FEW_ENTRIES);
  assert.ok(wholeSection.startsWith(headOf(inFallback)));
  assert.ok(inFallback.includes(SUITE_LISTING_LABELS.editable) && inFallback.includes(summary), "the label and the summary stay");
  assert.ok(editableIn(inFallback).length > 0 && editableIn(inFallback).length < LISTING_MAX_UNNAMED_EDITABLE, "the specs only the fallback added are shorter");
  assert.equal(inFallback.includes(SUITE_LISTING_LABELS.doNotRewrite), false, "the do-not-rewrite group is gone");
});

test("a listing is cut and never lost at any budget that leaves it room for its title, its label and its summary", () => {
  const whole = buildPromptAssembled(bigCoverage(), withoutBudget);
  const wholeSection = sectionText(whole, SUITE_ID);
  const head = wholeSection.split("\n").slice(0, wholeSection.split("\n").indexOf(everyDeliveredLine(MANY_DELIVERED.length)) + 1);
  const room = bytesOf(head.join("\n")) + MARKER_AND_A_FEW_ENTRIES;
  const wholeSize = whole.sectionSizes[SUITE_ID] ?? 0;
  assert.ok(wholeSize > 2 * room, "setup: there is a lot to cut");
  quietly(() => {
    for (let kept = room; kept < wholeSize; kept += 97) {
      const a = buildPromptAssembled(bigCoverage(), { budgetBytes: aroundTheListing(whole) + kept });
      const section = sectionText(a, SUITE_ID);
      assert.ok(section !== "", `room ${kept}: the listing stands`);
      assert.deepEqual(section.split("\n").slice(0, head.length), head, `room ${kept}: its title, its label and its summary stand`);
    }
  });
});

test("a plain list the byte budget cannot hold is dropped whole, as a first pass drops it, and not cut", () => {
  const input = mkInput({ existingSpecFiles: MANY_EXISTING, deliveredSpecs: MANY_DELIVERED, fixCases: [failing(undefined, "the page timed out")] });
  const whole = buildPromptAssembled(input, withoutBudget);
  assert.equal(countOf(whole.text, SUITE_LISTING_LABELS.editable), 0, "setup: nothing is editable, so the list is plain");
  const shed = quietly(() => buildPromptAssembled(input, { budgetBytes: aroundTheListing(whole) + MARKER_AND_A_FEW_ENTRIES }));
  assert.equal(shed.sectionSizes[SUITE_ID], undefined);
});

test("a listing the byte budget cuts can no longer justify skipping the outcome: the prompt asks for it, and a listing that fits does not", () => {
  const whole = buildPromptAssembled(bigCoverage(), withoutBudget);
  assert.equal(countOf(whole.text, OBJECTIVE_QUESTION), 0, "setup: every spec under correction has an objective its lead declared");
  const total = bytesOf(whole.text);
  const fits = quietly(() => buildPromptAssembled(bigCoverage(), { budgetBytes: total }));
  assert.equal(countOf(fits.text, OBJECTIVE_QUESTION), 0);
  const cut = quietly(() => buildPromptAssembled(bigCoverage(), { budgetBytes: total - 600 }));
  assert.ok((cut.sectionSizes[SUITE_ID] ?? Number.POSITIVE_INFINITY) < (whole.sectionSizes[SUITE_ID] ?? 0), "setup: the listing is cut, not shed");
  assert.equal(countOf(cut.text, OBJECTIVE_QUESTION), 1);
  assert.equal(directs(cut, "task", "state-outcome"), true);
});

test("the question costs the listing nothing of its head: wherever the prompt asks for the outcome again, the title, the label and the summary stand", () => {
  const whole = buildPromptAssembled(bigCoverage(), withoutBudget);
  const around = aroundTheListing(whole);
  const wholeLines = sectionText(whole, SUITE_ID).split("\n");
  const head = wholeLines.slice(0, wholeLines.indexOf(everyDeliveredLine(MANY_DELIVERED.length)) + 1).join("\n");
  let asked = 0;
  let held = 0;
  quietly(() => {
    for (let room = 0; room < (whole.sectionSizes[SUITE_ID] ?? 0); room += 29) {
      const a = buildPromptAssembled(bigCoverage(), { budgetBytes: around + room });
      const standing = a.text.includes(head);
      if (countOf(a.text, OBJECTIVE_QUESTION) === 1) {
        asked += 1;
        assert.ok(standing, `room ${room}: the prompt asks, so the head of the listing stands`);
      } else if (standing) {
        held += 1;
      }
    }
  });
  assert.ok(asked > 10, "setup: the prompt asks at many of the budgets tried");
  assert.ok(held > 5, "setup: the head is kept, without the question, at budgets where the question would take it");
});

/* Under this, the marker the assembler ends a cut section with leaves the section no room for anything of its own. */
const NO_ROOM_FOR_A_HEAD = 100;

test("asking for the outcome again never costs the prompt a section: at any budget that holds all but the listing the task stands, and so does a listing that has room", () => {
  const whole = buildPromptAssembled(bigCoverage(), withoutBudget);
  const around = aroundTheListing(whole);
  quietly(() => {
    for (let budgetBytes = around; budgetBytes <= bytesOf(whole.text); budgetBytes += 17) {
      const a = buildPromptAssembled(bigCoverage(), { budgetBytes });
      assert.ok(a.sectionSizes["task"] !== undefined, `budget ${budgetBytes}: the task stands`);
      if (budgetBytes - around >= NO_ROOM_FOR_A_HEAD) assert.ok(a.sectionSizes[SUITE_ID] !== undefined, `budget ${budgetBytes}: the listing stands`);
    }
  });
});

/* ── the contract ── */

test("a regeneration with a listing is clean under the lint, in both targets and every signal", () => {
  for (const target of ["e2e", "code"] as const) {
    for (const [what, signal] of TURN_SIGNALS) {
      const a = buildPromptAssembled(mkInput({ target, existingSpecFiles: [C_LINE], deliveredSpecs: [A, SIDEKICK], ...signal }));
      assert.deepEqual(findingsOf(a, true), [], `${target}, ${what}`);
    }
  }
});

test("the largest listing a regeneration carries is clean under the lint, whole and cut", () => {
  const whole = buildPromptAssembled(bigCoverage(), withoutBudget);
  assert.deepEqual(findingsOf(whole, true), []);
  const cut = quietly(() => buildPromptAssembled(bigCoverage(), { budgetBytes: bytesOf(whole.text) - 600 }));
  assert.ok((cut.sectionSizes[SUITE_ID] ?? Number.POSITIVE_INFINITY) < (whole.sectionSizes[SUITE_ID] ?? 0), "setup: the listing is cut");
  assert.deepEqual(findingsOf(cut, true), []);
});

test("a limited prompt still ends with the step limit and then the milestone when the listing is in it", () => {
  const a = buildPromptAssembled(mkInput({ stepLimit: 40, existingSpecFiles: [C_LINE], deliveredSpecs: [A], fixCases: [failing("flows/a.spec.ts")] }));
  assert.deepEqual(Object.keys(a.sectionSizes).slice(-2), ["step-limit", "step-milestone"]);
});
