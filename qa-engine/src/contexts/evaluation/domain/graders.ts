/*
 * The deterministic graders: pure functions from a run's evidence to scores. A grader says nothing when it has no data (a score
 * absent is "not measurable", never a fabricated 0), and never grades a run that has not finished. Definitions follow
 * docs/observability-design.md §11.2; every BOOLEAN is pass-oriented (`true` = the check passed, the problem is absent).
 */

import { UNREADABLE_ANSWER } from "@kernel/unreadable-answer.ts";
import { RUN_PHASES } from "@kernel/run-step";
import { STEP_INTENTS, scoreOf } from "./grader-catalog.ts";
import { extractReferences } from "./context-refs.ts";
import { itemId } from "@kernel/context-item-ids.ts";
import { WINDOW_FIT_REASON } from "@kernel/prompt-sections.ts";
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
      const dropped = e.signals.droppedRejections;
      /* Only a valid citation the orchestrator could not resolve contradicts an approval; uncited, out-of-scope and not-executed drops are the evidence policy working as designed. */
      const unresolved = dropped?.reasons["unresolved"] ?? 0;
      if (dropped && dropped.rounds > 0 && unresolved > 0) {
        said.push(`the reviewer rejected in ${dropped.rounds} round(s) but every blocking finding was dropped by the evidence filter (${unresolved} unresolved)`);
      }
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
  names: ["step_intent_mix"],
  grade: (e) => {
    if (!e.finished || !e.stepIntents) return [];
    const counts: Record<string, number> = Object.fromEntries(STEP_INTENTS.map((i) => [i, 0]));
    for (const [intent, n] of Object.entries(e.stepIntents)) {
      const key = (STEP_INTENTS as readonly string[]).includes(intent) ? intent : "other";
      counts[key] = (counts[key] ?? 0) + n;
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total === 0) return [];
    return STEP_INTENTS.map((i) => ({ name: `step_intent_mix.${i}`, value: ratio(counts[i] ?? 0, total), ...(i === "auth" ? { comment: `${counts.auth ?? 0} of ${total} steps` } : {}) }));
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

const routePath = (id: string): string => (id.startsWith("route:") ? id.slice("route:".length) : id);

/* The change-relevant pages the context grades are ratios over: the ranked routes, else the routes the sources delivered. */
const changePages = (ctx: ContextEvidence): string[] => [...new Set((ctx.relevantIds.length > 0 ? ctx.relevantIds : deliveredOfKind(ctx, "route")).map(routePath))];

/* One truncation on change-relevant content: its `source:reason:count` label and the pages it cost (`all` when it is not attributable to one). */
interface ContextLoss {
  label: string;
  pages: readonly string[] | "all";
}

/* The truncations that cost change-relevant content. A cut on a page the change does not reach never counts. */
const completenessLosses = (ctx: ContextEvidence): ContextLoss[] => {
  const relevantIds = new Set(ctx.relevantIds);
  const relevantPaths = new Set(ctx.relevantIds.map(routePath));
  const losses: ContextLoss[] = [];
  for (const source of ctx.delivered) {
    for (const omission of source.omissions) {
      if (omission.class !== "truncation") continue;
      const label = `${source.source}:${omission.reason}:${omission.count}`;
      /* A cut that names no page of a whole section (its cap, its shedding, or the window showing it only as a reference) costs every change page. */
      if (omission.reason === "section-cap" || omission.reason === "section-shed" || (omission.reason === WINDOW_FIT_REASON && omission.route === undefined)) losses.push({ label, pages: "all" });
      else if (omission.route !== undefined) {
        if (relevantPaths.has(omission.route)) losses.push({ label, pages: [omission.route] });
      } else {
        const hit = source.ids.filter((id) => relevantIds.has(id));
        if (hit.length > 0) losses.push({ label, pages: hit.map(routePath) });
      }
    }
  }
  return losses;
};

/* The share of the pages that no loss touches; the labels of the losses that touched a page. */
function untouchedShare(pages: readonly string[], losses: readonly ContextLoss[]): { value: number; labels: string[] } {
  const touched = new Set<string>();
  const labels: string[] = [];
  for (const loss of losses) {
    const hit = loss.pages === "all" ? pages : pages.filter((page) => loss.pages.includes(page));
    if (hit.length === 0) continue;
    labels.push(loss.label);
    for (const page of hit) touched.add(page);
  }
  return { value: ratio(pages.length - touched.size, pages.length), labels };
}

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
    /* Nothing of an extractable kind was delivered: the overall ratio has no denominator. */
    if (unionDelivered === 0) return [];
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
    const pages = changePages(ctx);
    if (pages.length === 0) return [];
    const { value, labels } = untouchedShare(pages, completenessLosses(ctx));
    return [{ name: "context_complete", value, ...(labels.length > 0 ? { comment: `${Math.round((1 - value) * pages.length)} of ${pages.length} change pages lost content: ${labels.join("; ")}` } : {}) }];
  }),
};

const contextFresh: Grader = {
  names: ["context_fresh"],
  grade: finishedOnly((e) => {
    const ctx = e.context;
    if (!ctx || ctx.delivered.length === 0 || ctx.freshness === undefined) return [];
    const pages = changePages(ctx);
    if (pages.length === 0) return [];
    /* A staleness or change not attributed to pages (a whole source gone stale) touches every change page. */
    const losses: ContextLoss[] = (ctx.freshness.stale ?? []).map((s) => ({ label: `${s.source}:${s.reason}`, pages: s.routes ? s.routes.map(routePath) : "all" }));
    if (ctx.freshness.domChanged === true) losses.push({ label: "dom-changed", pages: ctx.freshness.domChangedRoutes ? ctx.freshness.domChangedRoutes.map(routePath) : "all" });
    const { value, labels } = untouchedShare(pages, losses);
    return [{ name: "context_fresh", value, ...(labels.length > 0 ? { comment: `${Math.round((1 - value) * pages.length)} of ${pages.length} change pages not fresh: ${labels.join("; ")}` } : {}) }];
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

type PlanFlows = NonNullable<Evidence["plan"]>["flows"];

const reaches = (routes: readonly string[], flows: PlanFlows): string[] => routes.filter((route) => flows.some((f) => f.visits.includes(route)));

/*
 * The pages the call graph proved alone, scored apart from the whole plan's reach (`*_graph_route_coverage`) so graph pages can be
 * told from the map's: how many the plan reached, and how many a passing spec reached. The comment lists the unreached ones.
 */
const planGraphReach: Grader = {
  names: ["plan_graph_route_coverage", "delivered_graph_route_coverage"],
  grade: finishedOnly((e) => {
    const plan = fanoutPlan(e);
    if (!plan || plan.changeRoutes.length === 0) return [];
    const proven = graphPagesOf(e);
    const graphRoutes = plan.changeRoutes.filter((route) => proven.has(route));
    if (graphRoutes.length === 0) return [];
    const score = (name: string, flows: PlanFlows, lead: string): RawScore => {
      const unreached = graphRoutes.filter((route) => reaches([route], flows).length === 0);
      return { name, value: ratio(graphRoutes.length - unreached.length, graphRoutes.length), ...(unreached.length > 0 ? { comment: `${lead}: ${unreached.join(", ")}` } : {}) };
    };
    const scores: RawScore[] = [score("plan_graph_route_coverage", plan.flows, "no flow visits")];
    if (plan.flows.some((f) => f.passed === undefined)) return scores;
    scores.push(score("delivered_graph_route_coverage", plan.flows.filter((f) => f.passed === true), "no passing spec visits"));
    return scores;
  }),
};

/*
 * How much of what the plan had to answer for it planned, and how much a passing spec delivered. The unit is the use case (candidate):
 * planned when a flow answers for it, delivered when such a flow's spec passed the final execution; a sidekick's claim never scores. The
 * comment lists every candidate by id and state (delivered, planned, unplanned, dropped with its reason). A plan that kept no candidates
 * (a run recorded before they were) is graded the same way over the change's pages: reached when a flow visits it, delivered when a passing
 * flow does, the unreached pages the comment.
 */
const planCoverage: Grader = {
  names: ["plan_candidate_coverage", "delivered_candidate_coverage"],
  grade: finishedOnly((e) => {
    const plan = fanoutPlan(e);
    if (!plan) return [];
    const settled = plan.flows.every((f) => f.passed !== undefined);
    if (plan.candidates.length === 0) {
      if (plan.changeRoutes.length === 0) return [];
      const byPage = (name: string, flows: PlanFlows, lead: string): RawScore => {
        const reached = reaches(plan.changeRoutes, flows);
        const unreached = plan.changeRoutes.filter((route) => !reached.includes(route));
        return { name, value: ratio(reached.length, plan.changeRoutes.length), comment: `by change page, no candidates recorded${unreached.length > 0 ? `; ${lead}: ${unreached.join(", ")}` : ""}` };
      };
      return [byPage("plan_candidate_coverage", plan.flows, "no flow visits"), ...(settled ? [byPage("delivered_candidate_coverage", plan.flows.filter((f) => f.passed === true), "no passing spec visits")] : [])];
    }
    const flowsOf = (id: string): typeof plan.flows => plan.flows.filter((f) => f.candidates.some((c) => c.id === id));
    const planned = plan.candidates.filter((c) => c.state === "planned");
    const stateOf = (c: (typeof plan.candidates)[number]): string => {
      if (c.state === "dropped") return `dropped: ${c.reason ?? "no reason"}${c.contradicted ? " (the run's facts contradicted it)" : ""}`;
      if (c.state === "unplanned") return "unplanned";
      return flowsOf(c.id).some((f) => f.passed === true) ? "delivered" : "planned";
    };
    const comment = { comment: plan.candidates.map((c) => `${c.id}: ${stateOf(c)}`).join("; ") };
    const scores: RawScore[] = [{ name: "plan_candidate_coverage", value: ratio(planned.length, plan.candidates.length), ...comment }];
    if (!settled) return scores;
    const delivered = plan.candidates.filter((c) => stateOf(c) === "delivered");
    scores.push({ name: "delivered_candidate_coverage", value: ratio(delivered.length, plan.candidates.length), ...comment });
    return scores;
  }),
};

/*
 * Whether the harness detected the use cases the change introduces: of the use cases a person labelled reachable on dev for the change,
 * the share some candidate names. The comment lists the ids no candidate names and the candidates that match no labelled use case
 * (unlabelled, never counted as false positives). Nothing without a reference, or without a dev use case.
 */
const candidateRecall: Grader = {
  names: ["candidate_recall"],
  grade: finishedOnly((e) => {
    const reference = e.reference;
    if (!fanoutPlan(e) || !reference || reference.useCases.length === 0) return [];
    const missed = reference.useCases.filter((u) => !u.named).map((u) => u.id);
    const notes = [
      ...(missed.length > 0 ? [`no candidate names: ${missed.join(", ")}`] : []),
      ...(reference.unlabelledCandidates > 0 ? [`${reference.unlabelledCandidates} candidate(s) match no reference use case`] : []),
    ];
    return [{ name: "candidate_recall", value: ratio(reference.useCases.length - missed.length, reference.useCases.length), ...(notes.length > 0 ? { comment: notes.join("; ") } : {}) }];
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
 * call yet, or a needs-lead hand-off or a completion with concerns, which claim neither way, or an unreadable answer, which reported nothing) is not graded; silent when none is left.
 */
const sidekickReportConsistent: Grader = {
  names: ["sidekick_report_consistent"],
  grade: finishedOnly((e) => {
    const checked = e.sidekickReports.filter((r) => r.lastRunSpec !== undefined && ["failed", "blocked", "completed"].includes(r.status));
    if (checked.length === 0) return [];
    const unreadable = e.sidekickReports.filter((r) => r.status === UNREADABLE_ANSWER).length;
    const wrong = checked.filter((r) => contradicts(r.status, r.lastRunSpec!)).map((r) => `${r.delegationId.startsWith(`${e.runId}-`) ? r.delegationId.slice(e.runId.length + 1) : r.delegationId}${r.attempt !== undefined ? ` turn ${r.attempt}` : ""}: reported ${r.status}, last run_spec ${r.lastRunSpec}`);
    return [{ name: "sidekick_report_consistent", value: wrong.length === 0, ...(wrong.length > 0 || unreadable > 0 ? { comment: [...wrong, ...(unreadable > 0 ? [`${unreadable} unreadable answer(s) not graded`] : [])].join("; ") } : {}) }];
  }),
};

/* ---- do the tests find bugs: mutation, coverage, review, causal label, triage ---- */

/* Bundle mutants noticed by a test / mutants judged. Silent when none was judged: a ratio over nothing is not a 0. */
const mutationKillRate: Grader = {
  names: ["mutation_kill_rate"],
  grade: finishedOnly((e) => {
    const m = e.signals?.bundleMutation;
    if (!m || m.applied <= 0) return [];
    return [{ name: "mutation_kill_rate", value: ratio(m.killed, m.applied), comment: `${m.killed} of ${m.applied} bundle mutants killed` }];
  }),
};

/* The changed-line ratio the engine measured; silent when its decision was `unknown` or it recorded no ratio. */
const changeCoverageRatio: Grader = {
  names: ["change_coverage_ratio"],
  grade: finishedOnly((e) => {
    const s = e.signals;
    if (!s || s.coverageStatus === undefined || s.coverageStatus === "unknown" || s.coverageRatio === undefined) return [];
    return [{ name: "change_coverage_ratio", value: s.coverageRatio }];
  }),
};

/* The arms of the decisions on changed lines that ran / the arms seen; silent without a decision on a changed line, or when coverage was `unknown`. */
const branchCoverageRatio: Grader = {
  names: ["branch_coverage_ratio"],
  grade: finishedOnly((e) => {
    const s = e.signals;
    if (!s || s.coverageStatus === "unknown" || !s.branchCoverage || s.branchCoverage.changed <= 0) return [];
    return [{ name: "branch_coverage_ratio", value: ratio(s.branchCoverage.taken, s.branchCoverage.changed), comment: `${s.branchCoverage.taken} of ${s.branchCoverage.changed} arms ran` }];
  }),
};

/*
 * The review's final verdict against the model's own. A model rejection whose every blocking finding the evidence filter dropped read as an
 * approval: `approved-over-model-rejection`, with the reasons the findings were dropped for in the comment. Silent when no reviewer phase ran.
 */
const reviewVerdict: Grader = {
  names: ["review_verdict"],
  grade: finishedOnly((e) => {
    const reviewer = e.signals?.reviewer;
    if (!reviewer) return [];
    const dropped = e.signals?.droppedRejections;
    const overruled = reviewer.approved && dropped !== undefined && dropped.rounds > 0;
    const reasons = dropped ? Object.entries(dropped.reasons).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([reason, n]) => `${reason} ×${n}`) : [];
    return [{ name: "review_verdict", value: !reviewer.approved ? "rejected" : overruled ? "approved-over-model-rejection" : "approved", ...(dropped ? { comment: `${dropped.rounds} model rejection(s) lost every blocking finding: ${reasons.join(", ")}` } : {}) }];
  }),
};

/*
 * How many failing cases the causal label puts in the change's reach (what the tests found). A passing run found none; a run whose
 * failures carry no label (not decided, or recorded before the label) says nothing.
 */
const defectFound: Grader = {
  names: ["defect_found"],
  grade: finishedOnly((e) => {
    if (e.verdict === "pass") return [{ name: "defect_found", value: 0 }];
    const causal = e.signals?.causal;
    if (!causal) return [];
    return [{ name: "defect_found", value: causal.inReach, comment: `${causal.inReach} in the change's reach, ${causal.outOfReach} out of reach, ${causal.unknown} unknown` }];
  }),
};

/* The surviving mutants a delivered spec reached (so they reached its flow) / all survivors. Silent when there was no survivor. */
const survivorsRouted: Grader = {
  names: ["survivors_routed"],
  grade: finishedOnly((e) => {
    const s = e.signals?.survivors;
    if (!s || s.total <= 0) return [];
    return [{ name: "survivors_routed", value: ratio(s.routed, s.total), comment: `${s.routed} of ${s.total} surviving mutants reached a delivered spec` }];
  }),
};

/* The class of a flaky run's cases: DEV data instability, timing, both or neither. Silent for a run that was not flaky. */
const flakyTriage: Grader = {
  names: ["flaky_triage"],
  grade: finishedOnly((e) => {
    const t = e.signals?.flakyTriage;
    if (!t) return [];
    const value = t.dataInstability > 0 && t.timing > 0 ? "mixed" : t.dataInstability > 0 ? "data-instability" : t.timing > 0 ? "timing" : "unclassified";
    return [{ name: "flaky_triage", value, comment: `${t.cases} flaky case(s): ${t.dataInstability} data instability, ${t.timing} timing; correction ${t.outcome}` }];
  }),
};

/* The drops of a use case the run's facts contradicted and the lead kept: how many, and which. Graded for every plan of flows (0 when none). */
const dropsContradicted: Grader = {
  names: ["drops_contradicted"],
  grade: finishedOnly((e) => {
    const plan = fanoutPlan(e);
    if (!plan) return [];
    const ids = plan.candidates.filter((c) => c.state === "dropped" && c.contradicted !== undefined).map((c) => c.id);
    return [{ name: "drops_contradicted", value: ids.length, ...(ids.length > 0 ? { comment: ids.join(", ") } : {}) }];
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
  mutationKillRate,
  changeCoverageRatio,
  branchCoverageRatio,
  reviewVerdict,
  defectFound,
  survivorsRouted,
  flakyTriage,
  dropsContradicted,
  infraError,
  stepIntent,
  contextUtilization,
  contextUtilizationFocused,
  contextComplete,
  contextFresh,
  noopConsistent,
  planGraphReach,
  planCoverage,
  candidateRecall,
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
