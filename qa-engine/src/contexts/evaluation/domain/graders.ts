/*
 * The deterministic graders: pure functions from a run's evidence to scores. A grader says nothing when it has no data (a score
 * absent is "not measurable", never a fabricated 0), and never grades a run that has not finished. Definitions follow
 * docs/observability-design.md §11.2; every BOOLEAN is pass-oriented (`true` = the check passed, the problem is absent).
 */

import { RUN_PHASES } from "@contexts/qa-run-orchestration/domain/run-phase-cursor";
import { STEP_INTENTS, scoreOf } from "./grader-catalog.ts";
import { extractReferences } from "./context-refs.ts";
import { itemId } from "@contexts/generation/domain/context-item-ids.ts";
import type { ContextEvidence, RunEvaluationEvidence as Evidence } from "./run-evaluation-evidence.ts";
import type { RawScore, Score } from "./score.ts";

export interface Grader {
  /* The catalog base names this grader emits: what a regrade request names to run only some graders. */
  readonly names: readonly string[];
  grade(evidence: Evidence): RawScore[];
}

const ratio = (part: number, whole: number): number => part / whole;
const rank = (phase: string): number => (RUN_PHASES as readonly string[]).indexOf(phase);

/* The verdicts of a run that executed its specs. */
const EXECUTED_VERDICTS = ["pass", "fail", "flaky"];

/* The run was let through: it passed, or it chose to publish a PR. */
function accepted(e: Evidence): boolean {
  return e.verdict === "pass" || e.decision === "pr";
}

/* A run with no verdict has nothing to grade. */
const finishedOnly = (grade: (e: Evidence) => RawScore[]) => (e: Evidence): RawScore[] => (e.finished && e.verdict !== null ? grade(e) : []);

/*
 * A tripwire over stored facts only. It says nothing when a fact it needs was never recorded (validity before the validate phase,
 * whether a reviewer was required, the reviewer's trace), because a guess would read as a verdict about the pipeline.
 */
const emptyOutputGuard: Grader = {
  names: ["empty_output_guard"],
  grade: finishedOnly((e) => {
    /* A context run delivers no specs by design. */
    if (e.mode === "context") return [];
    if (e.specs.valid === null) return [];
    if (!accepted(e)) return [{ name: "empty_output_guard", value: true }];
    if (e.reviewRequired === undefined) return [];
    const problems: string[] = [];
    if (e.specs.valid === 0) problems.push("accepted with no valid spec delivered by this run");
    if (e.reviewRequired) {
      const reviewed = e.signals?.reviewerApproved !== undefined || (e.reviewerTurns ?? 0) > 0;
      if (!reviewed) {
        /* No verdict stored and no turn history to look in: the review cannot be judged either way. */
        if (e.reviewerTurns === undefined) return [];
        problems.push("accepted without a reviewer turn");
      }
    }
    return [{ name: "empty_output_guard", value: problems.length === 0, ...(problems.length > 0 ? { comment: problems.join("; ") } : {}) }];
  }),
};

const furthestPhase: Grader = {
  names: ["furthest_phase"],
  grade: (e) => (e.finished && e.furthestPhase !== null && (RUN_PHASES as readonly string[]).includes(e.furthestPhase) ? [{ name: "furthest_phase", value: e.furthestPhase }] : []),
};

const specValidityRate: Grader = {
  names: ["spec_validity_rate"],
  grade: (e) => (e.finished && e.specs.valid !== null && e.specs.generated > 0 ? [{ name: "spec_validity_rate", value: ratio(e.specs.valid, e.specs.generated), comment: `${e.specs.valid} of ${e.specs.generated}` }] : []),
};

/* Only a run that executed its specs has a pass rate, and only when every delivered spec could be tied to its cases. */
const specPassRate: Grader = {
  names: ["spec_pass_rate"],
  grade: (e) => {
    const { valid, passed } = e.specs;
    const executed = e.furthestPhase !== null && rank(e.furthestPhase) >= rank("execute") && e.verdict !== null && EXECUTED_VERDICTS.includes(e.verdict);
    if (!e.finished || !executed || valid === null || valid <= 0 || passed === undefined) return [];
    return [{ name: "spec_pass_rate", value: ratio(passed, valid), comment: `${passed} of ${valid}` }];
  },
};

const budgetExhaustion: Grader = {
  names: ["budget_exhaustion"],
  grade: finishedOnly((e) => [{ name: "budget_exhaustion", value: e.limit ? `${e.limit.fired}@${e.furthestPhase ?? "unknown"}/${e.limit.role ?? "unknown"}/${e.limit.intent ?? "unknown"}` : "none" }]),
};

const approvalConsistent: Grader = {
  names: ["approval_consistent"],
  grade: finishedOnly((e) => {
    if (e.mode === "context") return [];
    const said: string[] = [];
    if (e.signals) {
      if (!e.signals.static) said.push("static checks failed");
      if ((e.signals.catalogGateFailClosed ?? 0) > 0) said.push("catalog gate failed closed");
      if (e.signals.coverageMode === "enforce" && e.signals.coverageStatus === "fail") said.push("change-coverage failed under the enforced policy");
    }
    const inconsistent = accepted(e) && said.length > 0;
    return [{ name: "approval_consistent", value: !inconsistent, ...(inconsistent ? { comment: `accepted while: ${said.join("; ")}` } : {}) }];
  }),
};

/* The engine's own decision at run time. `unknown` is a decision the engine recorded; a run that recorded none (an older run) has no score, never a pass. */
const changeCoverage: Grader = {
  names: ["change_coverage"],
  grade: (e) => (e.finished && e.signals?.coverageStatus !== undefined ? [{ name: "change_coverage", value: e.signals.coverageStatus }] : []),
};

const mutationValue: Grader = {
  names: ["mutation_value"],
  grade: (e) => {
    const s = e.signals;
    if (!e.finished || !s || s.mutantCount === undefined || s.killedCount === undefined || s.mutantCount <= 0) return [];
    return [{ name: "mutation_value", value: ratio(s.killedCount, s.mutantCount), comment: `${s.killedCount} of ${s.mutantCount} mutants killed` }];
  },
};

const infraError: Grader = {
  names: ["infra_error"],
  /* Only an infra-error run (or a cancelled one) has an infra error to name; `unclassified` is an infra-error run that recorded no class. */
  grade: finishedOnly((e) => (e.cancelled ? [{ name: "infra_error", value: "cancelled" }] : e.verdict === "infra-error" ? [{ name: "infra_error", value: e.errorClass ?? "unclassified" }] : [])),
};

const stepIntent: Grader = {
  names: ["step_intent_mix", "auth_overhead"],
  grade: (e) => {
    if (!e.finished || !e.stepIntents) return [];
    const counts: Record<string, number> = Object.fromEntries(STEP_INTENTS.map((i) => [i, 0]));
    for (const [intent, n] of Object.entries(e.stepIntents)) {
      const key = (STEP_INTENTS as readonly string[]).includes(intent) ? intent : "other";
      counts[key] = (counts[key] ?? 0) + n;
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total === 0) return [];
    return [
      ...STEP_INTENTS.map((i) => ({ name: `step_intent_mix.${i}`, value: ratio(counts[i] ?? 0, total) })),
      { name: "auth_overhead", value: ratio(counts.auth ?? 0, total), comment: `${counts.auth ?? 0} of ${total} steps` },
    ];
  },
};

/* ---- context: utilization (gross + focused), completeness, freshness, no-op ---- */

/* The delivered ids of one extractable kind, deduplicated in delivery order. */
const deliveredOfKind = (ctx: ContextEvidence, kind: "route" | "dom" | "op"): string[] => {
  const prefix = `${kind}:`;
  const seen = new Set<string>();
  for (const source of ctx.delivered) for (const id of source.ids) if (id.startsWith(prefix)) seen.add(id);
  return [...seen];
};

/* The references the extractor finds over the delivered spec text and the tool targets, bound to the delivered route/op sets. */
const referencedOf = (ctx: ContextEvidence) => {
  return extractReferences({
    specTexts: ctx.snapshots.map((s) => s.text),
    toolTargets: ctx.toolSequence,
    routeTemplates: deliveredOfKind(ctx, "route").map((id) => id.slice("route:".length)),
    opIds: deliveredOfKind(ctx, "op").map((id) => id.slice("op:".length)),
  });
};

/* The relevant route ids grouped by component/page: one group per distinct name, one route per group when no grouping was recorded. */
const routeGroups = (ctx: ContextEvidence): Map<string, string[]> => {
  const ids = ctx.relevantIds.length > 0 ? ctx.relevantIds : deliveredOfKind(ctx, "route");
  const groups = new Map<string, string[]>();
  ids.forEach((id, i) => {
    const group = ctx.relevantGroups[i] ?? id;
    groups.set(group, [...(groups.get(group) ?? []), id]);
  });
  return groups;
};

/* The focused DOM ratio over the changed element's delivered ids on the relevant pages; undefined when no element is identifiable. */
const focusedDomRatio = (ctx: ContextEvidence, refs: ReturnType<typeof referencedOf>): number | undefined => {
  if (ctx.changedTestIds.length === 0) return undefined;
  const relevantTemplates = ctx.relevantIds.map((id) => id.slice("route:".length));
  const candidates = new Set<string>();
  for (const template of relevantTemplates) for (const testId of ctx.changedTestIds) candidates.add(itemId.dom(template, testId));
  const relevant = deliveredOfKind(ctx, "dom").filter((id) => candidates.has(id));
  if (relevant.length === 0) return undefined;
  const referenced = new Set(refs.domIds);
  return ratio(relevant.filter((id) => referenced.has(id)).length, relevant.length);
};

/* The `source:reason:count` losses that make a delivered source incomplete: truncation on a change-relevant item only. */
const completenessLosses = (ctx: ContextEvidence): string[] => {
  const relevantIds = new Set(ctx.relevantIds);
  const relevantPaths = new Set(ctx.relevantIds.map((id) => (id.startsWith("route:") ? id.slice("route:".length) : id)));
  const losses: string[] = [];
  for (const source of ctx.delivered) {
    for (const omission of source.omissions) {
      if (omission.class !== "truncation") continue;
      const section = omission.reason === "section-cap" || omission.reason === "section-shed";
      const relevant = section || (omission.route !== undefined ? relevantPaths.has(omission.route) : source.ids.some((id) => relevantIds.has(id)));
      if (relevant) losses.push(`${source.source}:${omission.reason}:${omission.count}`);
    }
  }
  return losses;
};

const contextUtilization: Grader = {
  names: ["context_utilization"],
  grade: finishedOnly((e) => {
    const ctx = e.context;
    if (!ctx || ctx.delivered.length === 0) return [];
    const refs = referencedOf(ctx);
    const delivered = { route: deliveredOfKind(ctx, "route"), dom: deliveredOfKind(ctx, "dom"), op: deliveredOfKind(ctx, "op") };
    const referenced = { route: new Set(refs.routeIds), dom: new Set(refs.domIds), op: new Set(refs.opIds) };
    const allDelivered = new Set([...delivered.route, ...delivered.dom, ...delivered.op]);
    const notProvided = [...new Set([...refs.routeIds, ...refs.domIds, ...refs.opIds])].filter((id) => !allDelivered.has(id));
    const scores: RawScore[] = [];
    const parts: string[] = [];
    let unionDelivered = 0;
    let unionReferenced = 0;
    for (const kind of ["route", "dom", "op"] as const) {
      const d = delivered[kind];
      const r = referenced[kind];
      unionDelivered += d.length;
      unionReferenced += d.filter((id) => r.has(id)).length;
      if (d.length === 0) {
        parts.push(`${kind} n/a`);
        continue;
      }
      const hit = d.filter((id) => r.has(id)).length;
      parts.push(`${kind} ${hit}/${d.length}`);
      scores.push({ name: `context_utilization.${kind}`, value: ratio(hit, d.length) });
    }
    const comment = `scope=all-delivered; ${parts.join("; ")}${notProvided.length > 0 ? `; referenced_not_provided: ${notProvided.slice(0, 10).join(",")}${notProvided.length > 10 ? ",…" : ""}` : ""}`;
    return [{ name: "context_utilization", value: ratio(unionReferenced, unionDelivered), comment }, ...scores];
  }),
};

const contextUtilizationFocused: Grader = {
  names: ["context_utilization_focused"],
  grade: finishedOnly((e) => {
    const ctx = e.context;
    if (!ctx || ctx.delivered.length === 0) return [];
    const refs = referencedOf(ctx);
    const delivered = { route: deliveredOfKind(ctx, "route"), dom: deliveredOfKind(ctx, "dom"), op: deliveredOfKind(ctx, "op") };
    const referenced = { route: new Set(refs.routeIds), dom: new Set(refs.domIds), op: new Set(refs.opIds) };

    const groups = routeGroups(ctx);
    const usedGroups = [...groups.values()].filter((routes) => routes.some((id) => referenced.route.has(id))).length;
    const routeValue = groups.size > 0 ? ratio(usedGroups, groups.size) : undefined;

    const domValue = focusedDomRatio(ctx, refs);
    /* The focused operation set is the change-filtered contracts the pack delivered, never every operation the map lists. */
    const packOps = ctx.delivered.find((source) => source.source === "context-pack")?.ids.filter((id) => id.startsWith("op:")) ?? [];
    const opValue = packOps.length > 0 ? ratio(packOps.filter((id) => referenced.op.has(id)).length, packOps.length) : undefined;

    const measured = [routeValue, domValue, opValue].filter((v): v is number => v !== undefined);
    const scores: RawScore[] = [];
    if (routeValue !== undefined) scores.push({ name: "context_utilization_focused.route", value: routeValue });
    if (domValue !== undefined) scores.push({ name: "context_utilization_focused.dom", value: domValue });
    if (opValue !== undefined) scores.push({ name: "context_utilization_focused.op", value: opValue });
    if (measured.length === 0) return [];
    const scope = ctx.relevantIds.length > 0 ? "change-relevant" : "fallback-all";
    const parts = [
      routeValue !== undefined ? `route ${usedGroups}/${groups.size} (${[...groups.keys()].join(",")})` : "route n/a",
      domValue !== undefined ? `dom ${domValue.toFixed(3)}` : "dom n/a",
      opValue !== undefined ? `op ${opValue.toFixed(3)}` : "op n/a",
    ];
    const overall = measured.reduce((sum, v) => sum + v, 0) / measured.length;
    return [{ name: "context_utilization_focused", value: overall, comment: `scope=${scope}; ${parts.join("; ")}` }, ...scores];
  }),
};

const contextComplete: Grader = {
  names: ["context_complete"],
  grade: finishedOnly((e) => {
    const ctx = e.context;
    if (!ctx || ctx.delivered.length === 0) return [];
    const losses = completenessLosses(ctx);
    return [{ name: "context_complete", value: losses.length === 0, ...(losses.length > 0 ? { comment: losses.join("; ") } : {}) }];
  }),
};

const contextFresh: Grader = {
  names: ["context_fresh"],
  grade: finishedOnly((e) => {
    const ctx = e.context;
    if (!ctx || ctx.delivered.length === 0 || ctx.freshness === undefined) return [];
    const stale = ctx.freshness.stale ?? [];
    const domChanged = ctx.freshness.domChanged === true;
    const reasons = [...stale.map((s) => `${s.source}:${s.reason}`), ...(domChanged ? ["dom-changed"] : [])];
    return [{ name: "context_fresh", value: reasons.length === 0, ...(reasons.length > 0 ? { comment: reasons.join("; ") } : {}) }];
  }),
};

const noopConsistent: Grader = {
  names: ["noop_consistent"],
  grade: finishedOnly((e) => {
    /* Only a run that could legitimately decide no-op or deliver is judged; an infra-error or invalid run with
     * zero specs is inconclusive, not a no-op. */
    if (e.verdict === null || !["pass", "fail", "flaky", "skipped"].includes(e.verdict)) return [];
    const changed = e.context?.changedElement;
    if (changed === undefined || changed === "unknown") return [];
    const isNoop = e.specs.generated === 0;
    return [{ name: "noop_consistent", value: (changed === "absent") === isNoop }];
  }),
};

/* A plan of flows to grade: the lead split the change into flows. A no-op or a change the lead authored alone has no flows to reach anything with. */
const fanoutPlan = (e: Evidence): NonNullable<Evidence["plan"]> | undefined => (e.plan?.kind === "fanout" && e.plan.flows.length > 0 ? e.plan : undefined);

/* The change pages the call graph proved (basis `graph`), from the route-ranking record; empty when the run recorded no basis. */
function graphPagesOf(e: Evidence): Set<string> {
  const ids = e.context?.relevantIds ?? [];
  const basis = e.context?.relevantBasis ?? [];
  return new Set(ids.flatMap((id, i) => (basis[i] === "graph" ? [id.startsWith(ROUTE_PREFIX) ? id.slice(ROUTE_PREFIX.length) : id] : [])));
}

/*
 * How much of the change's pages the plan reached, and how much of it a passing spec reached; unreached pages are the comment.
 * The pages the call graph proved are also scored apart (`*_graph_route_coverage`), so graph pages can be told from the map's.
 */
const planReach: Grader = {
  names: ["plan_route_coverage", "delivered_route_coverage", "plan_graph_route_coverage", "delivered_graph_route_coverage"],
  grade: finishedOnly((e) => {
    const plan = fanoutPlan(e);
    if (!plan || plan.changeRoutes.length === 0) return [];
    const proven = graphPagesOf(e);
    const graphRoutes = plan.changeRoutes.filter((route) => proven.has(route));
    const reach = (routes: readonly string[], flows: typeof plan.flows): RawScore["value"] => ratio(routes.filter((route) => flows.some((f) => f.visits.includes(route))).length, routes.length);
    const missed = (routes: readonly string[], flows: typeof plan.flows): string[] => routes.filter((route) => !flows.some((f) => f.visits.includes(route)));
    const score = (name: string, routes: readonly string[], flows: typeof plan.flows, lead: string): RawScore => {
      const unreached = missed(routes, flows);
      return { name, value: reach(routes, flows), ...(unreached.length > 0 ? { comment: `${lead}: ${unreached.join(", ")}` } : {}) };
    };
    const scores: RawScore[] = [score("plan_route_coverage", plan.changeRoutes, plan.flows, "no flow visits")];
    if (graphRoutes.length > 0) scores.push(score("plan_graph_route_coverage", graphRoutes, plan.flows, "no flow visits"));
    if (plan.flows.some((f) => f.passed === undefined)) return scores;
    const passing = plan.flows.filter((f) => f.passed === true);
    scores.push(score("delivered_route_coverage", plan.changeRoutes, passing, "no passing spec visits"));
    if (graphRoutes.length > 0) scores.push(score("delivered_graph_route_coverage", graphRoutes, passing, "no passing spec visits"));
    return scores;
  }),
};

/* The share of the plan's flows that delivered a spec whose every case passed the final execution. */
const flowDeliveryRate: Grader = {
  names: ["flow_delivery_rate"],
  grade: finishedOnly((e) => {
    const plan = fanoutPlan(e);
    if (!plan || plan.flows.some((f) => f.passed === undefined)) return [];
    const failed = plan.flows.filter((f) => f.passed !== true).map((f) => f.id);
    return [{ name: "flow_delivery_rate", value: ratio(plan.flows.length - failed.length, plan.flows.length), ...(failed.length > 0 ? { comment: `not delivered passing: ${failed.join(", ")}` } : {}) }];
  }),
};

/* A path two records name alike: the same, or one the other's tail on a directory boundary (one is relative to the test directory). */
const samePath = (a: string, b: string): boolean => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);

const ROUTE_PREFIX = "route:";

/*
 * The share of the change's pages the Context Pack delivered a live tree of. A page is grounded when the pack the agent received
 * holds an element of it (`dom:<page>#…`); a change page that was cut, not capturable or never rendered is not. Silent without
 * change pages or a delivered pack, and when a page is missing from a pack whose id list overflowed its cap.
 */
const changePagesGrounded: Grader = {
  names: ["change_pages_grounded"],
  grade: finishedOnly((e) => {
    const pages = (e.context?.relevantIds ?? []).filter((id) => id.startsWith(ROUTE_PREFIX)).map((id) => id.slice(ROUTE_PREFIX.length));
    const pack = e.context?.delivered.find((s) => s.source === "context-pack");
    if (pages.length === 0 || !pack) return [];
    const missing = pages.filter((page) => !pack.ids.some((id) => id.startsWith(`dom:${page}#`)));
    if (missing.length > 0 && (pack.idsOverflow ?? 0) > 0) return [];
    return [{ name: "change_pages_grounded", value: ratio(pages.length - missing.length, pages.length), ...(missing.length > 0 ? { comment: `not grounded: ${missing.join(", ")}` } : {}) }];
  }),
};

/*
 * Of the delivered specs whose final bytes passed a run_spec call, the share that also passed the final execution. A spec green
 * through run_spec and red in the run, on the same bytes, depends on something the bytes do not hold (timing, data, the order of
 * the suite): unstable. Silent when no delivered spec's final bytes passed run_spec, or the run did not execute them.
 */
const runSpecFinalAgreement: Grader = {
  names: ["run_spec_final_agreement"],
  grade: finishedOnly((e) => {
    const proven = e.deliveredSpecs.filter((spec) => spec.passed !== undefined && spec.sha256 !== undefined && e.runSpecCalls.some((c) => c.outcome === "passed" && c.sha256 === spec.sha256 && samePath(c.path, spec.path)));
    if (proven.length === 0) return [];
    const disagreed = proven.filter((spec) => spec.passed !== true).map((spec) => spec.path);
    return [{ name: "run_spec_final_agreement", value: ratio(proven.length - disagreed.length, proven.length), ...(disagreed.length > 0 ? { comment: `passed run_spec, failed the final execution on the same bytes: ${disagreed.join(", ")}` } : {}) }];
  }),
};

/* The share of the run's run_spec calls the orchestrator refused, with the count of each refusal code. Silent for a run that made none. */
const closedLoopRefusals: Grader = {
  names: ["closed_loop_refusals"],
  grade: finishedOnly((e) => {
    if (e.runSpecCalls.length === 0) return [];
    const byCode = new Map<string, number>();
    for (const call of e.runSpecCalls) if (call.outcome === "refused") byCode.set(call.refusal ?? "unknown", (byCode.get(call.refusal ?? "unknown") ?? 0) + 1);
    const refused = [...byCode.values()].reduce((sum, n) => sum + n, 0);
    const codes = [...byCode].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([code, n]) => `${code} ×${n}`);
    return [{ name: "closed_loop_refusals", value: ratio(refused, e.runSpecCalls.length), ...(refused > 0 ? { comment: `${refused} of ${e.runSpecCalls.length} refused: ${codes.join(", ")}` } : {}) }];
  }),
};

/* A sidekick's word that contradicts its flow's last run_spec call: it gave up on a spec that had just passed, or claimed it done on one that had not. */
const contradicts = (status: string, last: string): boolean => ((status === "failed" || status === "blocked") && last === "passed") || (status === "completed" && last !== "passed");

/*
 * Whether every sidekick report agrees with what its flow's last run_spec call showed. A report the orchestrator cannot check (no
 * call yet, or a needs-lead hand-off or a completion with concerns, which claim neither way) is not graded; silent when none is left.
 */
const sidekickReportConsistent: Grader = {
  names: ["sidekick_report_consistent"],
  grade: finishedOnly((e) => {
    const checked = e.sidekickReports.filter((r) => r.lastRunSpec !== undefined && ["failed", "blocked", "completed"].includes(r.status));
    if (checked.length === 0) return [];
    const wrong = checked.filter((r) => contradicts(r.status, r.lastRunSpec!)).map((r) => `${r.delegationId.startsWith(`${e.runId}-`) ? r.delegationId.slice(e.runId.length + 1) : r.delegationId}${r.attempt !== undefined ? ` turn ${r.attempt}` : ""}: reported ${r.status}, last run_spec ${r.lastRunSpec}`);
    return [{ name: "sidekick_report_consistent", value: wrong.length === 0, ...(wrong.length > 0 ? { comment: wrong.join("; ") } : {}) }];
  }),
};

export const GRADERS: readonly Grader[] = [
  emptyOutputGuard,
  furthestPhase,
  specValidityRate,
  specPassRate,
  budgetExhaustion,
  approvalConsistent,
  changeCoverage,
  mutationValue,
  infraError,
  stepIntent,
  contextUtilization,
  contextUtilizationFocused,
  contextComplete,
  contextFresh,
  noopConsistent,
  planReach,
  flowDeliveryRate,
  changePagesGrounded,
  runSpecFinalAgreement,
  closedLoopRefusals,
  sidekickReportConsistent,
];

/* Runs the graders that emit one of `only` (all of them when absent) and returns the catalog-typed scores. A throwing grader is not caught here. */
export function gradeEvidence(evidence: Evidence, only?: readonly string[]): Score[] {
  const wanted = only ? new Set(only) : undefined;
  /* A cancelled run did not run its pipeline: the only thing to say about it is that it was cancelled. */
  const graders = evidence.cancelled ? [infraError] : GRADERS;
  return graders.filter((g) => !wanted || g.names.some((n) => wanted.has(n))).flatMap((g) => g.grade(evidence).map(scoreOf));
}
