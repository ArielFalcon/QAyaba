import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClosedLoopPortAdapter, type ClosedLoopPortAdapterDeps } from "@contexts/agent-tools/infrastructure/adapters/closed-loop-port.adapter.ts";
import { ClosedLoopRegistry } from "@contexts/agent-tools/infrastructure/closed-loop-registry.ts";
import { AccountLock } from "@contexts/test-execution/domain/account-lock.ts";
import { RUN_SPEC_AGENT } from "@contexts/test-execution/domain/run-spec-capability.ts";
import { createRunSecretScope, redactByValue, withRunSecretScope } from "../../../../../src/shared-infrastructure/redaction/run-secret-redaction.ts";
import type { ExecutionOpts } from "@contexts/test-execution/application/index.ts";
import type { ClosedLoopOpenInput } from "@contexts/agent-tools/application/index.ts";

const SPEC = 'import { test } from "../fixtures";\ntest("loads", async () => {});\n';
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const LIMITS = { maxCalls: 4, perCallMs: 60_000, maxDevWrites: 10 };

interface Rig {
  deps: ClosedLoopPortAdapterDeps;
  registry: ClosedLoopRegistry;
  openInput: ClosedLoopOpenInput;
  specDir: string;
  executed: Array<{ specDir: string; opts: ExecutionOpts }>;
  cleaned: string[];
  seen: { redacted?: string };
  write(rel: string, text: string): void;
}

function rig(t: TestContext, over: { enabled?: boolean; canCall?: boolean } = {}): Rig {
  const mirrorDir = mkdtempSync(join(tmpdir(), "closed-loop-"));
  t.after(() => rmSync(mirrorDir, { recursive: true, force: true }));
  const specDir = join(mirrorDir, "e2e");
  mkdirSync(specDir, { recursive: true });
  const registry = new ClosedLoopRegistry();
  const r: Rig = {
    registry, specDir, executed: [], cleaned: [], seen: {},
    openInput: { runId: "run-9", app: "demo", mode: "diff", mirrorDir, specDir },
    deps: undefined as never,
    write: (rel, text) => { mkdirSync(join(specDir, rel, ".."), { recursive: true }); writeFileSync(join(specDir, rel), text); },
  };
  r.deps = {
    registry,
    setting: { enabled: over.enabled ?? true, limits: LIMITS },
    generatorRuntimeCanCall: () => over.canCall ?? true,
    execution: {
      execute: async (dir, opts) => {
        r.executed.push({ specDir: dir, opts: opts as ExecutionOpts });
        r.seen.redacted = redactByValue("the password is hunter2-secret");
        return { verdict: "pass", cases: [{ name: "loads", status: "pass" }], logs: "", devWrites: 1 };
      },
    },
    cleanup: { cleanup: async (_dir, o) => void r.cleaned.push(o.namespace) },
    specRelDir: "e2e",
    account: "demo/user",
    lock: new AccountLock(),
    redact: (text) => redactByValue(text),
  };
  r.write("flows/a.spec.ts", SPEC);
  return r;
}

const callOf = (r: Rig, path = "flows/a.spec.ts") => r.registry.find("ses-1")!.call({ sessionId: "ses-1", agent: RUN_SPEC_AGENT, path });

test("a disabled app is not granted the loop, and the run's own choice overrides the app's", async (t) => {
  const off = rig(t, { enabled: false });
  assert.equal(await new ClosedLoopPortAdapter(off.deps).open(off.openInput), undefined);
  assert.equal(off.registry.size, 0);

  const forcedOn = rig(t, { enabled: false });
  assert.ok(await new ClosedLoopPortAdapter(forcedOn.deps).open({ ...forcedOn.openInput, enabled: true }));

  const forcedOff = rig(t, { enabled: true });
  assert.equal(await new ClosedLoopPortAdapter(forcedOff.deps).open({ ...forcedOff.openInput, enabled: false }), undefined);
});

test("a generator on a runtime that cannot call the tool is not granted the loop", async (t) => {
  const r = rig(t, { canCall: false });
  assert.equal(await new ClosedLoopPortAdapter(r.deps).open(r.openInput), undefined);
});

test("an open loop tells the prompt its limits and waits for the generator's session", async (t) => {
  const r = rig(t);
  const handle = await new ClosedLoopPortAdapter(r.deps).open(r.openInput);
  assert.deepEqual(handle?.limits, LIMITS);
  assert.equal(r.registry.size, 1);
  assert.equal(r.registry.find("ses-1"), undefined, "no session is bound yet");
});

test("only the generator's session of the run gets the right, and a call runs the spec once with the narrowing options", async (t) => {
  const r = rig(t);
  await new ClosedLoopPortAdapter(r.deps).open(r.openInput);
  r.registry.bindSession({ sessionId: "ses-1", runId: "run-9", agent: RUN_SPEC_AGENT });
  r.registry.bindSession({ sessionId: "ses-2", runId: "run-9", agent: "qa-reviewer" });
  r.registry.bindSession({ sessionId: "ses-3", runId: "other-run", agent: RUN_SPEC_AGENT });
  assert.equal(r.registry.find("ses-2"), undefined);
  assert.equal(r.registry.find("ses-3"), undefined);

  const response = await callOf(r);
  assert.ok(response.ok);
  assert.equal(response.report.status, "passed");
  const [call] = r.executed;
  assert.equal(call!.specDir, r.specDir);
  assert.deepEqual({ ...call!.opts, signal: undefined }, { specFiles: ["flows/a.spec.ts"], namespace: "run-9-rs1", timeoutMs: 60_000, retries: 0, countWrites: true, signal: undefined });
  assert.deepEqual(r.cleaned, ["run-9-rs1"]);
});

test("a call made from outside the run still sees the run's secrets, because it runs in the run's own scope", async (t) => {
  const r = rig(t);
  const scope = createRunSecretScope();
  scope.addAccountSecrets(["hunter2-secret"]);
  await withRunSecretScope(scope, async () => {
    await new ClosedLoopPortAdapter(r.deps).open(r.openInput);
  });
  r.registry.bindSession({ sessionId: "ses-1", runId: "run-9", agent: RUN_SPEC_AGENT });
  await callOf(r);
  assert.doesNotMatch(r.seen.redacted ?? "", /hunter2-secret/);
});

test("the loop is closed when every delivered spec still holds the bytes whose last call passed", async (t) => {
  const r = rig(t);
  const handle = (await new ClosedLoopPortAdapter(r.deps).open(r.openInput))!;
  r.registry.bindSession({ sessionId: "ses-1", runId: "run-9", agent: RUN_SPEC_AGENT });
  assert.equal(await handle.isClosed(["flows/a.spec.ts"]), false, "nothing has run yet");
  await callOf(r);
  assert.equal(await handle.isClosed(["flows/a.spec.ts"]), true);
  assert.equal(await handle.isClosed(["./flows/a.spec.ts"]), true, "the canonical form of the path");
  assert.equal(await handle.isClosed(["flows/a.spec.ts", "flows/b.spec.ts"]), false, "b never ran");
  r.write("flows/a.spec.ts", SPEC + "// edited after the call\n");
  assert.equal(await handle.isClosed(["flows/a.spec.ts"]), false, "the bytes changed");
  assert.equal(r.deps.registry.find("ses-1")!.capability.ledger[0]!.sha256, sha(SPEC));
});

test("a spec that is gone, or a link, is never closed", async (t) => {
  const r = rig(t);
  const handle = (await new ClosedLoopPortAdapter(r.deps).open(r.openInput))!;
  r.registry.bindSession({ sessionId: "ses-1", runId: "run-9", agent: RUN_SPEC_AGENT });
  await callOf(r);
  rmSync(join(r.specDir, "flows", "a.spec.ts"));
  assert.equal(await handle.isClosed(["flows/a.spec.ts"]), false);
});

test("the counts are the capability's", async (t) => {
  const r = rig(t);
  const handle = (await new ClosedLoopPortAdapter(r.deps).open(r.openInput))!;
  r.registry.bindSession({ sessionId: "ses-1", runId: "run-9", agent: RUN_SPEC_AGENT });
  await callOf(r);
  await callOf(r);
  assert.deepEqual(handle.signals(), { calls: 2, devWrites: 2 });
});

test("sweeping removes the probe directory and leaves the suite alone; a link in its place goes without being followed", async (t) => {
  const r = rig(t);
  const handle = (await new ClosedLoopPortAdapter(r.deps).open(r.openInput))!;
  r.write(".qa-probe/try.spec.ts", SPEC);
  r.write(".qa-probe/deep/more.spec.ts", SPEC);
  await handle.sweepProbes();
  assert.equal(existsSync(join(r.specDir, ".qa-probe")), false);
  assert.equal(existsSync(join(r.specDir, "flows", "a.spec.ts")), true);
  await handle.sweepProbes();

  const outside = mkdtempSync(join(tmpdir(), "closed-loop-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "keep.txt"), "keep");
  symlinkSync(outside, join(r.specDir, ".qa-probe"));
  await handle.sweepProbes();
  assert.equal(existsSync(join(r.specDir, ".qa-probe")), false);
  assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "keep", "what the link pointed at is untouched");
});

test("a probe tree too deep to be removed within its bounds fails the sweep instead of leaving it or freezing on it", async (t) => {
  const r = rig(t);
  const handle = (await new ClosedLoopPortAdapter(r.deps).open(r.openInput))!;
  let deep = join(r.specDir, ".qa-probe");
  for (let i = 0; i < 80; i++) deep = join(deep, "d");
  mkdirSync(deep, { recursive: true });
  await assert.rejects(handle.sweepProbes(), /bounds/);
});

test("closing revokes the right, forgets the loop, removes the probes and never throws", async (t) => {
  const r = rig(t);
  const handle = (await new ClosedLoopPortAdapter(r.deps).open(r.openInput))!;
  r.registry.bindSession({ sessionId: "ses-1", runId: "run-9", agent: RUN_SPEC_AGENT });
  const capability = r.registry.find("ses-1")!.capability;
  r.write(".qa-probe/try.spec.ts", SPEC);
  await handle.close();
  assert.equal(capability.authorize("ses-1", RUN_SPEC_AGENT)?.code, "revoked");
  assert.equal(r.registry.size, 0);
  assert.equal(r.registry.find("ses-1"), undefined);
  assert.equal(existsSync(join(r.specDir, ".qa-probe")), false);
  await handle.close();
});

test("closing while a call is in flight cleans the namespace it was using", async (t) => {
  const r = rig(t);
  let release!: () => void;
  r.deps.execution = { execute: async () => { await new Promise<void>((resolve) => { release = resolve; }); return { verdict: "pass", cases: [{ name: "x", status: "pass" }], logs: "" }; } };
  const handle = (await new ClosedLoopPortAdapter(r.deps).open(r.openInput))!;
  r.registry.bindSession({ sessionId: "ses-1", runId: "run-9", agent: RUN_SPEC_AGENT });
  const pending = callOf(r);
  await new Promise((resolve) => setImmediate(resolve));
  await handle.close();
  assert.ok(r.cleaned.includes("run-9-rs1"));
  release();
  await pending;
});

test("the registry forgets a session that was unbound", async (t) => {
  const r = rig(t);
  await new ClosedLoopPortAdapter(r.deps).open(r.openInput);
  r.registry.bindSession({ sessionId: "ses-1", runId: "run-9", agent: RUN_SPEC_AGENT });
  r.registry.unbindSession("ses-1");
  assert.equal(r.registry.find("ses-1"), undefined);
});

test("when the generator's session ends, the call it left running is stopped, and a session that is still bound is left alone", async (t) => {
  const r = rig(t);
  const seen: AbortSignal[] = [];
  r.deps.execution = {
    execute: async (_dir, opts) => {
      const signal = (opts as ExecutionOpts).signal!;
      seen.push(signal);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { verdict: "infra-error", cases: [], logs: "aborted" };
    },
  };
  await new ClosedLoopPortAdapter(r.deps).open(r.openInput);
  r.registry.bindSession({ sessionId: "ses-1", runId: "run-9", agent: RUN_SPEC_AGENT });
  r.registry.bindSession({ sessionId: "ses-2", runId: "run-9", agent: RUN_SPEC_AGENT });
  const pending = callOf(r);
  await new Promise((resolve) => setImmediate(resolve));
  r.registry.unbindSession("ses-2");
  assert.equal(seen[0]!.aborted, false, "another session ending does not stop it");
  r.registry.unbindSession("ses-1");
  assert.equal(seen[0]!.aborted, true);
  const response = await pending;
  assert.ok(response.ok && response.report.status === "error");
});

function rigWithLoginWall(t: TestContext): { r: Rig; prepared: string[] } {
  const r = rig(t);
  const prepared: string[] = [];
  r.write("auth.setup.ts", "// the login the run opened with\n");
  r.deps.execution = {
    execute: async () => ({ verdict: "fail", cases: [{ name: "loads", status: "fail", detail: "x", finalUrl: "https://dev.example/login" }], logs: "", devWrites: 0 }),
  };
  r.deps.authSession = { prepare: async (req) => { prepared.push(req.phase); return { unauthored: false }; } };
  r.deps.authContext = { baseUrl: "https://dev.example" };
  return { r, prepared };
}

test("a call that ends on the login page renews the session once, with the login the loop opened with", async (t) => {
  const { r, prepared } = rigWithLoginWall(t);
  await new ClosedLoopPortAdapter(r.deps).open(r.openInput);
  r.registry.bindSession({ sessionId: "ses-1", runId: "run-9", agent: RUN_SPEC_AGENT });
  const first = await callOf(r);
  assert.ok(first.ok && first.report.note?.includes("renewed"));
  const second = await callOf(r);
  assert.ok(second.ok && second.report.sessionLost === true, "a second loss in one run is reported, not renewed again");
  assert.deepEqual(prepared, ["pre-execute"]);
});

test("a call never signs in with a login script the generator wrote while it authored", async (t) => {
  const { r, prepared } = rigWithLoginWall(t);
  await new ClosedLoopPortAdapter(r.deps).open(r.openInput);
  r.registry.bindSession({ sessionId: "ses-1", runId: "run-9", agent: RUN_SPEC_AGENT });
  r.write("auth.setup.ts", "// authored by the generator\n");
  const response = await callOf(r);
  assert.ok(response.ok && response.report.sessionLost === true);
  assert.deepEqual(prepared, []);
});
