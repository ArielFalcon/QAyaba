/* The engine is a closed set of commands. Each one's exact argument list is the contract (a term is never read as an
   option; no command reaches a server, a daemon or an installer), and every failure is typed, never an empty answer. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CodegraphEngine, STORE_READER_SCRIPT } from "../../../src/shared-infrastructure/code-graph/codegraph-engine.ts";
import type { SandboxedBinaryRunner, SandboxedRunRequest, SandboxedRunResult } from "../../../src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";

class ScriptedRunner implements SandboxedBinaryRunner {
  readonly requests: SandboxedRunRequest[] = [];
  constructor(private readonly reply: (req: SandboxedRunRequest) => SandboxedRunResult | Error) {}
  async run(req: SandboxedRunRequest): Promise<SandboxedRunResult> {
    this.requests.push(req);
    const r = this.reply(req);
    if (r instanceof Error) throw r;
    return r;
  }
}

const done = (stdout = ""): SandboxedRunResult => ({ exitCode: 0, stdout, stderr: "", timedOut: false });
const TIMEOUTS = { buildMs: 1000, queryMs: 100 };
const COMPLETE = JSON.stringify({ initialized: true, version: "1.6.2", nodeCount: 5, edgeCount: 4, fileCount: 2, index: { state: "complete" } });

test("each command runs with exactly its arguments, in the workspace, within its own time budget", async () => {
  const runner = new ScriptedRunner((req) => done(req.args[0] === "status" ? COMPLETE : req.command === "node" ? "{}" : ""));
  const engine = new CodegraphEngine(runner, TIMEOUTS, "node");

  await engine.build("/ws");
  await engine.sync("/ws");
  await engine.status("/ws");
  await engine.explore("/ws", ["OrderService", "--help"], 4.7);
  await engine.read("/ws", { op: "routes" });

  assert.deepEqual(runner.requests.map((r) => [r.command, r.args, r.cwd, r.timeoutMs]), [
    ["codegraph", ["init", "-y", "."], "/ws", 1000],
    ["codegraph", ["sync", "-q", "."], "/ws", 1000],
    ["codegraph", ["status", "-j", "."], "/ws", 100],
    ["codegraph", ["explore", "--max-files", "4", "--", "OrderService", "--help"], "/ws", 100],
    ["node", ["--disable-warning=ExperimentalWarning", STORE_READER_SCRIPT, "/ws/.codegraph/codegraph.db", '{"op":"routes"}'], "/ws", 100],
  ]);
});

test("status reads the engine's version and counts from a complete index", async () => {
  const engine = new CodegraphEngine(new ScriptedRunner(() => done(COMPLETE)), TIMEOUTS);
  assert.deepEqual(await engine.status("/ws"), { ok: true, value: { version: "1.6.2", nodeCount: 5, edgeCount: 4, fileCount: 2 } });
});

test("status refuses an index that is not complete, lacks its counts or is not JSON", async () => {
  for (const stdout of [
    JSON.stringify({ initialized: true, version: "1.6.2", nodeCount: 5, edgeCount: 4, fileCount: 2, index: { state: "indexing" } }),
    JSON.stringify({ initialized: false, index: { state: "complete" } }),
    JSON.stringify({ initialized: true, version: "1.6.2", nodeCount: -1, edgeCount: 4, fileCount: 2, index: { state: "complete" } }),
    "not json",
  ]) {
    const result = await new CodegraphEngine(new ScriptedRunner(() => done(stdout)), TIMEOUTS).status("/ws");
    assert.equal(result.ok, false, stdout);
    assert.equal(!result.ok && result.error.kind, "failed");
  }
});

test("a timeout, a non-zero exit, a spawn error and an unparsable reader answer are typed failures", async () => {
  const timeout = await new CodegraphEngine(new ScriptedRunner(() => ({ exitCode: null, stdout: "", stderr: "", timedOut: true })), TIMEOUTS).build("/ws");
  assert.deepEqual(timeout, { ok: false, error: { kind: "timeout", reason: "init timed out after 1000ms" } });

  const exit = await new CodegraphEngine(new ScriptedRunner(() => ({ exitCode: 3, stdout: "", stderr: "schema mismatch\n", timedOut: false })), TIMEOUTS).sync("/ws");
  assert.deepEqual(exit, { ok: false, error: { kind: "failed", reason: "sync exited 3: schema mismatch" } });

  const spawn = await new CodegraphEngine(new ScriptedRunner(() => new Error("ENOENT")), TIMEOUTS).build("/ws");
  assert.deepEqual(spawn, { ok: false, error: { kind: "failed", reason: "ENOENT" } });

  const garbled = await new CodegraphEngine(new ScriptedRunner(() => done("<html>")), TIMEOUTS).read("/ws", { op: "walk" });
  assert.deepEqual(garbled, { ok: false, error: { kind: "failed", reason: "the store reader answered something that is not JSON (walk)" } });
});
