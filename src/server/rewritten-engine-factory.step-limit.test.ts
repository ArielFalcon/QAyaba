/*
 * The step limit of each role reaches the engine through ONE per-run memo over the live runtime's facade:
 * a single read of the run's directory serves every role and every prompt, a read that fails or outlasts
 * its deadline leaves every role without a limit (one warning, never the baked config copy), and the
 * facade is the one the host resolves for THIS run (the runtime is switchable). Sibling of
 * rewritten-engine-factory.test.ts so the `step-limit` mutation preset runs only these tests per mutant.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRewrittenCompositionConfig, STEP_LIMIT_READ_TIMEOUT_MS, type RewrittenEngineFactoryDeps } from "./rewritten-engine-factory";
import { maxStepsFromConfig, type AgentDeps } from "../integrations/opencode-client";
import { AGENT_NAME_FOR_ROLE, type AgentFacade, type StepLimits } from "../agent-runtime/types";
import type { AppConfig } from "../orchestrator/config-loader";
import type { CompositionConfig } from "@contexts/qa-run-orchestration/composition/composition-root";
import type { StepLimitRole } from "@contexts/generation/application/ports/generation-ports";

const APP: AppConfig = {
  name: "step-limit-app",
  repo: "org/demo",
  dev: { baseUrl: "https://dev" },
  qa: { needsReview: true, testDataPrefix: "qa-bot", shadow: true, explorer: true },
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
    config: { mode: "single", singleProvider: "opencode", assignments: { primary: ASSIGNMENT, reviewer: ASSIGNMENT, chat: ASSIGNMENT } },
    deps: unusableAgentDeps,
    getStatus: async () => ({ mode: "single", providers: [] }),
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
function compose(getAgentFacade?: RewrittenEngineFactoryDeps["getAgentFacade"]): CompositionConfig {
  return buildRewrittenCompositionConfig(
    APP,
    { getAgentDeps: unusableAgentDeps, ...(getAgentFacade ? { getAgentFacade } : {}) },
    "qa-bot-abc1234-run1",
    { mode: "diff" },
  );
}

function limitOf(config: CompositionConfig, role: StepLimitRole): Promise<number | undefined> {
  assert.ok(config.stepLimitFor, "a host that wires a facade composes a step-limit resolver");
  return config.stepLimitFor(role);
}

const ROLES: readonly StepLimitRole[] = ["generator", "reviewer", "explorer"];
const limitsOf = (config: CompositionConfig): Promise<Array<number | undefined>> => Promise.all(ROLES.map((role) => limitOf(config, role)));

/* Lets every promise callback already queued run, with timers (mocked or not) left alone. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("each role's limit is the one the live runtime reports for its own role, and the generator's is the primary role's", async () => {
  const config = compose(() => reporting({ primary: 41, reviewer: 17, explorer: 9 }).facade);

  assert.deepEqual(await limitsOf(config), [41, 17, 9]);
});

test("a role the runtime reports no limit for has none, and a limit reported for some other role never stands in for it", async () => {
  assert.deepEqual(await limitsOf(compose(() => reporting({ primary: 41 }).facade)), [41, undefined, undefined]);
  assert.deepEqual(await limitsOf(compose(() => reporting({ chat: 5, worker: 6, sidekick: 7 }).facade)), [undefined, undefined, undefined]);
});

test("ONE read of the run's directory serves every role and every prompt, however they ask", async () => {
  const { facade, reads } = reporting({ primary: 41, reviewer: 17, explorer: 9 });
  const config = compose(() => facade);

  await limitsOf(config);
  await limitsOf(config);
  await Promise.all([limitOf(config, "generator"), limitOf(config, "generator"), limitOf(config, "reviewer")]);

  assert.deepEqual(reads, [config.mirrorDir]);
});

test("nothing is read until a prompt asks: a run that never prompts never touches the runtime", async () => {
  let resolved = 0;
  const { facade, reads } = reporting({ primary: 41 });
  const config = compose(() => {
    resolved += 1;
    return facade;
  });
  await flush();

  assert.deepEqual([resolved, reads.length], [0, 0]);
  await limitOf(config, "generator");
  assert.deepEqual([resolved, reads.length], [1, 1], "the first ask resolves the facade once and reads once");
  await limitsOf(config);
  assert.deepEqual([resolved, reads.length], [1, 1], "later asks reuse both");
});

test("the facade is resolved for each run: a runtime switched between runs gives each run the limit of the runtime it runs on", async () => {
  const first = reporting({ primary: 40 });
  const second = reporting({ primary: 25 });
  let current = first;
  const getAgentFacade = () => current.facade;

  const firstRun = compose(getAgentFacade);
  assert.equal(await limitOf(firstRun, "generator"), 40);
  current = second;
  const secondRun = compose(getAgentFacade);
  assert.equal(await limitOf(secondRun, "generator"), 25);

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
  answer({ primary: 41, reviewer: 17, explorer: 9 });

  assert.deepEqual(await asks, [41, 17, 9]);
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

  assert.deepEqual(await asks, [undefined, undefined, undefined]);
  assert.equal(warn.mock.callCount(), 1);
  const warning = String(warn.mock.calls[0]?.arguments[0]);
  assert.ok(warning.includes(config.mirrorDir), "the warning names the directory that was read");
  assert.ok(warning.includes(String(STEP_LIMIT_READ_TIMEOUT_MS)), "the warning names the deadline that passed");

  assert.ok(answer);
  answer({ primary: 41, reviewer: 17, explorer: 9 });
  await flush();
  assert.deepEqual(await limitsOf(config), [undefined, undefined, undefined]);
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

    assert.deepEqual(await limitsOf(config), [undefined, undefined, undefined]);
    assert.deepEqual(await limitsOf(config), [undefined, undefined, undefined]);

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

  assert.deepEqual(await limitsOf(config), [undefined, undefined, undefined]);

  assert.equal(warn.mock.callCount(), 1);
  assert.ok(String(warn.mock.calls[0]?.arguments[0]).includes("switching-sentinel"));
});

test("the baked config copy is never the source: a runtime that reports no limit gives none, and a live limit beats the file's", async () => {
  const baked = maxStepsFromConfig(AGENT_NAME_FOR_ROLE.primary);
  assert.equal(typeof baked, "number", "the baked agents/opencode.json declares a limit for the generator, so a silent fallback to it would show");
  const live = (baked as number) + 1;

  assert.deepEqual(await limitsOf(compose(() => reporting({}).facade)), [undefined, undefined, undefined]);
  assert.equal(await limitOf(compose(() => reporting({ primary: live }).facade), "generator"), live);
});

test("a number that is not a positive whole step count is no limit, however the runtime came to report it", async () => {
  for (const notALimit of [0, -3, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const config = compose(() => reporting({ primary: notALimit, reviewer: notALimit, explorer: notALimit }).facade);
    assert.deepEqual(await limitsOf(config), [undefined, undefined, undefined], `${notALimit} must not reach a prompt as a limit`);
  }
  assert.deepEqual(await limitsOf(compose(() => reporting({ primary: 1, reviewer: 1, explorer: 1 }).facade)), [1, 1, 1], "the smallest whole count is a limit");
});

test("a host that wires no facade composes no resolver: absence means no prompt states a limit, never a stand-in", () => {
  const config = compose();

  assert.equal("stepLimitFor" in config, false);
});

test("the explorer asks the same per-run read for its own limit, before it spends a session", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const { facade, reads } = reporting({ primary: 41, reviewer: 17, explorer: 9 });
  const config = compose(() => facade);
  const exploreBrief = config.groundingCollaborators?.exploreBrief;
  assert.ok(exploreBrief, "an app that explores composes the explorer pass");

  await exploreBrief({ specDir: `${config.mirrorDir}/${config.e2eRelDir}`, sha: "abc1234" });
  assert.deepEqual(reads, [config.mirrorDir], "the explorer asked, though its session could not be opened");

  await limitsOf(config);
  assert.equal(reads.length, 1, "the explorer shares the run's one read");
});
