/*
 * What the review rounds do next, read off the evidence a step just gathered. Pure: no I/O, no clock. The rounds are a ring of
 * three steps (judge the specs, correct them, resolve the correction); after each, this says which comes next or how the review
 * ends. `approve` and `reject` settle the review with that verdict; the two `end-*` cases end the run.
 */

export type ReviewNext = "correct" | "resolve" | "judge" | "approve" | "reject" | "end-unavailable" | "end-disputed";

export type ReviewTransition =
  /** A round has been judged. `gateApproves`: the reviewer approved with no blocking finding. */
  | { after: "judgment"; round: number; maxRounds: number; unavailable: boolean; parsed: boolean; executedRed: boolean; gateApproves: boolean; unchangedSinceRejection: boolean }
  /**
   * The correction is settled. `produced`: the turn delivered reviewable specs; `allWithdrawn`: every finding was withdrawn with
   * evidence; `disputed`: a rebuttal the run could not check left a finding standing.
   */
  | { after: "correction"; produced: boolean; allWithdrawn: boolean; disputed: boolean }
  /** The regenerated specs went through acceptance. */
  | { after: "acceptance"; accepted: boolean };

export function reviewAction(t: ReviewTransition): ReviewNext {
  switch (t.after) {
    case "judgment":
      if (t.unavailable) return "end-unavailable";
      /* A parse miss fails closed without burning a round. */
      if (!t.parsed) return "reject";
      /* A reviewer that sees a red spec must not approve it. */
      if (t.executedRed) return "reject";
      if (t.gateApproves) return "approve";
      /* Rejected: terminal on the last round, and when another round would regenerate the same bytes. */
      if (t.round >= t.maxRounds - 1) return "reject";
      if (t.unchangedSinceRejection) return "reject";
      return "correct";
    case "correction":
      if (t.produced) return "resolve";
      if (t.allWithdrawn) return "approve";
      return t.disputed ? "end-disputed" : "reject";
    case "acceptance":
      return t.accepted ? "judge" : "reject";
  }
}
