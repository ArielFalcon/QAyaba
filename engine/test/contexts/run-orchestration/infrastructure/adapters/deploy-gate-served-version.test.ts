/* The deploy gate's served-version decision through its public seam: the product-side reader answers only the served commit, the mirror's history says how it relates to the run's sha, and the gate records the closed state or waits for a deploy that has not landed. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DeployGatePortAdapter, NullDeployGateAdapter } from "@contexts/run-orchestration/infrastructure/adapters/deploy-gate-port.adapter.ts";
import type { ServedVersionReaderPort } from "@kernel/ports/served-version-reader.port.ts";
import type { CommitAncestryPort, CommitRelation } from "@kernel/ports/commit-ancestry.port.ts";
import type { ServedVersionRead } from "@kernel/served-version.ts";
import { DeployNotServedError } from "@kernel/served-version.ts";
import { Sha } from "@kernel/sha.ts";
import { isOk } from "@kernel/result.ts";

const SHA = Sha.of("abc1234def5678");
const URL = "https://dev.example.com/version";

const reading = (...answers: ServedVersionRead[]): ServedVersionReaderPort & { calls: number } => {
  const reader = { calls: 0, read: async () => answers[Math.min(reader.calls++, answers.length - 1)]! };
  return reader;
};
const commit = (value: string, healthy: boolean | "unsaid" = true): ServedVersionRead => ({ kind: "read", commit: value, healthy: healthy === "unsaid" ? undefined : healthy });
const history = (relation: CommitRelation): CommitAncestryPort & { asked: string[] } => {
  const port = { asked: [] as string[], relation: async (served: string) => { port.asked.push(served); return relation; } };
  return port;
};
const gate = (reader: ServedVersionReaderPort, ancestry: CommitAncestryPort | undefined, timeoutMs = 5000) =>
  new DeployGatePortAdapter(reader, ancestry, { versionUrl: URL, intervalMs: 0, timeoutMs });

test("the gate with no declared source records undeclared and never reports the deploy as verified", async () => {
  const result = await new NullDeployGateAdapter().verifyServed(SHA, { source: "webhook" });
  assert.ok(isOk(result));
  assert.deepEqual(result.value, { state: "undeclared" });
});

test("a source that cannot be read is unreadable with its typed reason, and the run does not wait for it", async () => {
  const reader = reading({ kind: "unreadable", reason: "http-status" });
  const result = await gate(reader, history("diverged")).verifyServed(SHA, { source: "webhook" });
  assert.ok(isOk(result));
  assert.deepEqual(result.value, { state: "unreadable", reason: "http-status" });
  assert.equal(reader.calls, 1, "read once, no wait");
});

test("the served commit equal to the run's sha is equal without asking the history", async () => {
  const ancestry = history("diverged");
  const result = await gate(reading(commit("abc1234")), ancestry).verifyServed(SHA, { source: "webhook" });
  assert.ok(isOk(result));
  assert.deepEqual(result.value, { state: "equal", served: "abc1234" });
  assert.deepEqual(ancestry.asked, []);
});

test("a manual run records behind and does not wait for the deploy", async () => {
  const reader = reading(commit("1111111"));
  const result = await gate(reader, history("served-is-ancestor")).verifyServed(SHA, { source: "manual" });
  assert.ok(isOk(result));
  assert.deepEqual(result.value, { state: "behind", served: "1111111" });
  assert.equal(reader.calls, 1);
});

test("a deploy-triggered run waits while the served version is behind and records equal with the wait once the deploy lands", async () => {
  const reader = reading(commit("1111111"), commit("1111111"), commit("abc1234def5678"));
  const result = await gate(reader, history("served-is-ancestor")).verifyServed(SHA, { source: "webhook" });
  assert.ok(isOk(result));
  assert.equal(result.value.state, "equal");
  assert.equal(result.value.served, "abc1234def5678");
  assert.equal(typeof result.value.waitedMs, "number");
  assert.equal(reader.calls, 3);
});

test("a deploy-triggered run whose deploy never lands ends with the timeout and the behind fact", async () => {
  const result = await gate(reading(commit("1111111")), history("served-is-ancestor"), 20).verifyServed(SHA, { source: "webhook" });
  assert.ok(!isOk(result));
  assert.ok(result.error instanceof DeployNotServedError);
  assert.match(result.error.message, /DEV did not serve sha abc1234def5678 within 20ms/);
  assert.equal(result.error.fact.state, "behind");
  assert.equal(result.error.fact.served, "1111111");
});

test("a served version ahead of the run's sha is recorded without waiting, on a deploy-triggered run too", async () => {
  const reader = reading(commit("9999999"));
  const result = await gate(reader, history("head-is-ancestor")).verifyServed(SHA, { source: "webhook" });
  assert.ok(isOk(result));
  assert.deepEqual(result.value, { state: "ahead", served: "9999999" });
  assert.equal(reader.calls, 1);
});

test("a served version that is neither an ancestor nor a descendant is unrelated without waiting", async () => {
  const reader = reading(commit("9999999"));
  const result = await gate(reader, history("diverged")).verifyServed(SHA, { source: "webhook" });
  assert.ok(isOk(result));
  assert.deepEqual(result.value, { state: "unrelated", served: "9999999" });
  assert.equal(reader.calls, 1);
});

test("a served commit the mirror does not hold is unreadable with its own reason, never unrelated, and the run is not blocked", async () => {
  const reader = reading(commit("9999999"));
  const result = await gate(reader, history("unknown-commit")).verifyServed(SHA, { source: "webhook" });
  assert.ok(isOk(result));
  assert.deepEqual(result.value, { state: "unreadable", reason: "commit-not-in-history", served: "9999999" });
  assert.equal(reader.calls, 1, "no wait");
});

test("a history that cannot be read leaves the fact unreadable with its reason, loudly, and the run is not blocked", async () => {
  const broken: CommitAncestryPort = { relation: async () => { throw new Error("git failed"); } };
  const result = await gate(reading(commit("1111111")), broken).verifyServed(SHA, { source: "webhook" });
  assert.ok(isOk(result));
  assert.deepEqual(result.value, { state: "unreadable", reason: "history-unavailable", served: "1111111" });
});

test("a gate wired without a history cannot tell another commit apart and says so", async () => {
  const result = await gate(reading(commit("1111111")), undefined).verifyServed(SHA, { source: "webhook" });
  assert.ok(isOk(result));
  assert.deepEqual(result.value, { state: "unreadable", reason: "history-unavailable", served: "1111111" });
});

test("health: a source that reports healthy passes, one that reports otherwise is waited for until the timeout", async () => {
  assert.ok(isOk(await gate(reading(commit("abc1234", false), commit("abc1234", true)), undefined).waitUntilHealthy()));
  assert.ok(!isOk(await gate(reading(commit("abc1234", false)), undefined, 20).waitUntilHealthy()));
  assert.ok(!isOk(await gate(reading(commit("abc1234", "unsaid")), undefined, 20).waitUntilHealthy()), "a source that does not say healthy is not healthy");
});

test("health: a source that cannot be read is not healthy, so DEV going down is still detected", async () => {
  const reader = reading({ kind: "unreadable", reason: "unreachable" });
  assert.ok(!isOk(await gate(reader, undefined, 20).waitUntilHealthy()));
  assert.ok(reader.calls >= 1);
  assert.ok(isOk(await gate(reading({ kind: "unreadable", reason: "unreachable" }, commit("abc1234", true)), undefined).waitUntilHealthy()), "it recovers when the source answers healthy again");
});

test("a deploy-triggered wait on behind goes on through unreadable reads and ends when the deploy lands", async () => {
  const refused: ServedVersionRead = { kind: "unreadable", reason: "unreachable" };
  const reader = reading(commit("1111111"), commit("1111111"), refused, refused, refused, refused, refused, commit("abc1234def5678"));
  const result = await gate(reader, history("served-is-ancestor")).verifyServed(SHA, { source: "webhook" });
  assert.ok(isOk(result));
  assert.equal(result.value.state, "equal");
  assert.equal(reader.calls, 8);
  assert.equal(typeof result.value.waitedMs, "number");
});

test("a wait on behind that only reads unreadable until the timeout ends with the last read as the fact", async () => {
  const result = await gate(reading(commit("1111111"), { kind: "unreadable", reason: "http-status" }), history("served-is-ancestor"), 20).verifyServed(SHA, { source: "webhook" });
  assert.ok(!isOk(result));
  assert.ok(result.error instanceof DeployNotServedError);
  assert.equal(result.error.fact.state, "unreadable");
  assert.equal(result.error.fact.reason, "http-status");
});

test("a wait on behind ends on a served commit the mirror does not hold, recorded as such", async () => {
  const ancestry: CommitAncestryPort = { relation: async (served) => (served === "1111111" ? "served-is-ancestor" : "unknown-commit") };
  const result = await gate(reading(commit("1111111"), commit("9999999")), ancestry).verifyServed(SHA, { source: "webhook" });
  assert.ok(isOk(result));
  assert.deepEqual({ state: result.value.state, reason: result.value.reason }, { state: "unreadable", reason: "commit-not-in-history" });
});

test("the entry's version wait and health wait share one deadline: a clock started earlier leaves the health wait no time", async () => {
  const reader = reading(commit("abc1234def5678", true));
  const startedAt = Date.now() - 1000;
  const result = await gate(reader, undefined, 500).waitUntilHealthy({ startedAt });
  assert.ok(!isOk(result));
  assert.equal(reader.calls, 0, "the entry's time was already spent");
  const waiting = await gate(reading(commit("1111111")), history("served-is-ancestor"), 500).verifyServed(SHA, { source: "webhook", startedAt });
  assert.ok(!isOk(waiting) && waiting.error instanceof DeployNotServedError, "the version wait ends at the same shared deadline");
});

test("a health re-read that must still serve the run's commit ends when DEV serves another, with the fact it read", async () => {
  const newer = await gate(reading(commit("9999999")), history("head-is-ancestor")).waitUntilHealthy({ servedSha: SHA });
  assert.ok(!isOk(newer));
  assert.ok(newer.error instanceof DeployNotServedError);
  assert.deepEqual(newer.error.fact, { state: "ahead", served: "9999999" });
  assert.match(newer.error.message, /no longer serves/);
  assert.ok(isOk(await gate(reading(commit("abc1234def5678")), undefined).waitUntilHealthy({ servedSha: SHA })), "the run's own commit passes without asking the history");
  assert.ok(isOk(await gate(reading(commit("9999999")), history("head-is-ancestor")).waitUntilHealthy()), "without the commit to hold, health only");
});
