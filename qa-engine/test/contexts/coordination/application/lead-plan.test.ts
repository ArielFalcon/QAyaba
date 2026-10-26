import { test } from "node:test";
import assert from "node:assert/strict";
import {
  admitLeadPlan,
  LEAD_PLAN_KIND,
  PLAN_DOWNGRADE,
  type AdmittedFlow,
  type AdmittedPlan,
  type PlanDeps,
  type PlanLimits,
} from "@contexts/coordination/application/lead-plan.ts";

const deps: PlanDeps = {
  specRelDir: "e2e",
  specFileFor: (id) => `flows/${id}.spec.ts`,
};

const limits: PlanLimits = {
  maxFlows: 6,
  maxParallel: 3,
  flowBudgetMs: 10 * 60_000,
  remainingMs: 60 * 60_000,
  reserveMs: 10 * 60_000,
  minFlowMs: 60_000,
  runSpecCalls: 8,
  runSpecDevWrites: 20,
  browserCalls: 150,
};

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
    assert.equal(plan.kind, LEAD_PLAN_KIND.LEAD);
    assert.equal(plan.kind === LEAD_PLAN_KIND.LEAD ? plan.downgrade : undefined, PLAN_DOWNGRADE.MALFORMED);
  }
});

test("a plan the lead authors itself is admitted as it is, with nothing to report", () => {
  const plan = admitLeadPlan({ kind: "lead" }, limits, deps);
  assert.deepEqual(plan, { kind: LEAD_PLAN_KIND.LEAD });
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
  assert.equal(dup.kind, LEAD_PLAN_KIND.LEAD);
  assert.equal(dup.kind === LEAD_PLAN_KIND.LEAD ? dup.downgrade : undefined, PLAN_DOWNGRADE.DUPLICATE);
});

test("more flows than the cap, no flows, a lone flow and an unreadable plan all go back to the lead, each with its reason", () => {
  const cases: Array<[string, unknown, string]> = [
    ["over the cap", fanout(...Array.from({ length: limits.maxFlows + 1 }, (_, i) => flow(`f${i}`))), PLAN_DOWNGRADE.OVER_LIMIT],
    ["no flows", fanout(), PLAN_DOWNGRADE.EMPTY],
    ["one flow", fanout(flow("only")), PLAN_DOWNGRADE.ONE_FLOW],
    ["a flow that is not an object", fanout(flow("a"), "b"), PLAN_DOWNGRADE.MALFORMED],
    ["a flow with no objective", fanout(flow("a"), { id: "b", objective: "  " }), PLAN_DOWNGRADE.MALFORMED],
    ["flows that are not a list", { kind: "fanout", flows: "a,b" }, PLAN_DOWNGRADE.MALFORMED],
    ["an unknown kind", { kind: "swarm" }, PLAN_DOWNGRADE.MALFORMED],
    ["a plan that is not an object", "fanout", PLAN_DOWNGRADE.MALFORMED],
    ["no plan at all", undefined, PLAN_DOWNGRADE.NO_PLAN],
  ];
  for (const [name, raw, reason] of cases) {
    const plan = admitLeadPlan(raw, limits, deps);
    assert.equal(plan.kind, LEAD_PLAN_KIND.LEAD, name);
    assert.equal(plan.kind === LEAD_PLAN_KIND.LEAD ? plan.downgrade : undefined, reason, name);
  }
});

test("the plan may use exactly the flows the cap allows", () => {
  const flows = admitted(admitLeadPlan(fanout(...Array.from({ length: limits.maxFlows }, (_, i) => flow(`f${i}`))), limits, deps));
  assert.equal(flows.length, limits.maxFlows);
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
  /* 6 flows, 3 parallel: two waves, so half of it each. */
  const waves = admitted(admitLeadPlan(fanout(...Array.from({ length: 6 }, (_, i) => flow(`f${i}`))), { ...limits, remainingMs: 16 * 60_000 }, deps));
  assert.ok(waves.every((f) => f.budgetMs === 3 * 60_000));
});

test("a run with no deadline gives each flow the full time a flow may take", () => {
  const { remainingMs: _, ...noDeadline } = limits;
  const flows = admitted(admitLeadPlan(fanout(flow("a"), flow("b")), noDeadline, deps));
  assert.ok(flows.every((f) => f.budgetMs === limits.flowBudgetMs));
});

test("when the run has too little time left for a flow to do anything, the lead does the work", () => {
  const plan = admitLeadPlan(fanout(flow("a"), flow("b"), flow("c")), { ...limits, remainingMs: limits.reserveMs + limits.minFlowMs / 2 }, deps);
  assert.equal(plan.kind, LEAD_PLAN_KIND.LEAD);
  assert.equal(plan.kind === LEAD_PLAN_KIND.LEAD ? plan.downgrade : undefined, PLAN_DOWNGRADE.NO_TIME);
});

test("the run's tool calls are shared out among the flows, and a flow gets none it was not given", () => {
  const flows = admitted(admitLeadPlan(fanout(flow("a"), flow("b"), flow("c")), limits, deps));
  assert.ok(flows.every((f) => f.runSpecCalls === Math.floor(limits.runSpecCalls! / 3)));
  assert.ok(flows.every((f) => f.runSpecDevWrites === Math.floor(limits.runSpecDevWrites! / 3)));
  assert.ok(flows.every((f) => f.browserCalls === Math.floor(limits.browserCalls! / 3)));
  assert.ok(flows.length * flows[0]!.runSpecCalls <= limits.runSpecCalls!, "the shares never add up to more than the run's");
});

test("a run that was not granted run_spec or the browser gives its flows none", () => {
  const { runSpecCalls: _a, runSpecDevWrites: _b, browserCalls: _c, ...bare } = limits;
  const flows = admitted(admitLeadPlan(fanout(flow("a"), flow("b")), bare, deps));
  assert.ok(flows.every((f) => f.runSpecCalls === 0 && f.runSpecDevWrites === 0 && f.browserCalls === 0));
});

test("when run_spec cannot give every flow a call, the lead does the work", () => {
  const plan = admitLeadPlan(fanout(...Array.from({ length: 5 }, (_, i) => flow(`f${i}`))), { ...limits, runSpecCalls: 3 }, deps);
  assert.equal(plan.kind, LEAD_PLAN_KIND.LEAD);
  assert.equal(plan.kind === LEAD_PLAN_KIND.LEAD ? plan.downgrade : undefined, PLAN_DOWNGRADE.NO_CALLS);
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
