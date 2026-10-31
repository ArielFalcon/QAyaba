/*
 * Manual trigger. Routes through a sequential funnel (enqueueTrackedRun → JobQueue), so a
 * manual run is queued, recorded in history and addressable. It then drains the queue and
 * exits with the run's verdict.
 * npm run qa -- --app <app> --sha <sha> [--mode diff|manual|context]
 * [--guidance "..."] [--closed-loop on|off]
 * [--agent-browser on|off] [--dom-pack on|off]
 * IMPORTANT: this CLI uses its OWN in-process queue. If the long-lived service is also
 * running on this host it has a SEPARATE queue, so a CLI run could execute QA against DEV
 * concurrently with a service run — breaking the "one run at a time against DEV" invariant.
 * We therefore always refuse the standalone path when the local service answers its health
 * probe, with no override, and delegate the run to that service instead (runViaService) — it
 * then executes inside the server process, so the service is the single writer of the
 * coordination telemetry ledger both processes resolve to (resolveCoordinationTelemetryPath).
 */

import { fileURLToPath } from "node:url";
import { JobQueue } from "../entrypoints/queue";
import { qayabaRoot } from "../settings/paths";
import { enqueueTrackedRun } from "../entrypoints/runner";
import { processTelemetry, TELEMETRY_SHUTDOWN_TIMEOUT_MS } from "./process-telemetry";
import { createDurableRunEventStore } from "./durable-run-events";
import { longestRunTimeBudgetMs } from "@contexts/run-orchestration/application/index";
import { delegateRun, type DelegateRunResult } from "../entrypoints/run-delegate";
import { discoverApiToken } from "../settings/api-token";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadAppConfig } from "./config-loader";
import { runSucceeded } from "../entrypoints/cli-exit";
import { delegateRunInput, groundingOf, parseCliArgs, type CliArgs } from "../entrypoints/cli-args";
import { renderRunReport } from "../entrypoints/value-report";
import { createAgentRuntimeManager } from "../agent-runtime/agent-runtime";
import { defaultEnvStoreFs } from "../settings/env-store";
import type { Settings } from "../settings/settings";
import { createSettingsStore, installSettingsStore, type SettingsStore } from "../settings/store";
import { OpenCodeRuntimeStrategy } from "../agent-runtime";
import { getOpenSessionCount } from "../agent-runtime/opencode-client";
import { createRunEngineFactory } from "./run-engine-factory";
import { getHistory } from "../persistence/index";
import type { RunRecord } from "../persistence/types";


/* The CLI is a composition root: the settings load once, on first use, from the process environment. */
let settingsStore: SettingsStore | undefined;
function cliSettings(): Settings {
  if (!settingsStore) {
    settingsStore = createSettingsStore(process.env);
    installSettingsStore(settingsStore);
  }
  return settingsStore.current();
}

let agentRuntimeManager: ReturnType<typeof createAgentRuntimeManager> | undefined;
function cliAgentRuntime(): ReturnType<typeof createAgentRuntimeManager> {
  agentRuntimeManager ??= createAgentRuntimeManager({
    env: cliSettings().environment,
    fs: defaultEnvStoreFs(),
    strategies: {
      opencode: new OpenCodeRuntimeStrategy({ env: cliSettings().environment }),
    },
    hasOpenSessions: () => getOpenSessionCount() > 0,
  });
  return agentRuntimeManager;
}
/* Built on first use, by which time main() has built this process's telemetry (a run that is delegated to the service builds none). */
let cliFactory: ReturnType<typeof createRunEngineFactory> | undefined;
const cliEngineFactory: ReturnType<typeof createRunEngineFactory> = (...args) => {
  const telemetry = processTelemetry(cliSettings().environment);
  cliFactory ??= createRunEngineFactory({
    getAgentDeps: () => cliAgentRuntime().facade().deps(),
    getAgentFacade: () => cliAgentRuntime().facade(),
    telemetry: telemetry.telemetry,
    clock: telemetry.clock,
  });
  return cliFactory(...args);
};

/*
 * Probe the local service's unauthenticated liveness endpoint. A 200 means a long-lived
 * orchestrator owns the queue on this host and a second queue here would race it against DEV.
 */
async function localServiceIsRunning(): Promise<boolean> {
  const port = cliSettings().server.port;
  try {
    const res = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;  /* nothing listening / not reachable → safe to run locally */
  }
}

/*
 * The control-plane token, discovered the same way the server resolves it (env wins, then the
 * persisted data/.api_token) so delegation
 * authenticates without the operator typing it.
 */
function cliApiToken(): string | undefined {
  return discoverApiToken(cliSettings().environment, qayabaRoot());
}

/*
 * Delegate the run to the already-running service and wait for its verdict, mirroring the
 * standalone CLI's contract (wait, report, exit with the verdict's code). The run executes IN the
 * server process, so the TUI streams it live and the single-queue invariant holds.
 */
async function runViaService(args: CliArgs): Promise<void> {
  const port = cliSettings().server.port;
  const baseUrl = `http://localhost:${port}`;
  console.log("[qa] the service is running — delegating this run to it (one queue against DEV; watch it live in the TUI).");
  /*
   * Explicitly typed: the catch terminates via process.exit, so result is always assigned past the
   * try/catch — the annotation enforces that invariant instead of relying on process.exit narrowing.
   */
  let result: DelegateRunResult;
  try {
    result = await delegateRun(
      delegateRunInput(args),
      {
        fetch,
        baseUrl,
        token: cliApiToken(),
        longestRunMs: longestRunTimeBudgetMs(cliSettings().run.runTimeBudgets),
        onUpdate: (r) => process.stdout.write(`\r[qa] ${r.status}${r.step ? " · " + r.step : ""}                    `),
      },
    );
  } catch (err) {
    console.error(`\n[qa] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (result.timedOut) {
    console.log(`\n[qa] run ${result.id} is still running server-side (stopped waiting) — watch it in the TUI.`);
    process.exit(0);
  }
  console.log(`\n[qa] run ${result.id} finished: verdict=${result.verdict ?? "?"} (${result.passed} passed, ${result.failed} failed)`);
  if (result.note) console.log(`[qa] ${result.note}`);
  /*
   * A run SUCCEEDED when the engine produced a trustworthy result — including a real bug found
   * (verdict `fail` → Issue). Only an engine error (infra-error/invalid, or no verdict) exits non-zero.
   */
  process.exit(runSucceeded(result.verdict) ? 0 : 1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (await localServiceIsRunning()) {
    /*
     * The service owns the only queue against DEV. Rather than refuse (or race it with a second
     * queue), hand the run to it: it then executes IN the server process, so a TUI attached to
     * that server streams it live, and the sequential-queue invariant is preserved. There is no
     * override for this — a standalone run against DEV while the service also owns the queue is
     * exactly the concurrency this check exists to prevent.
     */
    await runViaService(args);
    return;  /* runViaService always exits the process with the verdict's code */
  }

  /* Built once for this process (a mistyped QA_TELEMETRY stops it here); the engine factory takes `telemetry.telemetry` as a dep. */
  const telemetry = processTelemetry(cliSettings().environment);
  let record: RunRecord | undefined;
  try {
    const queue = new JobQueue();
    /*
     * Persist run events to the SAME durable store the server uses. A standalone CLI run lives in
     * its own process, so the server's in-process event bus never sees it — persisting here is what
     * lets the TUI (attached to the server) replay and tail this run's progress instead of freezing
     * on an empty stream.
     */
    const runEvents = createDurableRunEventStore();
    const appCfg = loadAppConfig(args.app);
    const id = enqueueTrackedRun(queue, {
      app: args.app,
      sha: args.sha,
      baseSha: args.baseSha,
      target: "e2e",
      mode: args.mode,
      guidance: args.guidance,
      source: "manual",
      trigger: "cli",
      ...(args.closedLoop !== undefined ? { closedLoop: args.closedLoop } : {}),
      ...(args.agentBrowser !== undefined ? { agentBrowser: args.agentBrowser } : {}),
      ...groundingOf(args),
    }, { loadApp: (name) => loadAppConfig(name), runEvents, engineFactory: cliEngineFactory, telemetry: telemetry.telemetry, clock: telemetry.clock });
    await queue.drain();
    record = getHistory().runs.getRecord(id);
    /*
     * Print the deterministic value signals the run already persisted. In shadow mode there is no
     * PR/Issue artifact to inspect.
     */
    if (record) printRunReport(record, appCfg);
  } finally {
    await telemetry.shutdown(TELEMETRY_SHUTDOWN_TIMEOUT_MS);
  }
  /*
   * A run SUCCEEDED when the engine produced a trustworthy result — including a real bug found
   * (verdict `fail` → Issue). Only an engine error (infra-error/invalid, or no verdict) exits non-zero.
   */
  process.exit(runSucceeded(record?.verdict) ? 0 : 1);
}

/*
 * Compose the value report from the persisted run record + its RunOutcome (the structured gate
 * signals). Kept in the CLI (not the pure renderer) because it stitches two persistence reads.
 */
function printRunReport(record: RunRecord, appCfg: ReturnType<typeof loadAppConfig>): void {
  const outcome = getHistory().learning.getRunOutcome(record.id);
  const gs = outcome?.gateSignals;
  const report = renderRunReport({
    app: record.app,
    sha: record.sha,
    mode: record.mode,
    target: record.target,
    shadow: appCfg.qa.shadow ?? false,
    verdict: record.verdict ?? "infra-error",
    passed: record.passed ?? 0,
    failed: record.failed ?? 0,
    specCount: record.specs?.length ?? 0,
    specNames: record.specs?.map((s) => s.name),
    note: record.note,
    signals: {
      /*
       * A persisted non-null ratio means coverage was actually measured (the pipeline persists
       * null for an unmeasured run, never a misleading 0). So presence === measured.
       */
      coverageRatio: gs?.coverageRatio ?? null,
      coverageMeasured: gs?.coverageRatio !== null && gs?.coverageRatio !== undefined,
      coveragePolicy: appCfg.qa.changeCoverage?.mode ?? "signal",
      reviewerApproved: gs?.reviewerApproved ?? null,
      reviewerRationale: gs?.reviewerRationale,
    },
    errorClass: outcome?.errorClass ?? null,
  }, { color: process.stdout.isTTY === true && !cliSettings().server.noColor });
  console.log("\n" + report + "\n");
}

/* The command line as the process takes it: a refusal is printed with exit code 2, before anything is built. */
export function parseArgs(argv: string[]): CliArgs {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    console.error(parsed.message);
    process.exit(2);
  }
  return parsed.args;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
