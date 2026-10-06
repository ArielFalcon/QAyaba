import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const slimFile = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url));

// A stand-in for the docker CLI, the process boundary of qayaba.sh. It records every call, prints
// STUB_PORT for `compose port`, and fails any call that contains one of the STUB_FAIL_ON patterns
// (separated by "|").
const DOCKER_STUB = `#!/bin/sh
args="$*"
echo "$args" >> "$STUB_LOG"
if [ -n "\${STUB_FAIL_ON:-}" ]; then
  IFS='|'
  for pattern in $STUB_FAIL_ON; do
    case "$args" in *"$pattern"*) echo "stub docker: refusing $args" >&2; exit 1 ;; esac
  done
  unset IFS
fi
case "$*" in
  *" port orchestrator "*) printf '%s\\n' "$STUB_PORT" ;;
  "version "*) echo "client 29 · server 29 (arm64)" ;;
esac
exit 0
`;

// qayaba.sh locates everything relative to its own path, so a copy inside a temp "slim" directory
// runs against temp files only.
function qayaba(args, { override, failOn = "", port = "127.0.0.1:8080", tag = "" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "qayaba-cli-"));
  try {
    const slim = join(root, "slim");
    const bin = join(root, "bin");
    mkdirSync(slim);
    mkdirSync(join(slim, "certs"));
    mkdirSync(bin);
    for (const file of ["qayaba.sh", "probe-gateway.sh"]) copyFileSync(slimFile(file), join(slim, file));
    writeFileSync(join(slim, ".env"), `NODE_IMAGE=registry.test/node:24\nEXTRA_NO_PROXY=.corp.test\n${tag ? `QAYABA_SLIM_TAG=${tag}\n` : ""}`);
    if (override) writeFileSync(join(slim, "opencode.override.json"), JSON.stringify(override));
    writeFileSync(join(bin, "docker"), DOCKER_STUB);
    chmodSync(join(bin, "docker"), 0o755);
    const log = join(root, "docker.log");
    writeFileSync(log, "");
    const run = spawnSync("bash", [join(slim, "qayaba.sh"), ...args], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: root, STUB_LOG: log, STUB_FAIL_ON: failOn, STUB_PORT: port },
    });
    return { ...run, output: `${run.stdout}${run.stderr}`, calls: readFileSync(log, "utf8").split("\n").filter(Boolean) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const withGateway = { provider: { corp: { options: { baseURL: "https://llm.example.test/v1" }, models: {} } } };
const probeCalls = (calls) => calls.filter((c) => c.includes("probe-gateway.sh"));

test("check reaches the orchestrator the way the tui service does, through the compose network", () => {
  const result = qayaba(["check"]);
  assert.equal(result.status, 0, result.output);
  const viaTui = result.calls.filter((c) => / run /.test(c) && / tui /.test(c) && c.includes("--no-deps") && c.includes("/api/health"));
  assert.equal(viaTui.length, 1, result.calls.join("\n"));
});

test("check fails and says the console cannot connect when the orchestrator is not reachable by its service name", () => {
  const result = qayaba(["check"], { failOn: "--no-deps" });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /tui service/);
  assert.match(result.output, /orchestrator:8080/);
});

test("check confirms the console port is published on the loopback interface only", () => {
  const result = qayaba(["check"], { port: "127.0.0.1:8080" });
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /127\.0\.0\.1:8080/);
});

test("check fails when the console port is published on every interface", () => {
  const result = qayaba(["check"], { port: "0.0.0.0:8080" });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /every interface|all interfaces/);
});

test("check fails when the console port is not published at all", () => {
  const result = qayaba(["check"], { port: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /not published/);
});

test("preflight probes the declared LLM gateway from a container that uses the runtime's proxy bypass list", () => {
  const result = qayaba(["preflight"], { override: withGateway });
  assert.equal(result.status, 0, result.output);
  const [call] = probeCalls(result.calls);
  assert.ok(call, "a container runs probe-gateway.sh");
  assert.match(call, /opencode\.override\.json:\/override\.json:ro/);
  assert.match(call, /NO_PROXY=agents,orchestrator,localhost,127\.0\.0\.1,\.corp\.test/);
  assert.match(call, /registry\.test\/node:24/);
});

test("preflight fails, after printing everything else, when there is no override and so no gateway to probe", () => {
  const result = qayaba(["preflight"]);
  assert.notEqual(result.status, 0);
  assert.deepEqual(probeCalls(result.calls), []);
  assert.match(result.output, /no LLM gateway/);
  assert.match(result.output, /opencode\.override\.json/);
  assert.ok(result.calls.some((c) => c.includes("registry.test/node:24")), "the network checks still ran");
});

test("preflight fails, after printing everything else, when the gateway is unreachable", () => {
  const result = qayaba(["preflight"], { override: withGateway, failOn: "probe-gateway.sh" });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /LLM gateway/);
});

const sbomCalls = (calls) => calls.filter((c) => /(^| )(scout sbom|sbom) /.test(c) && !c.includes("--version") && !c.includes("scout version"));

test("sbom asks Docker Scout for the SBOM of the built image and forwards the extra arguments", () => {
  const result = qayaba(["sbom", "--format", "spdx"]);
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(sbomCalls(result.calls), ["scout sbom --format spdx qayaba-slim:local"]);
});

test("sbom uses the image tag the operator configured", () => {
  const result = qayaba(["sbom"], { tag: "2026-10" });
  assert.deepEqual(sbomCalls(result.calls), ["scout sbom qayaba-slim:2026-10"]);
});

test("sbom falls back to the docker sbom plugin when Docker Scout is not available", () => {
  const result = qayaba(["sbom"], { failOn: "scout version" });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(sbomCalls(result.calls), ["sbom qayaba-slim:local"]);
});

test("sbom without any generator points at the static inventory instead of failing", () => {
  const result = qayaba(["sbom"], { failOn: "scout version|sbom --version" });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(sbomCalls(result.calls), []);
  assert.match(result.output, /INVENTORIO\.md/);
});

test("sbom asks for a build first when the image does not exist", () => {
  const result = qayaba(["sbom"], { failOn: "image inspect" });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /build/);
});

// The `console` command touches the macOS clipboard and the default browser. Its tests therefore run
// with a PATH that holds only the stand-ins and the few system tools the script needs, so neither a
// real pbcopy nor a real open can ever be reached.
const SYSTEM_TOOLS = ["bash", "dirname", "grep", "tail", "cut", "cat", "tr", "sed", "awk"];
const STANDIN_RECORDER = (name) => `#!/bin/sh
echo "$*" > "$STUB_DIR/${name}.args"
cat > "$STUB_DIR/${name}.stdin"
`;

function findOnPath(tool) {
  for (const dir of process.env.PATH.split(delimiter)) {
    const candidate = join(dir, tool);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${tool} not found on PATH`);
}

function consoleCli(args, { token = "tok-0123456789abcdef", pbcopy = true, open = true, env = "" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "qayaba-console-"));
  try {
    const slim = join(root, "slim");
    const bin = join(root, "bin");
    const stubs = join(root, "stubs");
    for (const dir of [slim, bin, stubs, join(root, "config")]) mkdirSync(dir);
    copyFileSync(slimFile("qayaba.sh"), join(slim, "qayaba.sh"));
    writeFileSync(join(slim, ".env"), env);
    if (token) writeFileSync(join(root, "config", ".api_token"), token);
    for (const tool of SYSTEM_TOOLS) symlinkSync(findOnPath(tool), join(bin, tool));
    for (const [name, present] of [["pbcopy", pbcopy], ["open", open]]) {
      if (!present) continue;
      writeFileSync(join(bin, name), STANDIN_RECORDER(name));
      chmodSync(join(bin, name), 0o755);
    }
    const run = spawnSync(join(bin, "bash"), [join(slim, "qayaba.sh"), ...args], { encoding: "utf8", env: { PATH: bin, HOME: root, STUB_DIR: stubs } });
    const recorded = (file) => (existsSync(join(stubs, file)) ? readFileSync(join(stubs, file), "utf8") : undefined);
    return { ...run, output: `${run.stdout}${run.stderr}`, clipboard: recorded("pbcopy.stdin"), clipboardArgs: recorded("pbcopy.args"), opened: recorded("open.args")?.trim() };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const TOKEN = "tok-0123456789abcdef";

test("console puts the local API token on the clipboard and never prints it", () => {
  const result = consoleCli(["console"]);
  assert.equal(result.status, 0, result.output);
  assert.equal(result.clipboard.trim(), TOKEN);
  assert.ok(!result.output.includes(TOKEN), "the token stays out of the terminal output");
  assert.ok(!result.clipboardArgs.includes(TOKEN), "the token is not passed on a command line");
});

test("console prints the console URL and opens it in the browser", () => {
  const result = consoleCli(["console"]);
  assert.match(result.stdout, /http:\/\/localhost:8080\/app/);
  assert.equal(result.opened, "http://localhost:8080/app");
});

test("console follows the published port the operator configured", () => {
  const result = consoleCli(["console"], { env: "QAYABA_PORT=9191\n" });
  assert.equal(result.opened, "http://localhost:9191/app");
});

test("console prints the token only when asked to, and still copies it", () => {
  const result = consoleCli(["console", "--print"]);
  assert.equal(result.status, 0, result.output);
  assert.ok(result.stdout.includes(TOKEN));
  assert.equal(result.clipboard.trim(), TOKEN);
});

test("console without a clipboard tool does not print the token and says how to get it", () => {
  const result = consoleCli(["console"], { pbcopy: false });
  assert.equal(result.status, 0, result.output);
  assert.ok(!result.output.includes(TOKEN));
  assert.match(result.output, /--print/);
  assert.match(result.output, /http:\/\/localhost:8080\/app/);
});

test("console without a browser opener still prints the URL", () => {
  const result = consoleCli(["console"], { open: false });
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /http:\/\/localhost:8080\/app/);
  assert.equal(result.opened, undefined);
});

test("console fails, copying and opening nothing, while there is no API token yet", () => {
  const result = consoleCli(["console"], { token: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /no API token yet/);
  assert.equal(result.clipboard, undefined);
  assert.equal(result.opened, undefined);
});
