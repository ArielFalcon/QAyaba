/* The boot check starts its probing child the way the launcher starts agent code, and with nothing the sandbox uid could have prepared. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { basename } from "node:path";
import { probeSpawnFor } from "./file-boundary-check";

const SANDBOX = { uid: 1002, gid: 1002, home: "/home/sandbox" };
const PLAN = [{ kind: "read" as const, path: "/app/data/.api_token" }, { kind: "write" as const, path: "/app/src" }];

test("the probing child runs the probe script with the plain node binary: no loader, no import hook, no flag of the parent's", () => {
  assert.ok(process.execArgv.length > 0, "this test runs under a loader, which the child must not inherit");
  const { command, args } = probeSpawnFor(SANDBOX, PLAN, { PATH: "/usr/bin" });
  assert.equal(command, process.execPath);
  assert.equal(args.length, 1);
  assert.equal(basename(args[0]!), "file-boundary-probe.mjs");
  assert.ok(!args.some((a) => a.startsWith("-")), args.join(" "));
});

test("the probing child gets the sandbox identity, an environment of PATH alone and the plan on stdin", () => {
  const { options } = probeSpawnFor(SANDBOX, PLAN, { PATH: "/usr/bin", TMPDIR: "/tmp/planted", NODE_OPTIONS: "--require /tmp/x.js", HOME: "/root" });
  assert.equal(options.uid, SANDBOX.uid);
  assert.equal(options.gid, SANDBOX.gid);
  assert.equal(options.cwd, "/");
  assert.deepEqual(options.env, { PATH: "/usr/bin" });
  assert.deepEqual(JSON.parse(String(options.input)), PLAN);
});
