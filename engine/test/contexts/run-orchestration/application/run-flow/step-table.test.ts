/* The step tables and the closed set of end reasons: a step has one id, and every end reason is the reason of a way a run ends. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { BEFORE_WORKSPACE, IN_WORKSPACE } from "@contexts/run-orchestration/application/run-flow/run-steps.ts";
import { STEP_IDS } from "@contexts/run-orchestration/application/run-flow/step-ids.ts";
import { END_REASONS } from "@contexts/run-orchestration/application/run-flow/run-end.ts";
import { RUN_END_ROWS } from "./run-end-rows.ts";

const TABLE_IDS = [...BEFORE_WORKSPACE, ...IN_WORKSPACE].map((step) => step.id);

test("every step of the two tables has an id of its own, and every id belongs to a step", () => {
  assert.deepEqual(TABLE_IDS, [...new Set(TABLE_IDS)]);
  assert.deepEqual([...TABLE_IDS].sort(), [...STEP_IDS].sort());
});

test("every end reason is the reason of at least one row of the run-end table, and every row names a member of the set", () => {
  const named = RUN_END_ROWS.flatMap((row) => (row.endReason ? [row.endReason] : []));
  assert.deepEqual([...new Set(named)].sort(), [...END_REASONS].sort());
});

test("the rows that carry no end reason are the runs that ended on an error nothing handled", () => {
  const without = RUN_END_ROWS.filter((row) => row.endReason === undefined).map((row) => row.id);
  assert.deepEqual(without, ["unhandled-error-with-evidence", "unhandled-error-without-evidence", "untrusted-git-tree"]);
});
