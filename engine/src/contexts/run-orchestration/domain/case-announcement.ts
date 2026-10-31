import type { RunEventBody } from "@kernel/contract/events.ts";
import type { QaCase } from "@kernel/qa-case.ts";

/* How a case was last announced while the run was live. */
export type LiveAnnouncedStatus = "passed" | "failed" | "flaky";

/* The case and status a live event announces, when it announces one. */
export function liveAnnouncement(body: RunEventBody): { name: string; status: LiveAnnouncedStatus } | undefined {
  if ((body.type === "test.passed" || body.type === "test.failed" || body.type === "test.flaky") && typeof (body as { name?: unknown }).name === "string") {
    return { name: (body as { name: string }).name, status: body.type.slice("test.".length) as LiveAnnouncedStatus };
  }
  return undefined;
}

/* Maps a final QaCase.status into the live vocabulary, to compare the store's own truth against what was last announced. */
function finalStatusAsAnnounced(status: QaCase["status"]): LiveAnnouncedStatus {
  return status === "pass" ? "passed" : status === "fail" ? "failed" : "flaky";
}

/* The terminal event a case still owes: none when it was announced live with the status it ended with, so its event publishes once; otherwise the event of its final status (the correcting one when the live status diverged). */
export function terminalCaseEvent(c: QaCase, lastAnnounced: LiveAnnouncedStatus | undefined): RunEventBody | undefined {
  if (lastAnnounced !== undefined && lastAnnounced === finalStatusAsAnnounced(c.status)) return undefined;
  return c.status === "pass"
    ? { type: "test.passed", name: c.name, durationMs: c.durationMs ?? 0 }
    : c.status === "fail"
      ? { type: "test.failed", name: c.name, detail: c.detail, ...(c.durationMs !== undefined ? { durationMs: c.durationMs } : {}) }
      : { type: "test.flaky", name: c.name, attempts: 2 };
}
