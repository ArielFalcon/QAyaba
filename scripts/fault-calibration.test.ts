/* The calibration script reads a campaign's runs, groups them by variant and gives each a verdict, writing nothing unless asked. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MIN_REPLICATES } from "@contexts/objective-signal/application/index.ts";
import { main, parseArguments, type FaultCalibrationDeps } from "./fault-calibration.ts";

const stats = { baseline: 10, exposed: 6, killed: 3, failed: 4, flowBreaks: 0 };
function fakeDeps(runs: Array<{ id: string; variant: Record<string, string> }>, ratio = 0.5) {
  const out: string[] = [];
  const written: Array<{ path: string; text: string }> = [];
  const deps: FaultCalibrationDeps = {
    listRuns: () => runs,
    outcomeOf: () => ({ gateSignals: { valueByCandidate: [{ candidateId: "uc-1", exposed: 4, killed: 2, ratio }], valueStats: stats } }),
    out: (l) => out.push(l),
    writeText: (path, text) => written.push({ path, text }),
  };
  return { deps, out, written };
}
const runsOf = (n: number, variant: Record<string, string>) => Array.from({ length: n }, (_, i) => ({ id: `${JSON.stringify(variant)}-${i}`, variant }));

describe("fault-calibrate", () => {
  it("requires a well-formed campaign id and refuses an unknown argument", () => {
    assert.equal(parseArguments([]).ok, false);
    assert.equal(parseArguments(["--campaign", "bad id"]).ok, false);
    assert.equal(parseArguments(["--campaign", "c1", "--x"]).ok, false);
    assert.deepEqual(parseArguments(["--campaign", "c1", "--out", "r.json"]), { ok: true, campaign: "c1", out: "r.json" });
  });

  it("gives each variant its own verdict from its own replicates", () => {
    const { deps, out } = fakeDeps([...runsOf(MIN_REPLICATES, { arm: "a" }), ...runsOf(MIN_REPLICATES - 1, { arm: "b" })]);
    assert.equal(main(["--campaign", "c1"], deps), 0);
    assert.match(out.find((l) => l.includes('"a"'))!, /calibrated/);
    assert.match(out.find((l) => l.includes('"b"'))!, /insufficient/);
  });

  it("exits 1 for a campaign with no run and 2 for a bad command line", () => {
    assert.equal(main(["--campaign", "c1"], fakeDeps([]).deps), 1);
    assert.equal(main([], fakeDeps([]).deps), 2);
  });

  it("writes the report only when asked", () => {
    const quiet = fakeDeps(runsOf(MIN_REPLICATES, { arm: "a" }));
    main(["--campaign", "c1"], quiet.deps);
    assert.equal(quiet.written.length, 0);
    const asked = fakeDeps(runsOf(MIN_REPLICATES, { arm: "a" }));
    main(["--campaign", "c1", "--out", "r.json"], asked.deps);
    assert.equal(JSON.parse(asked.written[0]!.text).variants[0].calibration.verdict, "calibrated");
  });
});
