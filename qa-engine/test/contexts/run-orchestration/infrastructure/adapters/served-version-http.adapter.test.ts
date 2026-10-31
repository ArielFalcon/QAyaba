import { test } from "node:test";
import assert from "node:assert/strict";
import { httpServedVersionReader } from "@contexts/run-orchestration/infrastructure/adapters/served-version-http.adapter.ts";

const answering = (init: { status?: number; body?: string }): typeof fetch =>
  (async () => new Response(init.body ?? "", { status: init.status ?? 200 })) as typeof fetch;

test("a source answering { sha, healthy } is read as the commit it serves and whether it reports healthy", async () => {
  const read = await httpServedVersionReader(answering({ body: JSON.stringify({ sha: "ABC1234def", healthy: true }) })).read("https://dev/version");
  assert.deepEqual(read, { kind: "read", commit: "abc1234def", healthy: true });
});

test("a source that does not say healthy is read with healthy unknown, not false", async () => {
  const read = await httpServedVersionReader(answering({ body: JSON.stringify({ sha: "abc1234" }) })).read("https://dev/version");
  assert.deepEqual(read, { kind: "read", commit: "abc1234", healthy: undefined });
});

test("every way a declared source fails to answer is a typed reason, never a throw", async () => {
  const reader = (f: typeof fetch) => httpServedVersionReader(f).read("https://dev/version");
  assert.deepEqual(await reader((async () => { throw new TypeError("fetch failed"); }) as typeof fetch), { kind: "unreadable", reason: "unreachable" });
  assert.deepEqual(await reader(answering({ status: 503 })), { kind: "unreadable", reason: "http-status" });
  assert.deepEqual(await reader(answering({ body: "<html>" })), { kind: "unreadable", reason: "malformed-body" });
  assert.deepEqual(await reader(answering({ body: "[1]" })), { kind: "unreadable", reason: "malformed-body" });
  assert.deepEqual(await reader(answering({ body: JSON.stringify({ healthy: true }) })), { kind: "unreadable", reason: "no-commit" });
  assert.deepEqual(await reader(answering({ body: JSON.stringify({ sha: "v1.2.3" }) })), { kind: "unreadable", reason: "no-commit" });
});
