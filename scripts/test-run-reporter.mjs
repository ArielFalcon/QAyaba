/*
 * The machine-readable reporter scripts/run-tests.mjs gives each worker: one JSON object per line for
 * every test and suite that ended, `{ file, name, ok, cancelled, skip, todo, ms, suite, nesting }`. The runner adds
 * them up into the totals and, with --record-timings, the top-level durations of each file into
 * scripts/test-timings.json.
 */
export default async function* runTestsReporter(source) {
  for await (const { type, data } of source) {
    if (type !== "test:pass" && type !== "test:fail") continue;
    yield `${JSON.stringify({
      file: data.file ?? null,
      name: data.name,
      ok: type === "test:pass",
      cancelled: data.details?.error?.failureType === "cancelledByParent",
      skip: Boolean(data.skip),
      todo: Boolean(data.todo),
      ms: data.details?.duration_ms ?? 0,
      suite: data.details?.type === "suite",
      nesting: data.nesting,
    })}\n`;
  }
}
