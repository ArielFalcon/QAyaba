/* ADR-0005: an app moves to enforce only after three consecutive replicates of one campaign case, at one qayaba commit, each with a trustworthy measurement and bundle mutation on. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { REQUIRED_CONSECUTIVE_REPLICATES, enforceReadiness, untrustedReasons, type Replicate, type ReplicateSignals } from "@contexts/objective-signal/domain/enforce-readiness.ts";

const TRUSTED: ReplicateSignals = { coverageRatio: 0.8, bundleMutation: { applied: 2, killed: 1, survived: [] } };

let n = 0;
const replicate = (over: Partial<Replicate> = {}): Replicate => ({ runId: `run-${++n}`, app: "shop", caseKey: "camp|abc1234|arm=B", engineVersion: "0.1.0+aaaaaaaaaaaa", gateSignals: TRUSTED, ...over });
const series = (count: number, over: Partial<Replicate> = {}): Replicate[] => Array.from({ length: count }, () => replicate(over));

test("a replicate is trustworthy when it measured a ratio, is not stale, left no evidence out and recorded bundle mutation", () => {
  assert.deepEqual(untrustedReasons(replicate()), []);
});

test("each way a measurement cannot be trusted is named, from the facts the run recorded", () => {
  const reasons = (gateSignals: Replicate["gateSignals"], engineVersion: string | null = "v") => untrustedReasons(replicate({ gateSignals, engineVersion }));
  assert.deepEqual(reasons(null), ["no-outcome"]);
  assert.deepEqual(reasons({ ...TRUSTED, coverageRatio: null }), ["not-measured"]);
  assert.deepEqual(reasons({ ...TRUSTED, coverageRatio: null, changeCoverage: { executableLines: 0, unmeasured: "decode-aborted" } }), ["evidence-unreadable"]);
  assert.deepEqual(reasons({ ...TRUSTED, coverageRatio: null, changeCoverage: { executableLines: 0, unmeasured: "no-dumps" } }), ["evidence-unreadable"]);
  assert.deepEqual(reasons({ ...TRUSTED, coverageRatio: null, changeCoverage: { executableLines: 0, unmeasured: "no-source-maps" } }), ["not-measured"]);
  assert.deepEqual(reasons({ ...TRUSTED, coverage: { stale: true } }), ["stale"]);
  assert.deepEqual(reasons({ ...TRUSTED, changeCoverage: { executableLines: 4, evidenceLeftOut: ["decode-aborted"] } }), ["evidence-left-out"]);
  assert.deepEqual(reasons({ ...TRUSTED, bundleMutation: { applied: 2, killed: 1, survived: [], unreadable: 1 } }), ["mutants-unreadable"]);
  assert.deepEqual(reasons({ coverageRatio: 0.8 }), ["no-bundle-mutation"]);
  assert.deepEqual(reasons(TRUSTED, null), ["no-engine-version"]);
});

test("three consecutive trustworthy replicates of one case at one commit qualify the app", () => {
  const out = enforceReadiness(series(REQUIRED_CONSECUTIVE_REPLICATES));

  assert.equal(out.length, 1);
  assert.equal(out[0]!.app, "shop");
  assert.equal(out[0]!.qualifies, true);
  assert.deepEqual(out[0]!.cases.map((c) => [c.caseKey, c.consecutive, c.qualifies]), [["camp|abc1234|arm=B", 3, true]]);
});

test("two replicates do not qualify", () => {
  const out = enforceReadiness(series(2));

  assert.equal(out[0]!.qualifies, false);
  assert.equal(out[0]!.cases[0]!.consecutive, 2);
});

test("a replicate that fails the trust test restarts the count", () => {
  const stale = replicate({ gateSignals: { ...TRUSTED, coverage: { stale: true } } });
  const out = enforceReadiness([...series(3), stale, ...series(2)]);

  assert.equal(out[0]!.qualifies, false);
  assert.equal(out[0]!.cases[0]!.consecutive, 2);
});

test("a case whose last replicate is untrustworthy has no run of trust and names why", () => {
  const unreadable = replicate({ gateSignals: { ...TRUSTED, coverageRatio: null, changeCoverage: { executableLines: 0, unmeasured: "dumps-unusable" } } });
  const out = enforceReadiness([...series(3), unreadable]);

  assert.equal(out[0]!.qualifies, false);
  assert.equal(out[0]!.cases[0]!.consecutive, 0);
  assert.deepEqual(out[0]!.cases[0]!.last, { runId: unreadable.runId, reasons: ["evidence-unreadable"] });
});

test("a new qayaba commit restarts the count: the run of trust counts only the replicates at the latest commit", () => {
  const out = enforceReadiness([...series(2, { engineVersion: "0.1.0+aaaaaaaaaaaa" }), ...series(2, { engineVersion: "0.1.0+bbbbbbbbbbbb" })]);

  assert.equal(out[0]!.qualifies, false);
  assert.equal(out[0]!.cases[0]!.consecutive, 2);
  assert.equal(out[0]!.cases[0]!.engineVersion, "0.1.0+bbbbbbbbbbbb");
});

test("replicates of different cases are never added up, and an app qualifies through any one case", () => {
  const other = { caseKey: "camp|def5678|arm=B" };
  const out = enforceReadiness([...series(2), ...series(2, other)]);
  assert.equal(out[0]!.qualifies, false);

  const enough = enforceReadiness([...series(2), ...series(3, other)]);
  assert.equal(enough[0]!.qualifies, true);
  assert.deepEqual(enough[0]!.cases.map((c) => [c.caseKey, c.qualifies]), [["camp|abc1234|arm=B", false], ["camp|def5678|arm=B", true]]);
});

test("each app is answered apart, in app order", () => {
  const out = enforceReadiness([...series(3, { app: "zeta" }), ...series(1, { app: "alpha" })]);

  assert.deepEqual(out.map((a) => [a.app, a.qualifies]), [["alpha", false], ["zeta", true]]);
});

test("untrusted replicates of an unknown commit never qualify: a run that recorded no engine version cannot be placed on a commit", () => {
  const out = enforceReadiness(series(3, { engineVersion: null }));

  assert.equal(out[0]!.qualifies, false);
  assert.deepEqual(out[0]!.cases[0]!.last?.reasons, ["no-engine-version"]);
});

test("a case that qualified at an older qayaba commit does not qualify the app once a newer commit ran", () => {
  const old = series(REQUIRED_CONSECUTIVE_REPLICATES, { caseKey: "camp-old", engineVersion: "v1" });
  const stale = replicate({ caseKey: "camp-new", engineVersion: "v2", gateSignals: { ...TRUSTED, coverage: { stale: true } } });
  const out = enforceReadiness([...old, stale]);

  assert.equal(out[0]!.engineVersion, "v2");
  assert.equal(out[0]!.qualifies, false);
  assert.equal(out[0]!.cases.find((c) => c.caseKey === "camp-old")!.qualifies, true, "the case itself still says what it reached at its commit");
});
