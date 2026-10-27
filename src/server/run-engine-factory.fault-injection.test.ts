/* The response oracle re-runs the suite with corrupted responses and asks how many it corrupted by reading the counter file each worker leaves under `.qa/fault-injection/<namespace>`. The workers run code the agent wrote, so a counter can be a named pipe or a link, and the composition root must hand the oracle a reader that waits on neither and follows neither, and that gives a count only when every counter could be read. A fake `playwright` binary stands in for the runner at the process boundary: it leaves the counters a worker would, and whatever the case plants beside them. Apart from run-engine-factory.test.ts, whose many tests would all run once per mutant. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEngineRootDeps } from "./run-engine-factory";
import type { AppConfig } from "../orchestrator/config-loader";
import type { AgentDeps } from "../integrations/opencode-client";
import { Sha } from "@kernel/sha";
import { BlastRadius } from "@kernel/blast-radius";
import { operationKey, type FaultAim } from "@contexts/objective-signal/application/index";
import { withoutWaitingOnNamedPipe } from "../../qa-engine/test/support/named-pipe-watch";

const NAMESPACE = "qa-bot-abc1234-run1";
const BASELINE_CASE = "login.spec.ts › shows the dashboard";
const OPERATION = { verb: "GET", pattern: "^/api/dashboard/?$" };
const KEY = operationKey(OPERATION);
const AIM: FaultAim = { operations: [OPERATION], candidates: [], specToCandidates: [] };
/* The counter a worker leaves for the one case, naming the operation it corrupted. */
const COUNTER = `JSON.stringify({ corrupted: 1, byOperation: { ${JSON.stringify(KEY)}: 1 }, test: "login.spec.ts::shows the dashboard" })`;

const app = (): AppConfig => ({
  name: "factory-fault-injection",
  repo: "org/demo",
  dev: { baseUrl: "https://dev" },
  qa: { needsReview: true, testDataPrefix: "qa-bot", shadow: true, valueOracle: "signal" },
  report: { onFailure: "github-issue" },
});

function stubAgentDeps(): AgentDeps {
  return {
    open: async () => {
      throw new Error("stubAgentDeps.open must never be called during factory construction");
    },
  };
}

function canMakeNamedPipes(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "qayaba-fault-fifo-probe-"));
  try {
    execFileSync("mkfifo", [join(dir, "probe")]);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const NO_NAMED_PIPES = canMakeNamedPipes() ? false : "mkfifo is not available on this platform, so the named-pipe case is not exercised";

/* A Playwright that fails the one baseline case under corruption, and leaves the counters the suite below asks for. `plant` runs in the counter directory of the re-run. */
function fakePlaywright(plant: string): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const marks = path.join(process.cwd(), ".qa", "fault-injection", process.env.PW_NAMESPACE);
fs.mkdirSync(marks, { recursive: true });
${plant}
fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_NAME, JSON.stringify({
  suites: [{ title: "login.spec.ts", specs: [{ title: "shows the dashboard", tests: [{ status: "unexpected", results: [{ status: "failed", error: { message: "dashboard heading missing" } }] }] }] }],
  stats: { expected: 0, unexpected: 1 },
}));
process.exit(1);
`;
}

/* <tmp>/e2e is the project the oracle re-runs; <tmp>/outside is what no read may reach. */
async function withOracleRun(plant: string, run: (measure: () => Promise<{ valueScore: number | null; killedCount: number | null; details?: string }>, counterDir: string, outside: string) => Promise<void>, aim: FaultAim | "no-scope" = AIM): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "qayaba-fault-injection-"));
  const e2eDir = join(tmp, "e2e");
  const outside = join(tmp, "outside");
  try {
    mkdirSync(join(e2eDir, "node_modules", ".bin"), { recursive: true });
    mkdirSync(outside);
    const bin = join(e2eDir, "node_modules", ".bin", "playwright");
    writeFileSync(bin, fakePlaywright(plant.replaceAll("OUTSIDE", JSON.stringify(outside))));
    chmodSync(bin, 0o755);
    const config = buildEngineRootDeps(app(), { getAgentDeps: stubAgentDeps }, NAMESPACE, { mode: "diff" });
    /* The oracle's re-run is a child of the run's sandbox: it needs the scope a run opens. */
    const session = await config.execScope!.open({ runId: `fault-injection-${randomUUID()}` });
    try {
      await run(
        () => session.run(() => config.objectiveSignal.oracle.measure(BlastRadius.of(Sha.of("abc1234"), ["src/login.ts"]), e2eDir, NAMESPACE, [BASELINE_CASE], aim === "no-scope" ? undefined : aim)),
        join(e2eDir, ".qa", "fault-injection", `${NAMESPACE}-fi`),
        outside,
      );
    } finally {
      session.close();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test("a counter the corrupted re-run left is counted, and a suite that corrupted a response is scored", async () => {
  await withOracleRun(`fs.writeFileSync(path.join(marks, "injected-1.json"), ${COUNTER});`, async (measure) => {
    const result = await measure();

    assert.notEqual(result.valueScore, null, `the corrupted re-run is conclusive, got: ${result.details}`);
    assert.equal(result.killedCount, 1);
  });
});

test("a counter that is a named pipe is not waited on, and the oracle is inconclusive: the counter beside it is a part of the count, not the count", { skip: NO_NAMED_PIPES }, async () => {
  let noCounterAtAll: string | undefined;
  await withOracleRun("", async (measure) => {
    noCounterAtAll = (await measure()).details;
  });

  await withOracleRun(
    `fs.writeFileSync(path.join(marks, "injected-1.json"), ${COUNTER});\nexecFileSync("mkfifo", [path.join(marks, "injected-2.json")]);`,
    async (measure, counterDir) => {
      const result = await withoutWaitingOnNamedPipe(join(counterDir, "injected-2.json"), measure);

      assert.equal(result.valueScore, null, "no score is made from a part of the count");
      assert.equal(result.killedCount, null);
      assert.ok(result.details && result.details.length > 0, "and it says why");
      assert.notEqual(result.details, noCounterAtAll, "which is not the claim that no response was there to corrupt");
    },
  );
});

test("a counter that is a link to a file outside the project leaves the count unknown, so a suite that corrupted nothing is not scored on its word", async () => {
  await withOracleRun(
    `fs.writeFileSync(path.join(OUTSIDE, "counter.json"), JSON.stringify({ corrupted: 7 }));\nfs.symlinkSync(path.join(OUTSIDE, "counter.json"), path.join(marks, "injected-1.json"));`,
    async (measure) => {
      const result = await measure();

      assert.equal(result.valueScore, null, "the count is unknown, so there is no score");
    },
  );
});

test("the operations the oracle is aimed at reach the suite as the only operations it may corrupt", async () => {
  await withOracleRun(`fs.writeFileSync(path.join(marks, "injected-1.json"), ${COUNTER});\nfs.writeFileSync(path.join(OUTSIDE, "operations.json"), process.env.QA_FAULT_INJECT_OPERATIONS ?? "unset");\nfs.writeFileSync(path.join(OUTSIDE, "switch.txt"), process.env.QA_FAULT_INJECT ?? "unset");`, async (measure, _counterDir, outside) => {
    await measure();

    assert.deepEqual(JSON.parse(readFileSync(join(outside, "operations.json"), "utf8")), [OPERATION]);
    assert.equal(readFileSync(join(outside, "switch.txt"), "utf8"), "1");
  });
});

test("with no operation in reach, or no change scope, the corrupted re-run is not launched and no score is given", async () => {
  for (const aim of ["no-scope" as const, { ...AIM, operations: [] }]) {
    await withOracleRun(`fs.writeFileSync(path.join(OUTSIDE, "launched.txt"), "yes");`, async (measure, _counterDir, outside) => {
      const result = await measure();

      assert.equal(result.valueScore, null);
      assert.match(result.details ?? "", /no operation of the change is in reach/);
      assert.equal(existsSync(join(outside, "launched.txt")), false, "nothing is run that would corrupt a response the change does not reach");
    }, aim);
  }
});
