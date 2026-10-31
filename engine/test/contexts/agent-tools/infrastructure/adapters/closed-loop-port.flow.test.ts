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
import { RUN_SPEC_FLOW_AGENT } from "@contexts/test-execution/domain/run-spec-capability.ts";
import type { ExecutionOpts } from "@contexts/test-execution/application/index.ts";
import type { DevWriteRequest } from "@contexts/test-execution/domain/dev-write-request.ts";
import type { ClosedLoopHandle, ClosedLoopOpenInput, FlowLoopOpenInput } from "@contexts/agent-tools/application/index.ts";

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

async function rig(t: TestContext, over: { devWrites?: number; runDevWrites?: number; uncounted?: boolean; devWriteRequests?: DevWriteRequest[]; script?: Array<{ devWrites: number; unfinishedTests?: number; stopped?: boolean }> } = {}): Promise<Rig> {
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
    setting: { enabled: true, limits: over.runDevWrites === undefined ? LIMITS : { ...LIMITS, maxDevWrites: over.runDevWrites } },
    generatorRuntimeCanCall: () => true,
    execution: {
      execute: async (dir, opts) => {
        r.events.push("execute");
        r.executed.push({ specDir: dir, opts: opts as ExecutionOpts });
        const scripted = over.script?.shift();
        if (scripted?.stopped) return { verdict: "infra-error", cases: [], logs: "playwright runner aborted by operator cancel — killed", devWrites: scripted.devWrites, ...(scripted.unfinishedTests !== undefined ? { unfinishedTests: scripted.unfinishedTests } : {}) };
        return { verdict: "pass", cases: [{ name: "loads", status: "pass" }], logs: "", ...(over.uncounted ? {} : { devWrites: over.devWrites ?? 1 }), ...(over.devWriteRequests ? { devWriteRequests: over.devWriteRequests } : {}) };
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

test("a flow's loop is the sidekick's alone: the sidekick of that flow calls it, the run's own session and a sibling do not", async (t) => {
  const r = await rig(t);
  assert.ok(r.run.openFlow(r.flowInput()));
  bind(r);
  bind(r, "side-2", "run-9-flow-other");
  r.registry.bindSession({ sessionId: "gen", runId: "run-9", agent: RUN_SPEC_FLOW_AGENT });
  assert.ok(r.registry.find("side-1"));
  assert.equal(r.registry.find("side-2"), undefined, "a flow that has no loop");
  assert.equal(r.registry.find("gen"), undefined, "no session of the run itself holds the run's loop");
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
  assert.equal(r.run.signals().calls, 2, "the run's totals count them");
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

test("the requests behind a call's writes to DEV reach the flow's ledger entry", async (t) => {
  const devWriteRequests = [{ method: "POST", url: "https://dev.example.com/api/sessions", count: 1 }];
  const r = await rig(t, { devWrites: 1, devWriteRequests });
  const flow = r.run.openFlow(r.flowInput())!;
  r.writeWorkspace("flows/login.spec.ts", SPEC);
  bind(r);
  assert.ok((await call(r)).ok);
  assert.deepEqual(flow.ledger()[0]?.devWriteRequests, devWriteRequests);
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

test("the run's counts include its flows' calls and writes, and the calls its flows were granted", async (t) => {
  const r = await rig(t);
  r.run.openFlow(r.flowInput());
  r.run.openFlow(r.flowInput({ delegationId: "run-9-flow-other", flowId: "other", limits: { maxCalls: 4, maxDevWrites: 3 } }));
  r.writeWorkspace("flows/login.spec.ts", SPEC);
  bind(r);
  await call(r);
  assert.deepEqual(r.run.signals(), { calls: 1, devWrites: 1, granted: 6 });
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

const flowOf = (r: Rig, i: number, maxDevWrites: number): FlowLoopOpenInput => r.flowInput({ delegationId: `run-9-flow-f${i}`, flowId: `f${i}`, limits: { maxCalls: 2, maxDevWrites } });

test("the run's DEV-write cap holds across its flows together: twelve flows of two writes each against a cap of twenty send twenty, and the refusals are recorded", async (t) => {
  const r = await rig(t, { runDevWrites: 20 });
  for (let i = 0; i < 12; i++) r.run.openFlow(flowOf(r, i, 2));
  r.writeWorkspace("flows/login.spec.ts", SPEC);
  const refused: string[] = [];
  for (let i = 0; i < 12; i++) {
    bind(r, `side-${i}`, `run-9-flow-f${i}`);
    for (let k = 0; k < 2; k++) {
      const answer = await call(r, `side-${i}`);
      if (!answer.ok) refused.push(answer.code);
    }
  }
  assert.equal(r.run.signals().devWrites, 20, "no write past the run's cap");
  assert.equal(r.executed.length, 20);
  assert.ok(refused.length === 4 && refused.every((code) => code === "no-writes"), JSON.stringify(refused));
  assert.equal(r.run.signals().writesRefused, 4);
});

test("flows racing for the run's last DEV write never send more than the run's cap together", async (t) => {
  const r = await rig(t, { runDevWrites: 1 });
  for (let i = 0; i < 3; i++) {
    r.run.openFlow(flowOf(r, i, 1));
    bind(r, `side-${i}`, `run-9-flow-f${i}`);
  }
  r.writeWorkspace("flows/login.spec.ts", SPEC);
  const answers = await Promise.all([0, 1, 2].map((i) => call(r, `side-${i}`)));
  assert.equal(r.executed.length, 1, "one spec ran");
  assert.equal(r.run.signals().devWrites, 1);
  assert.deepEqual(answers.map((a) => (a.ok ? "ok" : a.code)).sort(), ["no-writes", "no-writes", "ok"]);
  const ran = answers.find((a) => a.ok);
  assert.equal(ran?.ok ? ran.report.budget.devWritesLeft : -1, 0, "the budget a flow is told is the run's real remainder");
});

test("a flow opened once the run's DEV writes are spent keeps its loop and its share; its calls are refused while the run's cap is spent, and it is told so", async (t) => {
  const r = await rig(t, { runDevWrites: 1 });
  r.run.openFlow(flowOf(r, 0, 1));
  bind(r, "side-0", "run-9-flow-f0");
  r.writeWorkspace("flows/login.spec.ts", SPEC);
  assert.ok((await call(r, "side-0")).ok);
  const late = r.run.openFlow(flowOf(r, 1, 2))!;
  assert.equal(late.limits.maxDevWrites, 2);
  assert.equal(late.runWritesLeft(), 0);
  bind(r, "side-1", "run-9-flow-f1");
  const refused = await call(r, "side-1");
  assert.equal(!refused.ok ? refused.code : "", "no-writes");
  assert.equal(!refused.ok ? refused.budget.devWritesLeft : -1, 0);
  assert.equal(r.run.signals().writesRefused, 1);
});

test("a call whose writes could not be counted is charged the run's whole remainder, not only its flow's share", async (t) => {
  const r = await rig(t, { runDevWrites: 10, uncounted: true });
  r.run.openFlow(flowOf(r, 0, 2));
  r.run.openFlow(flowOf(r, 1, 2));
  bind(r, "side-0", "run-9-flow-f0");
  bind(r, "side-1", "run-9-flow-f1");
  r.writeWorkspace("flows/login.spec.ts", SPEC);
  assert.ok((await call(r, "side-0")).ok);
  const next = await call(r, "side-1");
  assert.equal(!next.ok ? next.code : "", "no-writes", "nothing of the run's cap is left for another flow");
  assert.equal(r.run.signals().writesRefused, 1);
});

test("the calls the run granted count only the flows whose loop can run a spec", async (t) => {
  const r = await rig(t, { runDevWrites: 10 });
  r.run.openFlow(r.flowInput({ delegationId: "run-9-flow-none", flowId: "none", limits: { maxCalls: 5, maxDevWrites: 0 } }));
  r.run.openFlow(flowOf(r, 0, 2));
  assert.equal(r.run.signals().granted, 2);
});

test("a replacement sidekick of a flow inherits what the first one's aborted call was counted, and the flow cannot be opened again", async (t) => {
  const r = await rig(t, { runDevWrites: 20, script: [{ devWrites: 3, unfinishedTests: 1, stopped: true }] });
  const flow = r.run.openFlow(flowOf(r, 0, 4))!;
  r.writeWorkspace("flows/login.spec.ts", SPEC);
  bind(r, "side-a", "run-9-flow-f0");
  const aborted = await call(r, "side-a");
  assert.ok(aborted.ok);
  r.registry.unbindSession("side-a");
  bind(r, "side-b", "run-9-flow-f0");
  const next = await call(r, "side-b");
  assert.ok(next.ok, "the replacement is not refused for writes the first one never sent");
  assert.equal(flow.signals().devWrites, 4, "the flow's share is spent by what was counted, 3 by the aborted call and 1 by the next");
  assert.equal(r.run.signals().devWrites, 4);
  assert.throws(() => r.run.openFlow(flowOf(r, 0, 4)), /already open/, "a replacement shares the flow's loop; it never gets a second one");
});

test("an aborted call charges the flow and the run only what was counted, so the flows beside it keep their share", async (t) => {
  const r = await rig(t, { runDevWrites: 20, script: [{ devWrites: 3, unfinishedTests: 1, stopped: true }] });
  r.run.openFlow(flowOf(r, 0, 4));
  const other = r.run.openFlow(flowOf(r, 1, 4))!;
  r.writeWorkspace("flows/login.spec.ts", SPEC);
  bind(r, "side-0", "run-9-flow-f0");
  bind(r, "side-1", "run-9-flow-f1");
  assert.ok((await call(r, "side-0")).ok);
  assert.equal(r.run.signals().devWrites, 3);
  assert.equal(other.runWritesLeft(), 17);
  assert.ok((await call(r, "side-1")).ok, "the other flow is admitted");
});
