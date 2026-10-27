import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Score } from "@contexts/evaluation/application/index";
import { MAX_SCORE_COMMENT_CHARS } from "@contexts/evaluation/application/index";
import { LangfuseScoreSink, langfuseScoreId, resolveLangfuseConfig, scoreConfigsOfCatalog, scoreSinkHealthOf, type LangfuseConfig } from "./langfuse-score-sink";

const CONFIG: LangfuseConfig = { baseUrl: "http://langfuse-web:3000", publicKey: "pk-lf-public", secretKey: "sk-lf-secret" };
const AUTH = `Basic ${Buffer.from("pk-lf-public:sk-lf-secret").toString("base64")}`;
const RUN_END = "2026-10-17T11:00:00.000Z";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}
type Responder = (call: Call) => { status: number; body?: unknown } | Error;

function rig(respond: Responder = () => ({ status: 200, body: {} }), over: { traceId?: string | null; config?: LangfuseConfig } = {}) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: String(input), method: init?.method ?? "GET", headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined };
    calls.push(call);
    const out = respond(call);
    if (out instanceof Error) throw out;
    return new Response(JSON.stringify(out.body ?? {}), { status: out.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const time = { ms: Date.parse("2026-10-17T12:00:00.000Z") };
  const sink = new LangfuseScoreSink({
    config: over.config ?? CONFIG,
    traceIdOf: () => (over.traceId === undefined ? "a".repeat(32) : over.traceId),
    sanitize: (text) => text.replaceAll("hunter2", "[redacted]"),
    fetch: fetchImpl,
    now: () => new Date(time.ms++).toISOString(),
    timeoutMs: 1_000,
    log: (m) => logs.push(m),
  });
  return { sink, calls, logs, time };
}

const score = (over: Partial<Score> & Pick<Score, "name" | "value" | "dataType">): Score => ({ polarity: "none", source: "deterministic", graderVersion: "1", ...over });
const posted = (calls: Call[]): Call[] => calls.filter((c) => c.method === "POST" && c.url.endsWith("/api/public/scores"));

const env = (url: string, extra: Record<string, string> = {}): Record<string, string> => ({ LANGFUSE_BASE_URL: url, LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", ...extra });
const resolve = (e: Record<string, string>) => {
  const warnings: string[] = [];
  return { config: resolveLangfuseConfig(e, (m) => warnings.push(m)), warnings };
};

test("the sink is configured only when the base URL and both keys are set", () => {
  assert.deepEqual(resolve(env("http://langfuse-web:3000/")).config, { baseUrl: "http://langfuse-web:3000", publicKey: "pk", secretKey: "sk" });
  for (const missing of ["LANGFUSE_BASE_URL", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"]) {
    const e = env("http://langfuse-web:3000");
    delete e[missing];
    const r = resolve(e);
    assert.equal(r.config, undefined, missing);
    assert.deepEqual(r.warnings, [], "an unset sink is the normal case, not a warning");
  }
  assert.equal(resolve(env("")).config, undefined);
});

test("the keys are sent only to the langfuse-web host, loopback, or an https address", () => {
  for (const url of ["http://langfuse-web:3000", "http://localhost:3002", "http://127.0.0.1:3002", "http://127.4.5.6:3000", "http://[::1]:3000", "https://langfuse.example.com", "HTTP://LANGFUSE-WEB:3000"]) {
    assert.ok(resolve(env(url)).config, url);
  }
});

test("any other host leaves the sink unconfigured with a clear warning, unless external hosts are explicitly allowed", () => {
  for (const url of ["http://langfuse.example.com", "http://10.0.0.5:3000", "http://langfuse-web.evil.com:3000", "http://localhost.evil.com"]) {
    const r = resolve(env(url));
    assert.equal(r.config, undefined, url);
    assert.equal(r.warnings.length, 1, url);
    assert.match(r.warnings[0]!, /LANGFUSE_ALLOW_EXTERNAL/);
    assert.ok(!r.warnings[0]!.includes("sk"), "the warning names no key");
    assert.ok(resolve(env(url, { LANGFUSE_ALLOW_EXTERNAL: "true" })).config, `${url} with the opt-in`);
  }
  assert.equal(resolve(env("http://langfuse.example.com", { LANGFUSE_ALLOW_EXTERNAL: "yes" })).config, undefined, "only the exact value true opts in");
});

test("an address that is not a URL or not http(s) leaves the sink unconfigured with a warning, even with the opt-in", () => {
  for (const url of ["ftp://langfuse-web", "not a url", "http://user:pw@langfuse-web:3000"]) {
    const r = resolve(env(url, { LANGFUSE_ALLOW_EXTERNAL: "true" }));
    assert.equal(r.config, undefined, url);
    assert.match(r.warnings[0] ?? "", /LANGFUSE_BASE_URL/);
  }
});

test("a score is posted with Basic auth, a deterministic id, the run's trace and the run's end as its timestamp", async () => {
  const { sink, calls } = rig();
  await sink.emit("run-1", [score({ name: "spec_pass_rate", value: 0.5, dataType: "NUMERIC", comment: "1 of 2 specs passed", observationId: "b".repeat(16) })], RUN_END);
  const [call] = posted(calls);
  assert.equal(call!.url, "http://langfuse-web:3000/api/public/scores");
  assert.equal(call!.headers.Authorization, AUTH);
  assert.equal(call!.headers["Content-Type"], "application/json");
  assert.deepEqual(call!.body, {
    id: createHash("sha256").update("run-1:spec_pass_rate:1").digest("hex"),
    traceId: "a".repeat(32),
    observationId: "b".repeat(16),
    name: "spec_pass_rate",
    value: 0.5,
    dataType: "NUMERIC",
    comment: "1 of 2 specs passed",
    timestamp: RUN_END,
  });
});

test("the score id depends on the run, the name and the grader version, so a regrade at the same version replaces and a new version adds", () => {
  const id = langfuseScoreId("run-1", "spec_pass_rate", "1");
  assert.equal(id, langfuseScoreId("run-1", "spec_pass_rate", "1"));
  assert.notEqual(id, langfuseScoreId("run-2", "spec_pass_rate", "1"));
  assert.notEqual(id, langfuseScoreId("run-1", "spec_validity_rate", "1"));
  assert.notEqual(id, langfuseScoreId("run-1", "spec_pass_rate", "2"));
});

test("a boolean goes as 0 or 1 and a category as its string, each with its own data type", async () => {
  const { sink, calls } = rig();
  await sink.emit("run-1", [score({ name: "empty_output_guard", value: true, dataType: "BOOLEAN" }), score({ name: "approval_consistent", value: false, dataType: "BOOLEAN" }), score({ name: "furthest_phase", value: "execute", dataType: "CATEGORICAL" })], RUN_END);
  assert.deepEqual(posted(calls).map((c) => [c.body!.name, c.body!.value, c.body!.dataType]), [["empty_output_guard", 1, "BOOLEAN"], ["approval_consistent", 0, "BOOLEAN"], ["furthest_phase", "execute", "CATEGORICAL"]]);
});

test("a comment is redacted and capped before it leaves, and an absent one is not sent", async () => {
  const { sink, calls } = rig();
  await sink.emit("run-1", [score({ name: "infra_error", value: "none", dataType: "CATEGORICAL", comment: `password hunter2 ${"x".repeat(2_000)}` }), score({ name: "closed_loop_refusals", value: 0.1, dataType: "NUMERIC" })], RUN_END);
  const [first, second] = posted(calls);
  assert.ok(!String(first!.body!.comment).includes("hunter2"));
  assert.ok(String(first!.body!.comment).length <= MAX_SCORE_COMMENT_CHARS);
  assert.equal("comment" in second!.body!, false);
});

test("a score with a catalog config carries its configId once the configs are ensured", async () => {
  const { sink, calls } = rig((call) => {
    if (call.method === "GET") return { status: 200, body: { data: [{ id: "cfg-1", name: "spec_pass_rate" }], meta: { page: 1, limit: 100, totalItems: 1, totalPages: 1 } } };
    return { status: 200, body: { id: "cfg-new" } };
  });
  await sink.ensureScoreConfigs();
  await sink.emit("run-1", [score({ name: "spec_pass_rate", value: 1, dataType: "NUMERIC" })], RUN_END);
  assert.equal(posted(calls)[0]!.body!.configId, "cfg-1");
});

test("the score configs are created once per catalog score, skipping those that exist, with the catalog's range and categories", async () => {
  const existing = ["spec_pass_rate"];
  const { sink, calls } = rig((call) => {
    if (call.method === "GET") return { status: 200, body: { data: existing.map((name) => ({ id: `id-${name}`, name })), meta: { page: 1, limit: 100, totalItems: 1, totalPages: 1 } } };
    return { status: 200, body: { id: `new-${String(call.body!.name)}` } };
  });
  const result = await sink.ensureScoreConfigs();
  const created = calls.filter((c) => c.method === "POST" && c.url.endsWith("/api/public/score-configs")).map((c) => c.body!);
  const byName = new Map(created.map((b) => [b.name as string, b]));
  assert.ok(!byName.has("spec_pass_rate"), "an existing config is not created again");
  assert.deepEqual(byName.get("closed_loop_refusals"), { name: "closed_loop_refusals", dataType: "NUMERIC", minValue: 0, maxValue: 1 });
  assert.deepEqual(byName.get("empty_output_guard"), { name: "empty_output_guard", dataType: "BOOLEAN" });
  const phase = byName.get("furthest_phase") as { categories: Array<{ label: string; value: number }> };
  assert.ok(phase.categories.length > 3);
  assert.deepEqual(phase.categories.map((c) => c.value), phase.categories.map((_, i) => i));
  assert.ok(byName.has("step_intent_mix.explore"), "a family is expanded to one config per suffix");
  assert.ok(!byName.has("step_intent_mix"), "the family base is not itself a score");
  assert.equal(result.created, created.length);
  assert.ok(result.skipped >= 1);
});

test("a config that already exists (a race, or a listing that missed it) is tolerated", async () => {
  const { sink } = rig((call) => (call.method === "GET" ? { status: 200, body: { data: [], meta: { page: 1, limit: 100, totalItems: 0, totalPages: 1 } } } : { status: 409, body: { message: "Score config name already exists" } }));
  const result = await sink.ensureScoreConfigs();
  assert.equal(result.failed, 0);
  assert.equal(sink.status().lastError, undefined);
});

test("existing configs are read across pages", async () => {
  const pages: number[] = [];
  const { sink } = rig((call) => {
    if (call.method !== "GET") return { status: 200, body: { id: "x" } };
    const page = Number(new URL(call.url).searchParams.get("page"));
    pages.push(page);
    return { status: 200, body: { data: [{ id: `id-${page}`, name: page === 1 ? "spec_pass_rate" : "closed_loop_refusals" }], meta: { page, limit: 1, totalItems: 2, totalPages: 2 } } };
  });
  await sink.ensureScoreConfigs();
  assert.deepEqual(pages, [1, 2]);
});

test("a Langfuse outage never throws and is counted in the health; no score is posted while the configs are not ensured", async () => {
  const { sink, calls } = rig(() => new Error("connect ECONNREFUSED 10.0.0.2:3000"));
  await sink.emit("run-1", [score({ name: "spec_pass_rate", value: 1, dataType: "NUMERIC" }), score({ name: "closed_loop_refusals", value: 1, dataType: "NUMERIC" })], RUN_END);
  assert.equal(posted(calls).length, 0, "no score goes before its config exists");
  const health = sink.status();
  assert.equal(health.configured, true);
  assert.match(health.lastError ?? "", /ECONNREFUSED/);
  assert.equal(health.faults, 1);
  assert.equal(health.lastExportAt, undefined);
});

test("while the configs are not ensured, retries are limited to one attempt per 60 seconds", async () => {
  let up = false;
  const { sink, calls, time } = rig((call) => (up ? { status: 200, body: call.method === "GET" ? { data: [], meta: { totalPages: 1 } } : { id: "x" } } : new Error("connect ECONNREFUSED")));
  const one = [score({ name: "spec_pass_rate", value: 1, dataType: "NUMERIC" })];
  await sink.emit("run-1", one, RUN_END);
  const afterFirst = calls.length;
  assert.ok(afterFirst >= 1);
  await sink.emit("run-2", one, RUN_END);
  time.ms += 59_000;
  await sink.emit("run-3", one, RUN_END);
  assert.equal(calls.length, afterFirst, "no request inside the backoff window");
  assert.equal(sink.status().faults, 3, "each skipped emission is a fault");
  up = true;
  time.ms += 2_000;
  await sink.emit("run-4", one, RUN_END);
  assert.equal(posted(calls).length, 1, "the first attempt after the window ensures the configs and posts");
  assert.ok(calls.some((c) => c.url.includes("/api/public/score-configs") && c.method === "POST"));
});

test("a partial ensure keeps scores back, so no score of one name lands both with and without its config", async () => {
  let failing = true;
  const { sink, calls, time } = rig((call) => {
    if (call.method === "GET" && call.url.includes("score-configs")) return { status: 200, body: { data: [], meta: { totalPages: 1 } } };
    if (call.url.endsWith("/api/public/score-configs")) return failing && call.body!.name === "closed_loop_refusals" ? { status: 400, body: { message: "bad" } } : { status: 200, body: { id: `cfg-${String(call.body!.name)}` } };
    return { status: 200 };
  });
  const scores = [score({ name: "spec_pass_rate", value: 1, dataType: "NUMERIC" }), score({ name: "closed_loop_refusals", value: 0.1, dataType: "NUMERIC" })];
  await sink.emit("run-1", scores, RUN_END);
  assert.equal(posted(calls).length, 0, "one config failed, so nothing is posted");
  failing = false;
  time.ms += 61_000;
  await sink.emit("run-2", scores, RUN_END);
  const sent = posted(calls);
  assert.equal(sent.length, 2);
  for (const call of sent) assert.ok(call.body!.configId, `${String(call.body!.name)} went without its config`);
});

test("an HTTP error on one score is recorded and the other scores still go", async () => {
  const { sink, calls } = rig((call) => (call.body?.name === "bad" ? { status: 400, body: { message: "invalid" } } : { status: 200 }));
  await sink.emit("run-1", [score({ name: "bad", value: 1, dataType: "NUMERIC" }), score({ name: "good", value: 1, dataType: "NUMERIC" })], RUN_END);
  assert.equal(posted(calls).length, 2);
  assert.match(sink.status().lastError ?? "", /400/);
  assert.ok(sink.status().lastExportAt);
});

test("a success clears nothing it did not cause but stamps lastExportAt", async () => {
  const { sink } = rig();
  assert.equal(sink.status().lastExportAt, undefined);
  await sink.emit("run-1", [score({ name: "spec_pass_rate", value: 1, dataType: "NUMERIC" })], RUN_END);
  assert.match(sink.status().lastExportAt ?? "", /^2026-10-17T12:00:00/);
});

test("neither key ever appears in the health, the log or a recorded error", async () => {
  const { sink, logs } = rig((call) => (call.method === "POST" ? new Error(`request to ${CONFIG.baseUrl} failed: Authorization ${AUTH} pk-lf-public sk-lf-secret`) : { status: 200 }));
  await sink.emit("run-1", [score({ name: "a", value: 1, dataType: "NUMERIC" })], RUN_END);
  const everything = JSON.stringify([sink.status(), logs]);
  for (const secret of [CONFIG.publicKey, CONFIG.secretKey, AUTH.slice(6)]) assert.ok(!everything.includes(secret), `${secret} leaked`);
});

test("a run with no trace id is skipped and said, never sent to a wrong trace", async () => {
  const { sink, calls, logs } = rig(undefined, { traceId: null });
  await sink.emit("run-1", [score({ name: "a", value: 1, dataType: "NUMERIC" })], RUN_END);
  assert.equal(calls.length, 0);
  assert.ok(logs.some((l) => l.includes("run-1")));
});

test("a request that outlasts the timeout is abandoned and counted, not waited on", async () => {
  const hanging = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
  const sink = new LangfuseScoreSink({ config: CONFIG, traceIdOf: () => "a".repeat(32), sanitize: (t) => t, fetch: hanging, timeoutMs: 20, log: () => undefined });
  await sink.emit("run-1", [score({ name: "a", value: 1, dataType: "NUMERIC" })], RUN_END);
  assert.match(sink.status().lastError ?? "", /abort|timeout/i);
});

test("the score configs of the catalog name every graded score exactly once", () => {
  const configs = scoreConfigsOfCatalog();
  const names = configs.map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes("spec_pass_rate"));
  assert.ok(!names.includes("selector_stability"), "a pending score is not configured until a grader emits it");
});

test("the health of an unconfigured sink says so and carries nothing else", () => {
  assert.deepEqual(scoreSinkHealthOf(undefined), { configured: false });
  assert.deepEqual(scoreSinkHealthOf(rig().sink), { configured: true });
});

test("the boot call and the first emission share one ensure: Langfuse is listed once", async () => {
  const { sink, calls } = rig((call) => (call.method === "GET" ? { status: 200, body: { data: [], meta: { totalPages: 1 } } } : { status: 200, body: { id: "x" } }));
  await Promise.all([sink.ensureScoreConfigs(), sink.emit("run-1", [score({ name: "spec_pass_rate", value: 1, dataType: "NUMERIC" })], RUN_END)]);
  assert.equal(calls.filter((c) => c.method === "GET").length, 1);
  assert.equal(posted(calls).length, 1);
});

test("lastError is the latest failure, not the first", async () => {
  const { sink, time } = rig(() => new Error("connect ECONNREFUSED first"));
  await sink.emit("run-1", [score({ name: "a", value: 1, dataType: "NUMERIC" })], RUN_END);
  assert.match(sink.status().lastError ?? "", /first/);
  time.ms += 61_000;
  await sink.emit("run-2", [score({ name: "a", value: 1, dataType: "NUMERIC" })], RUN_END);
  /* Inside the new backoff window the emission is held back, and that is now the latest error. */
  await sink.emit("run-3", [score({ name: "a", value: 1, dataType: "NUMERIC" })], RUN_END);
  assert.match(sink.status().lastError ?? "", /not ensured/);
});
