/* A case is calibrated when its replicates agree, its failures are not the flow breaking and enough of its suite is exposed; each limit holds at its boundary. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_FLOW_BREAK_SHARE, MAX_REPLICATE_SPREAD, MIN_APPLICABLE_SHARE, MIN_REPLICATES, calibrate, type CalibrationReplicate } from "@contexts/objective-signal/domain/fault-calibration.ts";

const replicate = (ratio: number | null, over: Partial<NonNullable<CalibrationReplicate["stats"]>> = {}): CalibrationReplicate => ({
  perCandidate: [{ candidateId: "uc-1", exposed: ratio === null ? 0 : 4, killed: 0, ratio }],
  stats: { baseline: 10, exposed: 5, killed: 2, failed: 5, flowBreaks: 0, ...over },
});
const times = (n: number, make: (i: number) => CalibrationReplicate): CalibrationReplicate[] => Array.from({ length: n }, (_, i) => make(i));

describe("calibrate", () => {
  it("gives no verdict with fewer replicates than the minimum", () => {
    const r = calibrate(times(MIN_REPLICATES - 1, () => replicate(0.5)));
    assert.equal(r.verdict, "insufficient");
    assert.equal(calibrate(times(MIN_REPLICATES, () => replicate(0.5))).verdict, "calibrated");
  });

  it("does not count a replicate whose re-run measured nothing", () => {
    const empty: CalibrationReplicate = { perCandidate: [], stats: undefined };
    assert.equal(calibrate([...times(MIN_REPLICATES - 1, () => replicate(0.5)), empty]).verdict, "insufficient");
  });

  it("accepts a spread of exactly the limit and refuses one past it", () => {
    const at = calibrate([replicate(0.5), replicate(0.5 + MAX_REPLICATE_SPREAD), replicate(0.6)]);
    assert.equal(at.verdict, "calibrated");
    assert.equal(at.spread, MAX_REPLICATE_SPREAD);
    const past = calibrate([replicate(0.25), replicate(0.25 + MAX_REPLICATE_SPREAD + 0.05), replicate(0.3)]);
    assert.equal(past.verdict, "not-calibrated");
    assert.match(past.reasons[0]!, /moves by/);
  });

  it("accepts a flow-break share of exactly the limit and refuses one past it", () => {
    const failed = 10;
    const at = calibrate(times(MIN_REPLICATES, () => replicate(0.5, { failed, flowBreaks: failed * MAX_FLOW_BREAK_SHARE })));
    assert.equal(at.verdict, "calibrated");
    assert.equal(at.flowBreakShare, MAX_FLOW_BREAK_SHARE);
    const past = calibrate(times(MIN_REPLICATES, () => replicate(0.5, { failed, flowBreaks: failed * MAX_FLOW_BREAK_SHARE + 1 })));
    assert.equal(past.verdict, "not-calibrated");
    assert.match(past.reasons[0]!, /flow breaking/);
  });

  it("accepts an applicable share of exactly the limit and refuses one under it", () => {
    const baseline = 10;
    const at = calibrate(times(MIN_REPLICATES, () => replicate(0.5, { baseline, exposed: baseline * MIN_APPLICABLE_SHARE })));
    assert.equal(at.verdict, "calibrated");
    assert.equal(at.applicableShare, MIN_APPLICABLE_SHARE);
    const under = calibrate(times(MIN_REPLICATES, () => replicate(0.5, { baseline, exposed: baseline * MIN_APPLICABLE_SHARE - 1 })));
    assert.equal(under.verdict, "not-calibrated");
    assert.match(under.reasons[0]!, /exposed/);
  });

  it("is not calibrated when no use case was scored in two replicates, and names every limit it fails", () => {
    const r = calibrate(times(MIN_REPLICATES, () => replicate(null, { baseline: 10, exposed: 1, failed: 4, flowBreaks: 4 })));
    assert.equal(r.verdict, "not-calibrated");
    assert.equal(r.spread, null);
    assert.equal(r.reasons.length, 3);
  });

  it("reads a run in which nothing failed as no flow break", () => {
    const r = calibrate(times(MIN_REPLICATES, () => replicate(0.5, { failed: 0, flowBreaks: 0 })));
    assert.equal(r.flowBreakShare, 0);
  });
});
