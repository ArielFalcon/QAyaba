/*
 * A checkpoint of a run: its state, the digest of the specs it holds and the step it stands after. It is data: a JSON round trip
 * keeps it whole, it holds no handle, and every string in it passed the run's secret redaction. Taking one stores nothing and
 * resumes nothing; a run reports one after each step only when its caller asked (`RunQaUseCaseDeps.onCheckpoint`).
 *
 * The open review round's scratch (`state.review.session.current`: the suite snapshot's bytes and the findings' spec map) is left
 * out, because it is not data; a checkpoint taken inside a round therefore stands for the round's start, not for the round's middle.
 */

import type { RunContext, WorkspaceRunContext } from "./run-context.ts";
import type { LoopCounters, RunState } from "./run-state.ts";
import { EMPTY_SPEC_SET_DIGEST } from "./spec-set-digest.ts";
import type { StepId } from "./step-ids.ts";

export interface RunCheckpoint {
  version: 1;
  runId: string;
  stepId: StepId;
  state: RunState;
  /** The digest of the specs the run has delivered, as the working copy holds them now: the digest of the empty set while the run has no working copy or no spec yet, `unreadable` when a delivered spec cannot be read. */
  workspaceDigest: string;
  loops: LoopCounters;
}

const UNREADABLE = "unreadable";

/* The same value with every string redacted by the run's secrets. */
function redacted(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redacted(item, redact));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redacted(item, redact)]));
  return value;
}

function workspaceDigestOf(state: Readonly<RunState>, ctx: RunContext): string {
  const files = state.generation.delivered.map((spec) => spec.file);
  if (files.length === 0 || !("services" in ctx)) return EMPTY_SPEC_SET_DIGEST;
  return (ctx as WorkspaceRunContext).services.specDigest(files) ?? UNREADABLE;
}

/* Pure but for the digest, which reads the delivered specs through the run's confined reader, and the redaction, which uses the active run's secrets. */
export function checkpointOf(state: Readonly<RunState>, ctx: RunContext, stepId: StepId): RunCheckpoint {
  const { session } = state.review;
  const withoutScratch: RunState = { ...state, review: { ...state.review, session: session === undefined ? undefined : { ...session, current: undefined } } };
  const plain = JSON.parse(JSON.stringify(withoutScratch)) as RunState;
  return {
    version: 1,
    runId: ctx.input.runId,
    stepId,
    state: redacted(plain, ctx.host.redact) as RunState,
    workspaceDigest: workspaceDigestOf(state, ctx),
    loops: { ...state.loops },
  };
}
