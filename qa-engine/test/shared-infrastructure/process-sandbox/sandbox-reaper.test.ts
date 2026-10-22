import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SandboxResidueError,
  createSandboxReaper,
  liveSandboxChildren,
  procTable,
  trackSandboxChild,
  type ProcessInfo,
  type ProcessTable,
} from "../../../src/shared-infrastructure/process-sandbox/sandbox-reaper.ts";

const UID = 1002;

/* A process table the test moves: a kill removes the process unless it is listed as stubborn. */
function fakeTable(initial: ProcessInfo[], stubborn: number[] = []): { table: ProcessTable; killed: number[]; processes: ProcessInfo[]; clock: { ms: number } } {
  const processes = [...initial];
  const killed: number[] = [];
  const clock = { ms: 0 };
  return {
    processes,
    killed,
    clock,
    table: {
      list: () => processes.map((p) => ({ ...p })),
      kill: (pid) => {
        killed.push(pid);
        if (stubborn.includes(pid)) return;
        const at = processes.findIndex((p) => p.pid === pid);
        if (at >= 0) processes.splice(at, 1);
      },
      sleepSync: (ms) => { clock.ms += ms; },
      now: () => clock.ms,
    },
  };
}

const proc = (pid: number, ppid: number, uid = UID, zombie = false): ProcessInfo => ({ pid, ppid, uid, zombie });

test("a process of the sandbox uid that no live child owns is killed, and the run is told how many", () => {
  const t = fakeTable([proc(500, 1), proc(501, 1), proc(900, 1, 0)]);
  const reaper = createSandboxReaper({ uid: UID, table: t.table, liveChildren: () => new Set(), ownPid: 7 });
  assert.equal(reaper.reapOrphans(), 2);
  assert.deepEqual(t.killed.sort(), [500, 501]);
  assert.deepEqual(t.processes.map((p) => p.pid), [900], "another uid's process is not touched");
});

test("a live child and everything below it are left alone, however deep", () => {
  const t = fakeTable([proc(100, 7), proc(101, 100), proc(102, 101), proc(103, 102), proc(500, 1)]);
  const reaper = createSandboxReaper({ uid: UID, table: t.table, liveChildren: () => new Set([100]), ownPid: 7 });
  assert.equal(reaper.reapOrphans(), 1);
  assert.deepEqual(t.killed, [500]);
});

test("a process that left the tree of a live child (a daemon reparented to init) is an orphan even while that child runs", () => {
  const t = fakeTable([proc(100, 7), proc(104, 1)]);
  const reaper = createSandboxReaper({ uid: UID, table: t.table, liveChildren: () => new Set([100]), ownPid: 7 });
  assert.equal(reaper.reapOrphans(), 1);
  assert.deepEqual(t.killed, [104]);
});

test("a zombie is not an orphan: it holds nothing and cannot act", () => {
  const t = fakeTable([proc(500, 1, UID, true)]);
  const reaper = createSandboxReaper({ uid: UID, table: t.table, liveChildren: () => new Set() });
  assert.equal(reaper.reapOrphans(), 0);
  assert.deepEqual(t.killed, []);
});

test("init and the orchestrator itself are never signalled, whatever uid the table gives them", () => {
  const t = fakeTable([proc(1, 0), proc(7, 1)]);
  const reaper = createSandboxReaper({ uid: UID, table: t.table, liveChildren: () => new Set(), ownPid: 7 });
  assert.equal(reaper.reapOrphans(), 0);
  assert.deepEqual(t.killed, []);
});

test("a process that survives the signal until the timeout fails the reap, naming it", () => {
  const t = fakeTable([proc(500, 1), proc(501, 1)], [501]);
  const reaper = createSandboxReaper({ uid: UID, table: t.table, liveChildren: () => new Set(), timeoutMs: 100 });
  assert.throws(() => reaper.reapOrphans(), (err: unknown) => err instanceof SandboxResidueError && err.pids.length === 1 && err.pids[0] === 501);
  assert.ok(t.killed.filter((pid) => pid === 501).length >= 2, "a stubborn process is signalled again on each pass");
});

test("a process that takes a moment to leave is waited for", () => {
  const t = fakeTable([proc(500, 1)]);
  let passes = 0;
  const slow: ProcessTable = { ...t.table, kill: (pid) => { passes += 1; if (passes >= 3) t.table.kill(pid); } };
  const reaper = createSandboxReaper({ uid: UID, table: slow, liveChildren: () => new Set() });
  assert.equal(reaper.reapOrphans(), 1);
  assert.ok(passes >= 3);
});

test("the launcher's registry follows children until they exit, per uid, and says when the last one went", () => {
  const first = Object.assign(new EventEmitter(), { pid: 4001 });
  const second = Object.assign(new EventEmitter(), { pid: 4002 });
  const settled: string[] = [];
  trackSandboxChild(UID, first, () => settled.push("first"));
  trackSandboxChild(UID, second, () => settled.push("second"));
  assert.deepEqual([...liveSandboxChildren(UID)].sort(), [4001, 4002]);
  assert.deepEqual([...liveSandboxChildren(UID + 1)], []);
  first.emit("exit", 0, null);
  assert.deepEqual([...liveSandboxChildren(UID)], [4002]);
  second.emit("error", new Error("x"));
  second.emit("exit", 0, null);
  assert.deepEqual([...liveSandboxChildren(UID)], []);
  assert.deepEqual(settled, ["first", "second"], "each child settles once");
});

test("procTable reads the uid, parent and state of each process from the status files", () => {
  const root = mkdtempSync(join(tmpdir(), "fake-proc-"));
  try {
    for (const [pid, uid, ppid, state] of [[10, 1002, 1, "S (sleeping)"], [11, 0, 10, "R (running)"], [12, 1002, 1, "Z (zombie)"]] as const) {
      mkdirSync(join(root, String(pid)));
      writeFileSync(join(root, String(pid), "status"), `Name:\tx\nState:\t${state}\nPPid:\t${ppid}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
    }
    mkdirSync(join(root, "self"));
    mkdirSync(join(root, "13"));
    const table = procTable(root).list().sort((a, b) => a.pid - b.pid);
    assert.deepEqual(table, [
      { pid: 10, ppid: 1, uid: 1002, zombie: false },
      { pid: 11, ppid: 10, uid: 0, zombie: false },
      { pid: 12, ppid: 1, uid: 1002, zombie: true },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
