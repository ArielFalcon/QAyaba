/* The run_spec loop of one flow of a plan: its own capability, limits and namespace, its sidekick's workspace as the place its spec is read from, and the working copy as the place that spec is executed in. */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClosedLoopPortAdapter, type ClosedLoopPortAdapterDeps } from "@contexts/agent-tools/infrastructure/adapters/closed-loop-port.adapter.ts";
import { ClosedLoopRegistry } from "@contexts/agent-tools/infrastructure/closed-loop-registry.ts";
import { DevLease } from "@contexts/test-execution/domain/dev-lease.ts";
import { RUN_SPEC_AGENT, RUN_SPEC_FLOW_AGENT } from "@contexts/test-execution/domain/run-spec-capability.ts";
import type { ClosedLoopHandle, ClosedLoopOpenInput, ExecutionOpts, FlowLoopOpenInput } from "@contexts/qa-run-orchestration/application/ports/index.ts";

const SPEC = 'import { test } from "../fixtures";\ntest("loads", async () => {});\n';
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const LIMITS = { maxCalls: 8, perCallMs: 60_000, maxDevWrites: 10 };
const STAGED = ".qa-probe/login.spec.ts";

interface Rig {
  registry: ClosedLoopRegistry;
  run: ClosedLoopHandle;
  deps: ClosedLoopPortAdapterDeps;
  workspaceDir: string;
  workspaceSpecDir: string;
  mirrorSpecDir: string;
  executed: Array<{ specDir: string; opts: ExecutionOpts }>;
  cleaned: string[];
  staged: number;
  openInput: ClosedLoopOpenInput;
  flowInput(over?: Partial<FlowLoopOpenInput>): FlowLoopOpenInput;
  writeWorkspace(rel: string, text: string): void;
  events: string[];
}

async function rig(t: TestContext, over: { devWrites?: number } = {}): Promise<Rig> {
  const base = mkdtempSync(join(tmpdir(), "closed-loop-flow-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const mirrorDir = join(base, "mirror");
  const mirrorSpecDir = join(mirrorDir, "e2e");
  const workspaceDir = join(base, "workspace");
  const workspaceSpecDir = join(workspaceDir, "e2e");
  mkdirSync(mirrorSpecDir, { recursive: true });
  mkdirSync(workspaceSpecDir, { recursive: true });
  const registry = new ClosedLoopRegistry();
  const r = {
    registry, workspaceDir, workspaceSpecDir, mirrorSpecDir, executed: [], cleaned: [], staged: 0, events: [],
    openInput: { runId: "run-9", app: "demo", mode: "diff", mirrorDir, specDir: mirrorSpecDir },
    writeWorkspace: (rel: string, text: string) => { mkdirSync(join(workspaceSpecDir, rel, ".."), { recursive: true }); writeFileSync(join(workspaceSpecDir, rel), text); },
  } as unknown as Rig;
  r.deps = {
    registry,
    setting: { enabled: true, limits: LIMITS },
    generatorRuntimeCanCall: () => true,
    execution: {
      execute: async (dir, opts) => {
        r.events.push("execute");
        r.executed.push({ specDir: dir, opts: opts as ExecutionOpts });
        return { verdict: "pass", cases: [{ name: "loads", status: "pass" }], logs: "", devWrites: over.devWrites ?? 1 };
      },
    },
    cleanup: { cleanup: async (_dir, o) => void r.cleaned.push(o.namespace) },
    specRelDir: "e2e",
    account: "demo/user",
    lock: new DevLease(),
    redact: (text) => text,
  };
  r.flowInput = (extra = {}) => ({
    delegationId: "run-9-flow-login",
    flowId: "login",
    limits: { maxCalls: 2, maxDevWrites: 3 },
    workspace: { dir: workspaceDir, specDir: workspaceSpecDir },
    specFile: "flows/login.spec.ts",
    stage: async () => { r.staged += 1; r.events.push("stage"); return STAGED; },
    ...extra,
  });
  r.run = (await new ClosedLoopPortAdapter(r.deps).open(r.openInput))!;
  return r;
}

const bind = (r: Rig, sessionId = "side-1", delegationId = "run-9-flow-login") =>
  r.registry.bindSession({ sessionId, runId: "run-9", agent: RUN_SPEC_FLOW_AGENT, delegationId });
const call = (r: Rig, sessionId = "side-1", path = "flows/login.spec.ts") => r.registry.find(sessionId)!.call({ sessionId, agent: RUN_SPEC_FLOW_AGENT, path });

test("a flow's loop is the sidekick's alone: the sidekick of that flow calls it, the generator and a sibling do not", async (t) => {
  const r = await rig(t);
  assert.ok(r.run.openFlow(r.flowInput()));
  bind(r);
  bind(r, "side-2", "run-9-flow-other");
  r.registry.bindSession({ sessionId: "gen", runId: "run-9", agent: RUN_SPEC_AGENT });
  assert.ok(r.registry.find("side-1"));
  assert.equal(r.registry.find("side-2"), undefined, "a flow that has no loop");
  assert.notEqual(r.registry.find("gen"), r.registry.find("side-1"), "the generator holds the run's loop and not the flow's");
});

test("a call runs the spec the sidekick wrote in its workspace, from the working copy where it was put, once and in a namespace of its own", async (t) => {
  const r = await rig(t);
  r.run.openFlow(r.flowInput());
  r.writeWorkspace("flows/login.spec.ts", SPEC);
  bind(r);
  const response = await call(r);
  assert.ok(response.ok);
  assert.equal(response.report.status, "passed");
  assert.deepEqual(r.events, ["stage", "execute"], "the spec is put in the working copy first, inside the lease");
  const [executed] = r.executed;
  assert.equal(executed!.specDir, r.mirrorSpecDir, "it runs in the working copy");
  assert.deepEqual(executed!.opts.specFiles, [STAGED]);
  assert.equal(executed!.opts.namespace, "run-9-login-rs1", "the flow's own namespace, apart from the run's and the siblings'");
  assert.deepEqual(r.cleaned, ["run-9-login-rs1"]);
});

test("a flow can run its own spec and no other", async (t) => {
  const r = await rig(t);
  r.run.openFlow(r.flowInput());
  r.writeWorkspace("flows/login.spec.ts", SPEC);
  r.writeWorkspace("flows/other.spec.ts", SPEC);
  r.writeWorkspace(".qa-probe/p.spec.ts", SPEC);
  bind(r);
  for (const path of ["flows/other.spec.ts", ".qa-probe/p.spec.ts", "e2e/flows/other.spec.ts"]) {
    const response = await call(r, "side-1", path);
    assert.equal(response.ok, false, path);
  }
  assert.equal(r.staged, 0);
  assert.equal(r.executed.length, 0);
  assert.ok((await call(r, "side-1", "e2e/flows/login.spec.ts")).ok);
});

test("the flow's calls and writes to DEV are capped by its own share, and the run's loop is not touched by them", async (t) => {
  const r = await rig(t);
  const flow = r.run.openFlow(r.flowInput({ limits: { maxCalls: 2, maxDevWrites: 3 } }))!;
  r.writeWorkspace("flows/login.spec.ts", SPEC);
  bind(r);
  assert.ok((await call(r)).ok);
  assert.ok((await call(r)).ok);
  const third = await call(r);
  assert.equal(third.ok, false);
  assert.equal(!third.ok ? third.code : "", "no-calls");
  assert.equal(flow.signals().calls, 2);
  r.registry.bindSession({ sessionId: "gen", runId: "run-9", agent: RUN_SPEC_AGENT });
  assert.ok(r.registry.find("gen"), "the run's own loop is still there with its own calls");
  assert.equal(r.run.limits.maxCalls, LIMITS.maxCalls);
});

test("a flow whose executed specs have spent its share of writes is refused the next call", async (t) => {
  const r = await rig(t, { devWrites: 4 });
  r.run.openFlow(r.flowInput({ limits: { maxCalls: 5, maxDevWrites: 3 } }));
  r.writeWorkspace("flows/login.spec.ts", SPEC);
  bind(r);
  assert.ok((await call(r)).ok);
  const next = await call(r);
  assert.equal(next.ok, false);
  assert.equal(!next.ok ? next.code : "", "no-writes");
});

test("a spec that is not in the sidekick's workspace yet is not found, and costs no call", async (t) => {
  const r = await rig(t);
  const flow = r.run.openFlow(r.flowInput())!;
  bind(r);
  const response = await call(r);
  assert.equal(response.ok, false);
  assert.equal(flow.signals().calls, 0);
});

test("what the flow saw pass is read from its ledger, with the bytes the sidekick's workspace held", async (t) => {
  const r = await rig(t);
  const flow = r.run.openFlow(r.flowInput())!;
  r.writeWorkspace("flows/login.spec.ts", SPEC);
  bind(r);
  assert.equal(await flow.isClosed(), false, "nothing has run");
  await call(r);
  assert.deepEqual(flow.ledger().map((e) => [e.path, e.sha256, e.status]), [["flows/login.spec.ts", sha(SPEC), "passed"]]);
  assert.equal(await flow.isClosed(), true);
  r.writeWorkspace("flows/login.spec.ts", SPEC + "// edited\n");
  assert.equal(await flow.isClosed(), false, "the bytes changed after the pass");
});

test("the run sees a flow's pass for the file that was copied back, as long as it holds the bytes that passed", async (t) => {
  const r = await rig(t);
  r.run.openFlow(r.flowInput());
  r.writeWorkspace("flows/login.spec.ts", SPEC);
  bind(r);
  await call(r);
  assert.equal(await r.run.isClosed(["flows/login.spec.ts"]), false, "the file is not in the working copy yet");
  mkdirSync(join(r.mirrorSpecDir, "flows"), { recursive: true });
  writeFileSync(join(r.mirrorSpecDir, "flows/login.spec.ts"), SPEC);
  assert.equal(await r.run.isClosed(["flows/login.spec.ts"]), true);
  writeFileSync(join(r.mirrorSpecDir, "flows/login.spec.ts"), SPEC + "// regenerated\n");
  assert.equal(await r.run.isClosed(["flows/login.spec.ts"]), false);
});

test("the run's counts include its flows' calls and writes", async (t) => {
  const r = await rig(t);
  r.run.openFlow(r.flowInput());
  r.writeWorkspace("flows/login.spec.ts", SPEC);
  bind(r);
  await call(r);
  assert.deepEqual(r.run.signals(), { calls: 1, devWrites: 1 });
});

test("closing a flow revokes its right and forgets its loop, and the run keeps what the flow did in its counts", async (t) => {
  const r = await rig(t);
  const flow = r.run.openFlow(r.flowInput())!;
  r.writeWorkspace("flows/login.spec.ts", SPEC);
  bind(r);
  await call(r);
  const capability = r.registry.find("side-1")!.capability;
  await flow.close();
  assert.equal(capability.authorize("side-1", RUN_SPEC_FLOW_AGENT)?.code, "revoked");
  assert.equal(r.registry.find("side-1"), undefined);
  assert.equal(r.run.signals().calls, 1);
  await flow.close();
});

test("closing the run closes every flow it still has open", async (t) => {
  const r = await rig(t);
  r.run.openFlow(r.flowInput());
  r.run.openFlow(r.flowInput({ delegationId: "run-9-flow-cart", flowId: "cart", specFile: "flows/cart.spec.ts" }));
  bind(r);
  bind(r, "side-2", "run-9-flow-cart");
  const capabilities = [r.registry.find("side-1")!.capability, r.registry.find("side-2")!.capability];
  await r.run.close();
  for (const capability of capabilities) assert.equal(capability.authorize("side-1", RUN_SPEC_FLOW_AGENT)?.code, "revoked");
  assert.equal(r.registry.size, 0);
});

test("closing a flow while its call is in flight cleans the namespace the call was using", async (t) => {
  const r = await rig(t);
  let release!: () => void;
  r.deps.execution = { execute: async () => { await new Promise<void>((resolve) => { release = resolve; }); return { verdict: "pass", cases: [{ name: "x", status: "pass" }], logs: "" }; } };
  const run = (await new ClosedLoopPortAdapter(r.deps).open({ ...r.openInput, runId: "run-10" }))!;
  const flow = run.openFlow(r.flowInput({ delegationId: "run-10-flow-login" }))!;
  r.writeWorkspace("flows/login.spec.ts", SPEC);
  r.registry.bindSession({ sessionId: "side-1", runId: "run-10", agent: RUN_SPEC_FLOW_AGENT, delegationId: "run-10-flow-login" });
  const pending = r.registry.find("side-1")!.call({ sessionId: "side-1", agent: RUN_SPEC_FLOW_AGENT, path: "flows/login.spec.ts" });
  await new Promise((resolve) => setImmediate(resolve));
  await flow.close();
  assert.ok(r.cleaned.includes("run-10-login-rs1"));
  release();
  await pending;
});

test("a flow cannot be opened twice, and a flow of a run whose loop is closed cannot be opened at all", async (t) => {
  const r = await rig(t);
  assert.ok(r.run.openFlow(r.flowInput()));
  assert.throws(() => r.run.openFlow(r.flowInput()), /already open/);
  await r.run.close();
  assert.equal(r.run.openFlow(r.flowInput({ delegationId: "run-9-flow-late", flowId: "late" })), undefined);
});
