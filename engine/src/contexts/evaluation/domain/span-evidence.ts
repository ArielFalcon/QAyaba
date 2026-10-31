/*
 * What the run's span ledger, its agent turns and its outcome row say, as the evidence a grader reads: the closed loop's calls, the
 * sidekicks' reports, the surviving mutants, the grounding context the generator was handed, the limit that stopped a turn and the intent
 * of its last step. Reads only what the run recorded; a fact never recorded is absent.
 */
import { isBindingLimit } from "@kernel/turn-limit.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import type { ContextEvidence, ContextFreshness, DeliveredContextSource, DeliveredOmission, RunSpecCallEvidence, SidekickReportEvidence } from "./run-evaluation-evidence.ts";
import type { EvidenceAgentTurn, EvidenceSpecSnapshot } from "./evidence-sources.ts";
import { asStringArray, attrsOf, optStr, type LedgerSpan } from "./ledger-span.ts";

const STEP_INTENT_ATTR = "qayaba.step.intent";
const AGENT_NAME_ATTR = "gen_ai.agent.name";
const AGENT_ROLE_ATTR = "qayaba.agent.role";
const LIMIT_FIRED_ATTR = "qayaba.limit.fired";

const isChat = (s: LedgerSpan): boolean => s.name === "chat" || s.name.startsWith("chat ");
const isTurn = (s: LedgerSpan): boolean => s.name === "invoke_agent" || s.name.startsWith("invoke_agent ");

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

/* The surviving bundle mutants a delivered spec reached and the total, from the newest coverage measurement that counted them. */
export function survivorsOf(spans: readonly LedgerSpan[]): { routed: number; total: number } | undefined {
  for (const span of [...spans].reverse()) {
    if (span.name !== "qayaba.coverage.measure") continue;
    const a = attrsOf(span);
    const routed = a["qayaba.mutation.survivors_routed"];
    const withoutSpec = a["qayaba.mutation.survivors_without_spec"];
    if (typeof routed === "number" && typeof withoutSpec === "number") return { routed, total: routed + withoutSpec };
  }
  return undefined;
}

/* The failing cases by the reach the causal label gave them; undefined when the run kept no label. */
export function causalOf(causal: NonNullable<RunOutcome["gateSignals"]["causal"]> | undefined): { inReach: number; outOfReach: number; unknown: number } | undefined {
  if (!causal) return undefined;
  const count = (reach: "in-reach" | "out-of-reach" | "unknown"): number => causal.cases.filter((c) => c.reach === reach).length;
  return { inReach: count("in-reach"), outOfReach: count("out-of-reach"), unknown: count("unknown") };
}

export function stepIntentsOf(spans: readonly LedgerSpan[]): Record<string, number> | undefined {
  const counts: Record<string, number> = {};
  for (const s of spans.filter(isChat)) {
    const intent = attrsOf(s)[STEP_INTENT_ATTR];
    if (typeof intent === "string") counts[intent] = (counts[intent] ?? 0) + 1;
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

/* ---- grounding context evidence ---- */

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
  const stale: Array<{ source: string; reason: string; routes?: string[] }> = [];
  let domChanged: boolean | undefined;
  /* The span flag names no page: the change is then not attributable to pages. */
  let domChangedUnscoped = false;
  const changedRoutes = new Set<string>();
  let any = false;
  /* The DOM ids of every capture, by route. Two captures of the same route that disagree mean the
   * page changed between them (R4: the grounding pack saw 0 results and the review saw 11). */
  const byRoute = new Map<string, string[][]>();
  const relevantRoutes = new Set(relevantIds.map((id) => (id.startsWith("route:") ? id.slice("route:".length) : id)));
  for (const span of spans) {
    if (!span.name.startsWith("qayaba.context.")) continue;
    const attrs = attrsOf(span);
    const ids = attrs["qayaba.context.item_ids"];
    if (attrs["qayaba.context.stale"] === true) {
      const source = attrs["qayaba.context.source"];
      const reason = attrs["qayaba.context.stale_reason"];
      if (typeof source === "string") {
        /* The pages the stale source delivered: the stale mark covers the capture, so those are the pages it can have cost. */
        const routes = [...new Set(asStringArray(ids).flatMap((id) => (id.startsWith("dom:") ? [id.slice(4, id.indexOf("#", 4) < 0 ? undefined : id.indexOf("#", 4))] : id.startsWith("route:") ? [id.slice("route:".length)] : [])))];
        stale.push({ source, reason: typeof reason === "string" ? reason : "stale", ...(routes.length > 0 ? { routes } : {}) });
        any = true;
      }
    }
    if (attrs["qayaba.context.dom_changed"] === true) {
      domChanged = true;
      domChangedUnscoped = true;
      any = true;
    }
    if (span.name !== "qayaba.context.dom-capture") continue;
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
  for (const [route, captures] of byRoute) {
    if (captures.length < 2) continue;
    const first = captures[0]!.join("|");
    if (captures.some((ids) => ids.join("|") !== first)) {
      domChanged = true;
      changedRoutes.add(route);
      any = true;
    }
  }
  return any ? { stale, domChanged, ...(!domChangedUnscoped && changedRoutes.size > 0 ? { domChangedRoutes: [...changedRoutes] } : {}) } : undefined;
}

/* The content the agent re-read even though the prompt already held it, summed over the turns that measured it. */
function fileReadsOf(turns: readonly EvidenceAgentTurn[]): number | undefined {
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

export function contextOf(spans: readonly LedgerSpan[], turns: readonly EvidenceAgentTurn[], snapshots: readonly EvidenceSpecSnapshot[]): ContextEvidence | undefined {
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
export function limitIntentOf(spans: readonly LedgerSpan[], role: string | undefined): string | undefined {
  if (!role) return undefined;
  const ofRole = spans.filter((s) => {
    if (!isTurn(s)) return false;
    const a = attrsOf(s);
    return a[AGENT_NAME_ATTR] === role || a[AGENT_ROLE_ATTR] === role;
  });
  const fired = ofRole.filter((s) => {
    const limit = attrsOf(s)[LIMIT_FIRED_ATTR];
    return typeof limit === "string" && isBindingLimit(limit);
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
