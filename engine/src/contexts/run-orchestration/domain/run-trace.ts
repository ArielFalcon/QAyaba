/*
 * The trace of one run, as far as it is a decision: what started the run, who it is on its spans, how it ended (the first verdict
 * wins, a crash outranks a verdict but never a cancel and forces `infra-error`) and the facts the root span states of that ending.
 */
import type { RunVerdict } from "@kernel/run-verdict.ts";
import type { RunDegradationFact, RunLimitFact } from "@kernel/run-trace-facts.ts";
import type { CaptureMode } from "@kernel/telemetry/capture-mode.ts";
import { attrKey } from "@kernel/telemetry/attribute-registry.ts";

/* What started a run. `campaign` is a run that names the campaign it is a replicate of. */
export const RUN_TRIGGERS = ["webhook", "api", "cli", "campaign", "continuation", "context", "login-bootstrap"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/* The campaign replicate a run is: recorded on the trace as data, never read to decide anything. */
export interface RunCampaign {
  readonly id: string;
  readonly variant: Readonly<Record<string, string>>;
  readonly replicate: number;
}

/* What the host did to the process while a run was active. */
export interface HostEventListener {
  /* The process was frozen for `ms` while wall time moved. `at` is wall-clock ms when it was noticed. */
  hostSuspended(ms: number, at: number): void;
  /* The event loop was blocked for about `ms`. */
  eventLoopBlocked(ms: number, at: number): void;
  /* The largest event-loop delay of the window that just closed, in ms (called for every sample, blocked or not). */
  eventLoopObserved(maxMs: number): void;
}

export interface RunIdentity {
  /* The engine build that ran the run. */
  engineVersion: string;
  runId: string;
  app: string;
  sha: string;
  mode: string;
  target: string;
  trigger: RunTrigger;
  parentRunId?: string | undefined;
  triggerRepo?: string | undefined;
  shadow?: boolean | undefined;
  campaign?: RunCampaign | undefined;
  /* The content capture the run asked for, already capped by the server's ceiling. Absent: the run takes the process default. */
  captureMode?: CaptureMode | undefined;
}

/* What of a run's request its identity is made of. */
export interface RunIdentityRequest {
  app: string;
  sha: string;
  mode: string;
  target: string;
  /* What started the run, when the door said; absent: "api" for a manual source, "webhook" otherwise. */
  trigger?: RunTrigger | undefined;
  source?: string | undefined;
  parentRunId?: string | undefined;
  triggerRepo?: string | undefined;
  shadow?: boolean | undefined;
  campaign?: RunCampaign | undefined;
}

/* A run that names its campaign is a campaign run, whichever door it came through. */
export function runTriggerOf(req: Pick<RunIdentityRequest, "campaign" | "trigger" | "source">): RunTrigger {
  return req.campaign ? "campaign" : (req.trigger ?? (req.source === "manual" ? "api" : "webhook"));
}

export function runIdentityOf(req: RunIdentityRequest, run: { runId: string; engineVersion: string; captureMode: CaptureMode | undefined }): RunIdentity {
  return {
    engineVersion: run.engineVersion,
    runId: run.runId,
    app: req.app,
    sha: req.sha,
    mode: req.mode,
    target: req.target,
    trigger: runTriggerOf(req),
    parentRunId: req.parentRunId,
    triggerRepo: req.triggerRepo,
    shadow: req.shadow,
    campaign: req.campaign,
    captureMode: run.captureMode,
  };
}

/* The campaign's identity as root attributes: the id, the replicate and one attribute per variant label. */
function campaignAttrs(campaign: RunCampaign | undefined): Record<string, string | number> {
  if (!campaign) return {};
  const out: Record<string, string | number> = { "qayaba.campaign.id": campaign.id, "qayaba.campaign.replicate": campaign.replicate };
  /* A registry template key is one dot-free segment, and a label key may hold dots: the attribute spells them as underscores (the stored variant keeps the key as given; keys differing only by '.' versus '_' collapse onto one attribute). */
  for (const [key, value] of Object.entries(campaign.variant)) out[attrKey.campaignVariant(key.replaceAll(".", "_"))] = value;
  return out;
}

/* The attributes the enqueue span and the root both carry. */
export function identityAttrs(identity: RunIdentity) {
  return {
    "qayaba.engine.version": identity.engineVersion,
    "qayaba.run.id": identity.runId,
    "qayaba.app": identity.app,
    "qayaba.commit.sha": identity.sha,
    "qayaba.mode": identity.mode,
    "qayaba.target": identity.target,
    "qayaba.trigger": identity.trigger,
    ...(identity.parentRunId ? { "qayaba.parent_run.id": identity.parentRunId } : {}),
    ...(identity.triggerRepo ? { "qayaba.trigger_repo": identity.triggerRepo } : {}),
    ...(identity.shadow !== undefined ? { "qayaba.shadow": identity.shadow } : {}),
    ...campaignAttrs(identity.campaign),
  };
}

/* What the engine told about how a run ended. */
export interface RunFacts {
  verdict: RunVerdict;
  errorClass: string | null;
  furthestPhase?: string | undefined;
  decision?: string | undefined;
  shadowed?: boolean | undefined;
  generationEnd?: string | undefined;
  endReason?: string | undefined;
  limitFired?: string | undefined;
  limitRole?: string | undefined;
  /* Every limit that fired and every fault the run went on past; absent when the engine recorded none of either list. */
  limits?: readonly RunLimitFact[] | undefined;
  degradations?: readonly RunDegradationFact[] | undefined;
  reviewRequired?: boolean | undefined;
  /* The kind of run the deadline bounded it as. */
  timeBudget?: string | undefined;
  coverage?: { status?: "pass" | "fail" | "unknown" | undefined; mode: string; minRatio?: number | undefined } | undefined;
  /* Delivered specs and how many of them validated/passed; absent when the run recorded none. */
  specs?: { generated: number; valid: number | null; passed?: number | undefined } | undefined;
}

/* The root's final facts as attributes, whether the run returned a verdict or crashed: one place, so the two cannot disagree. */
export function factsAttrs(f: RunFacts): Record<string, string | number | boolean | string[]> {
  return {
    "qayaba.verdict": f.verdict,
    ...(f.errorClass ? { "qayaba.error_class": f.errorClass } : {}),
    ...(f.generationEnd ? { "qayaba.generation.end": f.generationEnd } : {}),
    ...(f.endReason ? { "qayaba.run.end_reason": f.endReason } : {}),
    ...(f.decision ? { "qayaba.decision": f.decision } : {}),
    ...(f.shadowed !== undefined ? { "qayaba.decision.shadowed": f.shadowed } : {}),
    ...(f.furthestPhase ? { "qayaba.furthest_phase": f.furthestPhase } : {}),
    ...(f.limitFired ? { "qayaba.limit.fired": f.limitFired } : {}),
    ...(f.limits?.find((limit) => limit.purpose !== undefined) ? { "qayaba.limit.purpose": f.limits.find((limit) => limit.purpose !== undefined)!.purpose! } : {}),
    ...(f.limits ? { "qayaba.limits": f.limits.map((limit) => `${limit.fired}@${limit.role}`) } : {}),
    ...(f.degradations ? { "qayaba.degradations": f.degradations.map((d) => d.reason) } : {}),
    ...(f.specs
      ? {
          "qayaba.specs.generated": f.specs.generated,
          ...(f.specs.valid !== null ? { "qayaba.specs.valid": f.specs.valid } : {}),
          ...(f.specs.passed !== undefined ? { "qayaba.specs.passed": f.specs.passed } : {}),
        }
      : {}),
  };
}

/* One count per limit the engine met at run level (the turns' own are on the turn spans); a record with no list leads with its one limit. */
export function runLevelLimits(f: Pick<RunFacts, "limits" | "limitFired" | "limitRole">): Array<{ fired: string; role: string }> {
  return f.limits?.filter((limit) => limit.scope === "run") ?? (f.limitFired ? [{ fired: f.limitFired, role: f.limitRole ?? "" }] : []);
}

export type Ending = { kind: "facts"; facts: RunFacts } | { kind: "cancelled" } | { kind: "crashed"; error: unknown; facts: RunFacts };

/* How a run ended, as its trace is told. */
export class RunEnding {
  private ending: Ending | undefined;

  /* The run reached a verdict: the first one wins. */
  finished(facts: RunFacts): void {
    this.ending ??= { kind: "facts", facts };
  }

  /* An operator cancelled the run: not an error, and nothing the engine said afterwards counts. */
  cancelled(): void {
    this.ending = { kind: "cancelled" };
  }

  /* An exception out of the engine or the runner's own recording of the run. It outranks a verdict set earlier (the record says infra-error then, and the trace must say the same), but never a cancel. The facts the caller knows by then are set exactly as the normal exit sets them. */
  crashed(error: unknown, errorClass: string, facts: Omit<RunFacts, "verdict" | "errorClass"> = {}): void {
    if (this.ending?.kind === "cancelled") return;
    this.ending = { kind: "crashed", error, facts: { ...facts, verdict: "infra-error", errorClass } };
  }

  get current(): Ending | undefined {
    return this.ending;
  }
}
