/*
 * The lesson kinds: what a run's observations of DEV can teach, derived when read and never stored (docs/architecture/rfc/0013-learning-slice.md).
 *
 * An observation is a fact about DEV read in one run: the page it concerned, what the run's served-version state was, whether the read was trusted
 * and, when it was not, the one typed reason it was left out. A lesson is a pure function of the admitted observations of one scope; no run's verdict,
 * error class or adjudication is an input to either, and no count threshold decides whether one exists.
 */

import type { ServedVersionState } from "@kernel/served-version.ts";
import type { PageDataRead } from "@kernel/page-data-read.ts";

export const LESSON_KIND_IDS = ["data-volatility"] as const;
export type LessonKindId = (typeof LESSON_KIND_IDS)[number];

/* Why a read is not an input to a lesson. Exactly one per left-out read. */
export type LeftOutReason = `served-version:${ServedVersionState}` | "not-captured" | "no-data-state" | "unconfirmed-read";

/* The part of a read a lesson is derived from. */
export interface ObservedFact {
  resultCount?: number;
  emptyConfirmed?: boolean;
  ready?: boolean;
}

export interface LessonObservation {
  id: string;
  app: string;
  runId: string;
  sha: string;
  repo: string;
  kind: LessonKindId;
  scope: string;
  servedState: ServedVersionState;
  admitted: boolean;
  /* Null when admitted. */
  leftOutReason: LeftOutReason | null;
  fact: ObservedFact;
  /* ISO time of the read. */
  at: string;
}

export type Admission = { admitted: true } | { admitted: false; reason: LeftOutReason };

/* What a lesson states of a scope: the admitted reads, by the two states they showed, and the latest one. */
export interface Lesson {
  kind: LessonKindId;
  scope: string;
  /* Admitted reads that showed results. */
  withResults: number;
  /* Admitted reads that showed an empty state confirmed on two settled reads. */
  emptyConfirmed: number;
  /* ISO time of the latest admitted read. */
  latestReadAt: string;
  /* The runs whose reads the lesson rests on, sorted. */
  evidence: readonly string[];
}

export interface LessonKind {
  readonly id: LessonKindId;
  /* The served-version states under which a read is DEV's data at the commit under test. */
  readonly admittedServedStates: readonly ServedVersionState[];
  /* Whether a page read, made in a run whose anchor repo was in `served`, is an input to this kind. */
  admit(read: PageDataRead, served: ServedVersionState): Admission;
  /* The part of an admitted read the kind keeps. */
  factOf(read: PageDataRead): ObservedFact;
  /* The lessons the admitted observations of one app state; order of the input is not significant. */
  derive(admitted: readonly LessonObservation[]): Lesson[];
}
