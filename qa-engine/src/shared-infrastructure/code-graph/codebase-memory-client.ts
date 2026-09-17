/* It instead depends DIRECTLY on SandboxedBinaryRunnerAdapter + scrubEnv and independently reconstitutes runbinary.ts's two guarantees on top of the raw runner: (a) env scrubbing — scrubEnv() is applied to every spawn, so the codebase-memory process never inherits the orchestrator's unscrubbed secrets; (b) the {code:null}-on-error/timeout degrade contract — SandboxedBinaryRunnerAdapter.run() REJECTS on a spawn "error" event (e.g. This client is the ONE consumer that needs the codebase-memory graph-store location to reach its spawn (the docker volume mounts exactly at CBM_CACHE_DIR; dropping it would silently point the CLI at an unmounted container-FS default and kill persistence), so it opts in explicitly via `extraExact` — never widening every OTHER scrubEnv() consumer (code-execution, static-gate, git-mirror-read, ...) for a var only this one needs. */
import type { SandboxedBinaryRunner } from "../process-sandbox/sandboxed-binary-runner.ts";
import { SandboxedBinaryRunnerAdapter } from "../process-sandbox/sandboxed-binary-runner.adapter.ts";
import { ProcessKillAdapter } from "../process-sandbox/process-kill.adapter.ts";
import { scrubEnv } from "../process-sandbox/scrub-env.ts";

const BINARY = "codebase-memory-mcp";
const CBM_ENV_EXACT = new Set(["CBM_CACHE_DIR"]);
const DEFAULT_TIMEOUT_MS = 60_000;

export interface CodebaseMemoryResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export class CodebaseMemoryClient {
  /* Runner is constructor-injected against the SandboxedBinaryRunner INTERFACE (default = the real SandboxedBinaryRunnerAdapter) so tests can pass a fake runner instead of a hardcoded field — this is what makes the RED step ("construct the client with an injected fake runner") achievable, matching this codebase's DI-as-testing-strategy invariant (CLAUDE.md: "Dependency injection is the testing strategy"). Typing the parameter as the concrete SandboxedBinaryRunnerAdapter class (rather than the interface) would require every fake to structurally match the adapter's private fields too — the interface is the correct seam. */
  constructor(
    private readonly runner: SandboxedBinaryRunner = new SandboxedBinaryRunnerAdapter({
      processKill: new ProcessKillAdapter(),
    }),
  ) {}

  /* Spawns `codebase-memory-mcp cli <tool> <jsonArg>` in repoDir with a scrubbed env and a bounded timeout. The client is tool-agnostic: it just spawns and returns raw stdout — the caller (2b's adapter) owns JSON.parse and the tool-specific query shape. Never throws past this method. */
  async cli(
    tool: string,
    jsonArg: string,
    repoDir: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<CodebaseMemoryResult> {
    const env = scrubEnv({ extraExact: CBM_ENV_EXACT });
    try {
      const r = await this.runner.run({
        command: BINARY,
        args: ["cli", tool, jsonArg],
        cwd: repoDir,
        env,
        timeoutMs,
      });
      if (r.timedOut) {
        return { code: null, stdout: r.stdout, stderr: r.stderr || `timeout ${timeoutMs}ms` };
      }
      return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr };
    } catch (e) {
      /* Spawn error (e.g. binary missing — ENOENT): degrade to code:null, never throw. */
      return { code: null, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
    }
  }
}
