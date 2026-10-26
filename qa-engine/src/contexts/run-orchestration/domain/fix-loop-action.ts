/*
 * What the fix loop does next, read off the evidence it just gathered. Pure: no I/O, no clock. The loop is a ring of five steps
 * (look at the failure, adjudicate it, regenerate, accept the round or re-execute it); after each, this says which step comes next
 * or why the loop stops. Every `stop` is a named behavior, so a test states each of them and a log line can say which one ended the loop.
 */

import type { RunVerdict } from "@kernel/run-verdict.ts";
import { ADJ_ACTION, type AdjudicatorAction } from "./adjudicate.service.ts";

export type FixLoopStep = "triage" | "adjudicate" | "regenerate" | "accept" | "reexecute";

export type FixLoopStop =
  | "retries-spent"
  | "no-failure-to-fix"
  | "not-generating"
  | "triage-passed"
  | "adjudicated-to-an-issue"
  | "regeneration-retired"
  | "test-correct-claim-verified"
  | "no-fix-delivered"
  | "dev-unhealthy"
  | "revalidation-failed"
  | "round-rejected"
  | "round-capped"
  | "dev-failed-under-the-run";

/** `go` names the next step; `again` says the step opens a new round (the round counter moves on). */
export type FixLoopNext = { go: FixLoopStep; again?: true } | { stop: FixLoopStop };

export type FixLoopTransition =
  /** At the head of a round: is there a failure left to fix, and a retry to spend on it. */
  | { after: "round-start"; retry: number; maxRetries: number; verdict: RunVerdict; generating: boolean }
  /** The look at the failure, which may have re-read it once: `passed` means the same bytes passed the second time. */
  | { after: "triage"; passed: boolean }
  /** The adjudicator's action, and whether the loop may regenerate at all (the specs the generator saw pass are not rewritten). */
  | { after: "adjudication"; action: AdjudicatorAction; regenerate: boolean }
  /**
   * The regeneration: a typed test-correct claim is `verified`, `rejected` (earns one repair) or absent (`none`); `delivered` is
   * the number of specs the turn returned; `absentTargets` is whether the failure-point trees miss the selectors; `accepting` is
   * whether the run has an acceptance for an e2e round.
   */
  | { after: "regeneration"; claim: "verified" | "rejected" | "none"; delivered: number; absentTargets: boolean; isCode: boolean; accepting: boolean }
  /** DEV answered (or not) just before a round's execution; `then` is the step that execution belongs to. */
  | { after: "dev-check"; healthy: boolean; then: "accept" | "reexecute" }
  /** The pre-acceptance retry path: the gate on the regenerated specs. */
  | { after: "revalidation"; ok: boolean }
  /** The acceptance of a round: it was `accepted`, `rejected` (with or without contract deltas to hand back) or `cap`. */
  | { after: "acceptance"; kind: "accepted" | "rejected" | "cap"; violations: boolean }
  /** The re-execution of the retry path: it failed while DEV is not healthy, or it did not. */
  | { after: "reexecution"; failed: boolean; devHealthy: boolean }
;

export function fixLoopAction(t: FixLoopTransition): FixLoopNext {
  switch (t.after) {
    case "round-start":
      if (!t.generating) return { stop: "not-generating" };
      if (t.verdict !== "fail") return { stop: "no-failure-to-fix" };
      if (t.retry >= t.maxRetries) return { stop: "retries-spent" };
      return { go: "triage" };
    case "triage":
      return t.passed ? { stop: "triage-passed" } : { go: "adjudicate" };
    case "adjudication":
      if (t.action !== ADJ_ACTION.CONTINUE) return { stop: "adjudicated-to-an-issue" };
      return t.regenerate ? { go: "regenerate" } : { stop: "regeneration-retired" };
    case "regeneration":
      if (t.claim === "verified") return { stop: "test-correct-claim-verified" };
      if (t.claim === "rejected") return { go: "triage", again: true };
      if (t.delivered === 0) return { stop: "no-fix-delivered" };
      /* Absent selectors: regenerate without re-executing; the next round reads the failure again. */
      if (!t.isCode && t.absentTargets) return { go: "triage", again: true };
      return { go: !t.isCode && t.accepting ? "accept" : "reexecute" };
    case "dev-check":
      return t.healthy ? { go: t.then } : { stop: "dev-unhealthy" };
    case "revalidation":
      return t.ok ? { go: "reexecute" } : { stop: "revalidation-failed" };
    case "acceptance":
      if (t.kind === "cap") return { stop: "round-capped" };
      if (t.kind === "rejected") return t.violations ? { go: "triage", again: true } : { stop: "round-rejected" };
      return { go: "triage", again: true };
    case "reexecution":
      return t.failed && !t.devHealthy ? { stop: "dev-failed-under-the-run" } : { go: "triage", again: true };
  }
}
