import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { ProcessKillAdapter } from "../../../src/shared-infrastructure/process-sandbox/process-kill.adapter.ts";
/* Import depth: from qa-engine/test/shared-infrastructure/process-sandbox/ → qa-engine/src/ is 3 levels up
   (../../../). 4 levels would reach the repo root (qayaba/src/), which is wrong.
 */

function fakeChild(pid: number | undefined, killSpy: string[]): ChildProcess {
  return { pid, kill(sig?: string) { killSpy.push(`direct:${sig}`); return true; } } as unknown as ChildProcess;
}

test("killTree signals the whole process group when a pid is present", () => {
  const calls: Array<[number, string]> = [];
  const adapter = new ProcessKillAdapter((pid, sig) => { calls.push([pid, sig]); });
  adapter.killTree(fakeChild(1234, []));
  assert.deepEqual(calls, [[-1234, "SIGKILL"]]); /* negative pid ⇒ process group */
});

test("killTree falls back to a direct kill when the group send throws", () => {
  const spy: string[] = [];
  const adapter = new ProcessKillAdapter(() => { throw new Error("ESRCH"); });
  adapter.killTree(fakeChild(1234, spy));
  assert.deepEqual(spy, ["direct:SIGKILL"]);
});

test("killTree kills directly when there is no pid", () => {
  const spy: string[] = [];
  const adapter = new ProcessKillAdapter(() => { throw new Error("should not be called"); });
  adapter.killTree(fakeChild(undefined, spy));
  assert.deepEqual(spy, ["direct:SIGKILL"]);
});

/* code-execution.runner.ts, e2e-execution.runner.ts, static-gate.checks.ts, code-setup.ts,
   stryker-mutation-oracle.adapter.ts, dom-snapshot.ts, codebase-memory-client.ts) instantiates
   `new ProcessKillAdapter()` with NO args — i.e. every real timeout/abort kill path in the codebase
   runs through the DEFAULT `kill` param. The 3 tests above only ever inject a fake kill fn, so a
   neutered default ((pid, sig) => {}) passed `npm test` while silently disabling every real kill.
   This test is the missing pin: it proves the DEFAULT (no constructor arg) actually reaches
   process.kill, by monkeypatching the real global (a plain writable property, not an ESM-frozen
   export — process.kill is safely restorable via t.after).
 */
test("the DEFAULT kill function (no constructor arg) actually invokes process.kill", (t) => {
  const calls: Array<[number, string]> = [];
  const originalKill = process.kill;
  process.kill = ((pid: number, signal?: string | number) => {
    calls.push([pid, String(signal)]);
    return true;
  }) as typeof process.kill;
  t.after(() => {
    process.kill = originalKill;
  });

  const adapter = new ProcessKillAdapter(); /* no injected kill fn — exercises the real default */
  adapter.killTree(fakeChild(1234, []));

  assert.deepEqual(calls, [[-1234, "SIGKILL"]]); /* negative pid ⇒ process group */
});

/* A descendant that escaped the killed group (its own session) still holds the pipe the parent reads. If the parent
   keeps reading, that descendant keeps feeding it output for as long as it lives. */
test("killTree closes the parent's read side of the child's pipes, so an escaped descendant cannot keep feeding it", { timeout: 20_000 }, async () => {
  const escapee = [
    "const { spawn } = require('node:child_process');",
    "const g = spawn(process.execPath, ['-e', \"process.stdout.write('GRANDCHILD-PID:' + process.pid + '\\\\n'); setInterval(() => process.stdout.write('flood\\\\n'.repeat(2000)), 1);\"], { detached: true, stdio: ['ignore', 1, 2] });",
    "setInterval(() => {}, 1000);",
  ].join(" ");
  const child = spawn(process.execPath, ["-e", escapee], { detached: true });
  let escapedPid: number | undefined;
  let received = 0;
  let killed = false;
  let receivedAfterKill = 0;
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    received += chunk.length;
    if (killed) receivedAfterKill += chunk.length;
    const m = /GRANDCHILD-PID:(\d+)/.exec(chunk);
    if (m) escapedPid = Number(m[1]);
  });
  try {
    while (received < 10_000) await once(child.stdout!, "data");
    new ProcessKillAdapter().killTree(child);
    killed = true;
    assert.equal(child.stdout!.destroyed, true, "stdout is closed on the parent's side");
    assert.equal(child.stderr!.destroyed, true, "stderr is closed on the parent's side");
    await once(child, "close");
    assert.equal(receivedAfterKill, 0, "nothing more arrives from the escaped descendant once the tree is killed");
  } finally {
    if (escapedPid) { try { process.kill(escapedPid, "SIGKILL"); } catch { /* already gone */ } }
  }
});
