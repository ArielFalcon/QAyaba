/*
 * The fleet rollups the live console derives client-side from the per-app run feeds
 * (api.loadAll → stats / verdictMix). The pass rate must read the same as the control API's own
 * signals view for the same runs; the verdict mix must account for every finished run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appView, controlApi, loadConsole, runRecord } from "./console-harness";
import { toSignalsView } from "../signals-view";
import type { RunRecord } from "../../types";

async function fleetModel(verdicts: string[]) {
  const runs = verdicts.map((verdict, i) => runRecord(`run-${i}`, { verdict }));
  const h = await loadConsole({ token: "t", routes: controlApi({ apps: [appView("shop")], runs }) });
  return { model: await h.api.loadAll(), runs };
}

for (const verdicts of [
  ["pass", "infra-error"],
  ["pass", "invalid"],
  ["pass", "fail", "flaky", "invalid", "skipped", "infra-error"],
  ["skipped", "infra-error"],
]) {
  test(`the fleet pass rate reads the same as the signals view for ${verdicts.join(", ")}`, async () => {
    const { model, runs } = await fleetModel(verdicts);
    const server = toSignalsView([{ scorecard: null, runs: runs as unknown as RunRecord[] }]).reviewer.passRate;

    if (server === null) {
      assert.equal(model.stats.passRate, null, "no quality verdict → no rate, never 0%");
    } else {
      assert.ok(Math.abs(model.stats.passRate - server) < 1e-3, `console ${model.stats.passRate} vs signals view ${server}`);
    }
  });
}

test("the verdict mix accounts for every finished run, invalid included", async () => {
  const verdicts = ["pass", "fail", "flaky", "invalid", "invalid", "infra-error", "skipped"];
  const { model } = await fleetModel(verdicts);
  const mix = new Map<string, number>(model.verdictMix.map((s: { v: string; n: number }) => [s.v, s.n]));

  for (const v of new Set(verdicts)) {
    assert.equal(mix.get(v), verdicts.filter((x) => x === v).length, `${v} runs in the mix`);
  }
});
