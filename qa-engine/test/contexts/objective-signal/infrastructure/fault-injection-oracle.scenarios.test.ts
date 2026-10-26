/* Expected values are the established behavior, built by hand — change them only with a deliberate behavior change, never to silence a failure. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FaultInjectionOracleAdapter } from "@contexts/objective-signal/infrastructure/fault-injection-oracle.adapter.ts";
import { operationKey, type FaultAim } from "@contexts/objective-signal/domain/fault-injection-score.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";

const sha = Sha.of("abcdef1");
const br = BlastRadius.of(sha, ["src/svc.ts"]);
const BASE_URL = "https://dev.example.com";
const OP = { verb: "GET", pattern: "^/api/orders/?$" };
const KEY = operationKey(OP);
const AIM: FaultAim = { operations: [OP], candidates: [], specToCandidates: [] };

test("without baseline-passing specs the fault-injection oracle records no value score, and says why", async () => {
  /* runCorrupted must NOT run: the guard short-circuits before it because baselineCases is
     absent. A regression that injected baselineCases anyway would skip the guard and throw here.
   */
  const adapter = new FaultInjectionOracleAdapter(
    async () => {
      throw new Error("runCorrupted must not run when baselineCases is absent (guard should short-circuit)");
    },
    () => [],
    BASE_URL,
  );
  const r = await adapter.measure(br, "/m/repo", "qa-bot-abc", undefined, AIM);
  assert.equal(r.valueScore, null, "no baseline-passing specs means no score");
  assert.equal(typeof r.details, "string");
  assert.ok(r.details.length > 0, "details must describe why no score was recorded");
});

test("the fault-injection value score is the share of exposed baseline-passing specs that fail on the corrupted run", async () => {
  /* Corrupted re-run: login STAYS green (weak oracle) and checkout FLIPS to fail via a plain
     assertion timeout (a genuine catch, not a flow-break) -> catch-rate 1/2 = 0.5.
   */
  const adapter = new FaultInjectionOracleAdapter(
    async () => ({
      verdict: "fail",
      cases: [
        { name: "login", file: "login.spec.ts", status: "pass" as const },
        { name: "checkout", file: "checkout.spec.ts", status: "fail" as const, detail: "expect(locator).toBeVisible timed out" },
      ],
    }),
    () => [
      { corrupted: 1, byOperation: { [KEY]: 1 }, test: "login.spec.ts::login" },
      { corrupted: 2, byOperation: { [KEY]: 2 }, test: "checkout.spec.ts::checkout" },
    ],
    BASE_URL,
  );
  const r = await adapter.measure(br, "/m/repo", "qa-bot-abc", ["login", "checkout"], AIM);
  assert.notEqual(r.valueScore, null, "a defined result when baseline specs are threaded through");
  assert.equal(r.valueScore, 1 / 2, "1 of 2 exposed baseline-passing specs noticed the corruption");
  assert.equal(r.killedCount, 1);
  assert.equal(r.mutantCount, 2);
});
