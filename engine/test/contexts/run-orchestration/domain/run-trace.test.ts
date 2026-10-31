import { test } from "node:test";
import assert from "node:assert/strict";
import { RunEnding, factsAttrs, identityAttrs, runIdentityOf, runLevelLimits, runTriggerOf, type RunFacts } from "@contexts/run-orchestration/domain/run-trace.ts";

const pass: RunFacts = { verdict: "pass", errorClass: null };
const fail: RunFacts = { verdict: "fail", errorClass: null };

test("the first verdict a run reaches is the one its trace states", () => {
  const ending = new RunEnding();
  ending.finished(pass);
  ending.finished(fail);
  assert.deepEqual(ending.current, { kind: "facts", facts: pass });
});

test("a crash outranks a verdict set earlier and forces infra-error with its class and the facts known by then", () => {
  const ending = new RunEnding();
  ending.finished(pass);
  const error = new Error("boom");
  ending.crashed(error, "internal-error", { furthestPhase: "execute" });
  assert.deepEqual(ending.current, { kind: "crashed", error, facts: { furthestPhase: "execute", verdict: "infra-error", errorClass: "internal-error" } });
});

test("a cancel outranks any verdict and a crash never outranks a cancel", () => {
  const ending = new RunEnding();
  ending.finished(pass);
  ending.cancelled();
  ending.crashed(new Error("late"), "internal-error");
  ending.finished(fail);
  assert.deepEqual(ending.current, { kind: "cancelled" });
  assert.equal(new RunEnding().current, undefined);
});

test("a campaign run is a campaign run whichever door it came through; otherwise the door's trigger, else the source tells", () => {
  const campaign = { id: "c", variant: {}, replicate: 1 };
  assert.equal(runTriggerOf({ campaign, trigger: "api", source: "manual" }), "campaign");
  assert.equal(runTriggerOf({ trigger: "cli", source: "webhook" }), "cli");
  assert.equal(runTriggerOf({ source: "manual" }), "api");
  assert.equal(runTriggerOf({ source: "webhook" }), "webhook");
  assert.equal(runTriggerOf({}), "webhook");
});

test("a run's identity names the engine, the run and its request, and spells a campaign label's dots as underscores", () => {
  const identity = runIdentityOf(
    { app: "shop", sha: "abc", mode: "diff", target: "e2e", source: "manual", shadow: false, campaign: { id: "c1", replicate: 2, variant: { "arm.a": "x" } } },
    { runId: "r1", engineVersion: "9.9.9", captureMode: undefined },
  );
  assert.deepEqual(identityAttrs(identity), {
    "qayaba.engine.version": "9.9.9",
    "qayaba.run.id": "r1",
    "qayaba.app": "shop",
    "qayaba.commit.sha": "abc",
    "qayaba.mode": "diff",
    "qayaba.target": "e2e",
    "qayaba.trigger": "campaign",
    "qayaba.shadow": false,
    "qayaba.campaign.id": "c1",
    "qayaba.campaign.replicate": 2,
    "qayaba.campaign.variant.arm_a": "x",
  });
});

test("the root states only the facts the run recorded, and a run-level limit list falls back to the one limit it leads with", () => {
  assert.deepEqual(factsAttrs(pass), { "qayaba.verdict": "pass" });
  assert.deepEqual(factsAttrs({ verdict: "fail", errorClass: "E-X", furthestPhase: "execute", specs: { generated: 2, valid: null, passed: 1 } }), {
    "qayaba.verdict": "fail",
    "qayaba.error_class": "E-X",
    "qayaba.furthest_phase": "execute",
    "qayaba.specs.generated": 2,
    "qayaba.specs.passed": 1,
  });
  assert.deepEqual(runLevelLimits({ limitFired: "run-deadline", limitRole: "qa-author" }), [{ fired: "run-deadline", role: "qa-author" }]);
  assert.deepEqual(runLevelLimits({ limits: [{ fired: "step-cap", role: "qa-author", scope: "turn" }] }), []);
  assert.deepEqual(runLevelLimits({}), []);
});
