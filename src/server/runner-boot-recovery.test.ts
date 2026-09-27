/*
 * Boot recovery of runs a previous process left unfinished. Its own test file so the recovery sweep
 * only ever sees the records this file creates (each test file gets a fresh history database).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { finalizeInterruptedRuns } from "./runner";
import { createRecord, getRecord, updateRecord } from "./history";
import { createDurableRunEventStore } from "./durable-run-events";

test("a run interrupted by a restart is finalized and its event stream ends with a verdict a resuming client sees", () => {
  const rec = createRecord({ app: "boot-zombie", sha: "eee5555", target: "e2e", mode: "diff" });
  updateRecord(rec.id, { status: "running", step: "execute" });
  const previousProcess = createDurableRunEventStore();
  previousProcess.publish(rec.id, { type: "run.started", app: "boot-zombie", sha: "eee5555", mode: "diff", target: "e2e" });
  const lastSeen = previousProcess.publish(rec.id, { type: "step.changed", step: "execute" });

  const thisProcess = createDurableRunEventStore();
  finalizeInterruptedRuns({ runEvents: thisProcess });

  const record = getRecord(rec.id)!;
  assert.equal(record.status, "done");
  assert.equal(record.verdict, "infra-error");
  const resumed = thisProcess.replay(rec.id, lastSeen.seq).map((e) => e.body);
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0]!.type, "run.verdict");
  assert.equal(resumed[0]!.type === "run.verdict" && resumed[0]!.verdict, "infra-error");
});
