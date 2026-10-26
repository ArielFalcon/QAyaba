/* buildRunOrchestration: the deploy gate, the run history and the configuration block follow what was supplied, and the pipeline runs over them. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunOrchestration, type RunOrchestrationDeps } from "@contexts/run-orchestration/composition/build-run-orchestration.ts";
import { FileRunHistoryAdapter, InMemoryRunHistoryAdapter } from "@contexts/run-orchestration/infrastructure/adapters/run-history-port.adapter.ts";
import { Sha } from "@kernel/sha.ts";

const CONFIG: RunOrchestrationDeps["config"] = {
  needsReview: true,
  shadow: true,
  onFailure: "github-issue",
  maxRetries: 1,
  isCode: false,
  reviewLoopIntegrity: true,
  coveragePolicyMode: "signal",
};

function build(overrides: Partial<RunOrchestrationDeps> = {}) {
  return buildRunOrchestration({ ports: {} as never, config: CONFIG, deployGate: {}, history: {}, ...overrides });
}

test("without a version url the deploy gate is always ready", async () => {
  const result = await build().deps.deployGate.waitUntilServing(Sha.of("abc1234"));

  assert.equal(result.ok, true);
});

test("with a version url the deploy gate polls it until the sha is serving", async () => {
  const polled: string[] = [];
  const poll = async (url: string) => {
    polled.push(url);
    return { serving: polled.length >= 2 };
  };

  const result = await build({ deployGate: { versionUrl: "https://dev/version", poll, intervalMs: 0 } }).deps.deployGate.waitUntilServing(Sha.of("abc1234"));

  assert.equal(result.ok, true);
  assert.deepEqual(polled, ["https://dev/version", "https://dev/version"]);
});

test("a gate whose sha never serves ends in an infra error at its timeout", async () => {
  const result = await build({ deployGate: { versionUrl: "https://dev/version", poll: async () => ({ serving: false }), intervalMs: 0, timeoutMs: 5 } }).deps.deployGate.waitUntilServing(Sha.of("abc1234"));

  assert.equal(result.ok, false);
});

test("the run history is the explicit store, else the file, else memory", () => {
  const store = new InMemoryRunHistoryAdapter();
  const file = join(mkdtempSync(join(tmpdir(), "run-orchestration-")), "history.json");

  assert.equal(build({ history: { store, filePath: file } }).deps.runHistory, store);
  assert.ok(build({ history: { filePath: file } }).deps.runHistory instanceof FileRunHistoryAdapter);
  assert.ok(build().deps.runHistory instanceof InMemoryRunHistoryAdapter);
});

test("the configuration block records the reviewer independence read once at wiring", () => {
  let reads = 0;
  const api = build({ config: { ...CONFIG, reviewerIndependence: () => (reads++, "distinct-model") } });

  assert.equal(api.deps.config?.reviewerIndependence, "distinct-model");
  assert.equal(reads, 1);
});

test("a reviewer independence that cannot be read leaves the run without it, and warns", () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message: string) => void warnings.push(message);
  try {
    const api = build({
      config: {
        ...CONFIG,
        reviewerIndependence: () => {
          throw new Error("assignment unreadable");
        },
      },
    });

    assert.equal("reviewerIndependence" in (api.deps.config ?? {}), false);
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /assignment unreadable/);
});

test("the pipeline runs over the ports supplied", () => {
  assert.equal(typeof build().pipeline.run, "function");
});
