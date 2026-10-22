import { test } from "node:test";
import assert from "node:assert/strict";
import { activeExecScope, newSandboxReport, runScopeKey, withExecScope, withExecScopeParent, type RunScope } from "../../../src/shared-infrastructure/process-sandbox/exec-scope.ts";

const scope = (): RunScope => ({ runId: "r", workDir: "/tmp/x", egress: { dev: [], install: [] }, report: newSandboxReport(), telemetry: { parent: () => ({ traceId: "t", spanId: "phase" }) } });

test("inside a replaced parent every child hangs under the new one, and outside it the run's own parent is back", () => {
  const run = scope();
  withExecScope(run, () => {
    withExecScopeParent({ traceId: "t", spanId: "call" }, () => {
      assert.equal(activeExecScope()?.telemetry?.parent()?.spanId, "call");
    });
    assert.equal(activeExecScope()?.telemetry?.parent()?.spanId, "phase");
  });
});

test("the replaced scope reports into the run's own sandbox report", () => {
  const run = scope();
  withExecScope(run, () => {
    withExecScopeParent({ traceId: "t", spanId: "call" }, () => {
      activeExecScope()!.report.denied.push("evil.example");
    });
  });
  assert.deepEqual(run.report.denied, ["evil.example"]);
});

test("outside a run there is no scope to replace and the function still runs", () => {
  assert.equal(withExecScopeParent({ traceId: "t", spanId: "call" }, () => 7), 7);
});

test("the replaced scope keeps the phase's other hooks unless the call gives its own, and stays the run's scope for anything kept per run", () => {
  const annotated: string[] = [];
  const run: RunScope = { ...scope(), telemetry: { parent: () => ({ traceId: "t", spanId: "phase" }), phaseStart: () => 111, annotate: () => void annotated.push("phase") } };
  withExecScope(run, () => {
    withExecScopeParent({ traceId: "t", spanId: "call" }, () => {
      assert.equal(activeExecScope()?.telemetry?.phaseStart?.(), 111);
      activeExecScope()?.telemetry?.annotate?.({});
      assert.equal(runScopeKey(activeExecScope()!), run);
    });
    withExecScopeParent({ traceId: "t", spanId: "call" }, () => {
      assert.equal(activeExecScope()?.telemetry?.phaseStart?.(), 222);
      activeExecScope()?.telemetry?.annotate?.({});
    }, { startedAt: 222, annotate: () => void annotated.push("call") });
    assert.equal(runScopeKey(run), run);
  });
  assert.deepEqual(annotated, ["phase", "call"]);
});
