/*
 * Every way a run can end, pinned in one table (run-end-rows.ts): the verdict, the error class, how far the run got, and what it did
 * to history, publication and learning. A change to what a given end does fails its row; an end with no row fails the coverage check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RUN_END_ROWS } from "./run-end-rows.ts";
import { dispose, factsOf, newRig, observe } from "./run-end-rig.ts";

test("every row of the table has a distinct id", () => {
  const ids = RUN_END_ROWS.map((row) => row.id);
  assert.deepEqual(ids, [...new Set(ids)]);
});

for (const row of RUN_END_ROWS) {
  test(`run end: ${row.id}`, async () => {
    const rig = newRig();
    try {
      row.setup(rig);
      const facts = factsOf(await observe(rig, `end-${row.id}`));
      const { note, ...expected } = row.expect;
      const { note: actualNote, ...actual } = facts;
      assert.deepEqual(actual, expected);
      if (note) assert.match(actualNote, note);
    } finally {
      dispose(rig);
    }
  });
}
