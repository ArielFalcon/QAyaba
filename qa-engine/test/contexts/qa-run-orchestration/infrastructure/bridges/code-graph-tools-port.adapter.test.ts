import { test } from "node:test";
import assert from "node:assert/strict";
import { CodeGraphToolsPortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/code-graph-tools-port.adapter.ts";
import { CodeGraphToolRegistry } from "@contexts/qa-run-orchestration/infrastructure/code-graph-tool-registry.ts";
import { admitCodeGraphQuery } from "@contexts/qa-run-orchestration/domain/code-graph-query.ts";

interface Seen { calls: Array<{ tool: string; json: string; repoDir: string; timeoutMs: number | undefined }> }

function adapter(over: { answer?: { code: number | null; stdout: string; stderr: string }; project?: string | undefined; canCall?: boolean; maxCalls?: number; maxAnswerChars?: number; redact?: (t: string) => string } = {}) {
  const seen: Seen = { calls: [] };
  const registry = new CodeGraphToolRegistry();
  const port = new CodeGraphToolsPortAdapter({
    registry,
    client: { cli: async (tool, json, repoDir, timeoutMs) => { seen.calls.push({ tool, json, repoDir, timeoutMs }); return over.answer ?? { code: 0, stdout: '{"results":[]}', stderr: "level=info" }; } },
    resolver: { resolve: async () => ("project" in over ? over.project : "app-webapp") },
    repoDir: "/mirrors/webapp",
    generatorRuntimeCanCall: () => over.canCall ?? true,
    limits: { maxCalls: over.maxCalls ?? 40, perCallMs: 5_000, maxAnswerChars: over.maxAnswerChars ?? 12_000 },
    ...(over.redact ? { redact: over.redact } : {}),
  });
  return { port, registry, seen };
}

const search = admitCodeGraphQuery({ action: "search_graph", name_pattern: ".*Store.*" })!;
const request = (agent = "qa-generator") => ({ sessionId: "lead", agent, query: search });

test("a run whose app is in the graph grants the lead its project: the call runs the graph's CLI on that project, in the app's mirror, bounded in time", async () => {
  const { port, registry, seen } = adapter();
  const handle = await port.open({ runId: "r1" });
  assert.ok(handle);
  registry.bindSession({ sessionId: "lead", runId: "r1", agent: "qa-generator" });
  const answer = await registry.find("lead")!.call(request());
  assert.deepEqual(answer, { ok: true, result: '{"results":[]}', truncated: false, callsLeft: 39 });
  assert.equal(seen.calls[0]!.tool, "search_graph");
  assert.equal(JSON.parse(seen.calls[0]!.json).project, "app-webapp");
  assert.equal(seen.calls[0]!.repoDir, "/mirrors/webapp");
  assert.equal(seen.calls[0]!.timeoutMs, 5_000);
  assert.deepEqual(handle.signals(), { calls: 1, refused: 0, failed: 0 });
});

test("nothing is granted when the app is not in the graph or the lead's runtime cannot call a custom tool", async () => {
  assert.equal(await adapter({ project: undefined }).port.open({ runId: "r1" }), undefined);
  assert.equal(await adapter({ canCall: false }).port.open({ runId: "r1" }), undefined);
});

test("calls stop at the run's cap, another role is refused, and a closed grant answers nothing", async () => {
  const { port, registry } = adapter({ maxCalls: 1 });
  const handle = (await port.open({ runId: "r1" }))!;
  registry.bindSession({ sessionId: "lead", runId: "r1", agent: "qa-generator" });
  const live = registry.find("lead")!;
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

test("a graph that cannot answer is a failed call with no detail of its own, and a long answer is cut and says so", async () => {
  const failing = adapter({ answer: { code: 1, stdout: "", stderr: "secret path /app/.codebase-memory/x.db" } });
  await failing.port.open({ runId: "r1" });
  failing.registry.bindSession({ sessionId: "lead", runId: "r1", agent: "qa-generator" });
  const failed = await failing.registry.find("lead")!.call(request());
  assert.equal(failed.ok, false);
  assert.ok(!JSON.stringify(failed).includes("codebase-memory"), "the CLI's own output is not repeated");

  const long = adapter({ answer: { code: 0, stdout: "y".repeat(200), stderr: "" }, maxAnswerChars: 50, redact: (t) => t.replace(/y/g, "z") });
  await long.port.open({ runId: "r1" });
  long.registry.bindSession({ sessionId: "lead", runId: "r1", agent: "qa-generator" });
  const cut = await long.registry.find("lead")!.call(request());
  assert.ok(cut.ok);
  if (!cut.ok) return;
  assert.equal(cut.truncated, true);
  assert.equal(cut.result.length, 50);
  assert.match(cut.result, /^z+$/, "the answer passes the run's redaction");
});

/* A redaction by value, as the run's secret scope does it. */
const SECRET = 'pa"ss\\word';
const byValue = (text: string) => text.split(SECRET).join("[redacted]");

async function answerTo(stdout: string, maxAnswerChars = 12_000) {
  const a = adapter({ answer: { code: 0, stdout, stderr: "" }, maxAnswerChars, redact: byValue });
  await a.port.open({ runId: "r1" });
  a.registry.bindSession({ sessionId: "lead", runId: "r1", agent: "qa-generator" });
  const answer = await a.registry.find("lead")!.call(request());
  assert.ok(answer.ok);
  return answer as Extract<typeof answer, { ok: true }>;
}

test("a secret inside a JSON string is redacted though the JSON escapes it", async () => {
  const stdout = JSON.stringify({ results: [{ name: "Login", source: `const password = '${SECRET}';` }] });
  assert.ok(!stdout.includes(SECRET), "the JSON text holds the secret only escaped");
  const answer = await answerTo(stdout);
  assert.ok(!answer.result.includes("pa\\\"ss"), "nothing of the escaped secret is left");
  assert.match(answer.result, /\[redacted\]/);
  assert.deepEqual(JSON.parse(answer.result).results[0].name, "Login");
});

test("a JSON answer too long for the lead is cut by its structure and is still JSON", async () => {
  const stdout = JSON.stringify({ total: 40, results: Array.from({ length: 40 }, (_, i) => ({ name: `Symbol${i}`, file: `src/s${i}.ts` })) });
  const answer = await answerTo(stdout, 400);
  assert.equal(answer.truncated, true);
  assert.ok(answer.result.length <= 400);
  const parsed = JSON.parse(answer.result);
  assert.equal(parsed.total, 40);
  assert.ok(parsed.results.length > 0 && parsed.results.length < 40, "entries are dropped from the end");
  assert.equal(parsed.results[0].name, "Symbol0");

  const snippet = JSON.stringify({ name: "big", source: "x".repeat(5_000) });
  const cut = await answerTo(snippet, 300);
  assert.equal(cut.truncated, true);
  assert.match(JSON.parse(cut.result).source, /… \(cut\)$/);
});
