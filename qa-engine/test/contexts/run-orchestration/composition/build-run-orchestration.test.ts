/* buildRunOrchestration: the deploy gate, the run history and the configuration block follow what was supplied, and the pipeline runs over them. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunOrchestration, type RunOrchestrationDeps } from "@contexts/run-orchestration/composition/build-run-orchestration.ts";
import { FileRunHistoryAdapter, InMemoryRunHistoryAdapter } from "@contexts/run-orchestration/infrastructure/adapters/run-history-port.adapter.ts";
import { Sha } from "@kernel/sha.ts";
import type { ServedVersionReaderPort } from "@kernel/ports/served-version-reader.port.ts";
import type { ServedVersionRead } from "@kernel/served-version.ts";

const CONFIG: RunOrchestrationDeps["config"] = {
  needsReview: true,
  shadow: true,
  onFailure: "github-issue",
  maxRetries: 1,
  coveragePolicyMode: "signal",
};

function build(overrides: Partial<RunOrchestrationDeps> = {}) {
  return buildRunOrchestration({ ports: {} as never, config: CONFIG, deployGate: {}, history: {}, ...overrides });
}

/* A reader scripted per read; the last answer repeats. */
function reader(...answers: ServedVersionRead[]): ServedVersionReaderPort & { polled: string[] } {
  const polled: string[] = [];
  return { polled, read: async (url) => (polled.push(url), answers[Math.min(polled.length - 1, answers.length - 1)]!) };
}
const serving = (healthy: boolean | undefined = true): ServedVersionRead => ({ kind: "read", commit: "abc1234", healthy });

test("without a version url the deploy gate declares no source and is always ready", async () => {
  const gate = build().deps.deployGate;

  const verified = await gate.verifyServed(Sha.of("abc1234"), { source: "webhook" });
  assert.deepEqual(verified.ok && verified.value, { state: "undeclared" });
  assert.equal((await gate.waitUntilHealthy()).ok, true);
});

test("with a version url the deploy gate reads it until DEV reports healthy", async () => {
  const source = reader(serving(false), serving(true));

  const result = await build({ deployGate: { versionUrl: "https://dev/version", reader: source, intervalMs: 0 } }).deps.deployGate.waitUntilHealthy();

  assert.equal(result.ok, true);
  assert.deepEqual(source.polled, ["https://dev/version", "https://dev/version"]);
});

test("a gate whose source never reports healthy ends in an infra error at its timeout", async () => {
  const result = await build({ deployGate: { versionUrl: "https://dev/version", reader: reader(serving(false)), intervalMs: 0, timeoutMs: 5 } }).deps.deployGate.waitUntilHealthy();

  assert.equal(result.ok, false);
});

test("a declared version url with nothing wired to read it is a wiring defect, never a silent undeclared", () => {
  assert.throws(() => build({ deployGate: { versionUrl: "https://dev/version" } }), /no reader is wired/);
  assert.throws(() => build({ deployGate: { companions: [{ repo: "org/back", versionUrl: "https://back/version" }] } }), /no reader is wired/);
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

test("each companion repo with a version url gets a gate that reads its own url; a repo without one is not gated", async () => {
  const source = reader(serving());
  const api = build({
    deployGate: {
      reader: source,
      companions: [
        { repo: "org/back", versionUrl: "https://back/version", intervalMs: 0 },
        { repo: "org/static" },
      ],
    },
  });

  const gate = api.deps.companionDeployGates?.get("org/back");
  const result = await gate?.waitUntilHealthy();

  assert.equal(result?.ok, true);
  assert.deepEqual(source.polled, ["https://back/version"]);
  assert.equal(api.deps.companionDeployGates?.has("org/static"), false);
});

test("a run with no companion repos has no companion gates", () => {
  assert.equal(build().deps.companionDeployGates, undefined);
});
