/* The functions V8's precise block coverage reports for a script once it has run: the ranges a coverage dump carries. */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import vm from "node:vm";
import type { V8Entry } from "@contexts/objective-signal/infrastructure/v8-browser-coverage.adapter.ts";

let scriptCount = 0;

export async function ranUnderCoverage(source: string): Promise<V8Entry["functions"]> {
  const filename = `branch-probe-${++scriptCount}.js`;
  const session = new Session();
  session.connect();
  try {
    await session.post("Profiler.enable");
    await session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
    new vm.Script(source, { filename }).runInThisContext();
    const { result } = await session.post("Profiler.takePreciseCoverage");
    await session.post("Profiler.stopPreciseCoverage");
    const script = result.find((s) => s.url === filename);
    assert.ok(script, "V8 reported the script");
    return script.functions;
  } finally {
    session.disconnect();
  }
}
