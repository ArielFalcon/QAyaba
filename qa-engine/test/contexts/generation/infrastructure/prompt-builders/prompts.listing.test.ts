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
  buildPromptAssembled,
  setExplorationBriefCollaborators,
  type AssembledPrompt,
} from "@contexts/generation/infrastructure/prompt-builders/prompts.ts";
import { PROMPT_HEADINGS, ASSEMBLED_ARTIFACT_NAMES, SUITE_LISTING_LABELS } from "@contexts/generation/domain/prompt-headings.ts";
import { ARTIFACT_REFERENCES } from "@contexts/generation/domain/prompt-artifact-references.ts";
import { leftOutLine, PLAIN_LISTING_NOTE } from "@contexts/generation/domain/suite-listing-render.ts";
import { LISTING_MAX_DO_NOT_REWRITE, LISTING_MAX_ENTRY_CHARS } from "@contexts/generation/domain/suite-listing.ts";
import { lintCell, type LintSection, type PromptClaim } from "@contexts/generation/domain/prompt-contract-lint.ts";
import { isTestWritingTurn } from "@contexts/generation/domain/step-limit.ts";
import { REDACTED } from "@kernel/ports/redaction.port.ts";
import type { DeliveredSpec } from "@kernel/delivered-spec.ts";
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

/* ── the contract ── */

test("a regeneration with a listing is clean under the lint, in both targets and every signal", () => {
  for (const target of ["e2e", "code"] as const) {
    for (const [what, signal] of TURN_SIGNALS) {
      const a = buildPromptAssembled(mkInput({ target, existingSpecFiles: [C_LINE], deliveredSpecs: [A, SIDEKICK], ...signal }));
      assert.deepEqual(findingsOf(a, true), [], `${target}, ${what}`);
    }
  }
});

test("a limited prompt still ends with the step limit and then the milestone when the listing is in it", () => {
  const a = buildPromptAssembled(mkInput({ stepLimit: 40, existingSpecFiles: [C_LINE], deliveredSpecs: [A], fixCases: [failing("flows/a.spec.ts")] }));
  assert.deepEqual(Object.keys(a.sectionSizes).slice(-2), ["step-limit", "step-milestone"]);
});
