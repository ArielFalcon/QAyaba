/* The plain-agent arm: what the agent is allowed to do, what it is told, how its session is measured, and what
   the runner refuses to start. The server, git and the browser are fakes; the shape of the report is the real one. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BASELINE_AGENT, BASELINE_BASH_ALLOW, GENERATOR_AGENT, MAX_DIFF_CHARS, PERMISSION_PROBES,
  baselineAgentConfig, baselineInstructions, baselinePermission, buildBaselinePrompt, checkProbes, classifyBaseline, combineVerdicts, declaresNoop,
  evaluatePermission, finalTextOf, flattenPermission, generatorSettings, harnessFiles, main, parseArguments, replaySession, wildcardMatch,
  type AgentRun, type BaselineDeps, type CopyPlan, type PermissionRule, type SessionMessage, type SuiteRun,
} from "./baseline-agent.ts";
import type { ProbeReport } from "./probe-metrics.ts";

/* ── the generator's settings ── */

test("the baseline borrows the generator's model, step cap and temperature from the file, whatever they are", () => {
  const config = { agent: { [GENERATOR_AGENT]: { model: "some-provider/some-model-7", maxSteps: 33, temperature: 0.4 }, other: { model: "x/y" } } };
  assert.deepEqual(generatorSettings(config), { model: "some-provider/some-model-7", steps: 33, temperature: 0.4 });
  assert.equal(generatorSettings({ agent: { [GENERATOR_AGENT]: { model: "a/b", steps: 12, maxSteps: 99 } } }).steps, 12, "steps wins over the legacy key, as the server reads it");
  assert.equal(generatorSettings({ agent: { [GENERATOR_AGENT]: { model: "a/b" } } }).steps, null);
});

test("a config that gives the generator no model stops the run: there is no other source for it", () => {
  assert.throws(() => generatorSettings({ agent: {} }), /no model/);
  assert.throws(() => generatorSettings(null), /no model/);
  assert.throws(() => generatorSettings({ agent: { [GENERATOR_AGENT]: { model: "" } } }), /no model/);
});

test("the agent's config carries the borrowed settings and defines the agent only there, with no model baked into the code", () => {
  const config = baselineAgentConfig({ model: "p/m", steps: 50, temperature: 0.2 });
  const agent = config.agent[BASELINE_AGENT] as { model: string; steps: number; temperature: number; mode: string };
  assert.equal(agent.model, "p/m");
  assert.equal(agent.steps, 50);
  assert.equal(agent.temperature, 0.2);
  assert.equal(agent.mode, "primary");
  assert.deepEqual(Object.keys(config.agent), [BASELINE_AGENT]);
  const uncapped = baselineAgentConfig({ model: "p/m", steps: null, temperature: null }).agent[BASELINE_AGENT] as Record<string, unknown>;
  assert.equal("steps" in uncapped, false, "no cap is no cap, not zero");
});

/* ── permissions ── */

const designRules = flattenPermission(baselinePermission());

test("the agent's permission block does exactly what the design says: files and Playwright runs yes, every other shell, the web and the code-running browser tools no", () => {
  const outcomes = checkProbes(designRules);
  const failures = outcomes.filter((o) => !o.ok).map((o) => `${o.permission} ${o.pattern}: ${o.actual}`);
  assert.deepEqual(failures, []);
});

test("a permission block that lets any shell command through, or forgets the .env rule, fails the probes", () => {
  const openShell = flattenPermission({ ...baselinePermission(), bash: "allow" });
  assert.ok(checkProbes(openShell).some((o) => !o.ok && o.permission === "bash"));
  const noEnvRule = flattenPermission({ ...baselinePermission(), read: "allow" });
  assert.ok(checkProbes(noEnvRule).some((o) => !o.ok && o.permission === "read"));
  assert.ok(checkProbes([]).every((o) => o.actual === "ask"), "nothing decided asks, which a headless session cannot answer");
});

test("the last rule that matches decides, and a trailing ' *' also matches the bare command", () => {
  const rules: PermissionRule[] = [
    { permission: "bash", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "git *", action: "allow" },
    { permission: "bash", pattern: "git push*", action: "deny" },
  ];
  assert.equal(evaluatePermission(rules, "bash", "git status"), "allow");
  assert.equal(evaluatePermission(rules, "bash", "git"), "allow");
  assert.equal(evaluatePermission(rules, "bash", "git push origin main"), "deny");
  assert.equal(evaluatePermission(rules, "bash", "ls"), "deny");
  assert.equal(wildcardMatch("npx playwright test", "npx playwright test*"), true);
  assert.equal(wildcardMatch("npx playwright testing", "npx playwright test"), false);
  assert.equal(wildcardMatch("a.b", "a?b"), true);
});

test("the shell allow-list is the Playwright runner and nothing else", () => {
  assert.ok(BASELINE_BASH_ALLOW.every((p) => p.startsWith("npx playwright test")));
  assert.ok(PERMISSION_PROBES.some((p) => p.permission === "bash" && p.expect === "deny"));
});

/* ── the prompt ── */

const material = { baseUrl: "https://dev.example.test", testDataPrefix: "qa-bot", commitMessage: "feat(cart): apply coupon\n\nBody text", stat: " src/cart.ts | 4 ++--", diff: "diff --git a/src/cart.ts b/src/cart.ts\n+const x = 1;\n" };

test("the prompt is a few lines of generic instructions followed by the commit message, the stat and the diff, and names the site and the data prefix", () => {
  const prompt = buildBaselinePrompt(material);
  const instructions = baselineInstructions(material);
  assert.ok(instructions.length <= 15);
  assert.ok(prompt.startsWith(instructions.join("\n")));
  assert.ok(prompt.includes(material.baseUrl));
  assert.ok(prompt.includes(`"${material.testDataPrefix}"`));
  assert.ok(prompt.includes("apply coupon"));
  assert.ok(prompt.includes("src/cart.ts | 4"));
  assert.ok(prompt.includes("+const x = 1;"));
  assert.ok(/NOOP/.test(prompt), "the way to say there is nothing to test");
});

test("the prompt names no app, no model and none of the pipeline's stages", () => {
  const instructions = baselineInstructions(material).join("\n").toLowerCase();
  for (const word of ["explorer", "reviewer", "serena", "engram", "manifest", "context map", "qa-generator"]) assert.equal(instructions.includes(word), false, word);
});

test("a diff past the cap is cut and the prompt says how much was left out", () => {
  const prompt = buildBaselinePrompt({ ...material, diff: "x".repeat(MAX_DIFF_CHARS + 500) });
  assert.ok(prompt.includes("500 more not shown"));
  assert.ok(prompt.length < MAX_DIFF_CHARS + 2_000);
});

test("a secret in the commit text or the diff is redacted before it reaches the prompt", () => {
  const prompt = buildBaselinePrompt({ ...material, diff: "+const token = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';\n" });
  assert.equal(prompt.includes("sk-abcdefghijklmnopqrstuvwxyz0123456789"), false);
});

test("a closing message that says NOOP declares there is nothing to test, and one that merely contains the letters does not", () => {
  assert.equal(declaresNoop("NOOP: only a comment changed"), true);
  assert.equal(declaresNoop("I wrote nothing noop-ish"), false);
});

/* ── the Playwright wrapper ── */

test("the login run is reachable through the one command the shell allows, and its session is where the other tests look", () => {
  const { envModule } = harnessFiles({ baseUrl: "https://dev.example.test", namespace: "n", storageStatePath: "/mirrors/.baseline/l.auth/user.json" });
  assert.ok(envModule.includes("--project=setup"));
  assert.ok(envModule.includes("PW_AUTH_SETUP"));
  assert.ok(evaluatePermission(designRules, "bash", "npx playwright test --project=setup") === "allow");
});

test("the harness environment sets only non-secret values and applies the saved session only if it exists", () => {
  const { envModule, config } = harnessFiles({ baseUrl: "https://dev.example.test", namespace: "qa-bot-abc1234-l1", testIdAttribute: "data-qa", storageStatePath: "/mirrors/.baseline/l1.auth/storage-state.json" });
  assert.ok(envModule.includes("https://dev.example.test") && envModule.includes("qa-bot-abc1234-l1") && envModule.includes("data-qa"));
  assert.ok(envModule.includes("existsSync"));
  assert.equal(/DEV_(TEST|ENV)_/.test(envModule + config), false, "login credentials stay in the environment, never in a file the agent can read");
  assert.ok(config.indexOf("playwright.baseline-env") < config.indexOf("playwright.repo.config"), "the environment is set before the repo's config reads it");
  assert.ok(config.includes("defineConfig(base"));
});

/* ── verdicts ── */

test("two executions combine into one verdict, and an unrunnable one decides it", () => {
  assert.equal(combineVerdicts(["pass", "pass"]), "pass");
  assert.equal(combineVerdicts(["fail", "fail"]), "fail");
  assert.equal(combineVerdicts(["pass", "fail"]), "flaky");
  assert.equal(combineVerdicts(["pass", "flaky"]), "flaky");
  assert.equal(combineVerdicts(["pass", "infra-error"]), "infra-error");
  assert.equal(combineVerdicts([]), "skipped");
});

const run = (verdict: SuiteRun["verdict"]): SuiteRun => ({ verdict, passed: 1, failed: 0, flaky: 0, ms: 1_000 });

test("the arm's run reads in the pipeline's own vocabulary: specs that ran, a declared no-op, silence, the clock and the step cap", () => {
  assert.equal(classifyBaseline({ specs: 2, noop: false, ended: "completed", runs: [run("pass"), run("pass")], timeoutMin: 20 }).verdict, "pass");
  assert.equal(classifyBaseline({ specs: 1, noop: false, ended: "timeout", runs: [run("pass"), run("pass")], timeoutMin: 20 }).verdict, "pass", "specs written before the clock ran out are still judged");
  const noop = classifyBaseline({ specs: 0, noop: true, ended: "completed", runs: [], timeoutMin: 20 });
  assert.equal(noop.verdict, "skipped");
  const silent = classifyBaseline({ specs: 0, noop: false, ended: "completed", runs: [], timeoutMin: 20 });
  assert.deepEqual([silent.verdict, silent.errorClass], ["infra-error", "E-NO-DECISION"]);
  assert.equal(classifyBaseline({ specs: 0, noop: false, ended: "timeout", runs: [], timeoutMin: 20 }).errorClass, "E-TIME-BUDGET");
  assert.equal(classifyBaseline({ specs: 0, noop: false, ended: "exhausted", runs: [], timeoutMin: 20 }).errorClass, "E-STEP-BUDGET");
  assert.equal(classifyBaseline({ specs: 0, noop: true, ended: "timeout", runs: [], timeoutMin: 20 }).errorClass, "E-TIME-BUDGET", "a clock that ran out is not a decision");
});

/* ── arguments ── */

const SHA = "0123456789abcdef0123456789abcdef01234567";
const argv = (...extra: string[]): string[] => ["--app", "demo", "--sha", SHA, "--timeout-min", "20", "--label", "arm-a-1", ...extra];

test("arguments are validated: required names, a hex commit, a positive timeout, a label that cannot name a path", () => {
  const ok = parseArguments(argv());
  assert.ok(ok.ok);
  assert.equal(ok.ok && ok.args.timeoutMin, 20);
  assert.equal(parseArguments(argv("--dry-run")).ok, true);
  for (const bad of [["--app", "demo"], argv("--nope"), ["--app", "demo", "--sha", "xyz", "--timeout-min", "5", "--label", "l"], ["--app", "demo", "--sha", SHA, "--timeout-min", "0", "--label", "l"], ["--app", "demo", "--sha", SHA, "--timeout-min", "5", "--label", "../x"]]) {
    assert.equal(parseArguments(bad).ok, false, bad.join(" "));
  }
});

test("a real run needs its time limit, a dry run does not", () => {
  const withoutTimeout = ["--app", "demo", "--sha", SHA, "--label", "l"];
  assert.equal(parseArguments(withoutTimeout).ok, false);
  assert.equal(parseArguments([...withoutTimeout, "--dry-run"]).ok, true);
});

/* ── the session, measured by the pipeline's own tracker ── */

const DENIAL = "The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules []";
const T0 = 1_000_000;

function tool(id: string, name: string, input: Record<string, unknown>, start: number, end: number, status: "completed" | "error" = "completed", error?: string): SessionMessage["parts"][number] {
  return { id: `prt_${id}`, type: "tool", callID: id, tool: name, state: { status, input, output: "ok", ...(error ? { error } : {}), time: { start, end } } };
}

function sampleMessages(): SessionMessage[] {
  return [
    { info: { role: "user", time: { created: T0 } }, parts: [] },
    {
      info: { role: "assistant", time: { created: T0 + 1_000, completed: T0 + 20_000 } },
      parts: [
        { id: "s1", type: "step-start" },
        tool("c1", "read", { filePath: "/mirrors/copy/src/cart.ts" }, T0 + 2_000, T0 + 2_100),
        tool("c2", "grep", { pattern: "coupon", path: "/mirrors/copy/src" }, T0 + 3_000, T0 + 3_200),
        { id: "f1", type: "step-finish", tokens: { input: 1_000, output: 40, reasoning: 0, cache: { read: 5_000, write: 0 } }, cost: 0.01 },
        { id: "s2", type: "step-start" },
        tool("c3", "bash", { command: "rm -rf /" }, T0 + 9_000, T0 + 9_050, "error", DENIAL),
        tool("c4", "write", { filePath: "/mirrors/copy/e2e/flows/cart.spec.ts", content: "SECRET BODY" }, T0 + 12_000, T0 + 12_100),
        { id: "f2", type: "step-finish", tokens: { input: 300, output: 900, reasoning: 20, cache: { read: 7_000, write: 0 } }, cost: 0.02 },
      ],
    },
    { info: { role: "assistant", time: { created: T0 + 20_000, completed: T0 + 21_000 } }, parts: [{ id: "s3", type: "step-start" }, { type: "text", text: "Done: wrote cart.spec.ts" }, { id: "f3", type: "step-finish", tokens: { input: 50, output: 10, reasoning: 0, cache: { read: 7_500, write: 0 } }, cost: 0.005 }] },
  ];
}

test("a session is measured as the pipeline measures a turn: calls, order, denied calls, time to the first write, and usage over every step", async () => {
  const m = await replaySession("ses_1", "/mirrors/copy", T0, "the prompt", sampleMessages());
  assert.ok(m);
  assert.equal(m.totalCalls, 4, "a denied call that ran counts as a call, as it does for the pipeline");
  assert.equal(m.deniedCallCount, 1);
  assert.equal(m.writeCount, 1);
  assert.equal(m.callsBeforeFirstWrite, 3);
  assert.equal(m.stepsUsed, 3);
  assert.equal(m.timeToFirstCallMs, 2_000);
  assert.equal(m.timeToFirstWriteMs, 12_000);
  assert.deepEqual(m.toolSequence.map((e) => e.tool), ["read", "grep", "bash", "write"]);
  assert.equal(m.toolSequence[0]?.target, "src/cart.ts", "paths read relative to the working copy");
  assert.equal(m.toolSequence[2]?.denied, true);
  assert.equal(JSON.stringify(m.toolSequence).includes("SECRET BODY"), false);
  const { cost, ...tokens } = m.usage!;
  assert.deepEqual(tokens, { input: 1_350, output: 950, reasoning: 20, cacheRead: 19_500, cacheWrite: 0, steps: 3 });
  assert.ok(Math.abs(cost - 0.035) < 1e-9);
});

test("a session with no assistant message has no metrics, and the closing words are the last message that said anything", async () => {
  assert.equal(await replaySession("ses_1", "/mirrors/copy", T0, "p", [{ info: { role: "user" }, parts: [] }]), null);
  assert.equal(finalTextOf(sampleMessages()), "Done: wrote cart.spec.ts");
  assert.equal(finalTextOf([]), "");
});

/* ── the run, over fakes ── */

const GENERATOR_CONFIG = { agent: { [GENERATOR_AGENT]: { model: "p/m", maxSteps: 50, temperature: 0.2 } } };

interface Harness {
  deps: BaselineDeps;
  calls: string[];
  lines: string[];
  reports: ProbeReport[];
  prompts: string[];
}

function harness(over: Partial<BaselineDeps> = {}, opts: { rules?: PermissionRule[] } = {}): Harness {
  const calls: string[] = [];
  const lines: string[] = [];
  const reports: ProbeReport[] = [];
  const prompts: string[] = [];
  const deps: BaselineDeps = {
    assertQueueIdle: async () => { calls.push("queue"); },
    queueState: async () => "idle",
    loadApp: (name) => ({ name, repo: "org/demo", baseUrl: "https://dev.example.test", testDataPrefix: "qa-bot" }),
    agentsConfig: () => GENERATOR_CONFIG,
    copyDirFor: (label) => ({ copyDir: `/mirrors/.baseline/${label}`, authDir: `/mirrors/.baseline/${label}.auth` }),
    copyExists: () => false,
    prepareCopy: async () => { calls.push("prepare"); },
    removeCopy: () => { calls.push("remove"); },
    commitMaterial: async () => ({ message: "feat: coupon", stat: " src/cart.ts | 2 +-", diff: "diff --git a/src/cart.ts b/src/cart.ts\n", changedFiles: ["src/cart.ts"] }),
    resolvedPermissions: async () => opts.rules ?? designRules,
    resolvedGeneratorModel: async () => "p/m",
    prepareAuth: async (_app, _plan, phase) => { calls.push(`auth:${phase}`); return { unauthored: false }; },
    runAgent: async ({ prompt }): Promise<AgentRun> => {
      calls.push("agent");
      prompts.push(prompt);
      return { sessionId: "ses_1", startedAt: T0, endedAt: T0 + 21_000, ended: "completed", messages: sampleMessages() };
    },
    changedFiles: async () => ({ specs: ["flows/cart.spec.ts"], outsideSuite: [] }),
    specLines: () => new Map([["flows/cart.spec.ts", 41]]),
    runSuite: async () => { calls.push("suite"); return run("pass"); },
    writeReport: (_label, report) => { reports.push(report); return `/results/${report.id}.json`; },
    now: (() => { let t = 0; return () => (t += 1_000); })(),
    out: (line) => lines.push(line),
    ...over,
  };
  return { deps, calls, lines, reports, prompts };
}

test("a busy queue stops the run before anything is prepared: DEV is used by one thing at a time", async () => {
  const h = harness({ assertQueueIdle: async () => { throw new Error("the queue is busy"); } });
  assert.equal(await main(argv(), h.deps), 1);
  assert.ok(h.lines.some((l) => l.includes("the queue is busy")));
  assert.deepEqual(h.calls, []);
});

test("a label that already has a copy is refused before it is touched", async () => {
  const h = harness({ copyExists: () => true });
  assert.equal(await main(argv(), h.deps), 1);
  assert.equal(h.calls.includes("prepare"), false);
});

test("a dry run prepares the copy, shows the prompt and the permissions, starts no session and no login, and removes the copy", async () => {
  const h = harness();
  assert.equal(await main(argv("--dry-run"), h.deps), 0);
  assert.deepEqual(h.calls, ["prepare", "remove"]);
  const text = h.lines.join("\n");
  assert.ok(text.includes("p/m"), "the model it would use");
  assert.ok(text.includes("probes as expected"));
  assert.ok(text.includes("Write Playwright E2E tests under e2e/"));
  assert.ok(text.includes("dry run: no session was started"));
});

test("a dry run asked to check the login logs in once, and --keep-copy keeps the copy", async () => {
  const h = harness();
  assert.equal(await main(argv("--dry-run", "--check-auth", "--keep-copy"), h.deps), 0);
  assert.deepEqual(h.calls, ["prepare", "auth:pre-generate"]);
});

test("a dry run does not refuse a busy queue, it says what the queue holds", async () => {
  const h = harness({ assertQueueIdle: async () => { throw new Error("busy"); }, queueState: async () => "1 running" });
  assert.equal(await main(argv("--dry-run"), h.deps), 0);
  assert.ok(h.lines.some((l) => l.includes("1 running")));
});

test("permissions the server resolved that differ from the design stop the run before a session is started", async () => {
  const h = harness({}, { rules: [{ permission: "*", pattern: "*", action: "allow" }] });
  assert.equal(await main(argv(), h.deps), 1);
  assert.equal(h.calls.includes("agent"), false);
  assert.ok(h.lines.some((l) => l.includes("FAIL")));
});

test("a generator model the server resolves differently from the file stops the run: the orchestrator's copy of the config is stale", async () => {
  const h = harness({ resolvedGeneratorModel: async () => "other/model" });
  assert.equal(await main(argv(), h.deps), 1);
  assert.ok(h.lines.some((l) => l.includes("stale")));
  assert.equal(h.calls.includes("agent"), false);
});

test("a full run starts the agent, measures it, runs its specs twice, writes a report in the shared shape and prints its row", async () => {
  const h = harness();
  assert.equal(await main(argv(), h.deps), 0);
  assert.deepEqual(h.calls, ["queue", "prepare", "auth:pre-generate", "agent", "queue", "auth:pre-execute", "suite", "suite", "remove"], "the queue is checked again before the suite touches DEV, and the login is made again with whatever login the agent left");
  const report = h.reports[0]!;
  assert.equal(report.arm, "baseline");
  assert.equal(report.id, "arm-a-1");
  assert.equal(report.verdict, "pass");
  assert.deepEqual(report.specs, [{ path: "flows/cart.spec.ts", lines: 41 }]);
  const turn = report.turns[0]!;
  assert.equal(turn.role, BASELINE_AGENT);
  assert.equal(turn.calls, 4);
  assert.equal(turn.deniedCalls, 1);
  assert.equal(turn.msToFirstWrite, 12_000);
  assert.equal(turn.usage.source, "all-steps");
  assert.equal(turn.maxSteps, 50);
  assert.equal(report.coverage, null, "this arm measures no change-coverage");
  assert.equal(report.phases.generation, 21_000);
  assert.ok(h.lines.join("\n").includes("| baseline | arm-a-1 |"));
  assert.ok(h.prompts[0]!.includes("feat: coupon"));
});

test("a login that does not work before the agent starts is told to the agent, as the pipeline's generator is told, and does not stop the run", async () => {
  const h = harness({ prepareAuth: async (_a, _p, phase) => { h.calls.push(`auth:${phase}`); return { unauthored: phase === "pre-generate" }; } });
  assert.equal(await main(argv(), h.deps), 0);
  assert.ok(h.prompts[0]!.includes("--project=setup"));
  assert.ok(h.prompts[0]!.includes("did not work"));
});

test("a login that cannot be completed before the suite runs is an E-PRECONDITION and the suite is not run", async () => {
  const h = harness({ prepareAuth: async (_a, _p, phase) => { if (phase === "pre-execute") throw new Error("auth setup failed: login did not leave the password form"); return { unauthored: false }; } });
  assert.equal(await main(argv(), h.deps), 0);
  assert.equal(h.calls.includes("suite"), false);
  assert.deepEqual([h.reports[0]!.verdict, h.reports[0]!.errorClass], ["infra-error", "E-PRECONDITION"]);
});

test("a session the clock cut off with no spec is an infra-error, and its suite is never run", async () => {
  const h = harness({
    runAgent: async () => ({ sessionId: "ses_1", startedAt: T0, endedAt: T0 + 20 * 60_000, ended: "timeout", messages: [] }),
    changedFiles: async () => ({ specs: [], outsideSuite: [] }),
  });
  assert.equal(await main(argv(), h.deps), 0);
  assert.equal(h.calls.includes("suite"), false);
  const report = h.reports[0]!;
  assert.equal(report.verdict, "infra-error");
  assert.equal(report.errorClass, "E-TIME-BUDGET");
  assert.equal(report.turns[0]?.calls, null, "nothing observed is unknown, not zero");
  assert.equal(report.turns[0]?.ended, "timeout");
});

/* the copy a plan describes names its own non-secret environment and agent */
test("the plan the run hands to the copy carries the app's site, a namespace with its data prefix and the agent's config", async () => {
  const plans: CopyPlan[] = [];
  const h = harness({ prepareCopy: async (plan) => { plans.push(plan); } });
  await main(argv("--dry-run"), h.deps);
  const plan = plans[0]!;
  assert.equal(plan.env.baseUrl, "https://dev.example.test");
  assert.ok(plan.env.namespace.startsWith("qa-bot-0123456-"));
  assert.ok(plan.env.namespace.endsWith("arm-a-1"));
  assert.ok(plan.copyDir.endsWith("/arm-a-1"));
  assert.ok(plan.env.storageStatePath.startsWith(plan.authDir), "the login session lives beside the copy, not inside it");
});
