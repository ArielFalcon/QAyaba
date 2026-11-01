import { test } from "node:test";
import assert from "node:assert/strict";
import { SubmissionRegistry } from "@contexts/agent-tools/infrastructure/submission-registry.ts";
import { SUBMIT_TOOL, type SubmissionContract } from "@kernel/submission.ts";

type Plan = { flows: string[] };

const planContract: SubmissionContract<Plan> = {
  tool: SUBMIT_TOOL.PLAN,
  check: (answer) => {
    const flows = (answer as { flows?: unknown } | null)?.flows;
    if (!Array.isArray(flows)) return { ok: false, errors: [{ path: "flows", reason: "it is not a list" }] };
    const bad = flows.findIndex((flow) => typeof flow !== "string");
    return bad >= 0 ? { ok: false, errors: [{ path: `flows[${bad}]`, reason: "it is not text" }] } : { ok: true, value: { flows: flows as string[] } };
  },
};

const call = (over: Partial<{ agent: string; tool: string; answer: unknown }> = {}) => ({ sessionId: "ses-1", agent: "qa-lead", tool: SUBMIT_TOOL.PLAN, answer: { flows: ["a"] }, ...over });
const registry = () => new SubmissionRegistry({ redact: (text) => text.replaceAll("SECRET", "[REDACTED]") });

test("a malformed submission is told the path and the reason, and the corrected one is accepted in the same turn", () => {
  const live = registry();
  const slot = live.arm("ses-1", "qa-lead", planContract);
  const first = live.find("ses-1")!.call(call({ answer: { flows: ["a", 2] } }));
  assert.deepEqual(first, { ok: false, code: "invalid-answer", message: first.ok ? "" : first.message, errors: [{ path: "flows[1]", reason: "it is not text" }] });
  const second = live.find("ses-1")!.call(call({ answer: { flows: ["a", "b"] } }));
  assert.equal(second.ok, true);
  assert.deepEqual(slot.report("stopped"), { accepted: true, value: { flows: ["a", "b"] }, calls: 2 });
});

test("a turn that ends after a rejection reports the last rejection's errors and how it ended", () => {
  const live = registry();
  const slot = live.arm("ses-1", "qa-lead", planContract);
  live.find("ses-1")!.call(call({ answer: "nope" }));
  assert.deepEqual(slot.report("output-length"), { accepted: false, calls: 1, errors: [{ path: "flows", reason: "it is not a list" }], end: "output-length" });
});

test("the first accepted answer is the answer: a later call changes nothing", () => {
  const live = registry();
  const slot = live.arm("ses-1", "qa-lead", planContract);
  live.find("ses-1")!.call(call({ answer: { flows: ["first"] } }));
  const later = live.find("ses-1")!.call(call({ answer: { flows: ["second"] } }));
  assert.equal(later.ok, false);
  assert.equal(later.ok ? "" : later.code, "already-submitted");
  assert.deepEqual(slot.report("stopped"), { accepted: true, value: { flows: ["first"] }, calls: 1 });
});

test("another role, or another contract's tool, is refused and nothing is recorded", () => {
  const live = registry();
  const slot = live.arm("ses-1", "qa-lead", planContract);
  const stranger = live.find("ses-1")!.call(call({ agent: "qa-author" }));
  const other = live.find("ses-1")!.call(call({ tool: SUBMIT_TOOL.REVIEW }));
  assert.deepEqual([stranger.ok ? "" : stranger.code, other.ok ? "" : other.code], ["wrong-agent", "wrong-tool"]);
  assert.deepEqual(slot.report("stopped"), { accepted: false, calls: 0, errors: [], end: "stopped" });
});

test("a session no prompt armed, and a session whose prompt ended, find nothing", () => {
  const live = registry();
  assert.equal(live.find("ses-1"), undefined);
  const slot = live.arm("ses-1", "qa-lead", planContract);
  assert.ok(live.find("ses-1"));
  slot.close();
  assert.equal(live.find("ses-1"), undefined);
  assert.equal(live.size, 0);
});

test("a session is armed for one prompt at a time: the next prompt's contract replaces the last, and closing the old slot does not disarm the new", () => {
  const live = registry();
  const old = live.arm("ses-1", "qa-lead", planContract);
  const review: SubmissionContract<string> = { tool: SUBMIT_TOOL.FLOW_REVIEW, check: () => ({ ok: true, value: "r" }) };
  live.arm("ses-1", "qa-lead", review);
  old.close();
  assert.equal(live.find("ses-1")!.call(call({ tool: SUBMIT_TOOL.FLOW_REVIEW })).ok, true);
});

test("errors the model reads are redacted and bounded", () => {
  const live = registry();
  const noisy: SubmissionContract<never> = {
    tool: SUBMIT_TOOL.PLAN,
    check: () => ({ ok: false, errors: Array.from({ length: 40 }, (_, i) => ({ path: `p${i} SECRET`, reason: `${"x".repeat(1_000)} SECRET` })) }),
  };
  live.arm("ses-1", "qa-lead", noisy);
  const response = live.find("ses-1")!.call(call());
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.errors!.length, 20);
  assert.ok(response.errors!.every((error) => error.reason.length <= 300 && !error.path.includes("SECRET") && !error.reason.includes("SECRET")));
});
