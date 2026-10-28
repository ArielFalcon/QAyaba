/* The module resolver is shared infrastructure: the route table and the code graph's unlinked uses both reach it there, it reaches
   no context, and the cruise of its users under the real layering config finds no violation (only composition roots cross contexts). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
const DEPCRUISE = join(repoRoot, "node_modules", ".bin", "depcruise");
const RESOLVER = "qa-engine/src/shared-infrastructure/module-resolution/module-resolver.ts";
const UNLINKED = "qa-engine/src/shared-infrastructure/module-resolution/unlinked-uses.ts";
const ROUTE_TABLE = "qa-engine/src/contexts/generation/infrastructure/route-table/route-table.loader.ts";
const CODE_GRAPH = "qa-engine/src/shared-infrastructure/code-graph/codegraph-code-graph.adapter.ts";

interface Cruise {
  summary: { violations: unknown[] };
  modules: Array<{ source: string; dependencies: Array<{ resolved: string }> }>;
}

test("the module resolver lives in shared infrastructure, reaches no context, and its users reach it there without a layering violation", () => {
  const out = execFileSync(DEPCRUISE, ["--config", "qa-engine/.dependency-cruiser.cjs", "--output-type", "json", "qa-engine/src/shared-infrastructure/module-resolution", ROUTE_TABLE, CODE_GRAPH], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 << 20 });
  const cruise = JSON.parse(out) as Cruise;
  const deps = (source: string): string[] => cruise.modules.find((m) => m.source === source)?.dependencies.map((d) => d.resolved) ?? [];

  assert.deepEqual(cruise.summary.violations, []);
  for (const module of cruise.modules.filter((m) => m.source.startsWith("qa-engine/src/shared-infrastructure/module-resolution/"))) {
    assert.deepEqual(module.dependencies.map((d) => d.resolved).filter((r) => r.startsWith("qa-engine/src/contexts/")), [], module.source);
  }
  assert.ok(deps(ROUTE_TABLE).includes(RESOLVER), "the route table resolves with the shared resolver");
  assert.ok(deps(UNLINKED).includes(RESOLVER), "the code graph's unlinked uses resolve with the shared resolver");
  assert.ok(deps(CODE_GRAPH).includes(UNLINKED));
});
