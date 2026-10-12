import { test } from "node:test";
import assert from "node:assert/strict";
import { QUARANTINE_SCAN_LIMIT, QuarantineLearnedRulesUseCase } from "@contexts/cross-run-learning/application/quarantine-learned-rules.use-case.ts";
import { parseQuarantineSince, selectForQuarantine } from "@contexts/cross-run-learning/domain/quarantine.ts";
import type { LearningQuarantinePort, LearningRule } from "@contexts/cross-run-learning/application/ports/index.ts";

const SINCE = "2026-09-01T00:00:00.000Z";
const NOW = new Date("2026-10-12T10:00:00.000Z");

const rule = (id: string, over: Partial<LearningRule> = {}): LearningRule => ({
  id, trigger: `Applies when ${id}`, action: "do", errorClass: "E-STATIC", archetype: null, status: "candidate", confidence: "low",
  usageCount: 0, outcomeCount: 0, oracleOutcomeCount: 0, successRate: null, lastVerified: null, source: "run-1", at: "2026-09-15T00:00:00.000Z", ...over,
});

/** A fake store that remembers what was marked, like the real one: marking an already-marked rule changes nothing. */
function fakeStore(rules: LearningRule[]): LearningQuarantinePort & { marks: Array<{ app: string; ids: string[]; at: string }>; scans: Array<[string, number]> } {
  const marks: Array<{ app: string; ids: string[]; at: string }> = [];
  const scans: Array<[string, number]> = [];
  return {
    marks,
    scans,
    listAll: async (app, limit) => { scans.push([app, limit]); return rules.map((r) => ({ ...r })); },
    quarantine: async (app, ids, at) => {
      marks.push({ app, ids: [...ids], at });
      let n = 0;
      for (const r of rules) if (ids.includes(r.id) && !r.quarantinedAt) { r.quarantinedAt = at; n++; }
      return n;
    },
  };
}

test("only an in-force rule learned at or after the date is matched: older, retired and already-quarantined ones are not", () => {
  const { toQuarantine, alreadyQuarantined } = selectForQuarantine(
    [
      rule("new-candidate"),
      rule("new-active", { status: "active", confidence: "high" }),
      rule("on-the-day", { at: SINCE }),
      rule("older", { at: "2026-08-31T23:59:59.999Z" }),
      rule("deprecated", { status: "deprecated" }),
      rule("superseded", { status: "superseded" }),
      rule("done", { quarantinedAt: "2026-10-01T00:00:00.000Z" }),
    ],
    SINCE,
  );
  assert.deepEqual(toQuarantine.map((r) => r.id), ["new-candidate", "new-active", "on-the-day"]);
  assert.deepEqual(alreadyQuarantined.map((r) => r.id), ["done"]);
});

test("a date is read as UTC ISO whatever its form, and a value that is not a date is refused naming the flag", () => {
  assert.equal(parseQuarantineSince("2026-09-01"), "2026-09-01T00:00:00.000Z");
  assert.equal(parseQuarantineSince(" 2026-09-01T02:00:00+02:00 "), "2026-09-01T00:00:00.000Z");
  for (const bad of ["", "   ", "yesterday", "2026-13-45"]) assert.throws(() => parseQuarantineSince(bad), /--since/, bad);
});

test("a run marks the matching rules at the moment it ran and reports them", async () => {
  const store = fakeStore([rule("a"), rule("b", { status: "active" }), rule("old", { at: "2026-01-01T00:00:00.000Z" })]);
  const report = await new QuarantineLearnedRulesUseCase(store, () => NOW).execute({ app: "demo", since: "2026-09-01", dryRun: false });
  assert.deepEqual(store.marks, [{ app: "demo", ids: ["a", "b"], at: NOW.toISOString() }]);
  assert.deepEqual([report.matched.map((r) => r.id), report.marked, report.alreadyQuarantined, report.since, report.dryRun], [["a", "b"], 2, 0, SINCE, false]);
});

test("a dry run reports what it would mark and writes nothing", async () => {
  const store = fakeStore([rule("a"), rule("b")]);
  const report = await new QuarantineLearnedRulesUseCase(store, () => NOW).execute({ app: "demo", since: "2026-09-01", dryRun: true });
  assert.equal(store.marks.length, 0);
  assert.deepEqual([report.matched.map((r) => r.id), report.marked, report.dryRun], [["a", "b"], 0, true]);
});

test("running it twice marks each rule once: the second run matches nothing, counts the first run's rules and writes nothing", async () => {
  const store = fakeStore([rule("a"), rule("b")]);
  const useCase = new QuarantineLearnedRulesUseCase(store, () => NOW);
  await useCase.execute({ app: "demo", since: "2026-09-01", dryRun: false });
  const second = await useCase.execute({ app: "demo", since: "2026-09-01", dryRun: false });
  assert.deepEqual([second.matched.length, second.marked, second.alreadyQuarantined], [0, 0, 2]);
  assert.equal(store.marks.length, 1, "the store was written once");
});

test("a rule learned after the first run is marked by the next, and only it", async () => {
  const rules = [rule("a")];
  const store = fakeStore(rules);
  const useCase = new QuarantineLearnedRulesUseCase(store, () => NOW);
  await useCase.execute({ app: "demo", since: "2026-09-01", dryRun: false });
  rules.push(rule("later", { at: "2026-10-05T00:00:00.000Z" }));
  const second = await useCase.execute({ app: "demo", since: "2026-09-01", dryRun: false });
  assert.deepEqual(second.matched.map((r) => r.id), ["later"]);
});

test("an app is required, and a missing or invalid date stops the command before anything is read", async () => {
  const store = fakeStore([rule("a")]);
  const useCase = new QuarantineLearnedRulesUseCase(store, () => NOW);
  await assert.rejects(useCase.execute({ app: "  ", since: "2026-09-01", dryRun: false }), /--app/);
  await assert.rejects(useCase.execute({ app: "demo", since: "soon", dryRun: false }), /--since/);
  assert.equal(store.scans.length, 0);
});

test("a ledger as large as the scan limit stops the command rather than quarantine a part of it", async () => {
  const store = fakeStore(Array.from({ length: QUARANTINE_SCAN_LIMIT }, (_, i) => rule(`r${i}`)));
  await assert.rejects(new QuarantineLearnedRulesUseCase(store, () => NOW).execute({ app: "demo", since: "2026-09-01", dryRun: false }), /scan that may have missed some/);
  assert.equal(store.marks.length, 0);
});
