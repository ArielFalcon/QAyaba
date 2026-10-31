import { test } from "node:test";
import assert from "node:assert/strict";
import { liveAnnouncement, terminalCaseEvent } from "@contexts/run-orchestration/domain/case-announcement.ts";
import type { QaCase } from "@kernel/qa-case.ts";

const aCase = (status: QaCase["status"], extra: Partial<QaCase> = {}): QaCase => ({ name: "checkout", status, ...extra } as QaCase);

test("a case announced live with the status it ended with owes no event, and any other case owes the event of its final status", () => {
  assert.equal(terminalCaseEvent(aCase("pass"), "passed"), undefined);
  assert.equal(terminalCaseEvent(aCase("fail"), "failed"), undefined);
  assert.equal(terminalCaseEvent(aCase("flaky"), "flaky"), undefined);
  assert.deepEqual(terminalCaseEvent(aCase("pass", { durationMs: 12 }), undefined), { type: "test.passed", name: "checkout", durationMs: 12 });
  assert.deepEqual(terminalCaseEvent(aCase("pass"), undefined), { type: "test.passed", name: "checkout", durationMs: 0 });
  assert.deepEqual(terminalCaseEvent(aCase("fail", { detail: "boom" }), undefined), { type: "test.failed", name: "checkout", detail: "boom" });
  assert.deepEqual(terminalCaseEvent(aCase("fail", { detail: "boom", durationMs: 5 }), "passed"), { type: "test.failed", name: "checkout", detail: "boom", durationMs: 5 });
  assert.deepEqual(terminalCaseEvent(aCase("flaky"), "failed"), { type: "test.flaky", name: "checkout", attempts: 2 });
});

test("only the live test events announce a case, by the name they carry", () => {
  assert.deepEqual(liveAnnouncement({ type: "test.passed", name: "a", durationMs: 1 }), { name: "a", status: "passed" });
  assert.deepEqual(liveAnnouncement({ type: "test.failed", name: "b" }), { name: "b", status: "failed" });
  assert.deepEqual(liveAnnouncement({ type: "test.flaky", name: "c", attempts: 2 }), { name: "c", status: "flaky" });
  assert.equal(liveAnnouncement({ type: "log.line", level: "info", text: "x" }), undefined);
});
