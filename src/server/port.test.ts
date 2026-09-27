/*
 * The control plane's default port has one source (DEFAULT_PORT): the server and the CLI listen on
 * it, the help assistant and the `qa` shell client point operators at it. These pin that every
 * surface agrees, and what the boot log says about where the server actually listens.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_HOST, DEFAULT_PORT, describeListenAddress, listenErrorHint, resolvePort } from "./port";
import { buildHelpContext } from "./help";

test("the server listens on the default port unless PORT names another", () => {
  assert.equal(resolvePort({}), DEFAULT_PORT);
  assert.equal(resolvePort({ PORT: "" }), DEFAULT_PORT, "an empty PORT is unset, not port 0");
  assert.equal(resolvePort({ PORT: "8458" }), 8458);
});

test("a PORT that is not a TCP port fails loudly instead of binding somewhere unexpected", () => {
  for (const bad of ["abc", "-1", "65536", "80.5"]) {
    assert.throws(() => resolvePort({ PORT: bad }), /PORT/, `PORT=${bad}`);
  }
});

test("the qa shell client talks to the default host when QA_HOST is unset", () => {
  /* A stand-in curl on PATH records the URL bin/qa requests, then fails like an unreachable host. */
  const dir = mkdtempSync(join(tmpdir(), "qa-cli-host-"));
  try {
    const log = join(dir, "curl.log");
    writeFileSync(join(dir, "curl"), `#!/bin/sh\nfor a in "$@"; do echo "$a"; done >> "${log}"\nexit 7\n`);
    writeFileSync(join(dir, "jq"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, "curl"), 0o755);
    chmodSync(join(dir, "jq"), 0o755);
    const env: Record<string, string> = { PATH: `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: dir, QA_API_TOKEN: "t" };

    const run = spawnSync("bash", [join(import.meta.dirname, "..", "..", "bin", "qa"), "status"], { env, encoding: "utf8" });

    assert.notEqual(run.status, 0, "an unreachable host is an error");
    const urls = readFileSync(log, "utf8").split("\n").filter((a) => a.startsWith("http"));
    assert.ok(urls.length > 0, `bin/qa made no request (stderr: ${run.stderr})`);
    for (const url of urls) assert.ok(url.startsWith(`http://${DEFAULT_HOST}/`), `bin/qa requested ${url}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the help assistant tells operators the default address the service listens on", () => {
  assert.ok(buildHelpContext().includes(DEFAULT_HOST));
});

test("the boot log names the interface and port the server is bound to", () => {
  assert.equal(describeListenAddress({ address: "::", family: "IPv6", port: DEFAULT_PORT }), `[::]:${DEFAULT_PORT}`);
  assert.equal(describeListenAddress({ address: "0.0.0.0", family: "IPv4", port: 8458 }), "0.0.0.0:8458");
});

test("a refused privileged port explains how to run without root", () => {
  const hint = listenErrorHint(Object.assign(new Error("listen EACCES"), { code: "EACCES" }), 458);
  assert.match(hint, /\bPORT\b/, "names the variable that moves the port");
  assert.match(hint, /CAP_NET_BIND_SERVICE/, "names the capability that allows a low port");
  assert.doesNotMatch(listenErrorHint(Object.assign(new Error("listen EACCES"), { code: "EACCES" }), 8458), /CAP_NET_BIND_SERVICE/, "a high port is not a privilege problem");
});
