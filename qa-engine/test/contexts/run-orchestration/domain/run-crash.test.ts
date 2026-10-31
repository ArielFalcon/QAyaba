import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentTimeoutError, UntrustedGitTreeError } from "@kernel/domain-error.ts";
import { runCrashEnding, runFactsOfCrash, withTurnLimits } from "@contexts/run-orchestration/domain/run-crash.ts";

test("a crash is classified by type: a refused working copy, an infrastructure fault, anything else is an internal error", () => {
  const refused = runCrashEnding(new UntrustedGitTreeError("/w"), "msg");
  assert.equal(refused.errorClass, "security-refusal");
  assert.match(refused.note, /^security refusal — the working copy's git dir is not the orchestrator's own, so no git ran: msg$/);
  assert.equal(refused.label, "REFUSED (security refusal: untrusted git tree)");

  const infra = runCrashEnding(new AgentTimeoutError("deadline"), "agent too slow");
  assert.deepEqual(infra, { errorClass: "E-INFRA", note: "agent too slow", label: "infra-error" });

  const internal = runCrashEnding(new Error("JSON.parse threw"), "JSON.parse threw");
  assert.deepEqual(internal, { errorClass: "internal-error", note: "unexpected internal error (not infrastructure — investigate): JSON.parse threw", label: "CRASHED (internal error)" });
  assert.equal(runCrashEnding("a string", "x").errorClass, "internal-error");
});

test("a crash states only the facts the engine put on the error and the run knew; an error carrying none states none", () => {
  assert.deepEqual(runFactsOfCrash(new Error("x"), undefined, undefined), {});
  assert.deepEqual(runFactsOfCrash(null, { furthestPhase: "execute", phaseTimings: {} } as never, { generated: 1, valid: 1 }), { furthestPhase: "execute", specs: { generated: 1, valid: 1 } });
});

test("a limit only the agent turns met is listed but leads nothing; a limit the engine met leads, and a lone leading limit counts as met", () => {
  const turns = [{ fired: "step-cap", role: "qa-author", turns: 2 }];
  assert.deepEqual(withTurnLimits({}, turns), { limits: [{ fired: "step-cap", role: "qa-author", scope: "turn", turns: 2 }] });
  assert.deepEqual(withTurnLimits({ limitFired: "run-deadline", limitRole: "qa-lead" }, []), {
    limitFired: "run-deadline",
    limitRole: "qa-lead",
    limits: [{ fired: "run-deadline", role: "qa-lead", scope: "run" }],
  });
  assert.deepEqual(withTurnLimits({}, []), { limits: [] });
});
