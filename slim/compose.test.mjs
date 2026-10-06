import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

// The LLM gateway key expires daily, so the stack must start without it and receive it at run time
// (web console or TUI). compose would refuse to start any service whose interpolation uses the
// "required" form, so neither service may use it for the key.
const compose = parse(readFileSync(new URL("./compose.yml", import.meta.url), "utf8"));

function declaredValue(service, name) {
  const environment = compose.services[service].environment;
  assert.ok(environment, `${service} declares an environment block`);
  return environment[name];
}

for (const service of ["orchestrator", "agents"]) {
  test(`${service} receives the LLM gateway key when set and starts without it`, () => {
    const value = declaredValue(service, "OPENCODE_API_KEY");
    assert.equal(typeof value, "string", "the key is passed through to the service");
    assert.match(value, /\$\{OPENCODE_API_KEY:?-/, "unset or empty falls back to an empty value");
    assert.doesNotMatch(value, /\$\{OPENCODE_API_KEY:?\?/, "a missing key must not abort compose");
  });
}

// Memory budget. A managed laptop usually cannot change Docker Desktop's settings, so the Linux VM
// keeps its default memory: half of the host RAM, i.e. 8 GiB on a 16 GiB laptop. The containers'
// limits must leave the VM itself (kernel, Docker engine, page cache) room to breathe, or the
// kernel OOM-killer starts picking victims outside the limited cgroups.
const MIB_PER_GIB = 1024;
const DEFAULT_VM_MIB = 8 * MIB_PER_GIB;
const VM_AND_ENGINE_HEADROOM_MIB = 1 * MIB_PER_GIB;
// What the agents container runs next to the Java language server: opencode serve, Serena, the
// TypeScript language server, the Playwright MCP's Chromium and engram.
const AGENTS_NON_JAVA_NEED_MIB = Math.round(2.5 * MIB_PER_GIB);

const dockerfile = readFileSync(new URL("./Dockerfile", import.meta.url), "utf8");

function toMiB(size) {
  const match = /^(\d+(?:\.\d+)?)([mg])$/i.exec(size.trim());
  assert.ok(match, `unsupported memory size "${size}" (use <n>m or <n>g)`);
  const amount = Number(match[1]);
  return match[2].toLowerCase() === "g" ? amount * MIB_PER_GIB : amount;
}

function interpolationDefault(value, name) {
  const match = new RegExp(`\\$\\{${name}:-([^}]*)\\}`).exec(String(value));
  assert.ok(match, `${name} falls back to a default in "${value}"`);
  return match[1];
}

function memoryLimitMiB(service) {
  const limit = compose.services[service].deploy?.resources?.limits?.memory;
  assert.ok(limit, `${service} declares a memory limit`);
  const name = /^\$\{(\w+):-/.exec(String(limit))?.[1];
  return toMiB(name ? interpolationDefault(limit, name) : String(limit));
}

test("every service declares a memory limit, so the budget counts all of them", () => {
  for (const service of Object.keys(compose.services)) memoryLimitMiB(service);
});

test("the default memory limits together leave the default Docker Desktop VM its headroom", () => {
  const total = Object.keys(compose.services).reduce((sum, service) => sum + memoryLimitMiB(service), 0);
  assert.ok(total <= DEFAULT_VM_MIB - VM_AND_ENGINE_HEADROOM_MIB, `limits sum to ${total} MiB`);
});

test("the Java language server heap leaves the rest of the agents container what it needs", () => {
  const xmx = toMiB(interpolationDefault(compose["x-build"].args.JDTLS_XMX, "JDTLS_XMX"));
  assert.ok(memoryLimitMiB("agents") - xmx >= AGENTS_NON_JAVA_NEED_MIB, `heap ${xmx} MiB in a ${memoryLimitMiB("agents")} MiB limit`);
});

test("the Java language server heap defaults to the same value in the compose build args and the Dockerfile", () => {
  const fromCompose = interpolationDefault(compose["x-build"].args.JDTLS_XMX, "JDTLS_XMX");
  assert.equal(/^ARG JDTLS_XMX=(\S+)$/m.exec(dockerfile)?.[1], fromCompose);
});

// Containers reach each other by service name. When the Docker CLI injects proxy variables, a client
// that honors them (the Go console does) would send `orchestrator:8080` to the corporate proxy
// unless the service names are in the bypass list.
for (const service of Object.keys(compose.services)) {
  test(`${service} bypasses the proxy for the compose services and the extra internal domains`, () => {
    for (const name of ["NO_PROXY", "no_proxy"]) {
      const value = declaredValue(service, name);
      const [list] = String(value).split("${EXTRA_NO_PROXY");
      assert.deepEqual(list.split(",").filter(Boolean).sort(), ["127.0.0.1", "agents", "localhost", "orchestrator"], `${service} ${name}`);
      assert.equal(interpolationDefault(value, "EXTRA_NO_PROXY"), "", `${service} ${name} appends EXTRA_NO_PROXY`);
    }
  });
}

// The console signs in with the local API token (`./slim/qayaba.sh console` puts it on the clipboard).
// QA_WEB_AUTO_LOGIN would hand an operator session to any peer that sends `Host: localhost`, the
// agents container included, whose code is driven by an LLM.
test("no service enables the automatic console login", () => {
  for (const [name, service] of Object.entries(compose.services)) {
    assert.ok(!("QA_WEB_AUTO_LOGIN" in (service.environment ?? {})), `${name} must not declare QA_WEB_AUTO_LOGIN`);
  }
});

test("no service imports an environment file that could switch the automatic login on", () => {
  for (const [name, service] of Object.entries(compose.services)) assert.equal(service.env_file, undefined, `${name} declares env_file`);
});

// The agents container runs as root and an LLM drives its shell. The Maven settings.xml it reads for the
// Artifactory mirror may hold credentials, so the host file must never be writable from inside: the
// directory that carries it is mounted read-only apart from Maven's own home, and the local
// repository (which Maven does write) lives in a named volume.
const MAVEN_SETTINGS_DIR = "/root/.m2-settings";
const MAVEN_REPOSITORY = "/root/.m2/repository";
const agentMounts = compose.services.agents.volumes.map((entry) => {
  const [source, target, mode] = String(entry).split(":");
  return { source, target, mode };
});

test("the host Maven settings reach the agents only through a read-only mount", () => {
  const hostMounts = agentMounts.filter((m) => m.source.startsWith(".") && m.source.includes("maven"));
  assert.ok(hostMounts.length > 0, "the settings are still offered to the agents");
  for (const mount of hostMounts) assert.equal(mount.mode, "ro", `${mount.source} is mounted read-only`);
  assert.ok(hostMounts.some((m) => m.target === MAVEN_SETTINGS_DIR));
});

test("nothing from the host is mounted into Maven's home, where the agents write", () => {
  for (const mount of agentMounts) {
    if (mount.source.startsWith(".")) assert.ok(mount.target !== "/root/.m2" && !mount.target.startsWith("/root/.m2/"), `${mount.source} -> ${mount.target}`);
  }
});

test("the local Maven repository is a named volume, so the host directory stays settings-only", () => {
  const repository = agentMounts.find((m) => m.target === MAVEN_REPOSITORY);
  assert.ok(repository, "the repository is mounted");
  assert.ok(Object.hasOwn(compose.volumes, repository.source), `${repository.source} is a declared named volume`);
});

// The agents' command links the read-only settings.xml into Maven's default location (JDTLS and `mvn`
// both read ~/.m2/settings.xml), when the operator provided one.
function runAgentCommandWith(settingsFile) {
  const script = compose.services.agents.command[2].replaceAll("$$", "$");
  const root = mkdtempSync(join(tmpdir(), "qayaba-m2-"));
  try {
    const settingsDir = join(root, "settings");
    mkdirSync(settingsDir);
    if (settingsFile !== undefined) writeFileSync(join(settingsDir, "settings.xml"), settingsFile);
    const home = join(root, "home");
    mkdirSync(home);
    const probe = script.replaceAll(MAVEN_SETTINGS_DIR, settingsDir).replace(/exec node \S+/, "exec true");
    execFileSync("sh", ["-c", probe], { env: { HOME: home, PATH: process.env.PATH }, stdio: "pipe" });
    const linked = join(home, ".m2", "settings.xml");
    let link;
    try {
      lstatSync(linked);
      link = { target: readlinkSync(linked), content: readFileSync(linked, "utf8") };
    } catch {
      link = undefined;
    }
    return { link, settingsFile: join(settingsDir, "settings.xml") };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a settings.xml the operator provided is what Maven finds at its default location", () => {
  const { link, settingsFile } = runAgentCommandWith("<settings/>");

  assert.ok(link, "~/.m2/settings.xml exists");
  assert.equal(link.target, settingsFile, "it points at the read-only file, not at a copy");
  assert.equal(link.content, "<settings/>");
});

test("the agents start without a settings.xml and leave Maven's default location empty", () => {
  const { link } = runAgentCommandWith(undefined);

  assert.equal(link, undefined);
});

test("the agents command still ends in the supervisor", () => {
  assert.match(compose.services.agents.command[2], /exec node \/usr\/local\/bin\/agent-supervisor\.mjs$/);
});
