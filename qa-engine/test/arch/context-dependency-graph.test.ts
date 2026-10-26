/* Contexts depend on each other without a cycle, and only along the edges below. dependency-cruiser sees modules, so a cycle that runs
   through several contexts (a imports b, b imports c, c imports a) is invisible to its module-level rule: this test folds the module graph into
   a graph of contexts and checks it. A composition module wires contexts together by design and is not an edge. A new edge is a deliberate
   edit of ALLOWED. The cases run on small throwaway trees as well as on the real one, so a checker that stopped matching would fail here. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const DEPCRUISE = join(repoRoot, "node_modules", ".bin", "depcruise");
const CONFIG_REL = join("qa-engine", ".dependency-cruiser.cjs");

/** Who each context may depend on. A context absent from the map depends on no other. */
const ALLOWED: Record<string, readonly string[]> = {
  "agent-tools": ["app-catalog", "generation", "test-execution"],
  "change-analysis": ["agent-tools", "generation"],
  coordination: ["agent-tools", "generation", "test-execution"],
  generation: ["cross-run-learning", "service-topology"],
  "run-orchestration": ["agent-tools", "app-catalog", "change-analysis", "coordination", "cross-run-learning", "generation", "objective-signal", "service-topology", "test-execution", "workspace-and-publication"],
  "test-execution": ["generation", "objective-signal"],
  "workspace-and-publication": ["objective-signal", "test-execution"],
};

interface CruiseModule {
  source: string;
  dependencies: Array<{ resolved: string }>;
}

const contextOf = (file: string): string | undefined => file.match(/^qa-engine\/src\/contexts\/([^/]+)\//)?.[1];

/** The edges "from -> to" between contexts: some module of `from`, outside composition/, imports a module of `to`. */
function contextEdges(modules: readonly CruiseModule[]): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>();
  for (const m of modules) {
    const from = contextOf(m.source);
    if (!from || /\/composition\//.test(m.source)) continue;
    for (const d of m.dependencies) {
      const to = contextOf(d.resolved);
      if (!to || to === from) continue;
      if (!edges.has(from)) edges.set(from, new Set());
      edges.get(from)!.add(to);
    }
  }
  return edges;
}

/** One cycle of the graph as a list of contexts that returns to its first, or undefined when the graph is acyclic. */
function findCycle(edges: ReadonlyMap<string, ReadonlySet<string>>): string[] | undefined {
  const state = new Map<string, "open" | "done">();
  const stack: string[] = [];
  const visit = (node: string): string[] | undefined => {
    state.set(node, "open");
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      if (state.get(next) === "open") return [...stack.slice(stack.indexOf(next)), next];
      if (!state.has(next)) {
        const cycle = visit(next);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    state.set(node, "done");
    return undefined;
  };
  for (const node of edges.keys()) if (!state.has(node)) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return undefined;
}

function modulesOf(treeRoot: string): CruiseModule[] {
  let output: string;
  try {
    output = execFileSync(DEPCRUISE, ["--config", join(treeRoot, CONFIG_REL), "-T", "json", "qa-engine/src"], { cwd: treeRoot, encoding: "utf8", maxBuffer: 1 << 28 });
  } catch (e) {
    /* depcruise exits non-zero on a rule violation; the report is still on stdout. */
    output = (e as { stdout?: string }).stdout ?? "";
  }
  return (JSON.parse(output) as { modules: CruiseModule[] }).modules;
}

function treeWith(files: Record<string, string>): string {
  const treeRoot = mkdtempSync(join(tmpdir(), "context-graph-"));
  const tsconfig = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "ESNext", moduleResolution: "bundler", allowImportingTsExtensions: true } });
  for (const [rel, content] of Object.entries({ "tsconfig.json": tsconfig, "qa-engine/tsconfig.json": tsconfig, ...files })) {
    mkdirSync(dirname(join(treeRoot, rel)), { recursive: true });
    writeFileSync(join(treeRoot, rel), content);
  }
  copyFileSync(join(repoRoot, CONFIG_REL), join(treeRoot, CONFIG_REL));
  return treeRoot;
}

const CTX = "qa-engine/src/contexts";
const through = (from: string, to: string): string => `import { v } from "../../${to}/application/index.ts";\nexport const x = v;\n`;

test("a cycle that runs through three contexts is found, and an acyclic graph is not", () => {
  const tree = treeWith({
    [`${CTX}/a/application/index.ts`]: `export const v = 1;\n`,
    [`${CTX}/a/application/use.ts`]: through("a", "c"),
    [`${CTX}/b/application/index.ts`]: `export const v = 1;\n`,
    [`${CTX}/b/application/use.ts`]: through("b", "a"),
    [`${CTX}/c/application/index.ts`]: `export const v = 1;\n`,
    [`${CTX}/c/application/use.ts`]: through("c", "b"),
  });
  const cycle = findCycle(contextEdges(modulesOf(tree)));
  assert.ok(cycle, "a -> c -> b -> a is a cycle");
  assert.deepEqual([...new Set(cycle)].sort(), ["a", "b", "c"]);

  const acyclic = treeWith({
    [`${CTX}/a/application/index.ts`]: `export const v = 1;\n`,
    [`${CTX}/b/application/index.ts`]: `export const v = 1;\n`,
    [`${CTX}/b/application/use.ts`]: through("b", "a"),
  });
  assert.equal(findCycle(contextEdges(modulesOf(acyclic))), undefined);
});

test("a composition module is not an edge between contexts", () => {
  const tree = treeWith({
    [`${CTX}/a/application/index.ts`]: `export const v = 1;\n`,
    [`${CTX}/b/composition/build-b.ts`]: through("b", "a"),
  });
  assert.equal(contextEdges(modulesOf(tree)).size, 0);
});

test("the contexts of the engine form no cycle", () => {
  const cycle = findCycle(contextEdges(modulesOf(repoRoot)));
  assert.equal(cycle, undefined, `contexts depend on each other in a cycle: ${cycle?.join(" -> ")}`);
});

test("the contexts depend on each other only along the allowed edges", () => {
  const actual = [...contextEdges(modulesOf(repoRoot))].flatMap(([from, tos]) => [...tos].map((to) => `${from} -> ${to}`)).sort();
  const allowed = Object.entries(ALLOWED).flatMap(([from, tos]) => tos.map((to) => `${from} -> ${to}`)).sort();
  assert.deepEqual(actual, allowed, "a context gained or lost a dependency: edit ALLOWED on purpose");
});
