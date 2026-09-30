import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FORM_STATE } from "@contexts/qa-run-orchestration/domain/helpers/login-evidence.ts";
import {
  LOGGED_TEXT_MAX,
  LOGIN_DISCOVERY_HARD_KILL_MS,
  createDiscoverLogin,
  type LoginDiscoveryInput,
} from "@contexts/qa-run-orchestration/infrastructure/login-discovery/login-discovery.runner.ts";
import { CHILD_DEADLINE_MS, SUBMITTED_MARKER } from "@contexts/qa-run-orchestration/infrastructure/login-discovery/login-discovery.script.ts";
import type { SandboxedBinaryRunner, SandboxedRunRequest, SandboxedRunResult } from "../../../../../src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";
import { scriptedLoginEvidence } from "../../../../support/login-evidence.ts";

const USER = "synthetic.user@demo.example";
const PASS = "sYnth3tic pass&1";

const SUBMITTED = `${JSON.stringify({ marker: SUBMITTED_MARKER })}\n`;
const evidenceLine = (over = {}): string => `${JSON.stringify({ evidence: scriptedLoginEvidence(over) })}\n`;

const done = (over: Partial<SandboxedRunResult> = {}): SandboxedRunResult => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, ...over });

/* The fake sits at the process boundary: it records what the runner asked for and answers with scripted output. */
function fakeRunner(answer: (req: SandboxedRunRequest) => SandboxedRunResult | Promise<SandboxedRunResult>) {
  const requests: SandboxedRunRequest[] = [];
  const runner: SandboxedBinaryRunner = {
    run: async (req) => {
      requests.push(req);
      return answer(req);
    },
  };
  return { runner, requests };
}

const inputFor = (specDir: string, over: Partial<LoginDiscoveryInput> = {}): LoginDiscoveryInput => ({
  specDir,
  baseUrl: "https://app.example.test",
  routes: ["/reports"],
  storageStatePath: join(specDir, "state.json"),
  env: { DEV_TEST_USER: USER, DEV_TEST_PASS: PASS, PATH: "/usr/bin" },
  ...over,
});

const discovering = (runner: SandboxedBinaryRunner, lines: string[] = []) => createDiscoverLogin({ runner, log: (line) => lines.push(line) });

test("the script is written under the temp dir, run with node in the spec dir under the hard-kill bound, and removed afterwards", async () => {
  let scriptPath = "";
  let sourceSeen = "";
  const { runner, requests } = fakeRunner((req) => {
    scriptPath = req.args[0] ?? "";
    assert.ok(existsSync(scriptPath), "the script exists while the child runs");
    sourceSeen = readFileSync(scriptPath, "utf8");
    return done({ stdout: SUBMITTED + evidenceLine() });
  });
  await discovering(runner)(inputFor("/mirror/e2e"));
  const [req] = requests;
  assert.equal(req?.command, "node");
  assert.equal(req?.cwd, "/mirror/e2e");
  assert.equal(req?.timeoutMs, LOGIN_DISCOVERY_HARD_KILL_MS);
  assert.ok(dirname(scriptPath).startsWith(tmpdir()), "the script lives outside the watched repo");
  assert.ok(sourceSeen.includes(join("/mirror/e2e", "node_modules", "playwright")), "the child loads the repo's own playwright");
  assert.equal(existsSync(dirname(scriptPath)), false, "the temp dir is gone afterwards");
});

test("the hard kill falls after the deadline the child prints its evidence by, so the kill is never what ends it", () => {
  assert.ok(LOGIN_DISCOVERY_HARD_KILL_MS > CHILD_DEADLINE_MS);
});

test("the temp dir is removed even when the runner throws", async () => {
  let scriptPath = "";
  const { runner } = fakeRunner((req) => {
    scriptPath = req.args[0] ?? "";
    throw new Error("boom");
  });
  await discovering(runner)(inputFor("/mirror/e2e"));
  assert.ok(scriptPath.length > 0);
  assert.equal(existsSync(dirname(scriptPath)), false);
});

test("the child gets the account in its env and everything else as JSON that holds no credential", async () => {
  const { runner, requests } = fakeRunner(() => done({ stdout: evidenceLine() }));
  await discovering(runner)(inputFor("/mirror/e2e", { loginPath: "/signin", actionTimeoutMs: 12_000, env: { DEV_TEST_USER: USER, DEV_TEST_PASS: PASS, DEV_ENV_USER: "gate" } }));
  const env = requests[0]?.env ?? {};
  assert.equal(env.DEV_TEST_USER, USER);
  assert.equal(env.DEV_TEST_PASS, PASS);
  assert.equal(env.DEV_ENV_USER, "gate");
  const carried = env.PW_LOGIN_INPUT ?? "";
  const parsed = JSON.parse(carried) as { baseUrl: string; routes: string[]; loginPath: string; storageStatePath: string; actionTimeoutMs: number };
  assert.equal(parsed.baseUrl, "https://app.example.test");
  assert.deepEqual(parsed.routes, ["/reports"]);
  assert.equal(parsed.loginPath, "/signin");
  assert.equal(parsed.storageStatePath, "/mirror/e2e/state.json");
  assert.equal(parsed.actionTimeoutMs, 12_000);
  assert.equal(carried.includes(USER) || carried.includes(PASS), false);
});

test("the evidence line the child printed is what comes back", async () => {
  const { runner } = fakeRunner(() => done({ stdout: SUBMITTED + evidenceLine({ form: FORM_STATE.FOUND, finalPath: "/dashboard", passwordGone: true }) }));
  const result = await discovering(runner)(inputFor("/mirror/e2e"));
  assert.ok(!("crashed" in result));
  assert.equal(result.finalPath, "/dashboard");
  assert.equal(result.passwordGone, true);
  assert.equal(result.form, FORM_STATE.FOUND);
});

test("a submit marker with no evidence is a crash after an attempt, and no marker is a crash before one", async () => {
  const after = await discovering(fakeRunner(() => done({ exitCode: 1, stdout: SUBMITTED })).runner)(inputFor("/mirror/e2e"));
  assert.deepEqual(after, { crashed: true, attempted: true });
  const before = await discovering(fakeRunner(() => done({ exitCode: 1 })).runner)(inputFor("/mirror/e2e"));
  assert.deepEqual(before, { crashed: true, attempted: false });
});

test("a timeout or an abort keeps the partial output, so a marker that was printed still counts", async () => {
  const marker = await discovering(fakeRunner(() => done({ exitCode: null, timedOut: true, stdout: SUBMITTED })).runner)(inputFor("/mirror/e2e"));
  assert.deepEqual(marker, { crashed: true, attempted: true });
  const quiet = await discovering(fakeRunner(() => done({ exitCode: null, timedOut: true })).runner)(inputFor("/mirror/e2e"));
  assert.deepEqual(quiet, { crashed: true, attempted: false });
});

test("an overflow rejection is a crash after a possible attempt, and a spawn failure before the child started is not", async () => {
  const overflow = await discovering(fakeRunner(() => Promise.reject(new Error("node wrote more than 100 chars to stdout; killed"))).runner)(inputFor("/mirror/e2e"));
  assert.deepEqual(overflow, { crashed: true, attempted: true });
  const noNode = Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT", syscall: "spawn node" });
  const spawnFailed = await discovering(fakeRunner(() => Promise.reject(noNode)).runner)(inputFor("/mirror/e2e"));
  assert.deepEqual(spawnFailed, { crashed: true, attempted: false });
});

test("a rejection from a system call other than a spawn may have lost the marker, so a submit is assumed", async () => {
  const brokenPipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE", syscall: "write" });
  const result = await discovering(fakeRunner(() => Promise.reject(brokenPipe)).runner)(inputFor("/mirror/e2e"));
  assert.deepEqual(result, { crashed: true, attempted: true });
});

test("a child that ends with no evidence and nothing to say is still reported as a crash, saying how it ended", async () => {
  const ended: string[] = [];
  const cut: string[] = [];
  await discovering(fakeRunner(() => done({ exitCode: 137 })).runner, ended)(inputFor("/mirror/e2e"));
  await discovering(fakeRunner(() => done({ exitCode: 137, timedOut: true })).runner, cut)(inputFor("/mirror/e2e"));
  assert.equal(ended.length, 1, "exactly one line reports the crash");
  assert.ok(ended[0]?.includes("137"), "and it names the exit code");
  assert.equal(cut.length, 1);
  assert.notEqual(cut[0], ended[0], "a child that was cut off is told apart from one that exited");
});

/* One field of a valid evidence object bent at a time: the parser must not trust the result. */
const BENT: ReadonlyArray<[string, Record<string, unknown>]> = [
  ["a ladder that is not a list", { ladder: "/" }],
  ["a ladder of things that are not paths", { ladder: [1, 2] }],
  ["a form state nobody defined", { form: "sideways" }],
  ["markers missing a flag", { markers: { captcha: true } }],
  ["a flag that is not a boolean", { filled: "yes" }],
  ["requests that are not a list", { requests: "none" }],
  ["a request with no path", { requests: [{ method: "POST", status: 200 }] }],
  ["a request with a status that is neither a number nor null", { requests: [{ method: "POST", pathname: "/x", status: "200" }] }],
  ["a page error count that is not a number", { pageErrorCount: "0" }],
  ["a final path that is not text", { finalPath: 7 }],
];

for (const [label, bend] of BENT) {
  test(`an evidence line with ${label} is not trusted`, async () => {
    const line = `${JSON.stringify({ evidence: { ...scriptedLoginEvidence(), ...bend } })}\n`;
    const result = await discovering(fakeRunner(() => done({ stdout: SUBMITTED + line })).runner)(inputFor("/mirror/e2e"));
    assert.deepEqual(result, { crashed: true, attempted: true });
  });
}

test("an evidence line that is not login evidence is not trusted", async () => {
  const notEvidence = `${JSON.stringify({ evidence: { form: FORM_STATE.FOUND } })}\n`;
  const result = await discovering(fakeRunner(() => done({ stdout: SUBMITTED + notEvidence })).runner)(inputFor("/mirror/e2e"));
  assert.deepEqual(result, { crashed: true, attempted: true });
});

test("stderr and stray stdout are logged with the account removed in every spelling, and a crash is logged loudly", async () => {
  const echoes = [USER, "synthetic.user%40demo.example", PASS, "sYnth3tic%20pass%261", "sYnth3tic+pass%261"];
  const lines: string[] = [];
  const { runner } = fakeRunner(() => done({ exitCode: 1, stderr: `boom ${echoes.join(" ")}\n`, stdout: `not json ${echoes.join(" ")}\n` }));
  const result = await discovering(runner, lines)(inputFor("/mirror/e2e"));
  assert.deepEqual(result, { crashed: true, attempted: false });
  assert.ok(lines.length >= 2, "the crash, the stderr and the stray output are all reported");
  const logged = lines.join("\n");
  for (const echo of echoes) assert.equal(logged.toLowerCase().includes(echo.toLowerCase()), false, `leaked ${echo}`);
  assert.ok(logged.includes("boom"), "the rest of the message is kept");
});

test("stray stdout is reported, and what the child says is cut to a bound", async () => {
  const lines: string[] = [];
  const { runner } = fakeRunner(() => done({ exitCode: 1, stdout: "stray-marker\n", stderr: "x".repeat(LOGGED_TEXT_MAX * 3) }));
  await discovering(runner, lines)(inputFor("/mirror/e2e"));
  const logged = lines.join("\n");
  assert.ok(logged.includes("stray-marker"));
  assert.ok(logged.includes("x".repeat(LOGGED_TEXT_MAX)));
  assert.equal(logged.includes("x".repeat(LOGGED_TEXT_MAX + 1)), false);
});

test("a rejection message is logged with the account removed", async () => {
  const lines: string[] = [];
  await discovering(fakeRunner(() => Promise.reject(new Error(`died while signing in ${USER} with ${PASS}`))).runner, lines)(inputFor("/mirror/e2e"));
  const logged = lines.join("\n");
  assert.ok(logged.includes("died while signing in"));
  assert.equal(logged.includes(USER) || logged.includes(PASS), false);
});

test("an already aborted run starts nothing", async () => {
  const controller = new AbortController();
  controller.abort();
  const { runner, requests } = fakeRunner(() => done({ stdout: evidenceLine() }));
  const result = await discovering(runner)(inputFor("/mirror/e2e"), controller.signal);
  assert.deepEqual(result, { crashed: true, attempted: false });
  assert.equal(requests.length, 0);
});

test("the abort signal is handed to the runner", async () => {
  const controller = new AbortController();
  const { runner, requests } = fakeRunner(() => done({ stdout: evidenceLine() }));
  await discovering(runner)(inputFor("/mirror/e2e"), controller.signal);
  assert.equal(requests[0]?.signal, controller.signal);
});
