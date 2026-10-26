import { test } from "node:test";
import assert from "node:assert/strict";
import { main, parseArguments, type QuarantineDeps } from "./learning-quarantine.ts";
import type { LearningRule } from "@contexts/cross-run-learning/application/index.ts";

const NOW = new Date("2026-10-12T10:00:00.000Z");

const rule = (id: string, over: Partial<LearningRule> = {}): LearningRule => ({
  id, trigger: `Applies when ${id}\n  runs tsc`, action: "do", errorClass: "E-STATIC", archetype: null, status: "candidate", confidence: "low",
  usageCount: 0, outcomeCount: 0, oracleOutcomeCount: 0, successRate: null, lastVerified: null, source: "run-1", at: "2026-09-15T00:00:00.000Z", ...over,
});

function harness(rules: LearningRule[]) {
  const out: string[] = [];
  const marks: Array<{ app: string; ids: string[] }> = [];
  const deps: QuarantineDeps = {
    repo: {
      listAll: async () => rules.map((r) => ({ ...r })),
      quarantine: async (app, ids, at) => {
        marks.push({ app, ids: [...ids] });
        let n = 0;
        for (const r of rules) if (ids.includes(r.id) && !r.quarantinedAt) { r.quarantinedAt = at; n++; }
        return n;
      },
    },
    now: () => NOW,
    out: (line) => out.push(line),
  };
  return { deps, out, marks };
}

test("--app and --since are required, in either form of a flag, and an unknown flag is refused", () => {
  assert.deepEqual(parseArguments(["--app", "demo", "--since", "2026-09-01"]), { ok: true, app: "demo", since: "2026-09-01", dryRun: false });
  assert.deepEqual(parseArguments(["--since", "2026-09-01", "--app", "demo", "--dry-run"]), { ok: true, app: "demo", since: "2026-09-01", dryRun: true });
  assert.match((parseArguments(["--since", "2026-09-01"]) as { problem: string }).problem, /--app is required/);
  assert.match((parseArguments(["--app", "demo"]) as { problem: string }).problem, /--since is required/);
  assert.match((parseArguments(["--app", "--since", "x"]) as { problem: string }).problem, /--app needs a value/);
  assert.match((parseArguments(["--app", "demo", "--since", "x", "--force"]) as { problem: string }).problem, /unknown argument --force/);
});

test("a bad command line prints the problem and the usage, returns 2 and touches nothing", async () => {
  const { deps, out, marks } = harness([rule("a")]);
  assert.equal(await main(["--app", "demo"], deps), 2);
  assert.match(out.join("\n"), /--since is required/);
  assert.match(out.join("\n"), /usage: npm run learning:quarantine/);
  assert.equal(marks.length, 0);
});

test("a dry run lists each matched rule on one line and says nothing was written", async () => {
  const { deps, out, marks } = harness([rule("a"), rule("old", { at: "2026-01-01T00:00:00.000Z" })]);
  assert.equal(await main(["--app", "demo", "--since", "2026-09-01", "--dry-run"], deps), 0);
  assert.equal(marks.length, 0);
  assert.equal(out.length, 2);
  assert.match(out[0]!, /^ {2}a {2}candidate\/low {2}E-STATIC {2}learned 2026-09-15T00:00:00.000Z {2}Applies when a runs tsc$/);
  assert.equal(out[1], "dry run: 1 rule(s) of demo, learned since 2026-09-01T00:00:00.000Z would be quarantined; nothing was written");
});

test("a real run marks the matching rules of the named app and says how many", async () => {
  const { deps, out, marks } = harness([rule("a"), rule("b", { status: "active", confidence: "high" })]);
  assert.equal(await main(["--app", "demo", "--since", "2026-09-01"], deps), 0);
  assert.deepEqual(marks, [{ app: "demo", ids: ["a", "b"] }]);
  assert.equal(out.at(-1), "quarantined 2 rule(s) of demo, learned since 2026-09-01T00:00:00.000Z");
});

test("running it twice is a no-op the second time and says what it left alone", async () => {
  const { deps, out, marks } = harness([rule("a"), rule("b")]);
  await main(["--app", "demo", "--since", "2026-09-01"], deps);
  out.length = 0;
  assert.equal(await main(["--app", "demo", "--since", "2026-09-01"], deps), 0);
  assert.deepEqual(out, ["nothing to quarantine for demo, learned since 2026-09-01T00:00:00.000Z; 2 already quarantined"]);
  assert.equal(marks.length, 1, "the store was written once");
});

test("a date that is not a date fails the command loudly, before anything is read or written", async () => {
  const { deps, marks } = harness([rule("a")]);
  await assert.rejects(main(["--app", "demo", "--since", "when the gate went live"], deps), /--since must be an ISO date/);
  assert.equal(marks.length, 0);
});
