import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { ExecSandboxPort, ExecSpawnOptions } from "../../../../../src/shared-infrastructure/process-sandbox/exec-sandbox.ts";
import { SandboxedChromiumLauncher, type PlaywrightChromium } from "@contexts/test-execution/infrastructure/agent-browser/chromium-sandbox.launcher.ts";
import type { PwBrowser } from "@contexts/test-execution/infrastructure/agent-browser/playwright-types.ts";

class FakeChild extends EventEmitter {
  readonly stderr = new PassThrough();
  pid = 4242;
  killed = false;
}

function setup(over: { announce?: string | null; exitCode?: number; connectFails?: boolean; wrapper?: string; startSignal?: AbortSignal } = {}) {
  const child = new FakeChild();
  const spawns: { cmd: string; args: readonly string[]; options: ExecSpawnOptions }[] = [];
  const exec: Partial<ExecSandboxPort> = {
    allocDir: (prefix, subdirs) => `/work/${prefix}-x${subdirs?.length ? "" : ""}`,
    spawn: (cmd, args, options) => {
      spawns.push({ cmd, args, options });
      queueMicrotask(() => {
        if (over.exitCode !== undefined) child.emit("close", over.exitCode, null);
        else if (over.announce !== null) child.stderr.write(over.announce ?? "DevTools listening on ws://127.0.0.1:41233/devtools/browser/abc\n");
      });
      return child as unknown as ChildProcess;
    },
  };
  const connects: string[] = [];
  let browserClosed = 0;
  const browser: PwBrowser = { newContext: async () => { throw new Error("unused"); }, close: async () => { browserClosed += 1; } };
  const chromium: PlaywrightChromium = {
    executablePath: () => "/ms-playwright/chromium/chrome",
    connectOverCDP: async (url) => {
      connects.push(url);
      if (over.connectFails) throw new Error("connect refused");
      return browser;
    },
  };
  const killed: ChildProcess[] = [];
  const launcher = new SandboxedChromiumLauncher({
    exec: exec as ExecSandboxPort,
    chromium: async () => chromium,
    kill: { killTree: (c) => { killed.push(c); } },
    ...(over.wrapper !== undefined ? { ttlWrapper: { command: over.wrapper, seconds: 3600 } } : {}),
    startSignal: () => over.startSignal ?? new AbortController().signal,
  });
  return { launcher, child, spawns, connects, killed, browserClosed: () => browserClosed };
}

test("the browser runs through the execution launcher with the suite profile, a profile in the run's work dir and a debugging port of its own", async () => {
  const { launcher, spawns, connects } = setup();
  await launcher.launch();
  const spawn = spawns[0]!;
  assert.equal(spawn.cmd, "/ms-playwright/chromium/chrome");
  assert.equal(spawn.options.profile, "suite");
  assert.ok(spawn.args.includes("--remote-debugging-port=0"));
  assert.ok(spawn.args.includes("--headless"));
  const profile = spawn.args.find((a) => a.startsWith("--user-data-dir="));
  assert.ok(profile?.startsWith("--user-data-dir=/work/"), "the profile lives in the run's work dir");
  assert.deepEqual(connects, ["ws://127.0.0.1:41233/devtools/browser/abc"]);
});

test("a lifetime wrapper sits in front of the browser so that it ends even if the orchestrator does not", async () => {
  const { launcher, spawns } = setup({ wrapper: "timeout" });
  await launcher.launch();
  assert.equal(spawns[0]!.cmd, "timeout");
  assert.deepEqual(spawns[0]!.args.slice(0, 3), ["--signal=KILL", "3600", "/ms-playwright/chromium/chrome"]);
});

test("disposing closes the browser and kills the whole process group, once", async () => {
  const { launcher, killed, browserClosed } = setup();
  const launched = await launcher.launch();
  await launched.dispose();
  await launched.dispose();
  assert.equal(browserClosed(), 1);
  assert.equal(killed.length, 1);
});

test("a browser that exits before it announces its port is a start failure that names the exit code and not its output", async () => {
  const { launcher, killed } = setup({ announce: null, exitCode: 139 });
  await assert.rejects(launcher.launch(), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /139/);
    return true;
  });
  assert.equal(killed.length, 1);
});

test("a browser that never announces its port is killed when the start time is up", async () => {
  const start = new AbortController();
  const { launcher, killed } = setup({ announce: null, startSignal: start.signal });
  const pending = launcher.launch();
  await new Promise((r) => setImmediate(r));
  start.abort();
  await assert.rejects(pending, /did not start/);
  assert.equal(killed.length, 1);
});

test("a failed connection kills the browser it started", async () => {
  const { launcher, killed } = setup({ connectFails: true });
  await assert.rejects(launcher.launch(), /connect refused/);
  assert.equal(killed.length, 1);
});
