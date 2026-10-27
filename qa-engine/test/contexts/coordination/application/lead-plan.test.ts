import { test } from "node:test";
import assert from "node:assert/strict";
import {
  admitLeadPlan,
  DROP_BASIS,
  MIN_BROWSER_CALLS_PER_FLOW,
  MIN_RUN_SPEC_CALLS_PER_FLOW,
  MIN_RUN_SPEC_DEV_WRITES_PER_FLOW,
  LEAD_PLAN_KIND,
  PLAN_DOWNGRADE,
  PLAN_REJECTED,
  type AdmittedFlow,
  type AdmittedPlan,
  type PlanDeps,
  type PlanLimits,
} from "@contexts/coordination/application/lead-plan.ts";

import { PatternRedactionAdapter } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";

const deps: PlanDeps = {
  redaction: new PatternRedactionAdapter(),
  specRelDir: "e2e",
  specFileFor: (id) => `flows/${id}.spec.ts`,
};

/* 3 at once and (60 - 10) min / 10 min = 5 full waves: room for 15 flows. A flow's 10 min run 5 run_spec calls of 2 min and 20 browser calls of 30 s. */
const limits: PlanLimits = {
  maxParallel: 3,
  flowBudgetMs: 10 * 60_000,
  remainingMs: 60 * 60_000,
  reserveMs: 10 * 60_000,
  minFlowMs: 60_000,
  runSpecPerCallMs: 2 * 60_000,
  runSpecDevWrites: 20,
  browserPerCallMs: 30_000,
};
const RUN_SPEC_BY_TIME = 5;
const BROWSER_BY_TIME = 20;

const flow = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  objective: `check ${id}`,
  acceptance: [`${id} works`],
  routes: [`/${id}`],
  ...extra,
});

const fanout = (...flows: unknown[]) => ({ kind: "fanout", flows });

function admitted(plan: AdmittedPlan): AdmittedFlow[] {
  assert.equal(plan.kind, LEAD_PLAN_KIND.FANOUT, `expected a fan-out, got ${JSON.stringify(plan)}`);
  return plan.kind === LEAD_PLAN_KIND.FANOUT ? plan.flows : [];
}

test("a no-op plan keeps the lead's reason and nothing else", () => {
  const plan = admitLeadPlan({ kind: "noop", reason: "  the change only touches a README  " }, limits, deps);
  assert.deepEqual(plan, { kind: LEAD_PLAN_KIND.NOOP, reason: "the change only touches a README" });
});

test("a no-op plan with no reason is no decision: the lead authors the change itself", () => {
  for (const raw of [{ kind: "noop" }, { kind: "noop", reason: "   " }]) {
    const plan = admitLeadPlan(raw, limits, deps);
    assert.equal(plan.kind, PLAN_REJECTED);
    assert.equal(plan.kind === PLAN_REJECTED ? plan.downgrade : undefined, PLAN_DOWNGRADE.MALFORMED);
  }
});

test("a plan of kind lead is not admitted", () => {
  const plan = admitLeadPlan({ kind: "lead" }, limits, deps);
  assert.deepEqual(plan, { kind: PLAN_REJECTED, downgrade: PLAN_DOWNGRADE.MALFORMED });
});

test("a plan of one flow is admitted as a fan-out of one flow, one at a time", () => {
  const plan = admitLeadPlan(fanout(flow("only")), limits, deps);
  assert.equal(plan.kind, LEAD_PLAN_KIND.FANOUT);
  assert.equal(plan.kind === LEAD_PLAN_KIND.FANOUT ? plan.parallel : undefined, 1);
  const flows = admitted(plan);
  assert.deepEqual(flows.map((f) => f.id), ["only"]);
  assert.deepEqual(flows[0]!.routes, ["/only"]);
  assert.equal(flows[0]!.runSpecCalls, RUN_SPEC_BY_TIME);
  assert.equal(flows[0]!.browserCalls, BROWSER_BY_TIME);
});

test("a fan-out is admitted flow by flow, each with the spec file its slugged id names", () => {
  const flows = admitted(admitLeadPlan(fanout(flow("Checkout Flow"), flow("login")), limits, deps));
  assert.deepEqual(flows.map((f) => f.id), ["checkout-flow", "login"]);
  assert.deepEqual(flows.map((f) => f.writablePaths), [["e2e/flows/checkout-flow.spec.ts"], ["e2e/flows/login.spec.ts"]]);
  assert.deepEqual(flows.map((f) => f.specFile), ["flows/checkout-flow.spec.ts", "flows/login.spec.ts"]);
  assert.equal(flows[0]!.objective, "check Checkout Flow");
  assert.deepEqual(flows[0]!.acceptance, ["Checkout Flow works"]);
  assert.deepEqual(flows[0]!.routes, [], "a route with a space is not a path");
});

test("what a flow may write is decided from its id alone, whatever paths or tags the plan claims", () => {
  const flows = admitted(
    admitLeadPlan(
      fanout(
        flow("a", { writablePaths: ["../../etc/passwd", "."], readablePaths: ["/"], mutates: false, readOnly: true, scope: "everything" }),
        flow("b", { mutates: true, writable: "e2e/auth.setup.ts" }),
      ),
      limits,
      deps,
    ),
  );
  assert.deepEqual(flows.map((f) => f.writablePaths), [["e2e/flows/a.spec.ts"], ["e2e/flows/b.spec.ts"]]);
  for (const admittedFlow of flows) {
    assert.equal("mutates" in admittedFlow, false, "an agent's tag about writing decides nothing");
    assert.equal("readOnly" in admittedFlow, false);
  }
});

test("an id that slugs to nothing still names a file, and two flows that slug alike are a duplicate", () => {
  const unnamed = admitted(admitLeadPlan(fanout(flow("???"), flow("ok")), limits, deps));
  assert.match(unnamed[0]!.id, /^[a-z0-9-]+$/);
  const dup = admitLeadPlan(fanout(flow("Log In"), flow("log-in")), limits, deps);
  assert.equal(dup.kind, PLAN_REJECTED);
  assert.equal(dup.kind === PLAN_REJECTED ? dup.downgrade : undefined, PLAN_DOWNGRADE.DUPLICATE);
});

test("no flows and an unreadable plan go back to the lead, each with its reason", () => {
  const cases: Array<[string, unknown, string]> = [
    ["no flows", fanout(), PLAN_DOWNGRADE.EMPTY],
    ["a flow that is not an object", fanout(flow("a"), "b"), PLAN_DOWNGRADE.MALFORMED],
    ["a flow with no objective", fanout(flow("a"), { id: "b", objective: "  " }), PLAN_DOWNGRADE.MALFORMED],
    ["flows that are not a list", { kind: "fanout", flows: "a,b" }, PLAN_DOWNGRADE.MALFORMED],
    ["an unknown kind", { kind: "swarm" }, PLAN_DOWNGRADE.MALFORMED],
    ["a plan that is not an object", "fanout", PLAN_DOWNGRADE.MALFORMED],
    ["no plan at all", undefined, PLAN_DOWNGRADE.NO_PLAN],
  ];
  for (const [name, raw, reason] of cases) {
    const plan = admitLeadPlan(raw, limits, deps);
    assert.equal(plan.kind, PLAN_REJECTED, name);
    assert.equal(plan.kind === PLAN_REJECTED ? plan.downgrade : undefined, reason, name);
  }
});

test("the run's capacity is the flows that run at once times the full flow budgets that fit in what is left after the reserve", () => {
  const plan = admitLeadPlan(fanout(flow("a")), limits, deps);
  assert.equal(plan.kind === LEAD_PLAN_KIND.FANOUT ? plan.capacity : undefined, 15);
  /* 16 min left, 10 kept: 6 min is under one full flow budget but enough for a flow to work, so one wave. */
  const tight = admitLeadPlan(fanout(flow("a")), { ...limits, remainingMs: 16 * 60_000 }, deps);
  assert.equal(tight.kind === LEAD_PLAN_KIND.FANOUT ? tight.capacity : undefined, 3);
  const { remainingMs: _, ...noDeadline } = limits;
  const unbounded = admitLeadPlan(fanout(flow("a")), noDeadline, deps);
  assert.equal(unbounded.kind === LEAD_PLAN_KIND.FANOUT ? unbounded.capacity : "absent", undefined, "no deadline and no ceiling bound nothing");
});

test("a plan over the run's capacity is never rejected: its first flows are admitted in plan order and the rest are named as not admitted", () => {
  const plan = admitLeadPlan(fanout(...Array.from({ length: 5 }, (_, i) => flow(`f${i}`, { candidates: [`uc-${i}`] }))), { ...limits, remainingMs: 16 * 60_000 }, deps);
  assert.deepEqual(admitted(plan).map((f) => f.id), ["f0", "f1", "f2"]);
  assert.deepEqual(plan.kind === LEAD_PLAN_KIND.FANOUT ? plan.notAdmitted : undefined, [
    { id: "f3", objective: "check f3", candidates: ["uc-3"] },
    { id: "f4", objective: "check f4", candidates: ["uc-4"] },
  ]);
});

test("an app's ceiling bounds the capacity below what the time allows, and a plan within it names nothing not admitted", () => {
  const plan = admitLeadPlan(fanout(flow("a"), flow("b"), flow("c")), { ...limits, ceiling: 2 }, deps);
  assert.deepEqual(admitted(plan).map((f) => f.id), ["a", "b"]);
  assert.equal(plan.kind === LEAD_PLAN_KIND.FANOUT ? plan.capacity : undefined, 2);
  assert.deepEqual(plan.kind === LEAD_PLAN_KIND.FANOUT ? plan.notAdmitted.map((f) => f.id) : undefined, ["c"]);
  const within = admitLeadPlan(fanout(...Array.from({ length: 15 }, (_, i) => flow(`f${i}`))), limits, deps);
  assert.equal(admitted(within).length, 15);
  assert.deepEqual(within.kind === LEAD_PLAN_KIND.FANOUT ? within.notAdmitted : undefined, []);
});

test("text the plan carries is cleaned and bounded, and routes are paths or nothing", () => {
  const long = "x".repeat(5_000);
  const flows = admitted(
    admitLeadPlan(
      fanout(
        flow("a", { objective: long, acceptance: [long, "", 7, "ok"], routes: ["/ok", "https://evil.example/x", "no-slash", "/a b", "/" + long] }),
        flow("b"),
      ),
      limits,
      deps,
    ),
  );
  const first = flows[0]!;
  assert.ok(first.objective.length < 1_000, "the objective is cut");
  assert.ok(first.acceptance.every((line) => line.length < 1_000 && line.trim() !== ""), "an acceptance line is text and bounded");
  assert.ok(first.acceptance.includes("ok"));
  assert.deepEqual(first.routes, ["/ok"], "only a site-relative path is a route");
});

test("a secret in the plan's text is taken out before the sidekick reads it", () => {
  const secret = "AKIAIOSFODNN7EXAMPLE";
  const flows = admitted(admitLeadPlan(fanout(flow("a", { objective: `log in with key ${secret}` }), flow("b")), limits, deps));
  assert.doesNotMatch(flows[0]!.objective, new RegExp(secret));
});

test("the lists of a flow are capped", () => {
  const flows = admitted(
    admitLeadPlan(
      fanout(
        flow("a", { acceptance: Array.from({ length: 40 }, (_, i) => `criterion ${i}`), routes: Array.from({ length: 40 }, (_, i) => `/r${i}`) }),
        flow("b"),
      ),
      limits,
      deps,
    ),
  );
  assert.ok(flows[0]!.acceptance.length <= 12);
  assert.ok(flows[0]!.routes.length <= 12);
});

test("each flow's time is its share of what is left of the run after the reserve, never more than a flow may take", () => {
  /* 3 parallel, 6 flows: two waves. (60 - 10) min / 2 = 25 min, over the 10 min a flow may take. */
  const roomy = admitted(admitLeadPlan(fanout(...Array.from({ length: 6 }, (_, i) => flow(`f${i}`))), limits, deps));
  assert.ok(roomy.every((f) => f.budgetMs === limits.flowBudgetMs));
  /* 3 flows, 3 parallel: one wave. 6 min left after the reserve is under a flow's 10. */
  const tight = admitted(admitLeadPlan(fanout(flow("a"), flow("b"), flow("c")), { ...limits, remainingMs: 16 * 60_000 }, deps));
  assert.ok(tight.every((f) => f.budgetMs === 6 * 60_000));
});

test("a run with no deadline gives each flow the full time a flow may take", () => {
  const { remainingMs: _, ...noDeadline } = limits;
  const flows = admitted(admitLeadPlan(fanout(flow("a"), flow("b")), noDeadline, deps));
  assert.ok(flows.every((f) => f.budgetMs === limits.flowBudgetMs));
});

test("when the run has too little time left for a flow to do anything, the lead does the work", () => {
  const plan = admitLeadPlan(fanout(flow("a"), flow("b"), flow("c")), { ...limits, remainingMs: limits.reserveMs + limits.minFlowMs / 2 }, deps);
  assert.equal(plan.kind, PLAN_REJECTED);
  assert.equal(plan.kind === PLAN_REJECTED ? plan.downgrade : undefined, PLAN_DOWNGRADE.NO_TIME);
});

test("without an app ceiling, each flow is granted the calls its own time can run, however many flows the plan holds", () => {
  for (const count of [1, 2, 12]) {
    const flows = admitted(admitLeadPlan(fanout(...Array.from({ length: count }, (_, i) => flow(`f${i}`))), limits, deps));
    assert.equal(flows.length, count);
    assert.ok(flows.every((f) => f.runSpecCalls === RUN_SPEC_BY_TIME && f.browserCalls === BROWSER_BY_TIME), `${count} flow(s)`);
  }
  /* 10 min a flow, 4 min a run_spec call and 2 min a browser call: 2 and 5 calls fit. */
  const timed = admitted(admitLeadPlan(fanout(flow("a")), { ...limits, runSpecPerCallMs: 4 * 60_000, browserPerCallMs: 2 * 60_000 }, deps));
  assert.deepEqual([timed[0]!.runSpecCalls, timed[0]!.browserCalls], [2, 5]);
});

test("with an app ceiling on the run's calls, the flows share it, never under the useful minimum the ceiling allows nor over their own time", () => {
  const capped = { ...limits, runSpecCallsCeiling: 8, browserCallsCeiling: 150 };
  const few = admitted(admitLeadPlan(fanout(flow("a"), flow("b")), capped, deps));
  assert.ok(few.every((f) => f.runSpecCalls === Math.min(RUN_SPEC_BY_TIME, 8 / 2) && f.browserCalls === BROWSER_BY_TIME));
  /* 12 flows: 8 run_spec calls and 150 browser calls would split to 0 and 12 a flow. */
  const many = admitted(admitLeadPlan(fanout(...Array.from({ length: 12 }, (_, i) => flow(`f${i}`))), capped, deps));
  assert.ok(many.every((f) => f.runSpecCalls === MIN_RUN_SPEC_CALLS_PER_FLOW && f.browserCalls === Math.min(BROWSER_BY_TIME, MIN_BROWSER_CALLS_PER_FLOW)));
  const stingy = admitted(admitLeadPlan(fanout(...Array.from({ length: 4 }, (_, i) => flow(`f${i}`))), { ...limits, runSpecCallsCeiling: 1, browserCallsCeiling: 2 }, deps));
  assert.ok(stingy.every((f) => f.runSpecCalls === 1 && f.browserCalls === 2), "a minimum is never above the app's ceiling");
});

test("the flows' DEV writes never promise more than the run's DEV-write cap together: later flows get what is left, possibly none", () => {
  const writesOf = (count: number, cap: number) => admitted(admitLeadPlan(fanout(...Array.from({ length: count }, (_, i) => flow(`f${i}`))), { ...limits, runSpecDevWrites: cap }, deps)).map((f) => f.runSpecDevWrites);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  assert.deepEqual(writesOf(2, 20), [10, 10], "a share each while the cap allows it");
  /* 12 flows x the minimum of 2 is 24, more than 20: the first ten get their minimum and the last two get none. */
  const many = writesOf(12, 20);
  assert.equal(sum(many), 20);
  assert.deepEqual(many, [...Array.from({ length: 10 }, () => MIN_RUN_SPEC_DEV_WRITES_PER_FLOW), 0, 0]);
  assert.deepEqual(writesOf(4, 1), [1, 0, 0, 0]);
  assert.deepEqual(writesOf(4, 0), [0, 0, 0, 0]);
});

test("a run that was not granted run_spec or the browser gives its flows none", () => {
  const { runSpecPerCallMs: _a, runSpecDevWrites: _b, browserPerCallMs: _c, ...bare } = limits;
  const flows = admitted(admitLeadPlan(fanout(flow("a"), flow("b")), bare, deps));
  assert.ok(flows.every((f) => f.runSpecCalls === 0 && f.runSpecDevWrites === 0 && f.browserCalls === 0));
});

test("no more flows run at once than the parallel limit or the flows themselves", () => {
  const two = admitLeadPlan(fanout(flow("a"), flow("b")), limits, deps);
  assert.equal(two.kind === LEAD_PLAN_KIND.FANOUT ? two.parallel : undefined, 2);
  const six = admitLeadPlan(fanout(...Array.from({ length: 6 }, (_, i) => flow(`f${i}`))), limits, deps);
  assert.equal(six.kind === LEAD_PLAN_KIND.FANOUT ? six.parallel : undefined, limits.maxParallel);
});

test("a route that holds a placeholder for a value is kept with that segment as a parameter, instead of dropped", () => {
  const flows = admitted(admitLeadPlan(fanout(flow("a", { routes: ["/shops/madrid/qa-bot-<run>-missing", "/shops/{city}/menu", "/a b"] }), flow("b")), limits, deps));
  assert.deepEqual(flows[0]!.routes, ["/shops/madrid/:value", "/shops/:value/menu"]);
});

test("a flow that names no route visits the paths its objective and acceptance name", () => {
  const flows = admitted(
    admitLeadPlan(
      fanout(
        flow("a", { routes: [], objective: "the detail of a missing shop (e.g. /shops/madrid/x) explains it", acceptance: ["opening /shops/madrid/qa-bot-<run>-missing/menu shows the empty state", "its button lands on /search.", "see e2e/flows/a.spec.ts and https://dev.example/abs"] }),
        flow("b", { routes: ["/b"], acceptance: ["also /elsewhere"] }),
      ),
      limits,
      deps,
    ),
  );
  assert.deepEqual(flows[0]!.routes, ["/shops/madrid/x", "/shops/madrid/:value/menu", "/search"]);
  assert.deepEqual(flows[1]!.routes, ["/b"], "a flow that named its routes keeps exactly those");
});

test("a flow keeps the candidate ids it cites and the plan keeps the candidates it drops with a reason", () => {
  const plan = admitLeadPlan({ kind: "fanout", flows: [flow("cart", { candidates: ["uc-1a2b3c4d", "uc-1a2b3c4d", 7, "  "] })], dropped: [{ candidate: "uc-deadbeef", basis: "no-observable-change", reason: " only a log line changed " }] }, limits, deps);
  assert.deepEqual(admitted(plan)[0]!.candidates, ["uc-1a2b3c4d"]);
  assert.deepEqual(plan.kind === LEAD_PLAN_KIND.FANOUT ? plan.dropped : undefined, [{ candidate: "uc-deadbeef", basis: DROP_BASIS.NO_OBSERVABLE_CHANGE, reason: "only a log line changed" }]);
});

test("a drop without a reason, a candidate or a basis of the closed set is not a drop", () => {
  const basis = DROP_BASIS.ALREADY_COVERED;
  const plan = admitLeadPlan({ kind: "fanout", flows: [flow("cart")], dropped: [{ candidate: "uc-1", basis, reason: "" }, { candidate: "uc-2", basis }, { basis, reason: "r" }, "uc-3", { candidate: "uc-4", reason: "only a stylesheet changed" }, { candidate: "uc-5", basis: "cosmetic", reason: "r" }] }, limits, deps);
  assert.deepEqual(plan.kind === LEAD_PLAN_KIND.FANOUT ? plan.dropped : undefined, []);
});

test("a plan of no flows whose every use case is dropped carries its drops, so the facts can be held against them", () => {
  const dropped = [{ candidate: "uc-1", basis: DROP_BASIS.NEEDS_UNAVAILABLE_STATE, reason: "needs a card reader" }];
  const plan = admitLeadPlan({ kind: "fanout", flows: [], dropped }, limits, deps);
  assert.deepEqual(plan.kind === LEAD_PLAN_KIND.NOOP ? plan.dropped : undefined, dropped);
  const unbased = admitLeadPlan({ kind: "fanout", flows: [], dropped: [{ candidate: "uc-1", reason: "r" }] }, limits, deps);
  assert.equal(unbased.kind === PLAN_REJECTED ? unbased.downgrade : undefined, PLAN_DOWNGRADE.EMPTY);
});

test("a plan that names no candidates and drops none is admitted as before", () => {
  const plan = admitLeadPlan(fanout(flow("cart")), limits, deps);
  assert.deepEqual(admitted(plan)[0]!.candidates, []);
  assert.deepEqual(plan.kind === LEAD_PLAN_KIND.FANOUT ? plan.dropped : undefined, []);
});
