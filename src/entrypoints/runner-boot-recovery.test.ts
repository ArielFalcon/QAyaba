/*
 * Boot recovery of runs a previous process left unfinished. Its own test file so the recovery sweep
 * only ever sees the records this file creates (each test file gets a fresh history database).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { finalizeInterruptedRuns } from "./runner";
import { createDurableRunEventStore } from "../composition/durable-run-events";
import { getHistory } from "../persistence/index";
import { installLogShipper, type ShippedLine } from "../telemetry/redacting-logger";

test("a run interrupted by a restart is finalized and its event stream ends with a verdict a resuming client sees", () => {
  const rec = getHistory().runs.createRecord({ app: "boot-zombie", sha: "eee5555", target: "e2e", mode: "diff" });
  getHistory().runs.updateRecord(rec.id, { status: "running", step: "execute" });
  const previousProcess = createDurableRunEventStore();
  previousProcess.publish(rec.id, { type: "run.started", app: "boot-zombie", sha: "eee5555", mode: "diff", target: "e2e" });
  const lastSeen = previousProcess.publish(rec.id, { type: "step.changed", step: "execute" });

  const thisProcess = createDurableRunEventStore();
  finalizeInterruptedRuns({ runEvents: thisProcess });

  const record = getHistory().runs.getRecord(rec.id)!;
  assert.equal(record.status, "done");
  assert.equal(record.verdict, "infra-error");
  const resumed = thisProcess.replay(rec.id, lastSeen.seq).map((e) => e.body);
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0]!.type, "run.verdict");
  assert.equal(resumed[0]!.type === "run.verdict" && resumed[0]!.verdict, "infra-error");
});

test("a run interrupted by a restart is announced in the log with the status and step it was left at", () => {
  const rec = getHistory().runs.createRecord({ app: "boot-zombie-line", sha: "fff6666", target: "e2e", mode: "diff" });
  getHistory().runs.updateRecord(rec.id, { status: "running", step: "validate" });
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    finalizeInterruptedRuns({ runEvents: createDurableRunEventStore() });
  } finally {
    console.log = originalLog;
  }
  assert.ok(lines.some((l) => l.includes(`finalized ${rec.id} (boot-zombie-line@fff6666) as infra-error (was running, step validate)`)), `no recovery line in: ${JSON.stringify(lines)}`);
});

test("the recovery line of an interrupted run ships to the log store, since no span records a run the process died under", () => {
  const rec = getHistory().runs.createRecord({ app: "boot-zombie-ship", sha: "aaa7777", target: "e2e", mode: "diff" });
  getHistory().runs.updateRecord(rec.id, { status: "running", step: "generate" });
  const shipped: ShippedLine[] = [];
  installLogShipper((line) => shipped.push(line));
  const originalLog = console.log;
  console.log = () => {};
  try {
    finalizeInterruptedRuns({ runEvents: createDurableRunEventStore() });
  } finally {
    console.log = originalLog;
    installLogShipper(undefined);
  }
  assert.ok(shipped.some((l) => l.message.includes(`finalized ${rec.id}`) && l.message.includes("step generate")), `shipped: ${JSON.stringify(shipped.map((l) => l.message))}`);
});
