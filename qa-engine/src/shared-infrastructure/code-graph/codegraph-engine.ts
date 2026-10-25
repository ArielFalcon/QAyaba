/*
 * The code-graph engine as the orchestrator may run it: a closed set of commands (build, sync, status, explore, and the store
 * reader), each a child of the execution launcher's `graph` profile, in a workspace the orchestrator built. There is no
 * generic "run a codegraph command": the engine's servers, daemon, watcher, installer, upgrader and telemetry switch are not
 * reachable from here. A spawn error, a timeout, a non-zero exit or an answer that does not parse is a typed failure, never
 * an empty answer.
 */

import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { err, ok, type Result } from "../../shared-kernel/result.ts";
import type { SandboxedBinaryRunner } from "../process-sandbox/sandboxed-binary-runner.ts";
import { STORE_DIR } from "./codegraph-workspace.ts";

export const CODEGRAPH_ENGINE = "codegraph";
const BINARY = "codegraph";
const STORE_FILE = "codegraph.db";
/* The reader ships with qayaba and is run by Node under the same profile; the warning flag keeps node:sqlite's notice off stderr. */
export const STORE_READER_SCRIPT = fileURLToPath(new URL("./codegraph-store-reader.mjs", import.meta.url));

export interface EngineFailure {
  reason: string;
  /* "timeout" when the call ran out of time; the run records it as the index outcome. */
  kind: "timeout" | "failed";
}

export interface EngineStatus {
  version: string;
  nodeCount: number;
  edgeCount: number;
  fileCount: number;
}

export interface EngineTimeouts {
  buildMs: number;
  queryMs: number;
}

export const DEFAULT_ENGINE_TIMEOUTS: EngineTimeouts = { buildMs: 270_000, queryMs: 20_000 };

export function storePathOf(workspace: string): string {
  return join(workspace, STORE_DIR, STORE_FILE);
}

export class CodegraphEngine {
  constructor(
    /* A runner whose children start through the launcher's graph profile (createExecBinaryRunner). */
    private readonly runner: SandboxedBinaryRunner,
    private readonly timeouts: EngineTimeouts = DEFAULT_ENGINE_TIMEOUTS,
    private readonly node: string = "node",
  ) {}

  private async run(command: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<Result<string, EngineFailure>> {
    try {
      const r = await this.runner.run({ command, args, cwd, env: {}, timeoutMs, ...(signal ? { signal } : {}) });
      if (r.timedOut) return err({ kind: "timeout", reason: `${args[0] ?? command} timed out after ${timeoutMs}ms` });
      if (r.exitCode !== 0) return err({ kind: "failed", reason: `${args[0] ?? command} exited ${r.exitCode}: ${r.stderr.trim().slice(0, 400)}` });
      return ok(r.stdout);
    } catch (e) {
      return err({ kind: "failed", reason: e instanceof Error ? e.message : String(e) });
    }
  }

  /* A first build of the workspace's store. Every call takes the run's abort signal, which ends the child. */
  build(workspace: string, signal?: AbortSignal): Promise<Result<string, EngineFailure>> {
    return this.run(BINARY, ["init", "-y", "."], workspace, this.timeouts.buildMs, signal);
  }

  /* Brings a store copied into the workspace up to the workspace's files. */
  sync(workspace: string, signal?: AbortSignal): Promise<Result<string, EngineFailure>> {
    return this.run(BINARY, ["sync", "-q", "."], workspace, this.timeouts.buildMs, signal);
  }

  /* The store's state; a store that is not complete is a failure. */
  async status(workspace: string, signal?: AbortSignal): Promise<Result<EngineStatus, EngineFailure>> {
    const out = await this.run(BINARY, ["status", "-j", "."], workspace, this.timeouts.queryMs, signal);
    if (!out.ok) return out;
    let payload: unknown;
    try {
      payload = JSON.parse(out.value);
    } catch {
      return err({ kind: "failed", reason: "status answered something that is not JSON" });
    }
    const s = payload as { initialized?: unknown; version?: unknown; nodeCount?: unknown; edgeCount?: unknown; fileCount?: unknown; index?: { state?: unknown } };
    if (s.initialized !== true || s.index?.state !== "complete") return err({ kind: "failed", reason: `the index is not complete (state ${String(s.index?.state)})` });
    const counts = [s.nodeCount, s.edgeCount, s.fileCount];
    if (typeof s.version !== "string" || counts.some((c) => typeof c !== "number" || !Number.isInteger(c) || c < 0)) return err({ kind: "failed", reason: "status lacks the version or the counts" });
    return ok({ version: s.version, nodeCount: s.nodeCount as number, edgeCount: s.edgeCount as number, fileCount: s.fileCount as number });
  }

  /* The engine's read-equivalent answer for a bag of names, as text. Terms are passed after `--`, so none is read as an option. */
  explore(workspace: string, terms: readonly string[], maxFiles: number, signal?: AbortSignal): Promise<Result<string, EngineFailure>> {
    return this.run(BINARY, ["explore", "--max-files", String(Math.max(1, Math.trunc(maxFiles))), "--", ...terms], workspace, this.timeouts.queryMs, signal);
  }

  /* One structured answer from the store (codegraph-store-reader.mjs), parsed. */
  async read<T>(workspace: string, request: Record<string, unknown>, signal?: AbortSignal): Promise<Result<T, EngineFailure>> {
    const out = await this.run(this.node, ["--disable-warning=ExperimentalWarning", STORE_READER_SCRIPT, storePathOf(workspace), JSON.stringify(request)], workspace, this.timeouts.queryMs, signal);
    if (!out.ok) return out;
    try {
      return ok(JSON.parse(out.value) as T);
    } catch {
      return err({ kind: "failed", reason: `the store reader answered something that is not JSON (${String(request.op)})` });
    }
  }
}
