/* The append-only record of what runs read of DEV, through the history's public seam. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openHistoryDatabase } from "../database";
import { createHistory, getHistory } from "../index";
import type { LessonObservation } from "@contexts/cross-run-learning/application/index";

let seq = 0;
function row(over: Partial<LessonObservation> = {}): LessonObservation {
  seq += 1;
  return {
    id: `r${seq}#data-volatility#0`, app: "lessons-app", runId: `r${seq}`, sha: "abc1234", repo: "org/demo", kind: "data-volatility", scope: "/shops", servedState: "equal",
    admitted: true, leftOutReason: null, fact: { resultCount: 2, ready: true }, at: "2026-10-30T10:00:00.000Z", ...over,
  };
}

function inMemoryHistory(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "lesson-repo-"));
  const db = openHistoryDatabase(join(dir, "history.db"));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return createHistory(db);
}

test("rows are stored whole, left-out ones with their reason, and read back as they were written", async (t) => {
  const { lessons } = inMemoryHistory(t);
  const admitted = row({ fact: { resultCount: 0, emptyConfirmed: true, ready: true } });
  const leftOut = row({ admitted: false, leftOutReason: "served-version:behind", servedState: "behind", scope: "/shops" });
  lessons.record([admitted, leftOut]);
  const listed = lessons.listAdmitted({ app: "lessons-app", scopes: ["/shops"], before: "2026-10-31T00:00:00.000Z" });
  assert.deepEqual(listed, [admitted], "only admitted rows are inputs");
  assert.deepEqual(lessons.countByApp("lessons-app"), { admitted: 1, leftOut: 1 });
});

test("listing is by app, scope and strict time, and in a fixed order whatever the order of writing", (t) => {
  const { lessons } = inMemoryHistory(t);
  const early = row({ at: "2026-10-29T10:00:00.000Z" });
  const late = row({ at: "2026-10-30T10:00:00.000Z" });
  const elsewhere = row({ scope: "/other" });
  const otherApp = row({ app: "someone-else" });
  lessons.record([late, otherApp, elsewhere, early]);
  const query = { app: "lessons-app", scopes: ["/shops"], before: "2026-10-30T10:00:00.000Z" };
  assert.deepEqual(lessons.listAdmitted(query).map((r) => r.id), [early.id], "the instant of the run's start is not before it");
  assert.deepEqual(lessons.listAdmitted({ ...query, before: "2026-10-31T00:00:00.000Z" }).map((r) => r.id), [early.id, late.id]);
  assert.deepEqual(lessons.listAdmitted({ ...query, scopes: [] }), []);
});

test("the table is append-only: a row is never replaced, and writing the same row twice is refused", (t) => {
  const { lessons } = inMemoryHistory(t);
  const first = row();
  lessons.record([first]);
  assert.throws(() => lessons.record([{ ...first, admitted: false, leftOutReason: "no-data-state" }]), /UNIQUE|constraint/i);
  assert.deepEqual(lessons.listAdmitted({ app: "lessons-app", scopes: ["/shops"], before: "2027-01-01T00:00:00.000Z" }), [first]);
  assert.equal("update" in lessons || "delete" in lessons, false);
});

test("a batch is written whole or not at all", (t) => {
  const { lessons } = inMemoryHistory(t);
  const good = row();
  assert.throws(() => lessons.record([good, good]));
  assert.deepEqual(lessons.countByApp("lessons-app"), { admitted: 0, leftOut: 0 });
});

test("purging an app removes its observations and no other app's", () => {
  const { lessons, purgeApp } = getHistory();
  const mine = row({ app: "lessons-purge-app" });
  const theirs = row({ app: "lessons-purge-other" });
  lessons.record([mine, theirs]);
  purgeApp("lessons-purge-app");
  assert.deepEqual(lessons.countByApp("lessons-purge-app"), { admitted: 0, leftOut: 0 });
  assert.deepEqual(lessons.countByApp("lessons-purge-other"), { admitted: 1, leftOut: 0 });
  purgeApp("lessons-purge-other");
});
