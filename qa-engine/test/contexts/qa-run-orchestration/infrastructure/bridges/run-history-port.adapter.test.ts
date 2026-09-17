import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryRunHistoryAdapter, FileRunHistoryAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/run-history-port.adapter.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";

function fakeOutcome(runId: string): RunOutcome {
  return {
    runId, app: "app", sha: "abc1234", mode: "diff", target: "e2e", verdict: "pass",
    errorClass: null,
    gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 },
    rulesRetrieved: [], at: new Date().toISOString(),
  };
}

test("InMemoryRunHistoryAdapter.save() persists the outcome, retrievable via list()", async () => {
  const adapter = new InMemoryRunHistoryAdapter();
  const outcome = fakeOutcome("r1");

  await adapter.save(outcome);

  assert.deepEqual(adapter.list(), [outcome]);
});

test("InMemoryRunHistoryAdapter.save() accumulates across multiple calls (no silent overwrite)", async () => {
  const adapter = new InMemoryRunHistoryAdapter();
  await adapter.save(fakeOutcome("r1"));
  await adapter.save(fakeOutcome("r2"));

  assert.equal(adapter.list().length, 2);
});

test("FileRunHistoryAdapter.save() appends a JSON line to the configured file, durable across instances", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run-history-test-"));
  const file = join(dir, "run-history.jsonl");
  try {
    const adapter = new FileRunHistoryAdapter(file);
    await adapter.save(fakeOutcome("r1"));
    await adapter.save(fakeOutcome("r2"));

    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const parsed = lines.map((l) => JSON.parse(l) as RunOutcome);
    assert.equal(parsed[0]?.runId, "r1");
    assert.equal(parsed[1]?.runId, "r2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
