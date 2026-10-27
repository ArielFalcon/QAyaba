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
  const costs = '{ "qa-engine/test/gone.test.ts": 3 }';
  const tree = file("qa-engine/test/real.test.ts", "x");
  assert.deepEqual(check([tree, file("scripts/test-timings.json", costs)]).violations, []);
  assert.deepEqual(check([tree, file("scripts/other.json", costs)]).violations.map((v) => v.rule), ["dead-path"]);
});

test("paths in tests and fixtures are not checked, but banned terms in tests are", () => {
  const test = file("src/a.test.ts", "// docs/gone.md and a Legacy shim");
  assert.deepEqual(check([test, file("docs/real.md", "x")]).violations.map((v) => v.rule), ["legacy"]);
  assert.deepEqual(check([file("qa-engine/test/__fixtures__/x.txt", "docs/gone.md target.ts:9")]).violations, []);
});

test("the odd directory and the review document are skipped", () => {
  assert.equal(isScanned("odd/tasks/x.md"), false);
  assert.equal(isScanned("docs/architecture-remediation.md"), false);
  assert.equal(isScanned("scripts/check-previous-forms.ts"), false);
  assert.equal(isScanned("scripts/previous-forms.allow.json"), false);
  assert.equal(isScanned("src/a.ts"), true);
  assert.deepEqual(check([file("odd/tasks/x.md", "CLAUDE.md codex legacy")]).violations, []);
});
