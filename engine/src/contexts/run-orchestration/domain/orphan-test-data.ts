/* Whether a run's record says it may have left test data in DEV for the next run of the app to clean: it never reached a verdict of its own (still enqueued or running when the next run came) or ended as infra-error. */
export function mayHaveLeftTestData(prior: { status: string; verdict?: string | null | undefined }): boolean {
  return prior.status === "running" || prior.status === "enqueued" || prior.verdict === "infra-error";
}
