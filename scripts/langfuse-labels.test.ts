import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { importLabels, main, MAX_RESPONSE_BYTES, parseArguments, type LabelDeps, type LabelRow } from "./langfuse-labels.ts";

const AUTH = `Basic ${Buffer.from("pk-lf-test:sk-lf-test").toString("base64")}`;
const NOW = "2026-10-18T09:00:00.000Z";

interface Seen {
  path: string;
  query: URLSearchParams;
  auth: string | undefined;
}

/* A stand-in for the two Langfuse endpoints the import reads, paged one item at a time so paging is exercised. */
async function fakeLangfuse(pages: { traces?: Array<{ id: string }>; scores: Array<Record<string, unknown>> }) {
  const seen: Seen[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    seen.push({ path: url.pathname, query: url.searchParams, auth: req.headers.authorization });
    const items = url.pathname === "/api/public/traces" ? (pages.traces ?? []) : url.pathname === "/api/public/v2/scores" ? pages.scores : undefined;
    if (!items) {
      res.writeHead(404).end();
      return;
    }
    const page = Number(url.searchParams.get("page") ?? "1");
    const limit = 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: items.slice((page - 1) * limit, page * limit), meta: { page, limit, totalItems: items.length, totalPages: items.length } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { baseUrl, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function deps(baseUrl: string, runs: Record<string, string> = { ["a".repeat(32)]: "run-1", ["b".repeat(32)]: "run-2" }) {
  const saved: LabelRow[] = [];
  const logs: string[] = [];
  const d: LabelDeps = {
    config: { baseUrl, publicKey: "pk-lf-test", secretKey: "sk-lf-test" },
    runIdOfTrace: (traceId) => runs[traceId],
    save: (rows) => void saved.push(...rows),
    sanitize: (text) => text.replaceAll("hunter2", "[redacted]"),
    now: () => NOW,
    out: (line) => logs.push(line),
  };
  return { d, saved, logs };
}

const annotation = (over: Record<string, unknown>): Record<string, unknown> => ({ id: "s", source: "ANNOTATION", timestamp: "2026-10-17T12:00:00.000Z", dataType: "NUMERIC", value: 1, ...over });

test("a command line needs a session or a start date, and refuses anything else", () => {
  assert.deepEqual(parseArguments(["--session", "campaign-1"]), { ok: true, session: "campaign-1", dryRun: false });
  assert.deepEqual(parseArguments(["--since", "2026-10-01", "--name", "approval_consistent", "--dry-run"]), { ok: true, since: "2026-10-01", name: "approval_consistent", dryRun: true });
  assert.match((parseArguments([]) as { problem: string }).problem, /--session or --since is required/);
  assert.match((parseArguments(["--session"]) as { problem: string }).problem, /--session needs a value/);
  assert.match((parseArguments(["--session", "x", "--all"]) as { problem: string }).problem, /unknown argument --all/);
});

test("annotation scores of a session's traces become human rows of their runs, read across pages with the project keys", async () => {
  const lf = await fakeLangfuse({
    traces: [{ id: "a".repeat(32) }, { id: "b".repeat(32) }],
    scores: [
      annotation({ id: "s1", traceId: "a".repeat(32), name: "approval_consistent", dataType: "BOOLEAN", value: 1, comment: "agreed" }),
      annotation({ id: "s2", traceId: "b".repeat(32), name: "furthest_phase", dataType: "CATEGORICAL", value: 0, stringValue: "execute" }),
      annotation({ id: "s3", traceId: "c".repeat(32), name: "spec_pass_rate", value: 0.5 }),
    ],
  });
  try {
    const { d, saved } = deps(lf.baseUrl);
    const result = await importLabels(d, { session: "campaign-1" });
    assert.deepEqual(saved.map((r) => [r.runId, r.name, r.dataType, r.value, r.source, r.graderVersion]), [
      ["run-1", "approval_consistent", "BOOLEAN", true, "human", "human"],
      ["run-2", "furthest_phase", "CATEGORICAL", "execute", "human", "human"],
    ]);
    assert.deepEqual(result, { fetched: 3, imported: 2, unmatched: 1, unsupported: 0 });
    assert.ok(lf.seen.every((s) => s.auth === AUTH), "every request is signed with the project keys");
    const scoreCalls = lf.seen.filter((s) => s.path === "/api/public/v2/scores");
    assert.equal(scoreCalls.length, 3, "three pages");
    assert.equal(scoreCalls[0]!.query.get("source"), "ANNOTATION");
    assert.equal(lf.seen.find((s) => s.path === "/api/public/traces")!.query.get("sessionId"), "campaign-1");
  } finally {
    await lf.close();
  }
});

test("with a start date alone, scores are filtered by time and a name and every trace of a known run counts", async () => {
  const lf = await fakeLangfuse({ scores: [annotation({ traceId: "a".repeat(32), name: "spec_pass_rate", value: 0.25 })] });
  try {
    const { d, saved } = deps(lf.baseUrl);
    await importLabels(d, { since: "2026-10-01T00:00:00.000Z", name: "spec_pass_rate" });
    const call = lf.seen.find((s) => s.path === "/api/public/v2/scores")!;
    assert.equal(call.query.get("fromTimestamp"), "2026-10-01T00:00:00.000Z");
    assert.equal(call.query.get("name"), "spec_pass_rate");
    assert.equal(lf.seen.some((s) => s.path === "/api/public/traces"), false);
    assert.deepEqual(saved.map((r) => [r.runId, r.value, r.polarity]), [["run-1", 0.25, "higher_better"]]);
  } finally {
    await lf.close();
  }
});

test("two annotations of one score on one run keep the latest, and an unsupported data type is counted, not stored", async () => {
  const lf = await fakeLangfuse({
    scores: [
      annotation({ id: "old", traceId: "a".repeat(32), name: "spec_pass_rate", value: 0.1, timestamp: "2026-10-16T00:00:00.000Z" }),
      annotation({ id: "new", traceId: "a".repeat(32), name: "spec_pass_rate", value: 0.9, timestamp: "2026-10-17T00:00:00.000Z", comment: "password hunter2" }),
      annotation({ id: "txt", traceId: "a".repeat(32), name: "notes", dataType: "TEXT", value: null, stringValue: "free text" }),
    ],
  });
  try {
    const { d, saved } = deps(lf.baseUrl);
    const result = await importLabels(d, { since: "2026-10-01" });
    assert.deepEqual(saved.map((r) => [r.name, r.value]), [["spec_pass_rate", 0.9]]);
    assert.ok(!String(saved[0]!.comment).includes("hunter2"));
    assert.equal(result.unsupported, 1);
  } finally {
    await lf.close();
  }
});

test("a Langfuse that rejects the keys stops the import loudly without echoing them", async () => {
  const server = createServer((_req, res) => void res.writeHead(401).end("bad key sk-lf-test"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const { d, saved } = deps(baseUrl);
    await assert.rejects(importLabels(d, { since: "2026-10-01" }), (error: Error) => /401/.test(error.message) && !error.message.includes("sk-lf-test"));
    assert.equal(saved.length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("main prints the counts, writes nothing on a dry run and returns 2 on a bad command line", async () => {
  const lf = await fakeLangfuse({ scores: [annotation({ traceId: "a".repeat(32), name: "spec_pass_rate", value: 1 })] });
  try {
    const dry = deps(lf.baseUrl);
    assert.equal(await main(["--since", "2026-10-01", "--dry-run"], dry.d), 0);
    assert.equal(dry.saved.length, 0);
    assert.match(dry.logs.join("\n"), /dry run: 1 label\(s\) would be imported/);
    const real = deps(lf.baseUrl);
    assert.equal(await main(["--since", "2026-10-01"], real.d), 0);
    assert.equal(real.saved.length, 1);
    assert.match(real.logs.join("\n"), /imported 1 label\(s\)/);
    const bad = deps(lf.baseUrl);
    assert.equal(await main([], bad.d), 2);
    assert.match(bad.logs.join("\n"), /usage: npm run langfuse:labels/);
  } finally {
    await lf.close();
  }
});

test("only catalog names are imported: a made-up name, a family member and a family base behave as the catalog says", async () => {
  const lf = await fakeLangfuse({
    scores: [
      annotation({ traceId: "a".repeat(32), name: "invented_score", value: 1 }),
      annotation({ traceId: "a".repeat(32), name: "step_intent_mix.explore", value: 0.5 }),
      annotation({ traceId: "a".repeat(32), name: "step_intent_mix.nope", value: 0.5 }),
      annotation({ traceId: "a".repeat(32), name: "x".repeat(129), value: 1 }),
    ],
  });
  try {
    const { d, saved } = deps(lf.baseUrl);
    const result = await importLabels(d, { since: "2026-10-01" });
    assert.deepEqual(saved.map((r) => r.name), ["step_intent_mix.explore"]);
    assert.equal(result.unsupported, 3);
  } finally {
    await lf.close();
  }
});

test("a categorical value must belong to the catalog's closed set when it has one, and is capped otherwise", async () => {
  const lf = await fakeLangfuse({
    scores: [
      annotation({ traceId: "a".repeat(32), name: "furthest_phase", dataType: "CATEGORICAL", value: 0, stringValue: "not-a-phase" }),
      annotation({ traceId: "b".repeat(32), name: "furthest_phase", dataType: "CATEGORICAL", value: 0, stringValue: "execute" }),
      annotation({ traceId: "a".repeat(32), name: "infra_error", dataType: "CATEGORICAL", value: 0, stringValue: "e".repeat(257) }),
      annotation({ traceId: "b".repeat(32), name: "infra_error", dataType: "CATEGORICAL", value: 0, stringValue: "E-SANDBOX" }),
    ],
  });
  try {
    const { d, saved } = deps(lf.baseUrl);
    const result = await importLabels(d, { since: "2026-10-01" });
    assert.deepEqual(saved.map((r) => [r.runId, r.name, r.value]), [["run-2", "furthest_phase", "execute"], ["run-2", "infra_error", "E-SANDBOX"]]);
    assert.equal(result.unsupported, 2);
  } finally {
    await lf.close();
  }
});

test("an observation id longer than 200 characters is dropped, not stored", async () => {
  const lf = await fakeLangfuse({ scores: [annotation({ traceId: "a".repeat(32), name: "spec_pass_rate", value: 1, observationId: "o".repeat(201) }), annotation({ traceId: "b".repeat(32), name: "spec_pass_rate", value: 1, observationId: "o".repeat(200) })] });
  try {
    const { d, saved } = deps(lf.baseUrl);
    await importLabels(d, { since: "2026-10-01" });
    assert.deepEqual(saved.map((r) => r.observationId?.length ?? null), [null, 200]);
  } finally {
    await lf.close();
  }
});

test("the latest annotation is chosen by parsed time, not by string order, and by arrival order when a time cannot be parsed", async () => {
  const lf = await fakeLangfuse({
    scores: [
      /* As text "2026-10-17T09:00:00+02:00" sorts after "2026-10-17T08:30:00Z", yet it is the earlier instant (07:00Z). */
      annotation({ traceId: "a".repeat(32), name: "spec_pass_rate", value: 0.1, timestamp: "2026-10-17T09:00:00+02:00" }),
      annotation({ traceId: "a".repeat(32), name: "spec_pass_rate", value: 0.2, timestamp: "2026-10-17T08:30:00Z" }),
      annotation({ traceId: "b".repeat(32), name: "spec_pass_rate", value: 0.3, timestamp: "garbage" }),
      annotation({ traceId: "b".repeat(32), name: "spec_pass_rate", value: 0.4, timestamp: "also garbage" }),
    ],
  });
  try {
    const { d, saved } = deps(lf.baseUrl);
    await importLabels(d, { since: "2026-10-01" });
    assert.deepEqual(saved.map((r) => [r.runId, r.value]), [["run-1", 0.2], ["run-2", 0.4]]);
  } finally {
    await lf.close();
  }
});

test("a trace is resolved to its run once per import, however many labels it has", async () => {
  const lf = await fakeLangfuse({ scores: ["spec_pass_rate", "closed_loop_refusals", "spec_validity_rate"].map((name) => annotation({ traceId: "a".repeat(32), name, value: 1 })).concat([annotation({ traceId: "z".repeat(32), name: "spec_pass_rate", value: 1 }), annotation({ traceId: "z".repeat(32), name: "closed_loop_refusals", value: 1 })]) });
  try {
    const { d } = deps(lf.baseUrl);
    const lookups: string[] = [];
    const inner = d.runIdOfTrace;
    d.runIdOfTrace = (traceId) => (lookups.push(traceId), inner(traceId));
    await importLabels(d, { since: "2026-10-01" });
    assert.deepEqual(lookups.sort(), ["a".repeat(32), "z".repeat(32)], "an unknown trace is not looked up again either");
  } finally {
    await lf.close();
  }
});

test("a response over the size cap, or more pages than the cap, stops the import loudly", async () => {
  const big = createServer((_req, res) => void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [], pad: "p".repeat(MAX_RESPONSE_BYTES + 1), meta: { totalPages: 1 } })));
  await new Promise<void>((resolve) => big.listen(0, "127.0.0.1", resolve));
  const endless = createServer((req, res) => void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [], meta: { totalPages: 1_000_000, page: Number(new URL(req.url ?? "/", "http://x").searchParams.get("page")) } })));
  await new Promise<void>((resolve) => endless.listen(0, "127.0.0.1", resolve));
  try {
    const url = (server: Server): string => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await assert.rejects(importLabels(deps(url(big)).d, { since: "x" }), /too large/);
    await assert.rejects(importLabels(deps(url(endless)).d, { since: "x" }), /more than \d+ pages/);
  } finally {
    await new Promise<void>((resolve) => big.close(() => resolve()));
    await new Promise<void>((resolve) => endless.close(() => resolve()));
  }
});

test("a label is stored with the catalog's data type, and one whose type or range disagrees with the catalog is refused", async () => {
  const lf = await fakeLangfuse({
    scores: [
      annotation({ traceId: "a".repeat(32), name: "spec_pass_rate", dataType: "BOOLEAN", value: 1 }),
      annotation({ traceId: "a".repeat(32), name: "approval_consistent", dataType: "NUMERIC", value: 1 }),
      annotation({ traceId: "a".repeat(32), name: "spec_validity_rate", value: 1.5 }),
      annotation({ traceId: "a".repeat(32), name: "closed_loop_refusals", value: -0.1 }),
      annotation({ traceId: "a".repeat(32), name: "mutation_value", value: 0.75 }),
      annotation({ traceId: "a".repeat(32), name: "empty_output_guard", dataType: "BOOLEAN", value: 0 }),
    ],
  });
  try {
    const { d, saved } = deps(lf.baseUrl);
    const result = await importLabels(d, { since: "2026-10-01" });
    assert.deepEqual(saved.map((r) => [r.name, r.dataType, r.value]), [["mutation_value", "NUMERIC", 0.75], ["empty_output_guard", "BOOLEAN", false]]);
    assert.equal(result.unsupported, 4);
  } finally {
    await lf.close();
  }
});

test("a number above a catalog range with no maximum is accepted, and below its minimum is not", async () => {
  const lf = await fakeLangfuse({ scores: [annotation({ traceId: "a".repeat(32), name: "cost_per_useful_spec", value: 12 })] });
  try {
    const { d, saved } = deps(lf.baseUrl);
    await importLabels(d, { since: "2026-10-01" });
    assert.deepEqual(saved.map((r) => r.name), ["cost_per_useful_spec"]);
  } finally {
    await lf.close();
  }
});

test("the bytes imported by one run of the script are bounded across all its requests", async () => {
  const lf = await fakeLangfuse({ scores: Array.from({ length: 5 }, (_, i) => annotation({ id: `s${i}`, traceId: "a".repeat(32), name: "spec_pass_rate", value: 1, comment: "c".repeat(200) })) });
  try {
    const { d } = deps(lf.baseUrl);
    d.maxTotalBytes = 1_000;
    await assert.rejects(importLabels(d, { since: "2026-10-01" }), /imported more than 1000 bytes/);
  } finally {
    await lf.close();
  }
});

test("a human label of an LLM judge's score is imported as the judge's type, so the judge can be calibrated against it", async () => {
  const lf = await fakeLangfuse({
    scores: [
      annotation({ id: "j1", traceId: "a".repeat(32), name: "spec_relevance", dataType: "BOOLEAN", value: 0, comment: "tests another page" }),
      annotation({ id: "j2", traceId: "b".repeat(32), name: "failure_root_cause", dataType: "CATEGORICAL", value: 0, stringValue: "selector" }),
      annotation({ id: "j3", traceId: "b".repeat(32), name: "failure_root_cause", dataType: "CATEGORICAL", value: 0, stringValue: "not_a_category", timestamp: "2026-10-17T13:00:00.000Z" }),
      annotation({ id: "j4", traceId: "a".repeat(32), name: "spec_relevance", dataType: "NUMERIC", value: 0.5 }),
    ],
  });
  try {
    const { d, saved } = deps(lf.baseUrl);
    const result = await importLabels(d, { since: "2026-10-01" });
    const relevance = saved.find((r) => r.name === "spec_relevance");
    assert.deepEqual([relevance?.value, relevance?.dataType, relevance?.graderVersion, relevance?.source], [false, "BOOLEAN", "human", "human"]);
    assert.equal(saved.find((r) => r.name === "failure_root_cause")?.value, "selector");
    assert.equal(result.unsupported, 2, "a category outside the closed set and a wrong data type are refused");
  } finally {
    await lf.close();
  }
});
