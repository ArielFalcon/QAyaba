import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
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

// OpenCode reads its global config at every start, and every key paste restarts it. The agents
// container runs as root with an LLM-driven shell, so a config directory it can write would let it
// re-point the gateway, re-enable a provider or add a remote MCP server for the next start. The
// effective config therefore reaches the agents only through read-only named volumes that a one-shot
// service fills from the image (root without CAP_SYS_ADMIN cannot remount a read-only mount). The home
// `.opencode` directory is read by OpenCode as a config directory too, so it is held read-only and empty.
const OPENCODE_CONFIG_DIR = "/root/.config/opencode";
const PROMPT_DIR = "/root/.config/agent";
const OPENCODE_HOME_DIR = "/root/.opencode";
const FROZEN_DIRS = [OPENCODE_CONFIG_DIR, PROMPT_DIR, OPENCODE_HOME_DIR];

function mountsOf(service) {
  return (compose.services[service].volumes ?? []).map((entry) => {
    const [source, target, mode] = String(entry).split(":");
    return { source, target, mode };
  });
}

const [configInitName, configInit] =
  Object.entries(compose.services.agents.depends_on ?? {}).find(([, dependency]) => dependency.condition === "service_completed_successfully") ?? [];

test("the agents read the OpenCode config, the prompts and the home config directory from read-only named volumes", () => {
  for (const target of FROZEN_DIRS) {
    const mount = agentMounts.find((m) => m.target === target);
    assert.ok(mount, `${target} is mounted into the agents`);
    assert.equal(mount.mode, "ro", `${target} is read-only`);
    assert.ok(Object.hasOwn(compose.volumes, mount.source), `${mount.source} is a declared named volume`);
  }
});

test("the agents wait for a one-shot service that ran to completion before they start", () => {
  assert.ok(configInit, "the agents depend on a service with condition service_completed_successfully");
  assert.equal(compose.services[configInitName].restart, "no", "the init service runs once per start, never in a loop");
  assert.equal(compose.services[configInitName].image, compose.services.agents.image, "it carries the image whose config it freezes");
});

test("only the init service can write the volumes the agents see read-only", () => {
  for (const { source } of FROZEN_DIRS.map((target) => agentMounts.find((m) => m.target === target))) {
    const writers = Object.keys(compose.services).filter((name) => mountsOf(name).some((m) => m.source === source && m.mode !== "ro"));
    assert.deepEqual(writers, [configInitName], `writers of ${source}`);
  }
});

test("the init service does not mount a volume over the config directories it copies from", () => {
  for (const mount of mountsOf(configInitName)) {
    assert.ok(!FROZEN_DIRS.includes(mount.target), `${mount.source} -> ${mount.target}`);
  }
});

// The init command, run against temporary directories: the image's config stands in for
// /root/.config, the volumes for /frozen.
function listTree(root, base = root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    const relative = path.slice(base.length + 1);
    return entry.isDirectory() ? [`${relative}/`, ...listTree(path, base)] : [`${relative}=${readFileSync(path, "utf8")}`];
  }).sort();
}

function runConfigInit({ image, volumes }) {
  const root = mkdtempSync(join(tmpdir(), "qayaba-freeze-"));
  try {
    const sourceRoot = join(root, "image");
    const volumeRoot = join(root, "volumes");
    const seed = (base, files) => {
      for (const [name, content] of Object.entries(files)) {
        mkdirSync(join(base, name, ".."), { recursive: true });
        writeFileSync(join(base, name), content);
      }
    };
    seed(sourceRoot, image);
    seed(volumeRoot, volumes);
    const script = compose.services[configInitName].command[2].replaceAll("$$", "$").replaceAll("/root/.config", sourceRoot).replaceAll("/frozen", volumeRoot);
    const run = spawnSync("sh", ["-c", script], { encoding: "utf8" });
    const trees = Object.fromEntries(["opencode", "agent", "opencode-home"].map((name) => [name, existsSync(join(volumeRoot, name)) ? listTree(join(volumeRoot, name)) : undefined]));
    return { run, trees };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the init command makes each volume an exact copy of the image's config and clears whatever else it held", () => {
  const { run, trees } = runConfigInit({
    image: {
      "opencode/opencode.json": '{"share":"disabled"}',
      "opencode/agent/qa-generator.md": "prompt",
      "opencode/.hidden": "dotfile",
      "agent/roles/qa-reviewer.md": "neutral prompt",
    },
    volumes: {
      "opencode/opencode.json": '{"share":"auto"}',
      "opencode/stale.json": "left by an earlier boot",
      "opencode/.stale-hidden": "dotfile",
      "opencode/agent/old.md": "old prompt",
      "agent/stale.md": "old",
      "opencode-home/opencode.json": '{"provider":{}}',
    },
  });

  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(trees.opencode, [".hidden=dotfile", "agent/", "agent/qa-generator.md=prompt", 'opencode.json={"share":"disabled"}']);
  assert.deepEqual(trees.agent, ["roles/", "roles/qa-reviewer.md=neutral prompt"]);
  assert.deepEqual(trees["opencode-home"], [], "the home config directory is left empty");
});

test("the init command fails, and so the agents never start, when the image carries no OpenCode config", () => {
  const { run } = runConfigInit({ image: { "agent/p.md": "prompt" }, volumes: { "opencode/stale.json": "x", "opencode-home/x": "x" } });

  assert.notEqual(run.status, 0);
});
