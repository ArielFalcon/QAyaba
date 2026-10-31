import { test } from "node:test";
import assert from "node:assert/strict";
import { main, parseArguments, replicateOf, type ReadinessDeps } from "./enforce-readiness.ts";
import type { CampaignReplicateRow } from "../src/persistence/repositories/run.repository.ts";

const SIGNALS = { static: true, coverageRatio: 0.8, bundleMutation: { applied: 1, killed: 1, survived: [] }, reviewerCorrections: [], flaky: false, retries: 0 } as CampaignReplicateRow["gateSignals"];

let n = 0;
const row = (over: Partial<CampaignReplicateRow> = {}): CampaignReplicateRow => ({ runId: `run-${++n}`, app: "shop", sha: "abcdef1234567", campaignId: "camp", variant: { arm: "B", closedLoop: "on" }, replicate: n, engineVersion: "0.1.0+aaaaaaaaaaaa", gateSignals: SIGNALS, ...over });

function harness(rows: CampaignReplicateRow[]) {
  const out: string[] = [];
  const asked: Array<{ app?: string; since?: string }> = [];
  const deps: ReadinessDeps = { replicates: (opts) => { asked.push(opts); return rows; }, out: (line) => out.push(line) };
  return { deps, out, asked };
}

test("the arguments name an app and a date, both optional", () => {
  assert.deepEqual(parseArguments([]), { ok: true, app: undefined, since: undefined });
  assert.deepEqual(parseArguments(["--app", "shop", "--since", "2026-10-01T02:00:00+02:00"]), { ok: true, app: "shop", since: "2026-10-01T00:00:00.000Z" });
});

test("an unknown argument, a missing value or a date that is not one is refused", () => {
  assert.equal(parseArguments(["--bogus"]).ok, false);
  assert.equal(parseArguments(["--app"]).ok, false);
  assert.equal(parseArguments(["--since", "yesterday"]).ok, false);
});

test("a case is one campaign, one tested commit and one variant, whatever order the variant keys come in", () => {
  const a = replicateOf(row({ variant: { arm: "B", closedLoop: "on" } }));
  const b = replicateOf(row({ variant: { closedLoop: "on", arm: "B" } }));
  const other = replicateOf(row({ sha: "fedcba9876543" }));

  assert.equal(a.caseKey, b.caseKey);
  assert.notEqual(a.caseKey, other.caseKey);
  assert.equal(a.gateSignals, SIGNALS);
});

test("it answers per app: three trustworthy replicates of one case at one commit qualify, and the line says how many", async () => {
  const { deps, out } = harness([row(), row(), row()]);

  assert.equal(await main([], deps), 0);

  assert.match(out.join("\n"), /shop\s+QUALIFIES/);
  assert.match(out.join("\n"), /3 of 3 consecutive/);
});

test("it names why an app does not qualify: the reasons of the latest replicate and the commit the count restarted at", async () => {
  const stale = { ...SIGNALS, coverage: { stale: true } } as CampaignReplicateRow["gateSignals"];
  const { deps, out } = harness([row(), row(), row({ gateSignals: stale })]);

  assert.equal(await main([], deps), 0);

  assert.match(out.join("\n"), /shop\s+does not qualify/);
  assert.match(out.join("\n"), /0 of 3 consecutive/);
  assert.match(out.join("\n"), /stale/);
});

test("the app and date it was asked about reach the history, and an empty history is said so", async () => {
  const { deps, out, asked } = harness([]);

  assert.equal(await main(["--app", "shop", "--since", "2026-10-01T00:00:00Z"], deps), 0);

  assert.deepEqual(asked, [{ app: "shop", since: "2026-10-01T00:00:00.000Z" }]);
  assert.match(out.join("\n"), /no campaign replicates match/);
});

test("a bad argument prints the usage and exits 2, without reading the history", async () => {
  const { deps, out, asked } = harness([]);

  assert.equal(await main(["--bogus"], deps), 2);

  assert.deepEqual(asked, []);
  assert.match(out.join("\n"), /usage: npm run enforce-readiness/);
});
