import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPreviousForms, formatResult, isScanned, type AllowEntry, type SourceFile } from "./check-previous-forms";

const file = (path: string, content: string): SourceFile => ({ path, content });
const check = (files: SourceFile[], allow: AllowEntry[] = []) => checkPreviousForms(files, allow);

test("a banned term in a file is reported with rule, path and line", () => {
  const result = check([file("src/a.ts", "const fine = 1;\n// the cutover is done\n")]);
  assert.deepEqual(
    result.violations.map((v) => [v.rule, v.path, v.line]),
    [["narration", "src/a.ts", 2]],
  );
  assert.match(formatResult(result)[0]!, /^narration src\/a\.ts:2 /);
});

test("each banned family is matched, case-insensitively where it says so", () => {
  const samples: Array<[string, string]> = [
    ["engine-flag", "PIPELINE_ENGINE=x"],
    ["rewritten-name", "RewrittenFactory"],
    ["legacy", "a Legacy adapter"],
    ["bridges", "see infrastructure/bridges/x"],
    ["codex", "the Codex runtime"],
    ["dual-mode", "AGENT_RUNTIME_MODE=dual"],
    ["router-kind", 'kind: "router"'],
    ["claude-md", "see CLAUDE.md"],
    ["codebase-memory", "the codebase-memory graph"],
    ["narration", "a frozen oracle"],
  ];
  for (const [rule, text] of samples) {
    const rules = check([file("docs/x.md", text)]).violations.map((v) => v.rule);
    assert.ok(rules.includes(rule), `${rule} matches ${JSON.stringify(text)}`);
  }
});

test("ordinary English about a rewritten spec is not a banned term", () => {
  assert.deepEqual(check([file("scripts/c.ts", "the login was rewritten by the agent; a rewritten spec runs again")]).violations, []);
});

test("an allow-listed hit passes and is counted", () => {
  const allow: AllowEntry[] = [{ rule: "claude-md", path: "AGENTS.md", contains: "watched repo", reason: "a watched repo's own file" }];
  const result = check([file("AGENTS.md", "A watched repo's CLAUDE.md stays prompt text.")], allow);
  assert.deepEqual(result.violations, []);
  assert.equal(result.allowed, 1);
});

test("an allow-list entry for another path or substring does not hide a hit", () => {
  const allow: AllowEntry[] = [{ rule: "claude-md", path: "AGENTS.md", contains: "watched repo", reason: "x" }];
  assert.equal(check([file("docs/y.md", "A watched repo's CLAUDE.md")], allow).violations.length, 1);
  assert.equal(check([file("AGENTS.md", "see CLAUDE.md for details")], allow).violations.length, 1);
});

test("an allow-list entry that matches nothing fails the check", () => {
  const allow: AllowEntry[] = [{ rule: "codex", path: "docs/x.md", contains: "gone", reason: "x" }];
  const result = check([file("docs/x.md", "clean text")], allow);
  assert.deepEqual(result.unusedAllow, allow);
  assert.match(formatResult(result).join("\n"), /unused-allow codex docs\/x\.md/);
});

test("a citation past the end of its file fails and one inside it passes", () => {
  const target = file("src/target.ts", "a\nb\nc\n");
  const past = check([target, file("docs/n.md", "see target.ts:9")]);
  assert.deepEqual(past.violations.map((v) => v.rule), ["dead-citation"]);
  assert.deepEqual(check([target, file("docs/n.md", "see target.ts:3 and target.ts:1-2")]).violations, []);
});

test("a citation to a file nothing tracks fails, and a compiler-style location is not a citation", () => {
  assert.deepEqual(check([file("docs/n.md", "see missing.ts:4")]).violations.map((v) => v.rule), ["dead-citation"]);
  assert.deepEqual(check([file("docs/n.md", "error at spec.ts:3:1 - TS1005")]).violations, []);
});

test("a path token to a missing repo file fails and a fixture-root path is ignored", () => {
  const files = [file("docs/real.md", "x"), file("docs/n.md", "see docs/real.md, docs/gone.md and web/src/app/orders/page.ts")];
  const result = check(files);
  assert.deepEqual(result.violations.map((v) => [v.rule, v.text.split(" — ")[0]]), [["dead-path", "docs/gone.md"]]);
});

test("a path token that git ignores (user data) is not a dead reference", () => {
  const files = [file("docs/real.md", "x"), file("docs/n.md", "copy to config/apps/my-app.yaml")];
  const ignored = (path: string): boolean => path.startsWith("config/apps/");
  assert.deepEqual(checkPreviousForms([...files, file("config/example.yaml", "x")], [], files.concat(file("config/example.yaml", "x")).map((f) => f.path), ignored).violations, []);
});

test("the test runner's recorded file costs may name a test file since deleted: its paths are not checked", () => {
  const costs = '{ "engine/test/gone.test.ts": 3 }';
  const tree = file("engine/test/real.test.ts", "x");
  assert.deepEqual(check([tree, file("scripts/test-timings.json", costs)]).violations, []);
  assert.deepEqual(check([tree, file("scripts/other.json", costs)]).violations.map((v) => v.rule), ["dead-path"]);
});

test("paths in tests and fixtures are not checked, but banned terms in tests are", () => {
  const test = file("src/a.test.ts", "// docs/gone.md and a Legacy shim");
  assert.deepEqual(check([test, file("docs/real.md", "x")]).violations.map((v) => v.rule), ["legacy"]);
  assert.deepEqual(check([file("engine/test/__fixtures__/x.txt", "docs/gone.md target.ts:9")]).violations, []);
});

test("the odd directory and the review document are skipped", () => {
  assert.equal(isScanned("odd/tasks/x.md"), false);
  assert.equal(isScanned("docs/architecture-remediation.md"), false);
  assert.equal(isScanned("scripts/check-previous-forms.ts"), false);
  assert.equal(isScanned("scripts/previous-forms.allow.json"), false);
  assert.equal(isScanned("src/a.ts"), true);
  assert.deepEqual(check([file("odd/tasks/x.md", "CLAUDE.md codex legacy")]).violations, []);
});

test("a dead path or citation under docs/architecture passes, because the records name files later deletions remove", () => {
  const tree = file("docs/real.md", "x");
  const record = file("docs/architecture/adr/0001-x.md", "see src/server/gone.ts, docs/gone.md and target.ts:9");
  assert.deepEqual(check([tree, record]).violations, []);
});

test("a banned term under docs/architecture still fails", () => {
  const record = file("docs/architecture/adr/0001-x.md", "the Legacy adapter and CLAUDE.md");
  assert.deepEqual(check([record]).violations.map((v) => v.rule).sort(), ["claude-md", "legacy"]);
});

test("a dead path or citation outside docs/architecture still fails, including a sibling that only shares the prefix", () => {
  const tree = file("docs/real.md", "x");
  for (const path of ["docs/guide.md", "docs/architecture-notes.md", "README.md"]) {
    const rules = check([tree, file(path, "see docs/gone.md and missing.ts:4")]).violations.map((v) => v.rule);
    assert.deepEqual(rules, ["dead-path", "dead-citation"], path);
  }
});

test("a retired name fails outside docs/architecture and passes in the records, which cite it on purpose", () => {
  const retired = "the taxonomy in src/errors.ts";
  assert.deepEqual(check([file("docs/guide.md", retired)]).violations.map((v) => v.rule), ["shell-error-taxonomy"]);
  assert.deepEqual(check([file("docs/architecture/adr/0001-x.md", retired)]).violations, []);
});

test("a name of the deleted diff tiers fails outside docs/architecture and passes in the records, which cite it on purpose", () => {
  for (const name of ["DIFF_TIERS", "diffTier(stat)", "EFFORT_BY_TIER", "DIFF_TIME_BUDGET_MS", "resolveDiffTimeBudgets", "QA_DIFF_TIME_BUDGET_MS_TINY"]) {
    const text = `the size is read by ${name}`;
    assert.deepEqual(check([file("docs/guide.md", text)]).violations.map((v) => v.rule), ["diff-tier"], name);
    assert.deepEqual(check([file("docs/architecture/rfc/0014-x.md", text)]).violations, [], name);
  }
});

test("the operator's own size label of a benchmark case is not a deleted tier name", () => {
  assert.deepEqual(check([file("scripts/efficiency-benchmark.ts", "export const DIFF_TIER_NAMES = [\"tiny\"] as const;\ntype DiffTier = string;\n")]).violations, []);
});

test("the retired roots fail outside the records, in every path form, and their legitimate look-alikes pass", () => {
  for (const text of [
    "the factory lives in src/composition/engine-root.ts",
    "import x from '../../src/settings/registry'",
    "see ./src/entrypoints/api.ts",
    "the root qa-engine/src/contexts",
    "@qayaba/qa-engine",
    "qa-engine",
  ]) {
    assert.deepEqual(check([file("docs/guide.md", text)]).violations.map((v) => v.rule), ["retired-roots"], text);
    assert.deepEqual(check([file("docs/architecture/adr/0001-x.md", text)]).violations, [], text);
  }
  for (const text of [
    "platform/composition/engine-root.ts and engine/src/contexts",
    "a fixture app's src/app/cart.ts and its <img src=\"/a.png\">",
    "packages/sdk/src/composition/x.ts and web/src/settings/y.ts",
    "const src = readFileSync(file)",
  ]) {
    assert.deepEqual(check([file("docs/guide.md", text)]).violations, [], text);
  }
});

test("the roots' migration plan and the shipped seed revisions may name the retired roots", () => {
  const text = "src/ → platform/ and qa-engine/ → engine/";
  assert.deepEqual(check([file("docs/engine-platform-architecture.md", text)]).violations, []);
  assert.deepEqual(check([file("engine/test/contexts/workspace-and-publication/infrastructure/__fixtures__/seed-revisions/failure-capture.rev9.txt", "qa-engine/src/x.ts")]).violations, []);
});
