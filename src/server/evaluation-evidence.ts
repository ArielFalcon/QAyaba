/*
 * The evidence port over the run history: assembles one finished run's RunEvaluationEvidence from its record, its outcome row,
 * its agent turns and its span ledger. Reads only, and only what the run recorded: what the engine decided at run time (a
 * reviewer was due, the coverage decision and policy, the limit that fired) is read back from the run's columns, never recomputed
 * from the app's current configuration, so a regrade today grades the run as it was. Where a fact was never recorded the evidence
 * says so (undefined or null) and the graders stay silent. Every read is injected (`*Deps`) so the assembly is unit-tested with fakes.
 */

import { RUN_PHASES } from "@kernel/run-step";
import type { EvidencePort } from "@contexts/evaluation/application/index.ts";
import type { ContextEvidence, ContextFreshness, DeliveredContextSource, DeliveredOmission, DeliveredSpecEvidence, PlanEvidence, ReferenceEvidence, RunEvaluationEvidence, RunSpecCallEvidence, SidekickReportEvidence } from "@contexts/evaluation/application/index";
import { AGENT_NAME_FOR_ROLE } from "../agent-runtime/types";
import type { RunFactsPatch, RunPhases, SpecSnapshotRow } from "./persistence/repositories/run.repository";
import type { AgentTurnRecord } from "./persistence/repositories/telemetry.repository";
import type { RunOutcome, RunRecord } from "../types";
import { namesTemplatePage } from "@contexts/generation/application/index";
import { referenceFor, type UseCaseReference } from "@contexts/evaluation/application/index";
import { loadReferencesLeniently } from "./use-case-reference-loader";
import { getHistory } from "./persistence/index";

/* The slice of a ledger span the evidence reads. */
export interface LedgerSpan {
  name: string;
  spanId: string;
  parentSpanId: string | null;
  /* The span's attributes as JSON. */
  attrs: string;
}

export interface EvidenceDeps {
  getRecord(id: string): RunRecord | undefined;
  getRunPhases(id: string): RunPhases | undefined;
  getRunFacts(id: string): Required<RunFactsPatch> | undefined;
  getRunOutcome(id: string): RunOutcome | undefined;
  getAgentTurns(id: string): AgentTurnRecord[];
  runSpans(id: string): LedgerSpan[];
  listSpecSnapshots(id: string): SpecSnapshotRow[];
  /* The plan the run kept, as JSON (`run_plans`). */
  getRunPlan(id: string): string | undefined;
}

export const defaultEvidenceDeps: EvidenceDeps = {
  getRecord: (id) => getHistory().runs.getRecord(id),
  getRunPhases: (id) => getHistory().runs.getRunPhases(id),
  getRunFacts: (id) => getHistory().runs.getRunFacts(id),
  getRunOutcome: (id) => getHistory().learning.getRunOutcome(id),
  getAgentTurns: (id) => getHistory().telemetry.getAgentTurns(id),
  runSpans: (id) => getHistory().telemetry.listRunSpans(id).map((s) => ({ name: s.name, spanId: s.spanId, parentSpanId: s.parentSpanId, attrs: s.attrs })),
  listSpecSnapshots: (id) => getHistory().runs.listSpecSnapshots(id),
  getRunPlan: (id) => getHistory().runs.getRunPlan(id),
};

const STEP_INTENT_ATTR = "qayaba.step.intent";
const AGENT_NAME_ATTR = "gen_ai.agent.name";
const AGENT_ROLE_ATTR = "qayaba.agent.role";
const LIMIT_FIRED_ATTR = "qayaba.limit.fired";
const REVIEWER_AGENT = AGENT_NAME_FOR_ROLE.reviewer;
const rank = (phase: string): number => (RUN_PHASES as readonly string[]).indexOf(phase);

const COVERAGE_STATUSES = ["pass", "fail", "unknown"] as const;

const isChat = (s: LedgerSpan): boolean => s.name === "chat" || s.name.startsWith("chat ");
const isTurn = (s: LedgerSpan): boolean => s.name === "invoke_agent" || s.name.startsWith("invoke_agent ");

function attrsOf(s: LedgerSpan): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(s.attrs);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/*
 * A case belongs to a spec when the file the report named for it is the spec's path, or the path's tail on a directory boundary
 * (the report names the file relative to the test directory, the spec list relative to the repository). A file that fits more
 * than one spec fits none: an ambiguous attribution is not one.
 */
function specOfCase(file: string | undefined, specNames: readonly string[]): string | undefined {
  if (!file) return undefined;
  const fits = specNames.filter((s) => s === file || s.endsWith(`/${file}`) || file.endsWith(`/${s}`));
  return fits.length === 1 ? fits[0] : undefined;
}

/*
 * How many delivered specs passed, or undefined when that cannot be told. Cases are tied to specs by file (specOfCase). When every
 * spec has at least one case, a spec passed when all of its cases did. When any spec has none, the cases cannot be tied to the
 * suite: only a run-level pass, which means every case passed, still answers.
 */
export function countPassedSpecs(specNames: readonly string[], cases: ReadonlyArray<{ name: string; status: string; file?: string | undefined }>, valid: number, verdict: string | null): number | undefined {
  if (valid === 0) return 0;
  const bySpec = new Map<string, string[]>();
  for (const c of cases) {
    const spec = specOfCase(c.file, specNames);
    if (spec) bySpec.set(spec, [...(bySpec.get(spec) ?? []), c.status]);
  }
  if (specNames.length > 0 && specNames.every((s) => bySpec.has(s))) {
    return specNames.filter((s) => bySpec.get(s)!.every((st) => st === "pass")).length;
  }
  return verdict === "pass" ? valid : undefined;
}

/* The verdicts of a run whose specs ran in the final execution. */
const EXECUTED_VERDICTS: ReadonlySet<string> = new Set(["pass", "fail", "flaky"]);

/*
 * The plan the run kept, with each flow's result in the final execution: a flow passed when it delivered its spec and every case the
 * report ties to that spec passed. A flow that delivered nothing did not pass. Whether a delivered flow passed is unknown when the run
 * did not execute, or when no case can be tied to its spec. A plan that does not read as one is no plan.
 */
export function planEvidenceOf(raw: string | undefined, record: Pick<RunRecord, "cases" | "verdict">): PlanEvidence | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const plan = parsed as { kind?: unknown; changeRoutes?: unknown; candidates?: unknown; flows?: unknown };
  if (typeof plan.kind !== "string" || !Array.isArray(plan.flows)) return undefined;
  const executed = record.verdict !== undefined && EXECUTED_VERDICTS.has(record.verdict);
  const flows = plan.flows.flatMap((value: unknown) => {
    if (value === null || typeof value !== "object") return [];
    const flow = value as { id?: unknown; visits?: unknown; candidates?: unknown; specFile?: unknown; outcome?: { kind?: unknown } };
    if (typeof flow.id !== "string") return [];
    const delivered = flow.outcome?.kind === "delivered";
    const statuses = typeof flow.specFile === "string" ? record.cases.filter((c) => specOfCase(c.file, [flow.specFile as string]) !== undefined).map((c) => c.status) : [];
    const passed = !delivered ? false : !executed || statuses.length === 0 ? undefined : statuses.every((s) => s === "pass");
    return [{ id: flow.id, visits: asStringArray(flow.visits), candidates: flowCandidatesOf(flow.candidates), passed }];
  });
  return { kind: plan.kind, changeRoutes: asStringArray(plan.changeRoutes), candidates: planCandidatesOf(plan.candidates), flows };
}

/*
 * The labelled use cases reachable on dev for the change, each with whether a candidate of the plan names one of its routes (a candidate's
 * page is a route template; `namesTemplatePage` lets a renamed parameter match), and the candidates that match no labelled use case.
 * Undefined without a reference for the change, without a dev use case, or when the plan kept its candidates without their pages.
 */
export function referenceEvidenceOf(references: readonly UseCaseReference[], run: { app: string; sha: string }, plan: PlanEvidence | undefined): ReferenceEvidence | undefined {
  const change = referenceFor(references, run.app, run.sha);
  if (!change || !plan || plan.candidates.some((c) => c.pages === undefined)) return undefined;
  const dev = change.useCases.filter((u) => u.reachability === "dev");
  if (dev.length === 0) return undefined;
  const pages = plan.candidates.map((c) => c.pages ?? []);
  const names = (routes: readonly string[]): boolean => pages.some((candidatePages) => candidatePages.some((page) => routes.some((route) => namesTemplatePage(page, route))));
  const unlabelled = pages.filter((candidatePages) => !change.useCases.some((u) => candidatePages.some((page) => u.routes.some((route) => namesTemplatePage(page, route))))).length;
  return { useCases: dev.map((u) => ({ id: u.id, named: names(u.routes) })), unlabelledCandidates: unlabelled };
}

const CANDIDATE_STATES = new Set(["planned", "dropped", "unplanned"]);

/* The use cases the plan had to answer for, as the run kept them; an entry of another shape is left out. */
function planCandidatesOf(value: unknown): PlanEvidence["candidates"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    const c = entry as { id?: unknown; state?: unknown; reason?: unknown; pages?: unknown } | null;
    if (c === null || typeof c !== "object" || typeof c.id !== "string" || typeof c.state !== "string" || !CANDIDATE_STATES.has(c.state)) return [];
    return [{ id: c.id, state: c.state as "planned" | "dropped" | "unplanned", ...(typeof c.reason === "string" ? { reason: c.reason } : {}), ...(Array.isArray(c.pages) ? { pages: asStringArray(c.pages) } : {}) }];
  });
}

function flowCandidatesOf(value: unknown): PlanEvidence["flows"][number]["candidates"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    const c = entry as { id?: unknown; claimed?: unknown } | null;
    return c !== null && typeof c === "object" && typeof c.id === "string" ? [{ id: c.id, ...(typeof c.claimed === "string" ? { claimed: c.claimed } : {}) }] : [];
  });
}

const optStr = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/* The closed loop's calls, in the order the ledger holds them (by start). */
export function runSpecCallsOf(spans: readonly LedgerSpan[]): RunSpecCallEvidence[] {
  return spans.flatMap((s) => {
    if (s.name !== "qayaba.tool.run_spec") return [];
    const a = attrsOf(s);
    const path = optStr(a["qayaba.spec.path"]);
    const outcome = optStr(a["qayaba.tool.outcome"]);
    if (!path || !outcome) return [];
    return [{ path, sha256: optStr(a["qayaba.spec.sha256"]), outcome, refusal: optStr(a["qayaba.tool.refusal"]) }];
  });
}

/* Each delivered spec's newest delivered bytes and whether every case tied to it passed the final execution. */
export function deliveredSpecsOf(specNames: readonly string[], snapshots: readonly SpecSnapshotRow[], record: Pick<RunRecord, "cases" | "verdict">): DeliveredSpecEvidence[] {
  const executed = record.verdict !== undefined && EXECUTED_VERDICTS.has(record.verdict);
  return specNames.map((path) => {
    const newest = snapshots.filter((s) => s.delivered === 1 && specOfCase(s.path, [path]) !== undefined).sort((a, b) => b.capturedAt - a.capturedAt)[0];
    const statuses = record.cases.filter((c) => specOfCase(c.file, specNames) === path).map((c) => c.status);
    return { path, sha256: newest?.sha256, passed: !executed || statuses.length === 0 ? undefined : statuses.every((st) => st === "pass") };
  });
}

/* The delegation events that recorded the sidekick's status. */
export function sidekickReportsOf(spans: readonly LedgerSpan[]): SidekickReportEvidence[] {
  return spans.flatMap((s) => {
    if (s.name !== "qayaba.coordination.event") return [];
    const a = attrsOf(s);
    const delegationId = optStr(a["qayaba.delegation.id"]);
    const status = optStr(a["qayaba.delegation.status"]);
    if (a["qayaba.coordination.kind"] !== "delegation" || !delegationId || !status) return [];
    const attempt = a["qayaba.coordination.attempt"];
    return [{ delegationId, attempt: typeof attempt === "number" ? attempt : undefined, status, lastRunSpec: optStr(a["qayaba.delegation.last_run_spec"]) }];
  });
}

export interface SpecCounts {
  generated: number;
  valid: number | null;
  passed: number | undefined;
}

/*
 * The specs a run delivered: the record's own list when it holds one, else the delivered snapshots. The validate phase keeps a
 * snapshot of every delivered spec whatever path the run takes afterwards (the run record's list is written only by the normal
 * exit), so a run that fails after validation still says what it produced. The record's list wins whole: a run that recorded it
 * never counts a snapshot on top.
 */
export function deliveredSpecNames(record: Pick<RunRecord, "specs">, snapshots: ReadonlyArray<Pick<SpecSnapshotRow, "path" | "delivered">>): string[] {
  const named = (record.specs ?? []).map((s) => s.name);
  if (named.length > 0) return named;
  return [...new Set(snapshots.filter((s) => s.delivered === 1).map((s) => s.path))].sort();
}

/* The counts the run record, the run view, the graders and the run's own trace all report. Validation gates the whole suite: it is a measurement only once the run got past it. */
export function specCountsOf(record: Pick<RunRecord, "specs" | "cases" | "verdict">, snapshots: ReadonlyArray<Pick<SpecSnapshotRow, "path" | "delivered">>, furthestPhase: string | null): SpecCounts {
  const specNames = deliveredSpecNames(record, snapshots);
  const generated = specNames.length;
  const valid = record.verdict === "invalid" ? 0 : furthestPhase !== null && rank(furthestPhase) > rank("validate") ? generated : null;
  return { generated, valid, passed: valid === null ? undefined : countPassedSpecs(specNames, record.cases, valid, record.verdict ?? null) };
}

function stepIntentsOf(spans: readonly LedgerSpan[]): Record<string, number> | undefined {
  const counts: Record<string, number> = {};
  for (const s of spans.filter(isChat)) {
    const intent = attrsOf(s)[STEP_INTENT_ATTR];
    if (typeof intent === "string") counts[intent] = (counts[intent] ?? 0) + 1;
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

/* ---- grounding context evidence ---- */

const asStringArray = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/* The delivered sources, read from the `qayaba.delivered.<source>` spans. */
function deliveredSourcesOf(spans: readonly LedgerSpan[]): DeliveredContextSource[] {
  const bySource = new Map<string, DeliveredContextSource>();
  for (const span of spans) {
    if (!span.name.startsWith("qayaba.delivered.")) continue;
    const attrs = attrsOf(span);
    const source = attrs["qayaba.context.source"];
    if (typeof source !== "string") continue;
    const ids = asStringArray(attrs["qayaba.context.item_ids"]);
    const bytes = typeof attrs["qayaba.context.bytes"] === "number" ? attrs["qayaba.context.bytes"] : 0;
    const omitted = typeof attrs["qayaba.context.omitted"] === "number" ? attrs["qayaba.context.omitted"] : 0;
    const rawOmissions = attrs["qayaba.context.omissions"];
    const omissions: DeliveredOmission[] = (() => {
      if (!Array.isArray(rawOmissions)) return [];
      const result: DeliveredOmission[] = [];
      for (const entry of rawOmissions) {
        if (typeof entry !== "string") continue;
        const [cls, reason, countText, ...routeParts] = entry.split(":");
        const count = Number(countText);
        if ((cls !== "truncation" && cls !== "selection") || reason === undefined || reason === "" || !Number.isFinite(count)) continue;
        result.push({ class: cls, reason, count, ...(routeParts.length > 0 ? { route: routeParts.join(":") } : {}) });
      }
      return result;
    })();
    const overflow = attrs["qayaba.context.item_ids.overflow"];
    const entry = bySource.get(source) ?? { source, ids: [], bytes: 0, omitted: 0, omissions: [] };
    entry.ids.push(...ids);
    entry.bytes += bytes;
    entry.omitted += omitted;
    entry.omissions.push(...omissions);
    if (typeof overflow === "number" && overflow > 0) entry.idsOverflow = (entry.idsOverflow ?? 0) + overflow;
    bySource.set(source, entry);
  }
  return [...bySource.values()];
}

/* The change-relevant route ids and their component/page groups, recorded on the route-ranking span (a Track A addition). */
function relevantRoutesOf(spans: readonly LedgerSpan[]): { ids: string[]; groups: string[]; basis?: string[] } {
  for (const span of spans) {
    if (span.name !== "qayaba.context.route-ranking") continue;
    const attrs = attrsOf(span);
    const ids = asStringArray(attrs["qayaba.context.relevant_ids"]);
    if (ids.length === 0) continue;
    const basis = asStringArray(attrs["qayaba.context.relevant_basis"]);
    return { ids, groups: asStringArray(attrs["qayaba.context.relevant_groups"]), ...(basis.length === ids.length ? { basis } : {}) };
  }
  return { ids: [], groups: [] };
}

const FACT_RE = /^fact:.+#(.+):(present|absent)$/;

/* The changed element state and its test ids, from the `fact:` ids the delivered pack carries. A label-only change produces no fact, hence `unknown`. */
function changedElementOf(delivered: readonly DeliveredContextSource[]): { changedTestIds: string[]; changedElement: "present" | "absent" | "unknown" | undefined } {
  const pack = delivered.find((s) => s.source === "context-pack");
  if (!pack) return { changedTestIds: [], changedElement: undefined };
  const testIds = new Set<string>();
  let state: "present" | "absent" | undefined;
  for (const id of pack.ids) {
    const match = FACT_RE.exec(id);
    if (!match) continue;
    testIds.add(match[1] ?? "");
    if (state !== "present") state = match[2] === "present" ? "present" : "absent";
  }
  if (testIds.size === 0) return { changedTestIds: [], changedElement: "unknown" };
  return { changedTestIds: [...testIds], changedElement: state };
}

/* Freshness provenance, from the produced spans' stale/dom-changed attrs. Absent (undefined) while no source recorded provenance. */
function freshnessOf(spans: readonly LedgerSpan[], relevantIds: readonly string[]): ContextFreshness | undefined {
  const stale: Array<{ source: string; reason: string }> = [];
  let domChanged: boolean | undefined;
  let any = false;
  /* The DOM ids of every capture, by route. Two captures of the same route that disagree mean the
   * page changed between them (R4: the grounding pack saw 0 results and the review saw 11). */
  const byRoute = new Map<string, string[][]>();
  const relevantRoutes = new Set(relevantIds.map((id) => (id.startsWith("route:") ? id.slice("route:".length) : id)));
  for (const span of spans) {
    if (!span.name.startsWith("qayaba.context.")) continue;
    const attrs = attrsOf(span);
    if (attrs["qayaba.context.stale"] === true) {
      const source = attrs["qayaba.context.source"];
      const reason = attrs["qayaba.context.stale_reason"];
      if (typeof source === "string") {
        stale.push({ source, reason: typeof reason === "string" ? reason : "stale" });
        any = true;
      }
    }
    if (attrs["qayaba.context.dom_changed"] === true) {
      domChanged = true;
      any = true;
    }
    if (span.name !== "qayaba.context.dom-capture") continue;
    const ids = attrs["qayaba.context.item_ids"];
    if (!Array.isArray(ids)) continue;
    const perRoute = new Map<string, Set<string>>();
    for (const id of ids) {
      if (typeof id !== "string" || !id.startsWith("dom:")) continue;
      const hash = id.indexOf("#", 4);
      if (hash < 0) continue;
      const route = id.slice(4, hash);
      const set = perRoute.get(route) ?? new Set<string>();
      set.add(id);
      perRoute.set(route, set);
    }
    for (const [route, set] of perRoute) {
      if (relevantRoutes.size > 0 && !relevantRoutes.has(route)) continue;
      const captures = byRoute.get(route) ?? [];
      captures.push([...set].sort());
      byRoute.set(route, captures);
    }
  }
  for (const captures of byRoute.values()) {
    if (captures.length < 2) continue;
    const first = captures[0]!.join("|");
    if (captures.some((ids) => ids.join("|") !== first)) {
      domChanged = true;
      any = true;
      break;
    }
  }
  return any ? { stale, domChanged } : undefined;
}

/* The content the agent re-read even though the prompt already held it, summed over the turns that measured it. */
function fileReadsOf(turns: readonly AgentTurnRecord[]): number | undefined {
  let total = 0;
  let measured = false;
  for (const turn of turns) {
    if (turn.promptProvidedReadCount !== null && turn.promptProvidedReadCount !== undefined) {
      total += turn.promptProvidedReadCount;
      measured = true;
    }
    if (turn.pathProvidedReadCount !== null && turn.pathProvidedReadCount !== undefined) {
      total += turn.pathProvidedReadCount;
      measured = true;
    }
  }
  return measured ? total : undefined;
}

function contextOf(spans: readonly LedgerSpan[], turns: readonly AgentTurnRecord[], snapshots: readonly SpecSnapshotRow[]): ContextEvidence | undefined {
  const delivered = deliveredSourcesOf(spans);
  if (delivered.length === 0 && snapshots.length === 0) return undefined;
  const relevant = relevantRoutesOf(spans);
  const changed = changedElementOf(delivered);
  return {
    delivered,
    relevantIds: relevant.ids,
    relevantGroups: relevant.groups,
    ...(relevant.basis ? { relevantBasis: relevant.basis } : {}),
    changedTestIds: changed.changedTestIds,
    changedElement: changed.changedElement,
    snapshots: snapshots.map((s) => ({ path: s.path, text: s.text })),
    toolSequence: turns.flatMap((t) => t.toolSequence ?? []),
    fileReads: fileReadsOf(turns),
    freshness: freshnessOf(spans, relevant.ids),
  };
}

/*
 * The intent of the last step of the turn that hit the limit, read from the agent-turn span model: `invoke_agent <agent>` turn spans
 * (`gen_ai.agent.name`, `qayaba.agent.role`, and `qayaba.limit.fired` once the turn ended), `qayaba.agent.attempt` children, and
 * `chat <model>` step spans under an attempt carrying `qayaba.step.intent`. Of the turns of the limiting role the one that fired a
 * limit wins, else the last. Undefined when the ledger holds none of it.
 */
function limitIntentOf(spans: readonly LedgerSpan[], role: string | undefined): string | undefined {
  if (!role) return undefined;
  const ofRole = spans.filter((s) => {
    if (!isTurn(s)) return false;
    const a = attrsOf(s);
    return a[AGENT_NAME_ATTR] === role || a[AGENT_ROLE_ATTR] === role;
  });
  const fired = ofRole.filter((s) => {
    const limit = attrsOf(s)[LIMIT_FIRED_ATTR];
    return typeof limit === "string" && limit !== "none";
  });
  const turn = (fired.length > 0 ? fired : ofRole).at(-1);
  if (!turn) return undefined;
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  /* A step hangs under its attempt, which hangs under the turn. */
  const steps = spans.filter((s) => isChat(s) && s.parentSpanId !== null && (s.parentSpanId === turn.spanId || byId.get(s.parentSpanId)?.parentSpanId === turn.spanId));
  const last = steps.at(-1);
  const intent = last ? attrsOf(last)[STEP_INTENT_ATTR] : undefined;
  return typeof intent === "string" ? intent : undefined;
}

export class HistoryEvidenceAdapter implements EvidencePort {
  constructor(private readonly deps: EvidenceDeps = defaultEvidenceDeps, private readonly references: () => readonly UseCaseReference[] = () => loadReferencesLeniently()) {}

  async load(runId: string): Promise<RunEvaluationEvidence | undefined> {
    return this.assemble(runId);
  }

  /* The same evidence, synchronously: the run view reads the spec counts the graders will use. */
  assemble(runId: string): RunEvaluationEvidence | undefined {
    const d = this.deps;
    const record = d.getRecord(runId);
    if (!record) return undefined;
    const finished = record.status === "done" && record.verdict !== undefined;
    const verdict = record.verdict ?? null;
    const furthestPhase = d.getRunPhases(runId)?.furthestPhase ?? null;
    const facts = d.getRunFacts(runId);
    const outcome = d.getRunOutcome(runId);
    const spans = d.runSpans(runId);
    const turns = d.getAgentTurns(runId);

    const snapshots = d.listSpecSnapshots(runId);
    const specs = specCountsOf(record, snapshots, furthestPhase);
    const g = outcome?.gateSignals;
    const plan = planEvidenceOf(d.getRunPlan(runId), record);
    const reference = referenceEvidenceOf(this.references(), record, plan);
    const coverageStatus = COVERAGE_STATUSES.find((c) => c === facts?.coverageStatus);

    return {
      runId,
      ...(record.parentRunId ? { parentRunId: record.parentRunId } : {}),
      app: record.app,
      mode: record.mode,
      finished,
      cancelled: facts?.cancelled === true,
      verdict,
      errorClass: outcome?.errorClass ?? null,
      decision: facts?.decision ?? null,
      furthestPhase,
      specs,
      reviewerTurns: turns.length === 0 ? undefined : turns.filter((t) => t.role === REVIEWER_AGENT).length,
      reviewRequired: facts?.reviewRequired ?? undefined,
      signals: g
        ? {
            static: g.static,
            reviewerApproved: g.reviewerApproved,
            coverageStatus,
            coverageMode: facts?.coverageMode ?? undefined,
            mutantCount: g.mutantCount,
            killedCount: g.killedCount,
            catalogGateFailClosed: g.catalogGateFailClosed,
          }
        : undefined,
      limit: facts?.limitFired ? { fired: facts.limitFired, role: facts.limitRole ?? undefined, intent: limitIntentOf(spans, facts.limitRole ?? undefined) } : undefined,
      stepIntents: stepIntentsOf(spans),
      context: contextOf(spans, turns, snapshots),
      plan,
      ...(reference ? { reference } : {}),
      runSpecCalls: runSpecCallsOf(spans),
      deliveredSpecs: deliveredSpecsOf(deliveredSpecNames(record, snapshots), snapshots, record),
      sidekickReports: sidekickReportsOf(spans),
      finishedAt: outcome?.at ?? record.at,
    };
  }
}
