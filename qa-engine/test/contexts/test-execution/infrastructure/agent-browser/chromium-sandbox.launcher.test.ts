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
  readonly toBrowser = new PassThrough();
  readonly fromBrowser = new PassThrough();
  readonly stdio = [null, null, this.stderr, this.toBrowser, this.fromBrowser];
  pid = 4242;
}

function setup(over: { exitCode?: number; connectFails?: boolean; connectHangs?: boolean; wrapper?: string; startSignal?: AbortSignal; noPipe?: boolean } = {}) {
  const child = new FakeChild();
  const spawns: { cmd: string; args: readonly string[]; options: ExecSpawnOptions }[] = [];
  const exec: Partial<ExecSandboxPort> = {
    allocDir: (prefix) => `/work/${prefix}-x`,
    spawn: (cmd, args, options) => {
      spawns.push({ cmd, args, options });
      if (over.noPipe) (child.stdio as unknown[])[3] = null;
      if (over.exitCode !== undefined) setImmediate(() => child.emit("close", over.exitCode, null));
      return child as unknown as ChildProcess;
    },
  };
  const connects: string[] = [];
  const bridges: { pipe: unknown; closed: number }[] = [];
  let browserClosed = 0;
  const browser: PwBrowser = { newContext: async () => { throw new Error("unused"); }, close: async () => { browserClosed += 1; } };
  const chromium: PlaywrightChromium = {
    executablePath: () => "/ms-playwright/chromium/chrome",
    connectOverCDP: async (url) => {
      connects.push(url);
      if (over.connectFails) throw new Error("connect refused");
      if (over.connectHangs) return new Promise<PwBrowser>(() => undefined);
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
    startBridge: async (pipe) => {
      const record = { pipe, closed: 0 };
      bridges.push(record);
      return { url: "ws://127.0.0.1:41233/secret-path", close: async () => { record.closed += 1; } };
    },
  });
  return { launcher, child, spawns, connects, killed, bridges, browserClosed: () => browserClosed };
}

test("the browser runs through the execution launcher with the suite profile, a profile in the run's work dir and a pipe for the protocol", async () => {
  const { launcher, spawns, connects, child, bridges } = setup();
  await launcher.launch();
  const spawn = spawns[0]!;
  assert.equal(spawn.cmd, "/ms-playwright/chromium/chrome");
  assert.equal(spawn.options.profile, "suite");
  assert.equal(spawn.options.stdio?.length, 5, "two more descriptors than stdin, stdout and stderr: the browser's fd 3 and fd 4");
  assert.ok(spawn.args.includes("--remote-debugging-pipe"));
  assert.ok(!spawn.args.some((a) => a.startsWith("--remote-debugging-port")), "no TCP port: the egress filter would not let the orchestrator hear its answers");
  assert.ok(spawn.args.includes("--headless"));
  const profile = spawn.args.find((a) => a.startsWith("--user-data-dir="));
  assert.ok(profile?.startsWith("--user-data-dir=/work/"), "the profile lives in the run's work dir");
  assert.deepEqual(connects, ["ws://127.0.0.1:41233/secret-path"], "the orchestrator connects to the bridge, not to the browser");
  const pipe = bridges[0]!.pipe as { toBrowser: unknown; fromBrowser: unknown };
  assert.equal(pipe.toBrowser, child.toBrowser);
  assert.equal(pipe.fromBrowser, child.fromBrowser);
});

test("a lifetime wrapper sits in front of the browser so that it ends even if the orchestrator does not", async () => {
  const { launcher, spawns } = setup({ wrapper: "timeout" });
  await launcher.launch();
  assert.equal(spawns[0]!.cmd, "timeout");
  assert.deepEqual(spawns[0]!.args.slice(0, 3), ["--signal=KILL", "3600", "/ms-playwright/chromium/chrome"]);
});

test("disposing closes the browser and the bridge and kills the whole process group, once", async () => {
  const { launcher, killed, browserClosed, bridges } = setup();
  const launched = await launcher.launch();
  await launched.dispose();
  await launched.dispose();
  assert.equal(browserClosed(), 1);
  assert.equal(bridges[0]!.closed, 1);
  assert.equal(killed.length, 1);
});

test("a browser that exits before it is driven is a start failure that names the exit code and not its output", async () => {
  const { launcher, killed, bridges } = setup({ exitCode: 139, connectHangs: true });
  await assert.rejects(launcher.launch(), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /139/);
    return true;
  });
  assert.equal(killed.length, 1);
  assert.equal(bridges[0]!.closed, 1);
});

test("a browser that never answers is killed when the start time is up", async () => {
  const start = new AbortController();
  const { launcher, killed } = setup({ connectHangs: true, startSignal: start.signal });
  const pending = launcher.launch();
  await new Promise((r) => setImmediate(r));
  start.abort();
  await assert.rejects(pending, /did not start/);
  assert.equal(killed.length, 1);
});

test("a failed connection kills the browser it started and closes the bridge", async () => {
  const { launcher, killed, bridges } = setup({ connectFails: true });
  await assert.rejects(launcher.launch(), /connect refused/);
  assert.equal(killed.length, 1);
  assert.equal(bridges[0]!.closed, 1);
});

test("a browser started without its pipe is killed at once", async () => {
  const { launcher, killed } = setup({ noPipe: true });
  await assert.rejects(launcher.launch(), /pipe/);
  assert.equal(killed.length, 1);
});
