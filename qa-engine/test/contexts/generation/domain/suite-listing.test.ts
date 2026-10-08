import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSuiteListing,
  LISTING_MAX_DO_NOT_REWRITE,
  LISTING_MAX_ENTRY_CHARS,
  type SuiteListing,
  type SuiteListingInput,
} from "@contexts/generation/domain/suite-listing.ts";
import { suiteEntryFile } from "@contexts/generation/domain/suite-entry.ts";
import type { DeliveredSpec } from "@kernel/delivered-spec.ts";
import { SecretLeakError } from "@kernel/ports/redaction.port.ts";

/* The listing of the suite for a regeneration: which specs there are, which of them the turn must change, how many of the others are shown, and whether the objective is asked again. Pure: the text of an entry is whatever the injected sanitizer leaves of it, and an entry hands out nothing but that text, so a spec is told apart by the path its text starts with. */

const keep = (text: string): string => text;
const listing = (input: SuiteListingInput, sanitize: (text: string) => string = keep): SuiteListing => buildSuiteListing(input, { sanitize });
const filesOf = (entries: readonly { text: string }[]): string[] => entries.map((entry) => suiteEntryFile(entry.text));

/* Specs the lead delivered in this run, each with the flow and the objective it declared. */
const A: DeliveredSpec = { file: "flows/a.spec.ts", flow: "a flow", objective: "a objective" };
const B: DeliveredSpec = { file: "flows/b.spec.ts", flow: "b flow", objective: "b objective" };
/* Specs that were in the suite before the run, as the grounding folded them. */
const C_LINE = "flows/c.spec.ts — flow: c flow, objective: c objective";
const D_LINE = "d.spec.ts";

const failing = (file?: string, detail?: string) => ({ name: "a failing test", status: "fail" as const, ...(file !== undefined ? { file } : {}), ...(detail !== undefined ? { detail } : {}) });
const staticGate = (detail: string) => ({ name: "static-gate", status: "fail" as const, detail });

/* ── the entries ── */

test("the entries are the suite's lines in the order given, then the specs only this run delivered", () => {
  const result = listing({ existing: ["flows/c.spec.ts — flow: c, objective: o", D_LINE], delivered: [{ file: "e.spec.ts" }, A] });
  assert.deepEqual(filesOf(result.entries), ["flows/c.spec.ts", "d.spec.ts", "e.spec.ts", "flows/a.spec.ts"]);
});

test("a line of the suite and a spec this run delivered for the same file are one entry, in the place the suite had it, however each spells the file", () => {
  for (const [line, delivered] of [["a.spec.ts", "./a.spec.ts"], ["./a.spec.ts", "a.spec.ts"], ["./a.spec.ts", "./a.spec.ts"]] as const) {
    const result = listing({ existing: [`${line} — flow: old flow, objective: old objective`, D_LINE], delivered: [{ file: delivered, flow: "new flow", objective: "new objective" }] });
    assert.deepEqual(filesOf(result.entries), ["a.spec.ts", "d.spec.ts"], `${line} / ${delivered}`);
    assert.equal(result.entries[0]!.text, "a.spec.ts — flow: new flow, objective: new objective");
    assert.equal(result.entries[0]!.delivered, true);
  }
});

test("a delivery that declares nothing leaves the suite's line as it was", () => {
  const result = listing({ existing: [C_LINE], delivered: [{ file: "flows/c.spec.ts" }] });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]!.text, C_LINE);
  assert.equal(result.entries[0]!.delivered, true);
});

test("a delivery that declares only a flow, or only an objective, refreshes the suite's line with what it declares", () => {
  const flowOnly = listing({ existing: [C_LINE], delivered: [{ file: "flows/c.spec.ts", flow: "new flow" }] });
  assert.equal(flowOnly.entries[0]!.text, "flows/c.spec.ts — flow: new flow");
  assert.equal(flowOnly.entries[0]!.leadObjective, false);
  const objectiveOnly = listing({ existing: [C_LINE], delivered: [{ file: "flows/c.spec.ts", objective: "new objective" }] });
  assert.equal(objectiveOnly.entries[0]!.text, "flows/c.spec.ts — objective: new objective");
  assert.equal(objectiveOnly.entries[0]!.leadObjective, true);
});

test("a spec only this run delivered is shown with what the lead declared for it, or by its path alone", () => {
  const result = listing({ delivered: [A, { file: "flows/s.spec.ts" }, { file: "flows/t.spec.ts", flow: "t flow" }] });
  assert.deepEqual(result.entries.map((entry) => entry.text), ["flows/a.spec.ts — flow: a flow, objective: a objective", "flows/s.spec.ts", "flows/t.spec.ts — flow: t flow"]);
  assert.ok(result.entries.every((entry) => entry.delivered));
});

test("an objective is the lead's only when this run's lead declared one: a suite line's folded objective and a sidekick's spec have none", () => {
  const result = listing({
    existing: [C_LINE, "e.spec.ts — flow: e flow, objective: e objective"],
    delivered: [A, { file: "s.spec.ts" }, { file: "t.spec.ts", flow: "t flow" }, { file: "e.spec.ts", objective: "declared this run" }],
  });
  const leadObjective = Object.fromEntries(result.entries.map((entry) => [suiteEntryFile(entry.text), entry.leadObjective]));
  assert.deepEqual(leadObjective, {
    "flows/c.spec.ts": false,
    "e.spec.ts": true,
    "flows/a.spec.ts": true,
    "s.spec.ts": false,
    "t.spec.ts": false,
  });
});

test("a spec is delivered when this run delivered it, and a suite line this run did not touch is not", () => {
  const result = listing({ existing: [C_LINE], delivered: [A] });
  assert.deepEqual(result.entries.map((entry) => [suiteEntryFile(entry.text), entry.delivered]), [["flows/c.spec.ts", false], ["flows/a.spec.ts", true]]);
});

test("two lines of the suite for one file are one entry, the first line kept; a line that names no file is no entry", () => {
  const result = listing({ existing: ["a.spec.ts — flow: first, objective: first", "./a.spec.ts — flow: second, objective: second", "", " — flow: x, objective: y", "./"] });
  assert.deepEqual(result.entries.map((entry) => entry.text), ["a.spec.ts — flow: first, objective: first"]);
});

test("a spec delivered twice, spelled two ways, is one entry that reads as the newest declaration", () => {
  const result = listing({ delivered: [{ file: "a.spec.ts", objective: "first" }, { file: "./a.spec.ts", objective: "second" }] });
  assert.deepEqual(result.entries.map((entry) => entry.text), ["a.spec.ts — objective: second"]);
});

test("a run with no suite and nothing delivered lists nothing", () => {
  const result = listing({});
  assert.deepEqual(result, { entries: [], editable: [], doNotRewrite: [], leftOut: 0, reaskObjective: true });
});

/* ── which specs the turn must change ── */

const SUITE = { existing: [C_LINE, D_LINE], delivered: [A, B] };

test("a turn that asks for nothing changes nothing: every spec is do-not-rewrite, this run's first", () => {
  const result = listing(SUITE);
  assert.deepEqual(result.editable, []);
  assert.deepEqual(filesOf(result.doNotRewrite), ["flows/a.spec.ts", "flows/b.spec.ts", "flows/c.spec.ts", "d.spec.ts"]);
});

test("FixLoop: exactly the failing files are editable, a spec that passed is not, and the listing still carries all of them", () => {
  const result = listing({ ...SUITE, fixCases: [failing("flows/a.spec.ts"), failing("flows/c.spec.ts")] });
  assert.deepEqual(filesOf(result.editable), ["flows/c.spec.ts", "flows/a.spec.ts"]);
  assert.deepEqual(filesOf(result.doNotRewrite), ["flows/b.spec.ts", "d.spec.ts"]);
  assert.deepEqual(filesOf(result.entries), ["flows/c.spec.ts", "d.spec.ts", "flows/a.spec.ts", "flows/b.spec.ts"]);
});

test("FixLoop: a selector contradiction, attributed or not, never adds a spec beside a failing file", () => {
  const result = listing({
    ...SUITE,
    fixCases: [failing("flows/a.spec.ts")],
    selectorContradictions: ["a selector the page does not have"],
    attributedSpecFiles: ["flows/b.spec.ts", "d.spec.ts"],
  });
  assert.deepEqual(filesOf(result.editable), ["flows/a.spec.ts"]);
});

test("FixLoop: a contradiction that names no spec does not make every delivered spec editable while a failing file is known", () => {
  const result = listing({ ...SUITE, fixCases: [failing("flows/a.spec.ts")], selectorContradictions: ["a selector the page does not have"] });
  assert.deepEqual(filesOf(result.editable), ["flows/a.spec.ts"]);
});

test("FixLoop: the error text of a failing test names no other spec as editable", () => {
  const result = listing({ ...SUITE, fixCases: [failing("flows/a.spec.ts", "Error at flows/b.spec.ts:12:5 and flows/c.spec.ts")] });
  assert.deepEqual(filesOf(result.editable), ["flows/a.spec.ts"]);
});

test("FixLoop: where a failing case names its file, nothing else widens the turn: not a correction, an error text, a contradiction or a coverage gap", () => {
  const widening: Record<string, SuiteListingInput> = {
    "a correction that names another spec": { reviewCorrections: ["flows/b.spec.ts: weak assertion"] },
    "a correction that names no spec": { reviewCorrections: ["the checkout flow asserts nothing"] },
    "the error text of a case without a file": { fixCases: [failing("flows/a.spec.ts"), failing(undefined, "Error at flows/b.spec.ts:3")] },
    "a contradiction attributed to another spec": { selectorContradictions: ["a selector the page does not have"], attributedSpecFiles: ["d.spec.ts"] },
    "a coverage gap": { coverageGap: "src/cart.ts: lines 10-14" },
  };
  for (const [what, signal] of Object.entries(widening)) {
    const result = listing({ ...SUITE, fixCases: [failing("flows/a.spec.ts")], ...signal });
    assert.deepEqual(filesOf(result.editable), ["flows/a.spec.ts"], what);
  }
  const above = listing({ ...SUITE, fixCases: [failing("e2e/flows/a.spec.ts")], reviewCorrections: ["flows/b.spec.ts: weak assertion"] });
  assert.deepEqual(filesOf(above.editable), ["flows/a.spec.ts"], "the failing path still matches the entry at a folder boundary");
});

test("FixLoop: a failing file that no entry matches is appended to the listing as an editable entry of its own", () => {
  const result = listing({ ...SUITE, fixCases: [failing("flows/new.spec.ts")] });
  assert.deepEqual(filesOf(result.editable), ["flows/new.spec.ts"]);
  assert.deepEqual(filesOf(result.entries).at(-1), "flows/new.spec.ts");
  const appended = result.editable[0]!;
  assert.equal(appended.text, "flows/new.spec.ts");
  assert.equal(appended.delivered, false);
  assert.equal(appended.leadObjective, false);
});

test("FixLoop: every failing file no entry matches is appended as the harness reported it, even when one is the other's name", () => {
  const result = listing({ ...SUITE, fixCases: [failing("flows/new.spec.ts"), failing("new.spec.ts")] });
  assert.deepEqual(filesOf(result.editable), ["flows/new.spec.ts", "new.spec.ts"]);
  assert.deepEqual(filesOf(result.entries).slice(-2), ["flows/new.spec.ts", "new.spec.ts"]);
});

test("FixLoop: several failing tests of one file make one editable entry, whichever way the file is spelled", () => {
  const result = listing({ ...SUITE, fixCases: [failing("flows/a.spec.ts"), failing("./flows/a.spec.ts"), failing("flows\\a.spec.ts")] });
  assert.deepEqual(filesOf(result.editable), ["flows/a.spec.ts"]);
  assert.equal(result.entries.length, 4);
});

test("FixLoop: a failing file may be reported with folders above the entry's, or with only its name", () => {
  const above = listing({ ...SUITE, fixCases: [failing("e2e/flows/a.spec.ts")] });
  assert.deepEqual(filesOf(above.editable), ["flows/a.spec.ts"]);
  const bare = listing({ existing: ["flows/x.spec.ts", "other/x.spec.ts", "flows/xx.spec.ts", "xx.spec.ts"], fixCases: [failing("x.spec.ts")] });
  assert.deepEqual(filesOf(bare.editable), ["flows/x.spec.ts", "other/x.spec.ts"]);
  assert.equal(bare.entries.length, 4, "nothing was appended: the name matched");
});

test("FixLoop: a file that only ends like another is not that file", () => {
  const result = listing({ existing: ["flows/data.spec.ts", "flows/a.spec.ts"], fixCases: [failing("a.spec.ts")] });
  assert.deepEqual(filesOf(result.editable), ["flows/a.spec.ts"]);
});

test("FixLoop: a case that did not fail marks nothing, and a flaky one does", () => {
  const result = listing({
    ...SUITE,
    fixCases: [{ name: "passed", status: "pass" as const, file: "flows/a.spec.ts" }, { name: "flaky", status: "flaky" as const, file: "flows/b.spec.ts" }],
  });
  assert.deepEqual(filesOf(result.editable), ["flows/b.spec.ts"]);
});

test("FixLoop: a failing file with no entry is appended once even when a case without a file is beside it", () => {
  const result = listing({ ...SUITE, fixCases: [failing("flows/new.spec.ts"), failing(undefined, "no path in this error")] });
  assert.deepEqual(filesOf(result.editable), ["flows/new.spec.ts"]);
});

test("static fix: the specs the gate's output names are editable, and no other", () => {
  const result = listing({ ...SUITE, fixCases: [staticGate("e2e/flows/a.spec.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.")] });
  assert.deepEqual(filesOf(result.editable), ["flows/a.spec.ts"]);
});

test("static fix: a spec of the suite the gate names is editable, and the specs delivered are not for that", () => {
  const result = listing({ ...SUITE, fixCases: [staticGate("d.spec.ts:3:1 - error TS1005: ';' expected.")] });
  assert.deepEqual(filesOf(result.editable), ["d.spec.ts"]);
});

test("static fix: output that names no spec makes every spec this run delivered editable, and none of the suite", () => {
  const result = listing({ ...SUITE, fixCases: [staticGate("error TS2322: Type 'string' is not assignable to type 'number'.")] });
  assert.deepEqual(filesOf(result.editable), ["flows/a.spec.ts", "flows/b.spec.ts"]);
  assert.deepEqual(filesOf(result.doNotRewrite), ["flows/c.spec.ts", "d.spec.ts"]);
});

test("static fix: output that names no spec, in a run that delivered nothing, leaves nothing editable", () => {
  const result = listing({ existing: [C_LINE], fixCases: [staticGate("error TS2322")] });
  assert.deepEqual(result.editable, []);
});

test("a path in an error is a run of name characters, wherever it stands, with a position or a full stop after it", () => {
  for (const detail of ["flows/a.spec.ts:12:5", "see flows/a.spec.ts.", "see flows/a.spec.ts...", "(flows/a.spec.ts)", "`flows/a.spec.ts`", "at flows\\a.spec.ts line 3", "./flows/a.spec.ts:7"]) {
    const result = listing({ existing: ["flows/a.spec.ts", "flows/other.spec.ts"], delivered: [{ file: "flows/z.spec.ts" }], fixCases: [staticGate(detail)] });
    assert.deepEqual(filesOf(result.editable), ["flows/a.spec.ts"], detail);
  }
});

test("a scoped folder, a hyphen and an underscore belong to a name: the path is read whole", () => {
  const result = listing({
    existing: ["@scope/pkg/a.spec.ts", "other/b.spec.ts", "flows/sign-in.spec.ts", "flows/in.spec.ts", "flows/log_in.spec.ts", "flows/in.spec.ts "],
    fixCases: [staticGate("at @scope/pkg/a.spec.ts:3:1 and flows/sign-in.spec.ts:9 and flows/log_in.spec.ts:2")],
  });
  assert.deepEqual(filesOf(result.editable), ["@scope/pkg/a.spec.ts", "flows/sign-in.spec.ts", "flows/log_in.spec.ts"]);
});

test("pre-exec: the specs the contradictions are attributed to are editable, and no other", () => {
  const result = listing({ ...SUITE, selectorContradictions: ["a selector the page does not have"], attributedSpecFiles: ["flows/a.spec.ts", "d.spec.ts"] });
  assert.deepEqual(filesOf(result.editable), ["d.spec.ts", "flows/a.spec.ts"]);
});

test("pre-exec: an attributed file is matched whole, in any spelling, and not as a name or a suffix", () => {
  const result = listing({ existing: ["flows/a.spec.ts", "other/a.spec.ts"], selectorContradictions: ["x"], attributedSpecFiles: ["./flows/a.spec.ts"] });
  assert.deepEqual(filesOf(result.editable), ["flows/a.spec.ts"]);
  const byName = listing({ existing: ["flows/a.spec.ts"], delivered: [B], selectorContradictions: ["x"], attributedSpecFiles: ["a.spec.ts"] });
  assert.deepEqual(filesOf(byName.editable), ["flows/b.spec.ts"], "a bare name attributes to no entry, so every delivered spec is editable");
});

test("pre-exec: contradictions no spec is attributed to make every spec this run delivered editable", () => {
  for (const attributedSpecFiles of [undefined, [], ["flows/unknown.spec.ts"]]) {
    const result = listing({ ...SUITE, selectorContradictions: ["a selector the page does not have"], ...(attributedSpecFiles ? { attributedSpecFiles } : {}) });
    assert.deepEqual(filesOf(result.editable), ["flows/a.spec.ts", "flows/b.spec.ts"]);
  }
});

test("pre-exec: attributed files without a contradiction are not a turn's work", () => {
  const result = listing({ ...SUITE, attributedSpecFiles: ["flows/a.spec.ts"] });
  assert.deepEqual(result.editable, []);
});

test("reviewer: the specs a correction names are editable, by path, by the folders above it or by name alone", () => {
  const result = listing({
    existing: ["flows/c.spec.ts", "flows/x.spec.ts", "other/x.spec.ts"],
    delivered: [A],
    reviewCorrections: ["[false-positive] flows/a.spec.ts: assert the total", "e2e/flows/c.spec.ts: the cleanup is missing", "x.spec.ts clicks Pay but asserts nothing"],
  });
  assert.deepEqual(filesOf(result.editable), ["flows/c.spec.ts", "flows/x.spec.ts", "other/x.spec.ts", "flows/a.spec.ts"]);
});

test("reviewer: a correction that names only the basename of a carried spec makes that entry editable", () => {
  const result = listing({ delivered: [{ file: "e2e/x/a.spec.ts" }, B], reviewCorrections: ["a.spec.ts: assert the discounted total"] });
  assert.deepEqual(filesOf(result.editable), ["e2e/x/a.spec.ts"]);
});

test("reviewer: a correction that names no spec adds every spec this run delivered to the ones the others name", () => {
  const result = listing({ ...SUITE, reviewCorrections: ["flows/c.spec.ts: weak assertion", "the checkout flow asserts nothing at all"] });
  assert.deepEqual(filesOf(result.editable), ["flows/c.spec.ts", "flows/a.spec.ts", "flows/b.spec.ts"]);
  assert.deepEqual(filesOf(result.doNotRewrite), ["d.spec.ts"]);
});

test("reviewer: when every correction names a spec, no other spec is editable", () => {
  const result = listing({ ...SUITE, reviewCorrections: ["flows/b.spec.ts: weak assertion", "d.spec.ts: missing cleanup"] });
  assert.deepEqual(filesOf(result.editable), ["d.spec.ts", "flows/b.spec.ts"]);
});

test("reviewer: a name that only ends like a spec's does not name it", () => {
  const result = listing({ existing: ["flows/data.spec.ts", "flows/a.spec.ts"], reviewCorrections: ["a.spec.ts: weak assertion"] });
  assert.deepEqual(filesOf(result.editable), ["flows/a.spec.ts"]);
});

test("coverage: every spec this run delivered is editable and the suite's are not", () => {
  const result = listing({ ...SUITE, coverageGap: "src/cart.ts: lines 10-14" });
  assert.deepEqual(filesOf(result.editable), ["flows/a.spec.ts", "flows/b.spec.ts"]);
  assert.deepEqual(filesOf(result.doNotRewrite), ["flows/c.spec.ts", "d.spec.ts"]);
});

test("coverage: an empty gap is no coverage turn", () => {
  const result = listing({ ...SUITE, coverageGap: "" });
  assert.deepEqual(result.editable, []);
});

test("a failing file known to the FixLoop leaves no fallback to the others: a case without a file that names no spec does not widen the turn", () => {
  const result = listing({ ...SUITE, fixCases: [failing("flows/a.spec.ts"), failing(undefined, "the page timed out")] });
  assert.deepEqual(filesOf(result.editable), ["flows/a.spec.ts"]);
});

test("a case without a file names its spec in its error text, and the FixLoop with no file at all falls back to this run's specs", () => {
  const named = listing({ ...SUITE, fixCases: [failing(undefined, "flows/b.spec.ts › checkout works")] });
  assert.deepEqual(filesOf(named.editable), ["flows/b.spec.ts"]);
  const unnamed = listing({ ...SUITE, fixCases: [failing(undefined, "the page timed out")] });
  assert.deepEqual(filesOf(unnamed.editable), ["flows/a.spec.ts", "flows/b.spec.ts"]);
});

test("a failing case with neither a file nor an error text names no spec: the turn falls back to this run's specs", () => {
  const result = listing({ ...SUITE, fixCases: [failing()] });
  assert.deepEqual(filesOf(result.editable), ["flows/a.spec.ts", "flows/b.spec.ts"]);
});

/* ── how many are shown ── */

const suiteOf = (count: number): string[] => Array.from({ length: count }, (_, index) => `suite/s${String(index).padStart(3, "0")}.spec.ts`);

test("the do-not-rewrite entries shown are at most the cap, and the rest are counted", () => {
  const total = LISTING_MAX_DO_NOT_REWRITE + 5;
  const result = listing({ existing: suiteOf(total), delivered: [A], fixCases: [failing("flows/a.spec.ts")] });
  assert.equal(result.doNotRewrite.length, LISTING_MAX_DO_NOT_REWRITE);
  assert.equal(result.leftOut, total - LISTING_MAX_DO_NOT_REWRITE);
  assert.equal(result.entries.length, total + 1, "the listing still holds every entry");
});

test("at the cap, nothing is left out; one more, and one is", () => {
  const atCap = listing({ existing: suiteOf(LISTING_MAX_DO_NOT_REWRITE) });
  assert.equal(atCap.doNotRewrite.length, LISTING_MAX_DO_NOT_REWRITE);
  assert.equal(atCap.leftOut, 0);
  const over = listing({ existing: suiteOf(LISTING_MAX_DO_NOT_REWRITE + 1) });
  assert.equal(over.doNotRewrite.length, LISTING_MAX_DO_NOT_REWRITE);
  assert.equal(over.leftOut, 1);
});

test("every editable entry is listed, however many there are", () => {
  const delivered = Array.from({ length: LISTING_MAX_DO_NOT_REWRITE + 12 }, (_, index) => ({ file: `mine/m${String(index).padStart(3, "0")}.spec.ts` }));
  const result = listing({ existing: suiteOf(LISTING_MAX_DO_NOT_REWRITE + 3), delivered, coverageGap: "src/cart.ts: lines 10-14" });
  assert.equal(result.editable.length, delivered.length);
  assert.equal(result.doNotRewrite.length, LISTING_MAX_DO_NOT_REWRITE);
  assert.equal(result.leftOut, 3);
});

test("the cap keeps this run's own specs before the suite's", () => {
  const delivered = [A, B, { file: "flows/e.spec.ts" }];
  const result = listing({ existing: suiteOf(LISTING_MAX_DO_NOT_REWRITE + 10), delivered, fixCases: [failing("suite/s000.spec.ts")] });
  assert.deepEqual(filesOf(result.doNotRewrite).slice(0, 3), ["flows/a.spec.ts", "flows/b.spec.ts", "flows/e.spec.ts"]);
  assert.equal(result.doNotRewrite.length, LISTING_MAX_DO_NOT_REWRITE);
  assert.equal(result.leftOut, LISTING_MAX_DO_NOT_REWRITE + 10 + 3 - 1 - LISTING_MAX_DO_NOT_REWRITE);
  assert.ok(!filesOf(result.doNotRewrite).includes("suite/s000.spec.ts"), "an editable entry is not also shown as do-not-rewrite");
});

test("every entry is exactly one of editable and do-not-rewrite (or left out of it)", () => {
  const result = listing({ existing: suiteOf(LISTING_MAX_DO_NOT_REWRITE + 4), delivered: [A, B], fixCases: [failing("flows/a.spec.ts"), failing("suite/s001.spec.ts")] });
  const editable = new Set(result.editable);
  const shown = new Set(result.doNotRewrite);
  assert.equal([...editable].filter((entry) => shown.has(entry)).length, 0);
  assert.equal(editable.size + shown.size + result.leftOut, result.entries.length);
  assert.ok([...editable, ...shown].every((entry) => result.entries.includes(entry)), "the lists hold the very entries of the listing");
});

/* ── the text of an entry ── */

test("an entry is one line: a newline, a tab or a run of spaces in what the agent wrote is a single space", () => {
  const result = listing({ existing: ["a.spec.ts — flow: sign in,\n\tobjective:   the user\r\nsigns in"], delivered: [{ file: "b.spec.ts", flow: "two\nlines", objective: "o\tp" }] });
  assert.deepEqual(result.entries.map((entry) => entry.text), ["a.spec.ts — flow: sign in, objective: the user signs in", "b.spec.ts — flow: two lines, objective: o p"]);
});

test("an entry has no space at either end: what the agent left around its text is dropped", () => {
  const result = listing({ existing: ["a.spec.ts — flow: sign in, objective: the user signs in \n", "b.spec.ts — flow: x, objective: y\t"] });
  assert.deepEqual(result.entries.map((entry) => entry.text), ["a.spec.ts — flow: sign in, objective: the user signs in", "b.spec.ts — flow: x, objective: y"]);
});

test("every text the listing makes goes through the sanitizer: a suite line, a delivered spec and a failing file", () => {
  const redact = (text: string): string => text.replaceAll("hunter2", "[REDACTED]");
  const result = listing(
    {
      existing: ["flows/old.spec.ts — flow: login, objective: use hunter2 to sign in"],
      delivered: [{ file: "flows/new.spec.ts", flow: "hunter2 flow", objective: "o" }],
      fixCases: [failing("flows/hunter2.spec.ts")],
    },
    redact,
  );
  const texts = result.entries.map((entry) => entry.text);
  assert.deepEqual(texts, [
    "flows/old.spec.ts — flow: login, objective: use [REDACTED] to sign in",
    "flows/new.spec.ts — flow: [REDACTED] flow, objective: o",
    "flows/[REDACTED].spec.ts",
  ]);
});

test("the sanitizer sees one line, and sanitizing comes before the cap: a secret at the cut is redacted whole, never cut in two", () => {
  const seen: string[] = [];
  const redact = (text: string): string => {
    seen.push(text);
    return text.replaceAll("hunter2", "[REDACTED]");
  };
  /* The secret starts four characters before the limit, so a cut before the redaction would leave "hun" of it. */
  const prefix = "a.spec.ts — flow: ";
  const lead = "x".repeat(LISTING_MAX_ENTRY_CHARS - 4 - prefix.length);
  const result = listing({ existing: [`${prefix}${lead}hunter2\nmore`] }, redact);
  assert.ok(!seen[0]!.includes("\n"), "whitespace is already collapsed when the sanitizer is asked");
  assert.ok(!result.entries[0]!.text.includes("hun"), "no part of the secret is left");
  assert.equal([...result.entries[0]!.text].length, LISTING_MAX_ENTRY_CHARS);
});

test("a line is capped at the limit, with a mark where it was cut; a line within it is untouched", () => {
  const prefix = "a.spec.ts — flow: ";
  const within = `${prefix}${"y".repeat(LISTING_MAX_ENTRY_CHARS - prefix.length)}`;
  const over = `b.spec.ts${within.slice("a.spec.ts".length)}z`;
  assert.equal([...within].length, LISTING_MAX_ENTRY_CHARS);
  assert.equal([...over].length, LISTING_MAX_ENTRY_CHARS + 1);
  const result = listing({ existing: [within, over] });
  assert.equal(result.entries[0]!.text, within);
  const cut = result.entries[1]!.text;
  assert.equal([...cut].length, LISTING_MAX_ENTRY_CHARS);
  assert.ok(cut.endsWith("y…"), "the mark follows what was kept");
  assert.ok(cut.startsWith("b.spec.ts — flow: yyy"), "the path comes first and stays");
});

test("the cap counts characters, not code units: a line of astral characters is never cut inside one", () => {
  const long = `a.spec.ts — objective: ${"😀".repeat(LISTING_MAX_ENTRY_CHARS)}`;
  const text = listing({ existing: [long] }).entries[0]!.text;
  assert.equal([...text].length, LISTING_MAX_ENTRY_CHARS);
  assert.equal(Buffer.from(text, "utf8").toString("utf8"), text, "no half of a surrogate pair is left (it would not survive being encoded)");
});

test("a delivered spec's declarations are capped like any other text", () => {
  const result = listing({ delivered: [{ file: "a.spec.ts", flow: "f", objective: "o".repeat(LISTING_MAX_ENTRY_CHARS * 2) }] });
  assert.equal([...result.entries[0]!.text].length, LISTING_MAX_ENTRY_CHARS);
});

test("what the listing is given is left as it was", () => {
  const existing = Object.freeze([C_LINE, D_LINE]);
  const delivered = Object.freeze([Object.freeze({ ...A }), Object.freeze({ file: "s.spec.ts" })]);
  const fixCases = Object.freeze([Object.freeze(failing("flows/a.spec.ts"))]);
  const result = buildSuiteListing({ existing, delivered, fixCases }, { sanitize: keep });
  assert.equal(result.entries.length, 4);
});

/* ── what a listing hands out ── */

/* Every string a value holds outside a field called `text`, wherever it is nested. */
const stringsOutsideText = (value: unknown, field = ""): string[] => {
  if (typeof value === "string") return field === "text" ? [] : [value];
  if (Array.isArray(value)) return value.flatMap((item) => stringsOutsideText(item, field));
  if (value !== null && typeof value === "object") return Object.entries(value).flatMap(([name, item]) => stringsOutsideText(item, name));
  return [];
};

test("an entry hands out its text and two facts, and the text is the only string a listing holds: no path an agent reported is carried outside it", () => {
  const secret = "hunter2";
  const redact = (text: string): string => text.replaceAll(secret, "[REDACTED]");
  const result = listing(
    {
      existing: [`flows/${secret}-old.spec.ts — flow: login, objective: use ${secret}`],
      delivered: [{ file: `flows/${secret}-new.spec.ts`, flow: `${secret} flow`, objective: "o" }],
      fixCases: [failing(`flows/${secret}-failing.spec.ts`)],
      reviewCorrections: [`flows/${secret}-old.spec.ts: weak assertion`],
      selectorContradictions: [`a selector ${secret}`],
      attributedSpecFiles: [`flows/${secret}-new.spec.ts`],
      coverageGap: `src/${secret}.ts: lines 10-14`,
    },
    redact,
  );
  assert.equal(result.entries.length, 3);
  assert.deepEqual(Object.keys(result).sort(), ["doNotRewrite", "editable", "entries", "leftOut", "reaskObjective"]);
  for (const entry of result.entries) assert.deepEqual(Object.keys(entry).sort(), ["delivered", "leadObjective", "text"]);
  assert.deepEqual(stringsOutsideText(result), [], "nothing but the texts is a string");
  assert.deepEqual(result.entries.map((entry) => entry.text), [
    "flows/[REDACTED]-old.spec.ts — flow: login, objective: use [REDACTED]",
    "flows/[REDACTED]-new.spec.ts — flow: [REDACTED] flow, objective: o",
    "flows/[REDACTED]-failing.spec.ts",
  ]);
});

test("a sanitizer that refuses a text makes the listing throw, whichever text it refuses: no entry is made from a text it did not pass", () => {
  const refuse = (text: string): string => {
    if (text.includes("hunter2")) throw new SecretLeakError("a secret survived redaction");
    return text;
  };
  const refused: Record<string, SuiteListingInput> = {
    "a line of the suite": { existing: ["flows/old.spec.ts — flow: login, objective: use hunter2"] },
    "a spec this run delivered": { delivered: [{ file: "flows/new.spec.ts", objective: "use hunter2" }] },
    "a failing file no entry matches": { fixCases: [failing("flows/hunter2.spec.ts")] },
  };
  for (const [what, input] of Object.entries(refused)) {
    assert.throws(() => listing(input, refuse), SecretLeakError, what);
  }
  assert.equal(listing({ existing: [C_LINE], delivered: [A] }, refuse).entries.length, 2, "texts it passes are listed");
});

/* ── whether the objective is asked again ── */

const reask = (input: SuiteListingInput): boolean => listing(input).reaskObjective;

test("the objective is asked again when nothing is under correction", () => {
  assert.equal(reask({ ...SUITE }), true);
  assert.equal(reask({}), true);
});

test("the objective is not asked again when every spec under correction has an objective its lead declared", () => {
  assert.equal(reask({ ...SUITE, fixCases: [failing("flows/a.spec.ts"), failing("flows/b.spec.ts")] }), false);
  assert.equal(reask({ ...SUITE, coverageGap: "src/cart.ts: lines 10-14" }), false);
  assert.equal(reask({ ...SUITE, reviewCorrections: ["flows/a.spec.ts: assert the total"] }), false);
});

test("the objective is asked again when a spec under correction was in the suite before the run, even with an objective folded into its line", () => {
  assert.equal(reask({ ...SUITE, fixCases: [failing("flows/a.spec.ts"), failing("flows/c.spec.ts")] }), true);
});

test("the objective is asked again when a spec under correction was delivered by a sidekick, or declared no objective", () => {
  assert.equal(reask({ delivered: [A, { file: "s.spec.ts" }], fixCases: [failing("flows/a.spec.ts"), failing("s.spec.ts")] }), true);
  assert.equal(reask({ delivered: [A, { file: "t.spec.ts", flow: "t flow" }], fixCases: [failing("flows/a.spec.ts"), failing("t.spec.ts")] }), true);
});

test("the objective is asked again when a failing file is in no entry: it has no objective", () => {
  assert.equal(reask({ ...SUITE, fixCases: [failing("flows/a.spec.ts"), failing("flows/new.spec.ts")] }), true);
});

test("a spec that is not under correction does not matter: its missing objective asks nothing", () => {
  assert.equal(reask({ existing: [C_LINE], delivered: [A, { file: "s.spec.ts" }], fixCases: [failing("flows/a.spec.ts")] }), false);
});

test("the objective is asked again when a correction flags a spec under correction as having the wrong objective or as a false positive", () => {
  for (const tag of ["[wrong-objective]", "[false-positive]", "[WRONG-OBJECTIVE]", "  [False-Positive]"]) {
    assert.equal(reask({ ...SUITE, reviewCorrections: [`${tag} flows/a.spec.ts: tests an unrelated flow`] }), true, tag);
  }
});

test("a flagged correction that names no spec flags every spec under correction", () => {
  assert.equal(reask({ ...SUITE, reviewCorrections: ["[false-positive] the whole checkout flow asserts nothing"] }), true);
});

test("a correction with another tag, or none, disputes no objective", () => {
  assert.equal(reask({ ...SUITE, reviewCorrections: ["[fragile-selector] flows/a.spec.ts: ambiguous", "[no-cleanup] flows/a.spec.ts: leaves data", "flows/a.spec.ts: not tagged, wrong-objective in prose"] }), false);
});

test("a flag in the middle of a correction is not its tag", () => {
  assert.equal(reask({ ...SUITE, reviewCorrections: ["flows/a.spec.ts: [wrong-objective] quoted from the report"] }), false);
});

test("a flagged correction that names a spec other than the ones under correction asks nothing about them", () => {
  const fixing = { ...SUITE, fixCases: [failing("flows/a.spec.ts")] };
  assert.equal(reask({ ...fixing, reviewCorrections: ["[wrong-objective] flows/b.spec.ts: tests an unrelated flow"] }), false);
  assert.equal(reask({ ...fixing, reviewCorrections: ["[wrong-objective] flows/a.spec.ts: tests an unrelated flow"] }), true);
});

test("a flagged correction that names a name shared by a spec under correction and one that is not still disputes the one under correction", () => {
  const input = {
    delivered: [{ file: "e2e/a.spec.ts", objective: "an objective" }, { file: "e2e/other/a.spec.ts", objective: "another objective" }],
    fixCases: [failing("e2e/a.spec.ts")],
    reviewCorrections: ["[wrong-objective] a.spec.ts: tests an unrelated flow"],
  };
  assert.deepEqual(filesOf(listing(input).editable), ["e2e/a.spec.ts"]);
  assert.equal(reask(input), true);
});

test("with no correction, a listing is judged on its entries alone", () => {
  assert.equal(reask({ ...SUITE, fixCases: [failing("flows/a.spec.ts")] }), false);
  assert.equal(reask({ ...SUITE, fixCases: [failing("flows/c.spec.ts")] }), true);
});
