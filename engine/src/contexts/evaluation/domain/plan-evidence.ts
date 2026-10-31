/*
 * The lead's plan as the run kept it (`run_plans`), with each flow's result in the final execution. The stored plan is untrusted
 * JSON: an entry of another shape is left out, and a plan that does not read as one is no plan.
 */
import type { PlanEvidence } from "./run-evaluation-evidence.ts";
import type { EvidenceRunRecord } from "./evidence-sources.ts";
import { asStringArray } from "./ledger-span.ts";
import { ranInFinalExecution, specOfCase } from "./spec-evidence.ts";

/*
 * The plan the run kept, with each flow's result in the final execution: a flow passed when it delivered its spec and every case the
 * report ties to that spec passed. A flow that delivered nothing did not pass. Whether a delivered flow passed is unknown when the run
 * did not execute, or when no case can be tied to its spec. A plan that does not read as one is no plan.
 */
export function planEvidenceOf(raw: string | undefined, record: Pick<EvidenceRunRecord, "cases" | "verdict">): PlanEvidence | undefined {
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
  const executed = ranInFinalExecution(record);
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

const CANDIDATE_STATES = new Set(["planned", "dropped", "unplanned"]);

/* The use cases the plan had to answer for, as the run kept them; an entry of another shape is left out. */
function planCandidatesOf(value: unknown): PlanEvidence["candidates"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    const c = entry as { id?: unknown; state?: unknown; reason?: unknown; pages?: unknown; contradicted?: { basis?: unknown; why?: unknown } | null } | null;
    if (c === null || typeof c !== "object" || typeof c.id !== "string" || typeof c.state !== "string" || !CANDIDATE_STATES.has(c.state)) return [];
    return [{ id: c.id, state: c.state as "planned" | "dropped" | "unplanned", ...(typeof c.reason === "string" ? { reason: c.reason } : {}), ...(Array.isArray(c.pages) ? { pages: asStringArray(c.pages) } : {}), ...(typeof c.contradicted?.basis === "string" && typeof c.contradicted.why === "string" ? { contradicted: { basis: c.contradicted.basis, why: c.contradicted.why } } : {}) }];
  });
}

function flowCandidatesOf(value: unknown): PlanEvidence["flows"][number]["candidates"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    const c = entry as { id?: unknown; claimed?: unknown } | null;
    return c !== null && typeof c === "object" && typeof c.id === "string" ? [{ id: c.id, ...(typeof c.claimed === "string" ? { claimed: c.claimed } : {}) }] : [];
  });
}
