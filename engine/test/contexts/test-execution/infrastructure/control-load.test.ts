/* The control load of a counted run_spec call (RFC-0007) is two scripts the orchestrator writes and a Playwright child runs before the spec child: a config that is the project's own with the control's one test in place of the suite, and that test. They run here as the child runs them, in a process of their own with the project directory as cwd, against a stand-in for `@playwright/test` and for the page, so that what they decide is seen from the outside: the file they leave and the config they hand Playwright. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_DEV_WRITE_REQUESTS, MAX_PROJECT_NAME_CHARS } from "@contexts/test-execution/domain/dev-write-request.ts";
import { PRODUCER_ADDRESS_CHARS } from "@kernel/address-cut.ts";
import ts from "typescript";
import { buildControlConfig, buildControlTest, controlArgs, controlLoadMs } from "@contexts/test-execution/infrastructure/control-load.ts";

const DEV = "https://dev.example.com";
const TOKEN = "https://id.example.com/oauth/token";

interface Sent { method: string; url: string }
/* `timeout`: a page that never goes idle, so Playwright's goto ends in its TimeoutError; `error`: any other failure of the load. */
interface Scenario { requests?: Sent[]; gotoFails?: "timeout" | "error"; project?: string }
interface Outcome { goto?: { url: string; options: unknown }; threw?: string; files: Record<string, unknown> }

/* A project directory whose `@playwright/test` registers the tests it is given instead of running them. */
function projectDir(): { root: string; scripts: string; capture: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "qa-control-load-"));
  mkdirSync(join(root, "node_modules", "@playwright", "test"), { recursive: true });
  writeFileSync(join(root, "node_modules", "@playwright", "test", "index.js"), "exports.test = (name, fn) => { (globalThis.registered ??= []).push({ name, fn }); };");
  const scripts = join(root, "scripts");
  const capture = join(root, "dumps");
  mkdirSync(scripts);
  mkdirSync(capture);
  return { root, scripts, capture, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const DRIVER = `
const scenario = JSON.parse(process.env.SCENARIO);
require(process.argv[2]);
const registered = globalThis.registered ?? [];
(async () => {
  const out = { registered: registered.length };
  const listeners = [];
  const page = { goto: async (url, options) => {
    out.goto = { url, options };
    for (const r of scenario.requests ?? []) for (const fn of listeners) fn({ method: () => r.method, url: () => r.url });
    if (scenario.gotoFails === "timeout") throw Object.assign(new Error("page.goto: Timeout " + options.timeout + "ms exceeded"), { name: "TimeoutError" });
    if (scenario.gotoFails === "error") throw new Error("page.goto: net::ERR_CONNECTION_REFUSED");
  } };
  const context = { on: (event, fn) => { if (event === "requestfinished") listeners.push(fn); } };
  try { await registered[0].fn({ page, context }, { project: { name: scenario.project ?? "desktop" } }); } catch (err) { out.threw = String(err.message); }
  process.stdout.write(JSON.stringify(out));
})();
`;

function runControlTest(scenario: Scenario, env: Record<string, string | undefined> = {}): Outcome {
  const dir = projectDir();
  try {
    const script = join(dir.scripts, "control-load.run.cjs");
    writeFileSync(script, buildControlTest());
    const driver = join(dir.scripts, "driver.cjs");
    writeFileSync(driver, DRIVER);
    const full = { PATH: process.env.PATH, SCENARIO: JSON.stringify(scenario), QA_FAILURE_CAPTURE_DIR: dir.capture, PW_BASE_URL: DEV, PW_CONTROL_TIMEOUT_MS: "40000", ...env };
    const stdout = execFileSync(process.execPath, [driver, script], { cwd: dir.root, env: Object.fromEntries(Object.entries(full).filter(([, v]) => v !== undefined)) as Record<string, string>, encoding: "utf8" });
    const files: Record<string, unknown> = {};
    for (const name of readdirSync(dir.capture)) files[name] = JSON.parse(readFileSync(join(dir.capture, name), "utf8"));
    return { ...(JSON.parse(stdout) as Omit<Outcome, "files">), files };
  } finally {
    dir.cleanup();
  }
}

const only = (files: Record<string, unknown>): { name: string; body: Record<string, unknown> } => {
  const names = Object.keys(files);
  assert.equal(names.length, 1, `exactly one file and no temporary one: ${names.join(", ")}`);
  return { name: names[0]!, body: files[names[0]!] as Record<string, unknown> };
};

test("the control loads the launch URL until the network is idle, for the time it is given, and writes the mutating requests DEV answered", () => {
  const out = runControlTest({
    requests: [
      { method: "POST", url: `${TOKEN}?x=1` },
      { method: "POST", url: TOKEN },
      { method: "GET", url: `${DEV}/api/orders` },
      { method: "PUT", url: `${DEV}/api/auth/refresh#frag` },
      { method: "POST", url: "not a url" },
    ],
  });
  assert.deepEqual(out.goto, { url: DEV, options: { waitUntil: "networkidle", timeout: 40_000 } });
  assert.equal(out.threw, undefined);
  const { name, body } = only(out.files);
  assert.match(name, /^control-[a-f0-9]{12}\.json$/);
  assert.deepEqual(body, { v: 1, project: "desktop", requests: [{ method: "POST", url: TOKEN, count: 2 }, { method: "PUT", url: `${DEV}/api/auth/refresh`, count: 1 }] });
});

test("a launch page that never goes idle ends the load at its bound, keeps the writes it saw and closes cleanly: the control ran, it only saw less", () => {
  const out = runControlTest({ requests: [{ method: "POST", url: TOKEN }], gotoFails: "timeout" });
  assert.equal(out.threw, undefined, "a bound that bit is not a failure of the control");
  assert.deepEqual(only(out.files).body.requests, [{ method: "POST", url: TOKEN, count: 1 }]);
});

test("a load that fails for any other reason fails the control and leaves no file: a control that did not run exempts nothing", () => {
  const out = runControlTest({ requests: [{ method: "POST", url: TOKEN }], gotoFails: "error" });
  assert.match(out.threw ?? "", /ERR_CONNECTION_REFUSED/);
  assert.deepEqual(out.files, {});
});

test("the control keeps as many distinct requests as a ledger does, and cuts an address where the ledger cuts it", () => {
  const many = Array.from({ length: MAX_DEV_WRITE_REQUESTS + 5 }, (_, i) => ({ method: "POST", url: `${DEV}/api/items/${i}` }));
  const kept = only(runControlTest({ requests: many }).files).body.requests as unknown[];
  assert.equal(kept.length, MAX_DEV_WRITE_REQUESTS);
  const long = `${DEV}/${"a".repeat(400)}`;
  const [entry] = only(runControlTest({ requests: [{ method: "POST", url: long }] }).files).body.requests as Array<{ url: string }>;
  assert.equal(entry!.url, long.slice(0, PRODUCER_ADDRESS_CHARS));
});

test("the file of a project is named by a short key of the project's name, which is cut where the orchestrator's reader cuts it", () => {
  const first = only(runControlTest({ project: "desktop" }).files);
  const second = only(runControlTest({ project: "mobile" }).files);
  assert.notEqual(first.name, second.name);
  const long = only(runControlTest({ project: "p".repeat(MAX_PROJECT_NAME_CHARS + 100) }).files);
  assert.equal((long.body.project as string).length, MAX_PROJECT_NAME_CHARS);
  assert.match(long.name, /^control-[A-Za-z0-9_-]{1,64}\.json$/);
});

test("a control without the time of its load, the capture directory or the launch URL does not load anything and leaves no file", () => {
  for (const missing of ["PW_CONTROL_TIMEOUT_MS", "QA_FAILURE_CAPTURE_DIR", "PW_BASE_URL"]) {
    const out = runControlTest({ requests: [{ method: "POST", url: TOKEN }] }, { [missing]: undefined });
    assert.ok(out.threw, missing);
    assert.equal(out.goto, undefined, missing);
    assert.deepEqual(out.files, {}, missing);
  }
  const out = runControlTest({}, { PW_CONTROL_TIMEOUT_MS: "0" });
  assert.ok(out.threw);
});

/* ── the config: the project's own, with the control's test in place of the suite ─────────────────────────────────── */

interface ControlConfig { [key: string]: unknown; projects?: Array<Record<string, unknown>> }

function loadControlConfig(projectConfig: string | undefined, env: Record<string, string | undefined> = {}): { config?: ControlConfig; error?: string } {
  const dir = projectDir();
  try {
    if (projectConfig !== undefined) writeFileSync(join(dir.root, "playwright.config.js"), projectConfig);
    const testPath = join(dir.scripts, "abc-control-load.run.cjs");
    const script = join(dir.scripts, "abc-control-load.config.cjs");
    writeFileSync(script, buildControlConfig(testPath));
    const driver = join(dir.scripts, "driver.cjs");
    writeFileSync(driver, "const fail = (e) => process.stdout.write(JSON.stringify({ error: String(e.message) })); try { Promise.resolve(require(process.argv[2])).then((c) => process.stdout.write(JSON.stringify({ config: c })), fail); } catch (e) { fail(e); }");
    const full = { PATH: process.env.PATH, PW_CONTROL_TIMEOUT_MS: "12345", ...env };
    const stdout = execFileSync(process.execPath, [driver, script], { cwd: dir.root, env: Object.fromEntries(Object.entries(full).filter(([, v]) => v !== undefined)) as Record<string, string>, encoding: "utf8" });
    return { ...(JSON.parse(stdout) as { config?: ControlConfig; error?: string }) };
  } finally {
    dir.cleanup();
  }
}

const PROJECT_CONFIG = `module.exports = {
  testDir: ".", testMatch: "**/*.spec.ts", retries: 2, workers: 4, fullyParallel: true, globalSetup: "./login.ts", globalTeardown: "./bye.ts", webServer: { command: "serve" },
  shard: { current: 1, total: 2 }, grep: /smoke/, use: { baseURL: "https://dev.example.com", storageState: "session.json" }, timeout: 99,
  projects: [
    { name: "setup", testMatch: "**/*.setup.ts" },
    { name: "desktop", testIgnore: "**/*.setup.ts", dependencies: ["setup"], teardown: "cleanup", grepInvert: /slow/, retries: 3, use: { viewport: { width: 1280, height: 720 } } },
  ],
};`;

test("the control's config is the project's own with the control's test in place of the suite", () => {
  const { config, error } = loadControlConfig(PROJECT_CONFIG);
  assert.equal(error, undefined);
  assert.ok(config);
  assert.match(config.testDir as string, /\/scripts$/, "the directory the orchestrator wrote the test into");
  assert.equal(config.testMatch, "abc-control-load.run.cjs");
  assert.deepEqual([config.workers, config.retries, config.fullyParallel, config.timeout, config.globalTimeout], [1, 0, false, 24_690, 24_690], "one worker, no retry, and twice the load's bound for the test: the load, then the browser's start and the file's write");
  assert.deepEqual((config.use as Record<string, unknown>), { baseURL: "https://dev.example.com", storageState: "session.json" }, "the options a spec's context is made with are kept");
  for (const dropped of ["globalSetup", "globalTeardown", "webServer", "grep"]) assert.equal(config[dropped], undefined, dropped);
  assert.equal(config.shard, null);
  const projects = config.projects!;
  assert.deepEqual(projects.map((p) => p.name), ["setup", "desktop"], "a control per project, each charged against its own");
  assert.deepEqual(projects[1]!.use, { viewport: { width: 1280, height: 720 } });
  for (const project of projects) {
    assert.equal(project.testMatch, "abc-control-load.run.cjs");
    assert.equal(project.retries, 0);
    for (const dropped of ["dependencies", "teardown", "grepInvert", "testIgnore"]) assert.equal(project[dropped], undefined, `${project.name} ${dropped}`);
  }
});

test("a project with no projects of its own is controlled as it stands", () => {
  const { config } = loadControlConfig(`module.exports = { use: { baseURL: "https://dev.example.com" }, testMatch: "**/*.spec.ts" };`);
  assert.equal(config?.projects, undefined);
  assert.equal(config?.testMatch, "abc-control-load.run.cjs");
});

test("a control that cannot read the project's config, or has no time, fails loudly instead of running something else", () => {
  assert.match(loadControlConfig(undefined).error ?? "", /found no playwright\.config/);
  assert.match(loadControlConfig(PROJECT_CONFIG, { PW_CONTROL_TIMEOUT_MS: undefined }).error ?? "", /PW_CONTROL_TIMEOUT_MS/);
});

test("the control child is told its config, where Playwright writes, and the project the spec child is limited to, and nothing that selects a spec", () => {
  assert.deepEqual(controlArgs("/w/c.cjs", "/w/results", undefined), ["playwright", "test", "--config=/w/c.cjs", "--reporter=null", "--output=/w/results"]);
  assert.ok(controlArgs("/w/c.cjs", "/w/results", "desktop").includes("--project=desktop"));
});

test("the load of the control is given a fraction of its call's time, so that a launch page that never goes idle leaves the spec child most of the call", () => {
  for (const callMs of [80, 40_000, 600_000]) {
    const bound = controlLoadMs(callMs);
    assert.ok(bound > 0 && bound <= callMs / 4, `${callMs}: the load takes at most a quarter of the call, ${bound} ms`);
    assert.ok(2 * bound < callMs / 2, `${callMs}: with the room the config gives the test the control still leaves half the call`);
  }
  assert.equal(controlLoadMs(1), 1, "a bound is never nothing");
});

test("the control and the seed's counter cut an address at the same length, so a request has the same key in both", () => {
  const seed = readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "..", "config", "e2e", "fixtures.ts"), "utf8");
  const declaration = /^function networkUrl\(.*$/m.exec(seed);
  assert.ok(declaration, "the seed's capture block has its address function");
  const js = ts.transpileModule(declaration[0], { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const seedKey = new Function(`${js}\nreturn networkUrl;`)() as (raw: string) => string;
  for (const length of [10, PRODUCER_ADDRESS_CHARS - 1, PRODUCER_ADDRESS_CHARS, PRODUCER_ADDRESS_CHARS + 1, 400]) {
    const address = `${DEV}/${"a".repeat(length - DEV.length - 1 > 0 ? length - DEV.length - 1 : 1)}`;
    const raw = `${address}?q=1#f`;
    const [entry] = only(runControlTest({ requests: [{ method: "POST", url: raw }] }).files).body.requests as Array<{ url: string }>;
    assert.equal(entry!.url, seedKey(raw), `an address of ${address.length} characters`);
  }
});

test("the control is told the bounds the orchestrator reads its file with, and keeps no copy of them", () => {
  const text = buildControlTest();
  assert.ok(text.includes(`const CONTROL_MAX_ADDRESS_CHARS = ${PRODUCER_ADDRESS_CHARS};`));
  assert.ok(text.includes(`const CONTROL_MAX_PROJECT_CHARS = ${MAX_PROJECT_NAME_CHARS};`));
  assert.ok(!/\b(?:MAX_ADDRESS_CHARS|MAX_PROJECT_CHARS)\s*=\s*\d/.test(text), "the script reads the injected bounds");
});

test("the seed repeats the address and project bounds the orchestrator reads its ledgers and controls with", () => {
  const seed = readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "..", "config", "e2e", "fixtures.ts"), "utf8");
  assert.equal(Number(/function networkUrl\(raw: string, max = (\d+)\)/.exec(seed)?.[1]), PRODUCER_ADDRESS_CHARS);
  assert.equal(Number(/const MAX_PROJECT_CHARS = (\d+);/.exec(seed)?.[1]), MAX_PROJECT_NAME_CHARS);
});
