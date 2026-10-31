/* The first lesson kind through its public seam: which reads are admitted, why a read is left out, and when a lesson exists. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SERVED_VERSION_STATES, type ServedVersionState } from "@kernel/served-version.ts";
import type { PageDataRead } from "@kernel/page-data-read.ts";
import type { LessonObservation } from "@contexts/cross-run-learning/domain/lesson-kinds.ts";
import { LESSON_KINDS, deriveLessons, lessonKind } from "@contexts/cross-run-learning/domain/lesson-registry.ts";

const kind = lessonKind("data-volatility");

const WITH_RESULTS: PageDataRead = { scope: "/shops/madrid", grounded: true, dataState: true, unconfirmed: false, resultCount: 3, ready: true };
const EMPTY: PageDataRead = { scope: "/shops/madrid", grounded: true, dataState: true, unconfirmed: false, resultCount: 0, emptyConfirmed: true, ready: true };

test("each of the six served-version states is admitted or left out under its own typed reason", () => {
  const outcomes = Object.fromEntries(SERVED_VERSION_STATES.map((state) => [state, kind.admit(WITH_RESULTS, state)]));
  assert.deepEqual(outcomes, {
    undeclared: { admitted: false, reason: "served-version:undeclared" },
    unreadable: { admitted: false, reason: "served-version:unreadable" },
    equal: { admitted: true },
    behind: { admitted: false, reason: "served-version:behind" },
    ahead: { admitted: true },
    unrelated: { admitted: false, reason: "served-version:unrelated" },
  });
});

test("a read that cannot be trusted is left out with the one reason that names why, after the served-version state", () => {
  assert.deepEqual(kind.admit({ ...WITH_RESULTS, grounded: false }, "equal"), { admitted: false, reason: "not-captured" });
  assert.deepEqual(kind.admit({ ...WITH_RESULTS, dataState: undefined }, "equal"), { admitted: false, reason: "no-data-state" });
  assert.deepEqual(kind.admit({ ...WITH_RESULTS, unconfirmed: true, resultCount: 0 }, "equal"), { admitted: false, reason: "unconfirmed-read" });
  assert.deepEqual(kind.admit({ ...WITH_RESULTS, grounded: false, dataState: undefined, unconfirmed: true }, "behind"), { admitted: false, reason: "served-version:behind" });
  assert.deepEqual(kind.admit({ ...WITH_RESULTS, grounded: false, dataState: undefined }, "equal"), { admitted: false, reason: "not-captured" });
});

test("an empty state confirmed on two settled reads is a trusted read, not a left-out one", () => {
  assert.deepEqual(kind.admit(EMPTY, "equal"), { admitted: true });
  assert.deepEqual(kind.factOf(EMPTY), { resultCount: 0, emptyConfirmed: true, ready: true });
  assert.deepEqual(kind.factOf({ scope: "/x", grounded: true, dataState: true, unconfirmed: false }), {});
});

let seq = 0;
function observed(read: PageDataRead, at: string, over: Partial<LessonObservation> = {}): LessonObservation {
  seq += 1;
  return { id: `o${seq}`, app: "demo", runId: `run-${seq}`, sha: "abc1234", repo: "org/demo", kind: "data-volatility", scope: read.scope, servedState: "equal", admitted: true, leftOutReason: null, fact: kind.factOf(read), at, ...over };
}

test("a lesson exists when the admitted reads of a scope show both states, and carries what it rests on", () => {
  const rows = [observed(WITH_RESULTS, "2026-10-30T10:00:00.000Z"), observed(EMPTY, "2026-10-30T12:00:00.000Z"), observed(WITH_RESULTS, "2026-10-30T08:00:00.000Z")];
  const [lesson, ...rest] = deriveLessons(rows);
  assert.equal(rest.length, 0);
  assert.deepEqual({ ...lesson, evidence: undefined }, { kind: "data-volatility", scope: "/shops/madrid", withResults: 2, emptyConfirmed: 1, latestReadAt: "2026-10-30T12:00:00.000Z", evidence: undefined });
  assert.deepEqual(lesson!.evidence, rows.map((r) => r.runId).sort());
});

test("no lesson exists from one state alone, however many reads show it, and the count of reads decides nothing", () => {
  assert.deepEqual(deriveLessons([observed(WITH_RESULTS, "2026-10-30T10:00:00.000Z"), observed(WITH_RESULTS, "2026-10-30T11:00:00.000Z")]), []);
  assert.deepEqual(deriveLessons([observed(EMPTY, "2026-10-30T10:00:00.000Z")]), []);
  assert.equal(deriveLessons([observed(WITH_RESULTS, "2026-10-30T10:00:00.000Z"), observed(EMPTY, "2026-10-30T11:00:00.000Z")]).length, 1, "two reads are enough");
});

test("a left-out read is never an input, whatever it holds", () => {
  const rows = [observed(WITH_RESULTS, "2026-10-30T10:00:00.000Z"), observed(EMPTY, "2026-10-30T11:00:00.000Z", { admitted: false, leftOutReason: "served-version:behind", servedState: "behind" })];
  assert.deepEqual(deriveLessons(rows), []);
});

test("two runs with the same stored rows derive the same lessons, in whatever order the rows come", () => {
  const rows = [
    observed(WITH_RESULTS, "2026-10-30T10:00:00.000Z"),
    observed(EMPTY, "2026-10-30T11:00:00.000Z"),
    observed({ ...WITH_RESULTS, scope: "/offers" }, "2026-10-30T10:00:00.000Z"),
    observed({ ...EMPTY, scope: "/offers" }, "2026-10-30T10:30:00.000Z"),
  ];
  assert.deepEqual(deriveLessons(rows), deriveLessons([...rows].reverse()));
  assert.deepEqual(deriveLessons(rows).map((l) => l.scope), ["/offers", "/shops/madrid"]);
});

test("the registry knows each kind by its id", () => {
  assert.deepEqual(LESSON_KINDS.map((k) => k.id), ["data-volatility"]);
  assert.throws(() => lessonKind("nope" as never), /unknown lesson kind/);
});
