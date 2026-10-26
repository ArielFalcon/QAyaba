/*
 * Boot check of the execution sandbox's file boundary, run by bin/container-entrypoint.sh as root before the service starts.
 *
 * It plans every attempt the sandbox uid must see refused (qa-engine/src/shared-infrastructure/process-sandbox/file-boundary.ts:
 * reading the API token and the service's environment, listing the data (code-graph stores included), auth, config and mirror directories,
 * writing the app root, every mount under it found in /proc/self/mountinfo, the orchestrator's code and config and the status
 * files), makes them in a child started as that uid exactly the way the launcher starts agent code (spawn with uid and gid, no
 * supplementary groups, an empty environment), judges the child's report here, and leaves `ok` or `breach: <what>` in
 * QA_FILE_BOUNDARY_STATUS_FILE (default /run/qa-file-boundary.status). The service never trusts a missing status: the launcher
 * then refuses agent code under QA_EXEC_SANDBOX=required (E-SANDBOX) and /api/health says why.
 *
 * The probing child is src/server/file-boundary-probe.mjs, started with the plain node binary and no loader: a TypeScript loader
 * keeps its transforms under the temporary directory (tsx-<uid>), which the sandbox uid can write and which survives restarts, and
 * loads what it finds there unvalidated, so earlier agent code could forge a probe that reports everything refused. The child's
 * environment is PATH alone, so it reads no temporary directory, hook or option an earlier run could have prepared.
 *
 * Exit 0 when the boundary holds, 1 when it does not; the entrypoint starts the service either way.
 *   tsx src/server/file-boundary-check.ts            the check (root)
 */

import { appLogger } from "../integrations/redacting-logger";
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatFileBoundaryStatus,
  judgeFileBoundary,
  mountPointsUnder,
  planFileBoundaryProbes,
  readProbeReport,
  type FileBoundaryProbe,
  type FileBoundaryVerdict,
} from "../../qa-engine/src/shared-infrastructure/process-sandbox/file-boundary";
import { resolveSandbox, type Sandbox } from "../../qa-engine/src/shared-infrastructure/process-sandbox/sandbox";
import { qayabaRoot } from "../paths";
import { fileBoundaryLayout, fileBoundaryStatusFile } from "./file-boundary";

const PROBE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "file-boundary-probe.mjs");
const PROBE_TIMEOUT_MS = 60_000;

/* How the probing child is started: the way the launcher starts agent code (uid and gid, no supplementary groups), running the plain script with the plain binary. */
export function probeSpawnFor(sandbox: Sandbox, probes: readonly FileBoundaryProbe[], env: NodeJS.ProcessEnv): { command: string; args: string[]; options: SpawnSyncOptions & { encoding: "utf8" } } {
  return {
    command: process.execPath,
    args: [PROBE_SCRIPT],
    options: {
      uid: sandbox.uid,
      gid: sandbox.gid,
      cwd: "/",
      env: { PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
      input: JSON.stringify(probes),
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    },
  };
}

/* Written whole into a new file beside the target and renamed over it. The file is created exclusively (`wx`, which also refuses to follow a link) under a name nobody can predict, so nothing planted in the directory is written through. */
export function writeStatus(path: string, text: string, uniqueSuffix: () => string = () => randomBytes(8).toString("hex")): void {
  const temporary = join(dirname(path), `.${uniqueSuffix()}.file-boundary.tmp`);
  try {
    writeFileSync(temporary, text, { mode: 0o644, flag: "wx" });
    chmodSync(temporary, 0o644);
    renameSync(temporary, path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") rmSync(temporary, { force: true });
    throw err;
  }
}

function check(env: NodeJS.ProcessEnv): FileBoundaryVerdict {
  const sandbox = resolveSandbox(env);
  if (!sandbox) return { holds: false, exposures: ["there is no sandbox uid to check as (not root on Linux, the image lacks the sandbox user, or CODE_SANDBOX=off)"] };
  const root = qayabaRoot();
  const probes = planFileBoundaryProbes(fileBoundaryLayout(env, root), mountPointsUnder(readFileSync("/proc/self/mountinfo", "utf8"), root));
  const { command, args, options } = probeSpawnFor(sandbox, probes, env);
  const child = spawnSync(command, args, options);
  const finished = child.error === undefined && child.status === 0;
  const verdict = judgeFileBoundary(probes, finished ? readProbeReport(probes, child.stdout) : []);
  if (finished || verdict.holds) return verdict;
  const why = child.error ? child.error.message : `exit ${child.status ?? child.signal}: ${(child.stderr ?? "").trim().slice(0, 300)}`;
  return { holds: false, exposures: [`the probe as uid ${sandbox.uid} did not finish (${why})`, ...verdict.exposures] };
}

function main(): number {
  /* A process of its own, started by the container entrypoint as root before the service: it loads no settings, so an unrelated invalid variable can never stop the check that decides whether agent code may run. */
  const env = process.env;
  const statusFile = fileBoundaryStatusFile(env);
  let verdict: FileBoundaryVerdict;
  try {
    verdict = check(env);
  } catch (err) {
    verdict = { holds: false, exposures: [`the check failed: ${err instanceof Error ? err.message : String(err)}`] };
  }
  writeStatus(statusFile, formatFileBoundaryStatus(verdict));
  if (verdict.holds) {
    appLogger.error("[qa] file-boundary: the sandbox uid reaches none of the orchestrator's secrets, code or config");
    return 0;
  }
  appLogger.error(`[qa] file-boundary: the boundary does NOT hold on this host: ${verdict.exposures.join("; ")}`);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
