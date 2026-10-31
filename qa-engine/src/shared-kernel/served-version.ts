/*
 * The served-version fact: what the product says its DEV serves, set against the commit under test. The product-side reader
 * answers only the commit it serves; the run-orchestration context relates that commit to the run's sha from the mirror's history
 * and records one state of this closed set on every run.
 */

import { InfraError } from "./domain-error.ts";

export const SERVED_VERSION_STATES = ["undeclared", "unreadable", "equal", "behind", "ahead", "unrelated"] as const;
export type ServedVersionState = (typeof SERVED_VERSION_STATES)[number];

/* Why a declared source gave no state to compare. The first four are the reader's; `history-unavailable` is the engine's: the commit was read but the mirror's history could not say how it relates to the run's sha. */
export const UNREADABLE_REASONS = ["unreachable", "http-status", "malformed-body", "no-commit", "history-unavailable"] as const;
export type UnreadableReason = (typeof UNREADABLE_REASONS)[number];

/* One read of a declared source: the commit it serves and whether it reports DEV healthy, or why it gave neither. */
export type ServedVersionRead =
  | { kind: "read"; commit: string; healthy: boolean | undefined }
  | { kind: "unreadable"; reason: Exclude<UnreadableReason, "history-unavailable"> };

/* What the run records for one repo: the state, the typed reason when the state is `unreadable`, the commit DEV served when it was read, and the time spent waiting for a deploy that had not landed (absent when the run did not wait). */
export interface ServedVersionFact {
  state: ServedVersionState;
  reason?: UnreadableReason;
  served?: string;
  waitedMs?: number;
}

/* The run's record: the anchor repo's fact, and each other repo of a run over several repos. */
export interface ServedVersionSignal extends ServedVersionFact {
  companions?: ReadonlyArray<ServedVersionFact & { repo: string }>;
}

/* A gate that ended the run: the deploy did not land in time, or DEV did not report healthy. It carries the fact read last, so the end still records it. */
export class DeployNotServedError extends InfraError {
  constructor(message: string, readonly fact: ServedVersionFact) {
    super(message);
    this.name = "DeployNotServedError";
  }
}
