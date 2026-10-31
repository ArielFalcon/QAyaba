import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunContext as buildContext, buildRunChatContext as buildChatContext, recentOutcomesContext, type AssistantRunRecord, type AssistantTextDeps } from "@contexts/operator-assistant/application/index.ts";
import type { RunVerdict } from "@kernel/run-verdict.ts";
import { sanitizeText } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";

const infraErrorGloss = (errorClass: string): string => `gloss(${errorClass})`;
const deps: AssistantTextDeps = { sanitize: (text) => sanitizeText(text).text, infraErrorGloss };
const buildRunChatContext = (): string => buildChatContext(deps);
const buildRunContext = (record: AssistantRunRecord, limits?: { maxCases: number; caseDetailChars: number; logTailChars: number }): string => buildContext(record, deps, limits ? { limits } : {});

const rec = (over: Partial<AssistantRunRecord> = {}): AssistantRunRecord => ({
  app: "portfolio",
  sha: "abcdef1234567890",
  target: "e2e",
  mode: "diff",
  status: "done",
  verdict: "fail",
  passed: 1,
  failed: 1,
  cases: [
    { name: "login", status: "pass" },
    { name: "checkout", status: "fail", detail: "timed out waiting for the pay button" },
  ],
  logs: ["[qa] running...", "leaked password=hunter2 in a log line"],
  ...over,
});

test("buildRunContext includes verdict + failing case detail, and is sanitized on ingress", () => {
  const ctx = buildRunContext(rec());
  assert.match(ctx, /Verdict: fail/);
  assert.match(ctx, /checkout/);
  assert.match(ctx, /timed out/);
  assert.doesNotMatch(ctx, /hunter2/); /* a secret in the logs is redacted */
});

test("buildRunContext redacts a case's detail before cutting it: a token straddling the cut leaves no part of itself", () => {
  const words = "timed out waiting for the pay button while the page reloaded ";
  const detail = `${words.repeat(5).slice(0, 288)}sk-${"Q7x9Zk2M".repeat(6)} and more`;
  const ctx = buildRunContext(rec({ cases: [{ name: "checkout", status: "fail", detail }] }), { maxCases: 5, caseDetailChars: 300, logTailChars: 100 });
  assert.match(ctx, /timed out waiting/);
  assert.doesNotMatch(ctx, /sk-Q7x9/);
});

test("buildRunContext caps the case list and reports the overflow", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ name: `t${i}`, status: "pass" as const }));
  const ctx = buildRunContext(rec({ cases: many }), { maxCases: 5, caseDetailChars: 50, logTailChars: 100 });
  assert.match(ctx, /and 25 more/);
});

test("buildRunContext includes the note when present", () => {
  const ctx = buildRunContext(rec({ note: "retry exhausted" }));
  assert.match(ctx, /Note: retry exhausted/);
});

test("buildRunContext shows 'running' when verdict is undefined", () => {
  const ctx = buildRunContext(rec({ verdict: undefined }));
  assert.match(ctx, /Verdict: running/);
});

test("buildRunContext omits cases section when there are none", () => {
  const ctx = buildRunContext(rec({ cases: [] }));
  assert.doesNotMatch(ctx, /Cases:/);
});

test("buildRunContext omits logs section when logs are empty", () => {
  const ctx = buildRunContext(rec({ logs: [] }));
  assert.doesNotMatch(ctx, /Logs/);
});

test("buildRunContext preserves complete log lines — does not split mid-line", () => {
  const lineOne = "first-line";
  const lineTwo = ".".repeat(200);
  const lineThree = "last";
  const budgetFitsTwo = lineTwo.length + lineThree.length + 10;

  const ctx = buildRunContext(
    rec({ logs: [lineOne, lineTwo, lineThree] }),
    { maxCases: 0, caseDetailChars: 50, logTailChars: budgetFitsTwo },
  );

  assert.match(ctx, new RegExp(lineThree));
  assert.match(ctx, new RegExp(lineTwo));
  assert.doesNotMatch(ctx, new RegExp(lineOne));
});

test("the assistant is told an infra-error can be the agent running out of steps or deciding nothing, not only DEV", () => {
  const legend = buildRunChatContext();
  assert.ok(legend.includes(infraErrorGloss("E-STEP-BUDGET")));
  assert.ok(legend.includes(infraErrorGloss("E-NO-DECISION")));
  assert.ok(legend.includes(infraErrorGloss("E-PRECONDITION")));
  const line = legend.split("\n").find((l) => l.startsWith("· infra-error")) ?? "";
  assert.notEqual(line, "");
  assert.doesNotMatch(line, /^· infra-error → DEV/);
});

test("the assistant is told a skipped run is one where the agent declared a no-op", () => {
  const line = buildRunChatContext().split("\n").find((l) => l.startsWith("· skipped")) ?? "";
  assert.match(line, /declared/i);
});

const outcome = (over: { verdict?: RunVerdict; errorClass?: string | null } = {}) => ({ verdict: "fail" as RunVerdict, errorClass: null as string | null, mode: "diff" as const, target: "e2e" as const, sha: "abcdef1234567", ...over });

test("an app with no recent outcome has no outcomes block", () => {
  assert.equal(recentOutcomesContext([]), null);
});

test("the outcomes block lists the five newest with their class, mode, target and short sha, and counts all it was given", () => {
  const outcomes = [outcome({ errorClass: "E-EXEC-FAIL" }), ...Array.from({ length: 6 }, () => outcome({ verdict: "pass" }))];
  const block = recentOutcomesContext(outcomes)!;
  assert.match(block, /^## Learning state for this app\n\n### Recent outcomes \(7\):\n- fail E-EXEC-FAIL \(diff\/e2e, abcdef1\)\n- pass \(diff\/e2e, abcdef1\)/);
  assert.equal(block.split("\n").filter((l) => l.startsWith("- ")).length, 5);
});

test("the outcomes block is cut past its cap", () => {
  const block = recentOutcomesContext([outcome({ errorClass: "E".repeat(4000) })])!;
  assert.ok(block.endsWith("\n…(truncated)"));
  assert.equal(block.length, 3000 + "\n…(truncated)".length);
});

test("the run context carries the app, the live activity and the outcomes block the caller supplies", () => {
  const ctx = buildContext(rec(), deps, { appInfo: { repo: "org/app", baseUrl: "http://dev.example" }, activityContext: "writing specs", learningContext: "## Outcomes block" });
  assert.match(ctx, /Repository: org\/app   DEV URL: http:\/\/dev\.example/);
  assert.match(ctx, /Agent activity: writing specs/);
  assert.match(ctx, /\n## Outcomes block$/);
});
