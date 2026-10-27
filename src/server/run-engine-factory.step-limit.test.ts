/*
 * The step limit of each role reaches the engine through ONE per-run memo over the live runtime's facade:
 * a single read of the run's directory serves every role and every prompt, a read that fails or outlasts
 * its deadline leaves every role without a limit (one warning, never the baked config copy), and the
 * facade is the one the host resolves for THIS run (the runtime is switchable). Sibling of
 * run-engine-factory.test.ts so the `step-limit` mutation preset runs only these tests per mutant.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEngineRootDeps, STEP_LIMIT_READ_TIMEOUT_MS, type RunEngineFactoryDeps } from "./run-engine-factory";
import { maxStepsFromConfig, type AgentDeps } from "../integrations/opencode-client";
import { AGENT_NAME_FOR_ROLE, type AgentFacade, type StepLimits } from "../agent-runtime/types";
import type { AppConfig } from "../orchestrator/config-loader";
import type { EngineRootDeps } from "./engine-root";
import type { StepLimitRole } from "@contexts/generation/application/index.ts";
import { rosterFixturePath } from "../integrations/fixtures/opencode-roster";
import { setAgentsConfigPath } from "../integrations/opencode-client";

/* The roster is an input here: window budgets resolve from the roster fixture, never the deployable agents/opencode.json. */
setAgentsConfigPath(rosterFixturePath());

const APP: AppConfig = {
  name: "step-limit-app",
  repo: "org/demo",
  dev: { baseUrl: "https://dev" },
  qa: { needsReview: true, testDataPrefix: "qa-bot", shadow: true },
  report: { onFailure: "github-issue" },
};

/* An AgentDeps whose sessions cannot be opened: composing and asking for a limit must never need one. */
function unusableAgentDeps(): AgentDeps {
  return {
    open: async () => {
      throw new Error("no agent session in a step-limit test");
    },
  };
}

const ASSIGNMENT = { provider: "opencode" as const, model: "provider/model" };

/* A facade whose limit read is `answer`, recording the directory of every read. */
function facadeAnswering(answer: (directory: string) => Promise<StepLimits>): { facade: AgentFacade; reads: string[] } {
  const reads: string[] = [];
  const facade: AgentFacade = {
    config: { assignments: { primary: ASSIGNMENT, reviewer: ASSIGNMENT, chat: ASSIGNMENT } },
    deps: unusableAgentDeps,
    getStatus: async () => ({ providers: [] }),
    listModels: async () => [],
    stepLimits: (directory) => {
      reads.push(directory);
      return answer(directory);
    },
  };
  return { facade, reads };
}

const reporting = (limits: StepLimits) => facadeAnswering(async () => limits);

/* One composition = one run: the config a run's engine is built from. */
function compose(getAgentFacade?: RunEngineFactoryDeps["getAgentFacade"]): EngineRootDeps {
  return buildEngineRootDeps(
    APP,
    { getAgentDeps: unusableAgentDeps, ...(getAgentFacade ? { getAgentFacade } : {}) },
    "qa-bot-abc1234-run1",
    { mode: "diff" },
  );
}

function limitOf(config: EngineRootDeps, role: StepLimitRole): Promise<number | undefined> {
  assert.ok(config.stepLimitFor, "a host that wires a facade composes a step-limit resolver");
  return config.stepLimitFor(role);
}

const ROLES: readonly StepLimitRole[] = ["author", "reviewer"];
const limitsOf = (config: EngineRootDeps): Promise<Array<number | undefined>> => Promise.all(ROLES.map((role) => limitOf(config, role)));

/* Lets every promise callback already queued run, with timers (mocked or not) left alone. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("each role's limit is the one the live runtime reports for its own role, and the author's is the author sidekick's role", async () => {
  const config = compose(() => reporting({ author: 41, reviewer: 17 }).facade);

  assert.deepEqual(await limitsOf(config), [41, 17]);
});

test("a role the runtime reports no limit for has none, and a limit reported for some other role never stands in for it", async () => {
  assert.deepEqual(await limitsOf(compose(() => reporting({ author: 41 }).facade)), [41, undefined]);
  assert.deepEqual(await limitsOf(compose(() => reporting({ chat: 5, maintainer: 6, explore: 7 }).facade)), [undefined, undefined]);
});

test("ONE read of the run's directory serves every role and every prompt, however they ask", async () => {
  const { facade, reads } = reporting({ author: 41, reviewer: 17 });
  const config = compose(() => facade);

  await limitsOf(config);
  await limitsOf(config);
  await Promise.all([limitOf(config, "author"), limitOf(config, "author"), limitOf(config, "reviewer")]);

  assert.deepEqual(reads, [config.mirrorDir]);
});

test("nothing is read until a prompt asks: a run that never prompts never touches the runtime", async () => {
  let resolved = 0;
  const { facade, reads } = reporting({ author: 41 });
  const config = compose(() => {
    resolved += 1;
    return facade;
  });
  await flush();

  assert.deepEqual([resolved, reads.length], [0, 0]);
  await limitOf(config, "author");
  assert.deepEqual([resolved, reads.length], [1, 1], "the first ask resolves the facade once and reads once");
  await limitsOf(config);
  assert.deepEqual([resolved, reads.length], [1, 1], "later asks reuse both");
});

test("the facade is resolved for each run: a runtime switched between runs gives each run the limit of the runtime it runs on", async () => {
  const first = reporting({ author: 40 });
  const second = reporting({ author: 25 });
  let current = first;
  const getAgentFacade = () => current.facade;

  const firstRun = compose(getAgentFacade);
  assert.equal(await limitOf(firstRun, "author"), 40);
  current = second;
  const secondRun = compose(getAgentFacade);
  assert.equal(await limitOf(secondRun, "author"), 25);

  assert.equal(first.reads.length, 1);
  assert.equal(second.reads.length, 1);
});

test("a read inside STEP_LIMIT_READ_TIMEOUT_MS is used and warns nothing", async (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  let answer: ((limits: StepLimits) => void) | undefined;
  const { facade } = facadeAnswering(() => new Promise<StepLimits>((resolve) => { answer = resolve; }));
  const config = compose(() => facade);
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const asks = limitsOf(config);
  await flush();
  t.mock.timers.tick(STEP_LIMIT_READ_TIMEOUT_MS - 1);
  assert.ok(answer, "the read was started by the first ask");
  answer({ author: 41, reviewer: 17 });

  assert.deepEqual(await asks, [41, 17]);
  assert.equal(warn.mock.callCount(), 0);
});

test("a read that outlasts STEP_LIMIT_READ_TIMEOUT_MS gives every role no limit and one warning naming the directory and the deadline; a late answer never revives it", async (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  let answer: ((limits: StepLimits) => void) | undefined;
  const { facade, reads } = facadeAnswering(() => new Promise<StepLimits>((resolve) => { answer = resolve; }));
  const config = compose(() => facade);
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const asks = limitsOf(config);
  await flush();
  t.mock.timers.tick(STEP_LIMIT_READ_TIMEOUT_MS);

  assert.deepEqual(await asks, [undefined, undefined]);
  assert.equal(warn.mock.callCount(), 1);
  const warning = String(warn.mock.calls[0]?.arguments[0]);
  assert.ok(warning.includes(config.mirrorDir), "the warning names the directory that was read");
  assert.ok(warning.includes(String(STEP_LIMIT_READ_TIMEOUT_MS)), "the warning names the deadline that passed");

  assert.ok(answer);
  answer({ author: 41, reviewer: 17 });
  await flush();
  assert.deepEqual(await limitsOf(config), [undefined, undefined]);
  assert.equal(reads.length, 1, "a later ask does not read again");
  assert.equal(warn.mock.callCount(), 1, "a later ask does not warn again");
});

test("a read that fails gives every role no limit and one warning carrying the failure, whatever was thrown; later asks neither read nor warn again", async (t) => {
  const failures = [
    { thrown: new Error("agent list unreachable-sentinel"), carried: "agent list unreachable-sentinel" },
    { thrown: "plain-value-sentinel", carried: "plain-value-sentinel" },
  ];
  for (const { thrown, carried } of failures) {
    const warn = t.mock.method(console, "warn", () => undefined);
    const { facade, reads } = facadeAnswering(async () => {
      throw thrown;
    });
    const config = compose(() => facade);

    assert.deepEqual(await limitsOf(config), [undefined, undefined]);
    assert.deepEqual(await limitsOf(config), [undefined, undefined]);

    assert.equal(warn.mock.callCount(), 1);
    const warning = String(warn.mock.calls[0]?.arguments[0]);
    assert.ok(warning.includes(carried), "the warning carries the failure");
    assert.ok(warning.includes(config.mirrorDir), "the warning names the directory that was read");
    assert.equal(reads.length, 1);
    warn.mock.restore();
  }
});

test("a host that cannot resolve a facade gives every role no limit and one warning, and does not fail the run", async (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  const config = compose(() => {
    throw new Error("runtime switching-sentinel");
  });

  assert.deepEqual(await limitsOf(config), [undefined, undefined]);

  assert.equal(warn.mock.callCount(), 1);
  assert.ok(String(warn.mock.calls[0]?.arguments[0]).includes("switching-sentinel"));
});

test("the baked config copy is never the source: a runtime that reports no limit gives none, and a live limit beats the file's", async () => {
  const baked = maxStepsFromConfig(AGENT_NAME_FOR_ROLE.author);
  assert.equal(typeof baked, "number", "the baked agents/opencode.json declares a limit for the generator, so a silent fallback to it would show");
  const live = (baked as number) + 1;

  assert.deepEqual(await limitsOf(compose(() => reporting({}).facade)), [undefined, undefined]);
  assert.equal(await limitOf(compose(() => reporting({ author: live }).facade), "author"), live);
});

test("a number that is not a positive whole step count is no limit, however the runtime came to report it", async () => {
  for (const notALimit of [0, -3, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const config = compose(() => reporting({ author: notALimit, reviewer: notALimit }).facade);
    assert.deepEqual(await limitsOf(config), [undefined, undefined], `${notALimit} must not reach a prompt as a limit`);
  }
  assert.deepEqual(await limitsOf(compose(() => reporting({ author: 1, reviewer: 1 }).facade)), [1, 1], "the smallest whole count is a limit");
});

test("a host that wires no facade composes no resolver: absence means no prompt states a limit, never a stand-in", () => {
  const config = compose();

  assert.equal("stepLimitFor" in config, false);
});

/* A facade whose roles run on two models: the primary tier (lead, author) and the reviewer. */
function facadeWithWindows(windows: () => Promise<Record<string, number>>, limits: StepLimits = { author: 41, lead: 12 }): AgentFacade {
  const { facade } = reporting(limits);
  facade.config = { assignments: { primary: { provider: "opencode", model: "p/primary-model" }, reviewer: { provider: "opencode", model: "p/reviewer-model" }, chat: ASSIGNMENT } };
  facade.modelWindows = windows;
  return facade;
}

test("the run's one read of its runtime also installs the window of each role's model in the run's own context budget", async () => {
  const facade = facadeWithWindows(async () => ({ "p/primary-model": 500_000, "p/reviewer-model": 200_000 }));
  const config = compose(() => facade);
  assert.ok(config.contextBudget, "a host that wires a facade composes a context budget");
  assert.equal(config.contextBudget.windowTokens("author"), undefined, "nothing is known before a prompt asks");

  await limitOf(config, "author");

  assert.equal(config.contextBudget.windowTokens("author"), 500_000);
  assert.equal(config.contextBudget.windowTokens("lead"), 500_000, "the lead runs on the primary tier");
  assert.equal(config.contextBudget.windowTokens("reviewer"), 200_000);
  assert.equal(config.contextBudget.windowTokens("author", "primary-model"), 500_000, "a model the caller picked, named without its provider, is found under the role's provider");
  assert.equal(config.contextBudget.windowTokens("author", "p/reviewer-model"), 200_000);
});

test("two runs read their own windows: a later run's read never changes an earlier run's budget", async () => {
  const first = compose(() => facadeWithWindows(async () => ({ "p/primary-model": 100_000 })));
  const second = compose(() => facadeWithWindows(async () => ({ "p/primary-model": 900_000 })));

  await limitOf(first, "author");
  await limitOf(second, "author");

  assert.equal(first.contextBudget!.windowTokens("lead"), 100_000);
  assert.equal(second.contextBudget!.windowTokens("lead"), 900_000);
});

test("a window read that fails leaves every window unknown, never an invented one, and still answers the step limits", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const config = compose(() => facadeWithWindows(async () => { throw new Error("providers unreachable"); }));

  assert.equal(await limitOf(config, "author"), 41);
  assert.equal(config.contextBudget!.windowTokens("author"), undefined);
  assert.equal(config.contextBudget!.fit({ prompt: { tokens: 1 }, role: "author" }).outcome, "unknown");
});

test("a model the runtime reports no window for has an unknown window", async () => {
  const config = compose(() => facadeWithWindows(async () => ({ "p/primary-model": 0, "p/other": 10 })));

  await limitOf(config, "author");

  assert.equal(config.contextBudget!.windowTokens("author"), undefined, "a zero window is no window");
  assert.equal(config.contextBudget!.windowTokens("reviewer"), undefined);
});

test("with no recorded turns the working room starts cold from the role's live step limit", async () => {
  const config = compose(() => facadeWithWindows(async () => ({ "p/primary-model": 1_000_000 }), { author: 41, lead: 12 }));

  await limitOf(config, "author");

  const fit = config.contextBudget!.fit({ prompt: { tokens: 1_000 }, role: "author" });
  assert.equal(fit.roomBasis, "cold-start");
  assert.equal(fit.outcome, "fits");
  assert.equal(config.contextBudget!.fit({ prompt: { tokens: 1_000 }, role: "reviewer" }).outcome, "unknown", "no step limit and no history: the room is unknown");
});
