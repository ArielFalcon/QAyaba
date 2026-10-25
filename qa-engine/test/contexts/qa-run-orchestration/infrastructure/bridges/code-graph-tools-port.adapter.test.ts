import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { err, ok, type Result } from "@kernel/result.ts";
import type { CodeExplorePort, ExploreAnswer } from "@kernel/ports/code-explore.port.ts";
import type { CodeGraphUnavailable } from "@kernel/code/index.ts";
import type { Attrs } from "@kernel/telemetry/attribute-registry.ts";
import { NoopTelemetry } from "@kernel/telemetry/noop-telemetry.ts";
import type { SpanHandle, StartSpanOptions } from "@kernel/telemetry/telemetry.port.ts";
import { CodeGraphToolsPortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/code-graph-tools-port.adapter.ts";
import { CodeGraphToolRegistry } from "@contexts/qa-run-orchestration/infrastructure/code-graph-tool-registry.ts";
import { admitCodeGraphQuery } from "@contexts/qa-run-orchestration/domain/code-graph-query.ts";

/* The engine's own text for `explore formatMoney OrdersPage`, as recorded: three files, a blast radius and a list of names not shown. */
const ENGINE_TEXT = readFileSync(new URL("../../../../shared-infrastructure/code-graph/__fixtures__/codegraph/explore.txt", import.meta.url), "utf8");

interface Seen { calls: Array<{ repoDir: string; terms: readonly string[]; maxFiles: number }> }

function adapter(over: { answer?: Result<ExploreAnswer, CodeGraphUnavailable>; canCall?: boolean; maxCalls?: number; maxFiles?: number; maxAnswerChars?: number; redact?: (t: string) => string; telemetry?: NoopTelemetry } = {}) {
  const seen: Seen = { calls: [] };
  const registry = new CodeGraphToolRegistry();
  const explore: CodeExplorePort = {
    explore: async (repoDir, terms, maxFiles) => {
      seen.calls.push({ repoDir, terms, maxFiles });
      return over.answer ?? ok({ text: ENGINE_TEXT, indexedSha: "abc1234" });
    },
  };
  const port = new CodeGraphToolsPortAdapter({
    registry,
    explore,
    repoDir: "/mirrors/webapp",
    generatorRuntimeCanCall: () => over.canCall ?? true,
    limits: { maxCalls: over.maxCalls ?? 40, maxFiles: over.maxFiles ?? 8, maxAnswerChars: over.maxAnswerChars ?? 12_000 },
    ...(over.redact ? { redact: over.redact } : {}),
    ...(over.telemetry ? { trace: { telemetry: over.telemetry, clock: { now: () => 1 } } } : {}),
  });
  return { port, registry, seen };
}

const explore = admitCodeGraphQuery({ action: "explore", terms: ["formatMoney", "OrdersPage"] })!;
const request = (agent = "qa-generator") => ({ sessionId: "lead", agent, query: explore });

async function granted(over: Parameters<typeof adapter>[0] = {}) {
  const a = adapter(over);
  const handle = (await a.port.open({ runId: "r1" }))!;
  a.registry.bindSession({ sessionId: "lead", runId: "r1", agent: "qa-generator" });
  return { ...a, handle, live: a.registry.find("lead")! };
}

test("an explore call asks the run's index for the lead's terms, in the run's repo, with the orchestrator's own file cap, and carries the index commit", async () => {
  const { live, seen, handle } = await granted({ maxFiles: 3 });
  const answer = await live.call(request());
  assert.ok(answer.ok);
  if (!answer.ok) return;
  assert.deepEqual(seen.calls, [{ repoDir: "/mirrors/webapp", terms: ["formatMoney", "OrdersPage"], maxFiles: 3 }]);
  assert.equal(answer.indexedSha, "abc1234");
  assert.equal(answer.callsLeft, 39);
  assert.equal(answer.truncated, false);
  assert.equal(answer.result, ENGINE_TEXT.trim());
  assert.deepEqual(handle.signals(), { calls: 1, refused: 0, failed: 0 });
});

test("nothing is granted when the lead's runtime cannot call a custom tool", async () => {
  assert.equal(await adapter({ canCall: false }).port.open({ runId: "r1" }), undefined);
});

test("calls stop at the run's cap, another role is refused, and a closed grant answers nothing", async () => {
  const { handle, live, registry } = await granted({ maxCalls: 1 });
  assert.equal((await live.call(request("qa-sidekick"))).ok, false);
  assert.equal((await live.call(request())).ok, true);
  const spent = await live.call(request());
  assert.equal(spent.ok ? "" : spent.code, "no-calls");
  handle.close();
  assert.equal(registry.find("lead"), undefined, "the run's right is gone");
  const revoked = await live.call(request());
  assert.equal(revoked.ok ? "" : revoked.code, "revoked");
  assert.deepEqual(handle.signals(), { calls: 1, refused: 3, failed: 0 });
});

test("an index that cannot answer is a failed call that repeats nothing of the engine's own reason", async () => {
  const { live, handle } = await granted({ answer: err({ reason: "spawn failed: /app/data/code-graph/webapp/codegraph.db is locked" }) });
  const failed = await live.call(request());
  assert.equal(failed.ok, false);
  assert.equal(failed.ok ? "" : failed.code, "failed");
  assert.ok(!JSON.stringify(failed).includes("codegraph.db"), "the engine's reason is not repeated");
  assert.deepEqual(handle.signals(), { calls: 1, refused: 0, failed: 1 });
});

/* A redaction by value and by pattern, as the run's secret scope does both. */
const byValueAndPattern = (text: string) => text.split("pa\"ss\\word").join("[redacted]").replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]");

test("the answer is redacted as text, by value and by pattern, before it is cut and before the lead reads it", async () => {
  const leaky = ENGINE_TEXT.replace("return Math.round(amount * 100) / 100;", "return AKIAABCDEFGHIJKLMNOP + 'pa\"ss\\word';");
  assert.notEqual(leaky, ENGINE_TEXT);
  const { live } = await granted({ answer: ok({ text: leaky, indexedSha: "abc1234" }), redact: byValueAndPattern });
  const answer = await live.call(request());
  assert.ok(answer.ok);
  if (!answer.ok) return;
  assert.ok(!answer.result.includes("AKIAABCDEFGHIJKLMNOP") && !answer.result.includes("pa\"ss\\word"));
  assert.match(answer.result, /\[redacted\]/);
});

/* The engine's text split the way the answer must be cut: the file sections, each from its heading to the next. */
const fileHeadings = (text: string) => [...text.matchAll(/^\*\*`([^`]+)`\*\*/gm)].map((m) => m[1]!);
const fences = (text: string) => text.split("\n").filter((line) => line.startsWith("```")).length;

test("a long answer is cut only at a file boundary, never inside a code block, and says what it left out", async () => {
  const all = fileHeadings(ENGINE_TEXT);
  assert.equal(all.length, 3);
  const second = ENGINE_TEXT.indexOf(`**\`${all[1]}\`**`);
  /* Room for the first file and the marker, and for part of the second: the second must go whole. */
  const max = second + 100;
  const { live } = await granted({ maxAnswerChars: max });
  const answer = await live.call(request());
  assert.ok(answer.ok);
  if (!answer.ok) return;
  assert.equal(answer.truncated, true);
  assert.ok(answer.result.length <= max);
  assert.deepEqual(fileHeadings(answer.result), [all[0]], "only whole files are kept");
  assert.equal(fences(answer.result) % 2, 0, "every code block that starts also ends");
  assert.ok(answer.result.includes(ENGINE_TEXT.slice(ENGINE_TEXT.indexOf(`**\`${all[0]}\`**`), second).trim()), "the kept file is the engine's, byte for byte");
  assert.match(answer.result, /omitted/i, "an omission marker closes the answer");
  assert.ok(!answer.result.includes("Not shown above"), "a section after the cut is left out too");
});

test("an answer none of whose files fit is the engine's opening and a marker, with no code cut", async () => {
  const first = ENGINE_TEXT.indexOf(`**\`${fileHeadings(ENGINE_TEXT)[0]}\`**`);
  const max = first + 150;
  const { live } = await granted({ maxAnswerChars: max });
  const answer = await live.call(request());
  assert.ok(answer.ok);
  if (!answer.ok) return;
  assert.equal(answer.truncated, true);
  assert.ok(answer.result.length <= max);
  assert.deepEqual(fileHeadings(answer.result), []);
  assert.equal(fences(answer.result), 0);
  assert.match(answer.result, /omitted/i);
});

test("an answer too long even for its opening is only a marker that asks for narrower terms", async () => {
  const { live } = await granted({ maxAnswerChars: 120 });
  const answer = await live.call(request());
  assert.ok(answer.ok);
  if (!answer.ok) return;
  assert.equal(answer.truncated, true);
  assert.ok(answer.result.length <= 120);
  assert.match(answer.result, /omitted/i);
  assert.equal(answer.result.includes("Exploration"), false);
});

class RecordingTelemetry extends NoopTelemetry {
  readonly spans: Array<{ name: string; attrs: Attrs }> = [];
  override startSpan(name: string, opts?: StartSpanOptions): SpanHandle {
    const record = { name, attrs: { ...(opts?.attrs ?? {}) } as Attrs };
    this.spans.push(record);
    return { ...super.startSpan(name, opts), setAttrs: (attrs: Attrs) => void Object.assign(record.attrs, attrs) };
  }
}

test("the call is a tool span named for the codegraph tool, with how it ended and the commit of the index it read", async () => {
  const telemetry = new RecordingTelemetry();
  const { live } = await granted({ telemetry });
  await live.call(request());
  const span = telemetry.spans.find((s) => s.name === "qayaba.tool.codegraph");
  assert.ok(span);
  assert.equal(span.attrs["qayaba.tool.outcome"], "ok");
  assert.equal(span.attrs["qayaba.code_graph.sha"], "abc1234");
});
