import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dockerfile = readFileSync(new URL("./Dockerfile", import.meta.url), "utf8");

// The runtime stage is the last one: everything after the final FROM.
const runtime = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));

// Values of every ENV instruction of a stage, with line continuations joined.
function envOf(stage) {
  const env = {};
  for (const line of stage.replace(/\\\n/g, " ").split("\n")) {
    if (!/^ENV\s/.test(line)) continue;
    for (const pair of line.replace(/^ENV\s+/, "").split(/\s+/)) {
      const [key, ...value] = pair.split("=");
      env[key] = value.join("=");
    }
  }
  return env;
}

test("every client in the image is pointed at the system bundle that holds the corporate CAs", () => {
  const env = envOf(runtime);
  const bundle = "/etc/ssl/certs/ca-certificates.crt";
  for (const name of ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "PIP_CERT"]) assert.equal(env[name], bundle, name);
});

test("git trusts the system bundle for every user of the image", () => {
  assert.match(runtime, /git config --system http\.sslCAInfo \/etc\/ssl\/certs\/ca-certificates\.crt/);
});

test("the Java truststore is fed after the JDK is installed, never before", () => {
  const jdk = runtime.indexOf("openjdk-21-jdk-headless");
  const trust = runtime.indexOf("\nRUN java-trust-ca");
  assert.ok(jdk > 0, "the runtime stage installs the JDK");
  assert.ok(trust > jdk, "java-trust-ca runs after the JDK package");
});

test("Serena does not report usage from the image", () => {
  assert.equal(envOf(runtime).SERENA_USAGE_REPORTING, "false");
});

// The one-line `RUN node -e '...'` that proves the runtime's Node and its native module.
const nodeCheck = /^RUN node -e '([^']+)'$/m.exec(runtime);

test("the runtime stage checks its Node and native module after the dependencies are copied in", () => {
  assert.ok(nodeCheck, "the runtime stage runs a node -e check");
  assert.ok(nodeCheck.index > runtime.indexOf("COPY --from=deps /app/node_modules"), "the check runs after node_modules is copied");
  assert.ok(nodeCheck.index > runtime.indexOf("COPY . ."), "the check runs after the sources are copied");
  assert.match(nodeCheck[1], /better-sqlite3/);
});

test("the Node and native module check passes against this repository's dependencies", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const result = spawnSync(process.execPath, ["-e", nodeCheck[1]], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("the Node and native module check fails when the runtime Node is older than the supported major", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const oldNode = `Object.defineProperty(process.versions, "node", { value: "22.9.0" }); ${nodeCheck[1]}`;
  const result = spawnSync(process.execPath, ["-e", oldNode], { cwd: root, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /older than 24/);
});

test("the Node check prints the runtime's Node version, so a build log shows which Node the image really has", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const result = spawnSync(process.execPath, ["-e", nodeCheck[1]], { cwd: root, encoding: "utf8" });
  assert.ok(result.stdout.includes(process.version), result.stdout);
});

test("the Node check says so when the runtime Node has no proxy support for the gateway key check, and stays quiet when it has", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const without = `Object.defineProperty(require("http"), "setGlobalProxyFromEnv", { value: undefined, configurable: true }); ${nodeCheck[1]}`;
  const withApi = `Object.defineProperty(require("http"), "setGlobalProxyFromEnv", { value: () => {}, configurable: true }); ${nodeCheck[1]}`;
  const missing = spawnSync(process.execPath, ["-e", without], { cwd: root, encoding: "utf8" });
  const present = spawnSync(process.execPath, ["-e", withApi], { cwd: root, encoding: "utf8" });
  assert.equal(missing.status, 0, "an older minor is reported, not a build failure");
  assert.match(missing.stdout, /setGlobalProxyFromEnv/);
  assert.match(missing.stdout, /unverified/);
  assert.doesNotMatch(present.stdout, /unverified/);
});

test("the effective OpenCode config is built from the base and the override, so the build stops without a gateway", () => {
  const step = /^RUN node \/tmp\/qayaba\/opencode-config\.mjs (\S+) (\S+) > \S+$/m.exec(dockerfile);
  assert.ok(step, "the deps stage runs opencode-config.mjs with both inputs and no fallback");
  assert.match(step[1], /opencode\.base\.json$/);
  assert.match(step[2], /opencode\.override\.json$/);
});
