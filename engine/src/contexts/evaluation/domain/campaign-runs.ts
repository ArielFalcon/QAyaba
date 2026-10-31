/*
 * The runs of a campaign as a consumer polls them (docs/observability-design.md section 14, GET /campaigns/:id/runs).
 *
 * The server never sees the matrix a client requested (items x variants x replicates), so "complete" is what it can know: every run it
 * holds for the campaign, narrowed by the filter the caller named, is over and graded. A client that knows how many runs it queued
 * also compares the count.
 */

export type EvaluationState = "pending" | "complete" | "failed";

export interface CampaignRunRow {
  readonly id: string;
  readonly variant: Readonly<Record<string, string>>;
  readonly replicate: number;
  /* The run's status: enqueued, running or done. */
  readonly status: string;
  readonly verdict: string | null;
  /* Null: never graded. */
  readonly evaluationStatus: string | null;
}

export interface CampaignRunView {
  id: string;
  variant: Record<string, string>;
  replicate: number;
  status: "enqueued" | "running" | "done";
  verdict?: string;
  evaluationStatus: EvaluationState;
}

const STATUSES = ["enqueued", "running", "done"] as const;

function evaluationState(value: string | null): EvaluationState {
  return value === "complete" || value === "failed" ? value : "pending";
}

/* A run matches when it carries every label of the filter with the same value. An empty filter matches everything. */
export function matchesVariant(variant: Readonly<Record<string, string>>, filter: Readonly<Record<string, string>>): boolean {
  return Object.entries(filter).every(([key, value]) => Object.hasOwn(variant, key) && variant[key] === value);
}

export function campaignRunsView(rows: readonly CampaignRunRow[], filter: Readonly<Record<string, string>> = {}): { runs: CampaignRunView[]; complete: boolean } {
  const runs: CampaignRunView[] = rows
    .filter((r) => matchesVariant(r.variant, filter))
    .map((r) => ({
      id: r.id,
      variant: { ...r.variant },
      replicate: r.replicate,
      status: (STATUSES as readonly string[]).includes(r.status) ? (r.status as CampaignRunView["status"]) : "enqueued",
      ...(r.verdict !== null ? { verdict: r.verdict } : {}),
      evaluationStatus: evaluationState(r.evaluationStatus),
    }));
  return { runs, complete: runs.length > 0 && runs.every((r) => r.status === "done" && r.evaluationStatus === "complete") };
}
