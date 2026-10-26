/* FaultInjectionOracleAdapter: measure() owns the orchestration. Ctor is (runCorrupted, readCounters, baseUrl) — self-contained, no injected "runner closure". The re-run is aimed: it corrupts only the operations it is given. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FaultInjectionOracleAdapter } from "@contexts/objective-signal/infrastructure/fault-injection-oracle.adapter.ts";
import { operationKey, type FaultAim } from "@contexts/objective-signal/domain/fault-injection-score.ts";
import type { FaultCounterRecord } from "@contexts/objective-signal/domain/dump-sanitizers.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";

const sha = Sha.of("abcdef1");
const br = BlastRadius.of(sha, ["src/svc.ts"]);
const BASE_URL = "https://dev.example.com";
const OP = { verb: "GET", pattern: "^/orders/[^/]+/?$" };
const KEY = operationKey(OP);
const AIM: FaultAim = { operations: [OP], candidates: [{ candidateId: "uc-1", operations: [KEY] }], specToCandidates: [{ specFile: "flows/a.spec.ts", candidates: ["uc-1"] }] };
const counter = (test: string): FaultCounterRecord => ({ corrupted: 3, byOperation: { [KEY]: 3 }, test });

test("returns valueScore null when baselineCases is missing (guard short-circuits before runCorrupted)", async () => {
  const adapter = new FaultInjectionOracleAdapter(
    async () => {
      throw new Error("runCorrupted must not run when baselineCases is absent (guard should short-circuit)");
    },
    () => [],
    BASE_URL,
  );
  const r = await adapter.measure(br, "/m/repo", "qa-bot-abc", undefined, AIM);
  assert.equal(r.valueScore, null);
  assert.equal(r.mutantCount, null, "not measured must be null, never a fabricated zero mutant count");
  assert.equal(r.killedCount, null, "not measured must be null, never a fabricated zero killed count");
  assert.match(r.details, /needs e2eDir \+ baseUrl \+ baseline-passing specs/);
});

test("with no operation in reach, or no aim at all, the corrupted re-run is not started and no score is given", async () => {
  const adapter = new FaultInjectionOracleAdapter(
    async () => {
      throw new Error("nothing is corrupted that the change does not reach");
    },
    () => [],
    BASE_URL,
  );
  for (const aim of [undefined, { ...AIM, operations: [] }]) {
    const r = await adapter.measure(br, "/m/repo", "qa-bot-abc", ["a"], aim);
    assert.equal(r.valueScore, null);
    assert.equal(r.mutantCount, null);
    assert.equal(r.killedCount, null);
    assert.match(r.details, /no operation of the change is in reach/);
  }
});

test("re-runs the suite corrupting the aim's operations, with a -fi namespace suffix, and scores the exposed specs per use case", async () => {
  let seen: { dir: string; baseUrl: string; namespace: string; operations: FaultAim["operations"] } | null = null;
  const adapter = new FaultInjectionOracleAdapter(
    async (args) => {
      seen = args;
      return {
        verdict: "fail",
        cases: [
          { name: "a", file: "flows/a.spec.ts", status: "fail" as const },
          { name: "b", file: "flows/b.spec.ts", status: "pass" as const },
        ],
      };
    },
    () => [counter("flows/a.spec.ts::a"), { corrupted: 1, byOperation: { [KEY]: 1 }, test: "flows/b.spec.ts::b" }],
    BASE_URL,
  );
  const r = await adapter.measure(br, "/m/repo", "qa-bot-abc", ["a", "b"], AIM);
  assert.equal(seen!.dir, "/m/repo");
  assert.equal(seen!.baseUrl, BASE_URL);
  assert.equal(seen!.namespace, "qa-bot-abc-fi", "the fault-injection re-run namespace must be isolated with a -fi suffix");
  assert.deepEqual(seen!.operations, [OP], "the re-run is handed the operations to corrupt");
  assert.equal(r.valueScore, 0.5);
  assert.equal(r.killedCount, 1);
  assert.equal(r.mutantCount, 2);
  assert.deepEqual(r.perCandidate, [{ candidateId: "uc-1", exposed: 1, killed: 1, ratio: 1 }]);
  assert.equal(typeof r.details, "string");
});

test("returns null when the corrupted re-run is inconclusive (infra-error)", async () => {
  const adapter = new FaultInjectionOracleAdapter(async () => ({ verdict: "infra-error", cases: [] }), () => [], BASE_URL);
  const r = await adapter.measure(br, "/m/repo", "qa-bot-abc", ["a"], AIM);
  assert.equal(r.valueScore, null);
  assert.equal(r.mutantCount, null, "not measured must be null, never a fabricated zero mutant count");
  assert.equal(r.killedCount, null, "not measured must be null, never a fabricated zero killed count");
  assert.match(r.details, /inconclusive \(infra\)/);
});

test("returns null when no JSON response of an operation in reach was intercepted (not applicable — never gates)", async () => {
  const adapter = new FaultInjectionOracleAdapter(
    async () => ({ verdict: "pass", cases: [{ name: "a", status: "pass" as const }] }),
    () => [],
    BASE_URL,
  );
  const r = await adapter.measure(br, "/m/repo", "qa-bot-abc", ["a"], AIM);
  assert.equal(r.valueScore, null);
  assert.equal(r.mutantCount, null, "not measured must be null, never a fabricated zero mutant count");
  assert.equal(r.killedCount, null, "not measured must be null, never a fabricated zero killed count");
  assert.match(r.details, /not applicable to this app's flows/);
});

test("returns null, and says it could not be told, when the counters could not all be read: not the claim that no response was there to corrupt", async () => {
  const rerun = async () => ({ verdict: "pass", cases: [{ name: "a", status: "pass" as const }] });
  const unknown = await new FaultInjectionOracleAdapter(rerun, () => undefined, BASE_URL).measure(br, "/m/repo", "qa-bot-abc", ["a"], AIM);
  const none = await new FaultInjectionOracleAdapter(rerun, () => [], BASE_URL).measure(br, "/m/repo", "qa-bot-abc", ["a"], AIM);

  assert.equal(unknown.valueScore, null);
  assert.equal(unknown.mutantCount, null, "not measured must be null, never a fabricated zero mutant count");
  assert.equal(unknown.killedCount, null, "not measured must be null, never a fabricated zero killed count");
  assert.ok(unknown.details.length > 0, "and it says why");
  assert.notEqual(unknown.details, none.details, "what could not be told is not what was told to be nothing");
});

test("returns null when the corrupted re-run executed none of the baseline-passing specs", async () => {
  const adapter = new FaultInjectionOracleAdapter(
    async () => ({ verdict: "fail", cases: [{ name: "other", status: "fail" as const }] }),
    () => [counter("flows/a.spec.ts::a")],
    BASE_URL,
  );
  const r = await adapter.measure(br, "/m/repo", "qa-bot-abc", ["a"], AIM);
  assert.equal(r.valueScore, null);
  assert.equal(r.mutantCount, null, "not measured must be null, never a fabricated zero mutant count");
  assert.equal(r.killedCount, null, "not measured must be null, never a fabricated zero killed count");
  assert.match(r.details, /executed none of the baseline-passing specs/);
});

test("a use case none of whose specs requested a reached operation is reported with no ratio, and the run still scores the exposed ones", async () => {
  const adapter = new FaultInjectionOracleAdapter(
    async () => ({ verdict: "pass", cases: [{ name: "a", file: "flows/a.spec.ts", status: "pass" as const }, { name: "c", file: "flows/c.spec.ts", status: "fail" as const }] }),
    () => [{ corrupted: 1, byOperation: { [KEY]: 1 }, test: "flows/c.spec.ts::c" }],
    BASE_URL,
  );
  const r = await adapter.measure(br, "/m/repo", "qa-bot-abc", ["a", "c"], { ...AIM, specToCandidates: [{ specFile: "flows/a.spec.ts", candidates: ["uc-1"] }, { specFile: "flows/c.spec.ts", candidates: ["uc-other"] }] });
  assert.deepEqual(r.perCandidate, [{ candidateId: "uc-1", exposed: 0, killed: 0, ratio: null, unscored: "no-operation-hit" }]);
  assert.equal(r.valueScore, 1);
});
