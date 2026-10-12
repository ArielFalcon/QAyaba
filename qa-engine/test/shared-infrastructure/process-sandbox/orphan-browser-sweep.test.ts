import { test } from "node:test";
import assert from "node:assert/strict";
import { sweepOrphanAgentBrowsers, type OrphanSweepDeps } from "../../../src/shared-infrastructure/process-sandbox/orphan-browser-sweep.ts";

const ROOT = "/tmp/qa-exec";

function proc(entries: Record<string, string[]>, own = 1): { deps: OrphanSweepDeps; killed: Array<[number, string]> } {
  const killed: Array<[number, string]> = [];
  return {
    killed,
    deps: {
      listProcesses: () => Object.keys(entries),
      commandLine: (pid) => entries[pid],
      kill: (pid, signal) => void killed.push([pid, signal]),
      ownPid: own,
    },
  };
}

const BROWSER = ["/ms-playwright/chromium/chrome", "--headless", "--remote-debugging-pipe", `--user-data-dir=${ROOT}/run-1/browser-ab12/profile`, "about:blank"];

test("a browser the agent tools started in a run's work dir, left behind, is killed with its group", () => {
  const { deps, killed } = proc({ "300": BROWSER });
  assert.equal(sweepOrphanAgentBrowsers(ROOT, deps), 1);
  assert.deepEqual(killed, [[-300, "SIGKILL"]]);
});

test("the lifetime wrapper in front of the browser is found by the same command line", () => {
  const { deps, killed } = proc({ "310": ["timeout", "--signal=KILL", "10800", ...BROWSER] });
  assert.equal(sweepOrphanAgentBrowsers(ROOT, deps), 1);
  assert.deepEqual(killed, [[-310, "SIGKILL"]]);
});

test("a browser that is not ours is left alone: another profile directory, no debugging pipe, or the orchestrator itself", () => {
  const { deps, killed } = proc({
    "400": ["/usr/bin/chromium", "--remote-debugging-pipe", "--user-data-dir=/home/user/.config/chromium"],
    "401": ["/ms-playwright/chromium/chrome", `--user-data-dir=${ROOT}/run-1/browser-x/profile`],
    "402": ["node", "tsx", "src/index.ts"],
    "1": BROWSER,
  });
  assert.equal(sweepOrphanAgentBrowsers(ROOT, deps), 0);
  assert.deepEqual(killed, []);
});

test("a process that vanished while it was being read, or cannot be signalled, does not stop the sweep", () => {
  const { deps, killed } = proc({ "500": BROWSER, "501": BROWSER });
  const original = deps.kill;
  deps.kill = (pid, signal) => { if (pid === -500) throw new Error("ESRCH"); original(pid, signal); };
  deps.commandLine = (pid) => (pid === 499 ? undefined : { 500: BROWSER, 501: BROWSER }[pid]);
  assert.equal(sweepOrphanAgentBrowsers(ROOT, deps), 1);
  assert.deepEqual(killed, [[-501, "SIGKILL"]]);
});

test("with no process table (not Linux) there is nothing to sweep", () => {
  assert.equal(sweepOrphanAgentBrowsers(ROOT, { listProcesses: () => { throw new Error("ENOENT"); }, commandLine: () => undefined, kill: () => {}, ownPid: 1 }), 0);
});
