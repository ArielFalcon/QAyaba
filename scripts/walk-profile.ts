/*
 * The impact walk's profile on real code-graph stores: the in-degree distribution a fan-in limit would be set from, and a
 * replay of one change's walk under today's budget and under fan-in limits, so the walk policy is chosen from measurements
 * (docs: the adaptive impact walk design, Phase 0). Read-only: it opens each store read-only and writes nothing.
 *
 *   npx tsx scripts/walk-profile.ts --store <codegraph.db> [--store ...] [--diff <unified diff>] [--map <context map JSON>]
 *       [--depth 3] [--max-nodes 300] [--watch <file::symbol>]... [--focus <file>]... [--json]
 *
 * --store  a codegraph store (a copy of `<data>/code-graph/<app>/<repo>/codegraph.db`, or one inside a run's workspace).
 * --diff   `git diff <base> <head>` of the change whose seeds are replayed; without it only the degrees are reported.
 * --map    the app's context map (`context_maps.data`): its routes' `implementationFiles` are the pages a walk can reach.
 * --watch  a symbol to look for in every seed's complete walk (a route guard, for example).
 * --focus  a changed file whose seeds are listed one by one.
 *
 * The replay of today's budget runs the store reader itself (the walk the engine runs). The fan-in policies are a
 * simulation of the proposed walk: every seed walked on its own to the depth (so a page reached by two seeds counts for
 * both), a node whose caller list is longer than the limit recorded as a hub node and not expanded, a seed whose own caller
 * list is longer recorded as a hub seed. "Expansions" are the distinct nodes whose callers were read (the reader's SQL work).
 * The caller rule is the reader's: its queries are repeated here, so a change to the reader's walk must be made here too.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { STORE_READER_SCRIPT } from "../qa-engine/src/shared-infrastructure/code-graph/codegraph-engine.ts";
import { selectSeeds, type StoreSymbol } from "../qa-engine/src/shared-infrastructure/code-graph/codegraph-code-graph.adapter.ts";
import { DiffParserService } from "../qa-engine/src/shared-kernel/diff-parser/diff-parser.service.ts";
import { LanguageRegistry } from "../qa-engine/src/shared-kernel/language-id.ts";
import { CHANGE_SCOPE_LIMITS } from "../qa-engine/src/contexts/change-analysis/application/index.ts";

const CALLABLE_KINDS = ["function", "method", "class", "component", "interface"];
const VALUE_KINDS = ["constant", "variable"];
const REFERENCED_KINDS = [...VALUE_KINDS, "function", "method"];
const INJECTABLE_KINDS = [...VALUE_KINDS, "class", "component"];
const TOP_LEVEL_CODE_KINDS = ["function", "class", "component"];
const CONTAINER_KINDS = ["class", "component", "interface"];
const PERCENTILES = [50, 90, 95, 99, 99.5] as const;

export interface Args {
  stores: string[];
  diff?: string;
  map?: string;
  depth: number;
  maxNodes: number;
  watch: string[];
  focus: string[];
  json: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { stores: [], depth: 3, maxNodes: 300, watch: [], focus: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === "--store") args.stores.push(value());
    else if (flag === "--diff") args.diff = value();
    else if (flag === "--map") args.map = value();
    else if (flag === "--depth") args.depth = Number(value());
    else if (flag === "--max-nodes") args.maxNodes = Number(value());
    else if (flag === "--watch") args.watch.push(value());
    else if (flag === "--focus") args.focus.push(value());
    else if (flag === "--json") args.json = true;
    else throw new Error(`unknown argument ${flag}`);
  }
  if (args.stores.length === 0) throw new Error("name at least one --store");
  return args;
}

/* Nearest-rank percentile of an ascending list. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

interface Row {
  id: string;
  file: string;
  symbol: string;
  kind: string;
  startLine: number;
}

const marks = (list: readonly string[]): string => list.map(() => "?").join(",");
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byPosition = (a: Row, b: Row): number => compare(a.file, b.file) || a.startLine - b.startLine || compare(a.symbol, b.symbol) || compare(a.id, b.id);

/* The store as the reader's walk sees it: a node, its callers (or, for a value or class no code calls, the top-level code of its importers), a method's containers. */
class WalkGraph {
  private readonly nodeStmt: StatementSync;
  private readonly callersStmt: StatementSync;
  private readonly importersStmt: StatementSync;
  private readonly containersStmt: StatementSync;
  private readonly rows = new Map<string, Row | null>();
  private readonly callerMemo = new Map<string, string[]>();
  queries = 0;

  /* appCallersOnly: a caller in a test file (by the language registry) is not a caller, before the importers fallback is decided. */
  constructor(readonly db: DatabaseSync, private readonly appCallersOnly = false) {
    this.nodeStmt = db.prepare("SELECT id, name, kind, file_path, start_line FROM nodes WHERE id = ?");
    this.callersStmt = db.prepare(`SELECT e.source AS id FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target WHERE e.target = ? AND (e.kind IN ('calls', 'instantiates') OR (e.kind = 'references' AND (s.kind = 'route' OR (t.kind IN (${marks(REFERENCED_KINDS)}) AND s.kind IN (${marks(CALLABLE_KINDS)}))))) GROUP BY e.source ORDER BY s.file_path, s.start_line, s.name, s.id`);
    this.importersStmt = db.prepare(`SELECT c.id AS id FROM edges e JOIN nodes f ON f.id = e.source AND f.kind = 'file' JOIN edges ce ON ce.source = f.id AND ce.kind = 'contains' JOIN nodes c ON c.id = ce.target WHERE e.target = ? AND e.kind = 'imports' AND c.kind IN (${marks(TOP_LEVEL_CODE_KINDS)}) GROUP BY c.id ORDER BY c.file_path, c.start_line, c.name, c.id`);
    this.containersStmt = db.prepare(`SELECT e.source AS id FROM edges e JOIN nodes s ON s.id = e.source WHERE e.target = ? AND e.kind = 'contains' AND s.kind IN (${marks(CONTAINER_KINDS)}) ORDER BY s.file_path, s.start_line, s.name, s.id`);
  }

  row(id: string): Row | null {
    if (!this.rows.has(id)) {
      const r = this.nodeStmt.get(id) as { id: string; name: string; kind: string; file_path: string; start_line: number } | undefined;
      this.rows.set(id, r && r.kind !== "file" && r.kind !== "import" ? { id: r.id, file: r.file_path, symbol: r.name, kind: r.kind, startLine: r.start_line } : null);
    }
    return this.rows.get(id)!;
  }

  private kept(ids: string[]): string[] {
    return ids.filter((c) => {
      const r = this.row(c);
      return r !== null && !(this.appCallersOnly && LanguageRegistry.isTestFile(r.file));
    });
  }

  /* The reader's caller list of a node; read once per node. */
  callers(id: string): string[] {
    const known = this.callerMemo.get(id);
    if (known) return known;
    this.queries++;
    const found = (this.callersStmt.all(id, ...REFERENCED_KINDS, ...CALLABLE_KINDS) as { id: string }[]).map((r) => r.id);
    /* The reader falls back to the importers only when the query found nothing (a file-level caller counts, then is dropped). */
    const decided = this.appCallersOnly ? this.kept(found) : found;
    const kept = this.kept(decided.length === 0 && INJECTABLE_KINDS.includes(this.row(id)?.kind ?? "") ? (this.importersStmt.all(id, ...TOP_LEVEL_CODE_KINDS) as { id: string }[]).map((r) => r.id) : found);
    this.callerMemo.set(id, kept);
    return kept;
  }

  containers(id: string): string[] {
    return (this.containersStmt.all(id, ...CONTAINER_KINDS) as { id: string }[]).map((r) => r.id).filter((c) => this.row(c) !== null);
  }

  /* Every node a walk can seed or reach, with its caller count. */
  fanIns(): { id: string; fanIn: number; test: boolean }[] {
    const ids = (this.db.prepare(`SELECT id FROM nodes WHERE kind IN (${marks([...CALLABLE_KINDS, ...VALUE_KINDS])})`).all(...CALLABLE_KINDS, ...VALUE_KINDS) as { id: string }[]).map((r) => r.id);
    return ids.map((id) => ({ id, fanIn: this.callers(id).length, test: LanguageRegistry.isTestFile(this.row(id)?.file ?? "") }));
  }
}

export interface SeedWalk {
  seed: Row;
  reached: Map<string, number>;
  hubSeed: boolean;
  hubNodes: Set<string>;
  expanded: Set<string>;
}

/* One seed's walk to the depth; with a fan-in limit, a node (or the seed) with more callers is not expanded. */
function walkSeed(graph: WalkGraph, seed: Row, depth: number, fanInLimit: number | undefined): SeedWalk {
  const reached = new Map<string, number>([[seed.id, 0]]);
  const hubNodes = new Set<string>();
  const expanded = new Set<string>();
  const lift = (ids: string[], d: number): string[] => {
    const out: string[] = [];
    for (const id of ids) {
      out.push(id);
      if (graph.row(id)?.kind !== "method") continue;
      for (const owner of graph.containers(id)) if (!reached.has(owner)) { reached.set(owner, d); out.push(owner); }
    }
    return out;
  };
  const hubSeed = fanInLimit !== undefined && graph.callers(seed.id).length > fanInLimit;
  let frontier = hubSeed ? [] : lift([seed.id], 0);
  for (let d = 1; d <= depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const id of [...frontier].sort((a, b) => byPosition(graph.row(a)!, graph.row(b)!))) {
      const callers = graph.callers(id);
      if (fanInLimit !== undefined && id !== seed.id && callers.length > fanInLimit) { hubNodes.add(id); continue; }
      expanded.add(id);
      for (const c of callers) if (!reached.has(c)) { reached.set(c, d); next.push(c); }
    }
    frontier = lift(next, d);
  }
  return { seed, reached, hubSeed, hubNodes, expanded };
}

interface Pages {
  /* page route → its implementing files */
  files: Map<string, string[]>;
}

function loadPages(path: string | undefined): Pages {
  if (!path) return { files: new Map() };
  const map = JSON.parse(readFileSync(path, "utf8")) as { routes?: { path: string; implementationFiles?: string[] }[] };
  return { files: new Map((map.routes ?? []).map((r) => [r.path, (r.implementationFiles ?? []).filter((f) => !LanguageRegistry.isTestFile(f))])) };
}

function pagesOf(graph: WalkGraph, ids: Iterable<string>, pages: Pages): Set<string> {
  const files = new Set<string>();
  for (const id of ids) {
    const r = graph.row(id);
    if (r && !LanguageRegistry.isTestFile(r.file)) files.add(r.file);
  }
  const out = new Set<string>();
  for (const [route, implementing] of pages.files) if (implementing.some((f) => files.has(f))) out.add(route);
  return out;
}

function routesOf(graph: WalkGraph, ids: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    const r = graph.row(id);
    if (r?.kind === "route" && !LanguageRegistry.isTestFile(r.file)) out.add(r.symbol);
  }
  return out;
}

export interface PolicyReport {
  policy: string;
  fanInLimit: number | null;
  seeds: number;
  hubSeeds: number;
  seedsMeetingHubNodes: number;
  hubNodes: number;
  nodesVisited: number;
  expansions: number;
  seedsHubByEntries: number;
  seedsWithPages: number;
  pagesReached: number;
  pagesProvenByNonHubSeeds: number;
  routesReached: number;
  /* The hub nodes and hub seeds with the most callers, `file::symbol (callers)`. */
  topHubs: string[];
  ms: number;
}

function runPolicy(db: DatabaseSync, seeds: Row[], depth: number, fanInLimit: number | undefined, pages: Pages, appCallersOnly = false): { report: PolicyReport; walks: SeedWalk[]; graph: WalkGraph } {
  const graph = new WalkGraph(db, appCallersOnly);
  const started = performance.now();
  const walks = seeds.map((s) => walkSeed(graph, s, depth, fanInLimit));
  const ms = performance.now() - started;
  const visited = new Set<string>();
  const expanded = new Set<string>();
  const hubNodes = new Set<string>();
  const allPages = new Set<string>();
  const provenPages = new Set<string>();
  let hubByEntries = 0;
  let withPages = 0;
  for (const w of walks) {
    for (const id of w.reached.keys()) visited.add(id);
    for (const id of w.expanded) expanded.add(id);
    for (const id of w.hubNodes) hubNodes.add(id);
    const p = pagesOf(graph, w.reached.keys(), pages);
    for (const route of p) allPages.add(route);
    if (p.size > 0) withPages++;
    const hub = p.size > CHANGE_SCOPE_LIMITS.hubEntries || w.hubSeed;
    if (p.size > CHANGE_SCOPE_LIMITS.hubEntries) hubByEntries++;
    if (!hub) for (const route of p) provenPages.add(route);
  }
  return {
    graph,
    walks,
    report: {
      policy: `${fanInLimit === undefined ? "complete" : `fan-in ≤ ${fanInLimit}`}, depth ${depth}${appCallersOnly ? ", app callers only" : ""}`,
      fanInLimit: fanInLimit ?? null,
      seeds: seeds.length,
      hubSeeds: walks.filter((w) => w.hubSeed).length,
      seedsMeetingHubNodes: walks.filter((w) => w.hubNodes.size > 0).length,
      hubNodes: hubNodes.size,
      nodesVisited: visited.size,
      expansions: expanded.size,
      seedsHubByEntries: hubByEntries,
      seedsWithPages: withPages,
      pagesReached: allPages.size,
      pagesProvenByNonHubSeeds: provenPages.size,
      routesReached: routesOf(graph, visited).size,
      topHubs: [...new Set([...hubNodes, ...walks.filter((w) => w.hubSeed).map((w) => w.seed.id)])]
        .map((id) => ({ id, fanIn: graph.callers(id).length }))
        .sort((a, b) => b.fanIn - a.fanIn || compare(a.id, b.id))
        .slice(0, 8)
        .map(({ id, fanIn }) => `${graph.row(id)?.file}::${graph.row(id)?.symbol} (${fanIn})`),
      ms: Math.round(ms),
    },
  };
}

interface ReaderWalk {
  nodes: { id: string; file: string; symbol: string; kind: string; depth: number }[];
  truncated: boolean;
}

export function readerWalk(store: string, seeds: Row[], depth: number, maxNodes: number): { walk: ReaderWalk; ms: number } {
  const started = performance.now();
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", STORE_READER_SCRIPT, store, JSON.stringify({ op: "walk", seeds: seeds.map((s) => s.id), depth, maxNodes })], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`the store reader failed (${r.status}): ${r.stderr.slice(0, 400)}`);
  return { walk: JSON.parse(r.stdout) as ReaderWalk, ms: Math.round(performance.now() - started) };
}

export function seedsOf(db: DatabaseSync, diffText: string): Row[] {
  const parser = new DiffParserService();
  const files = [...new Set(parser.changedFiles(diffText))].filter((f) => !LanguageRegistry.isTestFile(f));
  const stmt = db.prepare(`SELECT id, name, kind, file_path, start_line, end_line FROM nodes WHERE file_path = ? AND kind IN (${marks([...CALLABLE_KINDS, ...VALUE_KINDS])})`);
  const symbols: StoreSymbol[] = [];
  for (const f of files) for (const r of stmt.all(f, ...CALLABLE_KINDS, ...VALUE_KINDS) as { id: string; name: string; kind: string; file_path: string; start_line: number; end_line: number }[]) symbols.push({ id: r.id, file: r.file_path, symbol: r.name, kind: r.kind, startLine: r.start_line, endLine: r.end_line });
  return selectSeeds(symbols, files, parser.touchedLines(diffText)).map((s) => ({ id: s.id, file: s.file, symbol: s.symbol, kind: s.kind, startLine: s.startLine }));
}

export function main(argv: readonly string[], out: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): number {
  const args = parseArgs(argv);
  const pages = loadPages(args.map);
  const result: Record<string, unknown>[] = [];
  for (const store of args.stores) {
    const db = new DatabaseSync(store, { readOnly: true });
    const degrees = new WalkGraph(db);
    const fan = degrees.fanIns();
    const top = [...fan].sort((a, b) => b.fanIn - a.fanIn || compare(a.id, b.id)).slice(0, 5).map((f) => `${degrees.row(f.id)?.file}::${degrees.row(f.id)?.symbol} (${f.fanIn})`);
    const all = fan.map((f) => f.fanIn).sort((a, b) => a - b);
    const app = fan.filter((f) => !f.test).map((f) => f.fanIn).sort((a, b) => a - b);
    /* The same nodes outside test files, counting only their callers outside test files. */
    const appGraph = new WalkGraph(db, true);
    const appCallers = appGraph.fanIns().filter((f) => !f.test).map((f) => f.fanIn).sort((a, b) => a - b);
    const dist = (xs: number[]) => ({ n: xs.length, ...Object.fromEntries(PERCENTILES.map((p) => [`p${p}`, percentile(xs, p)])), max: xs.at(-1) ?? 0 });
    const entry: Record<string, unknown> = { store, inDegree: { all: dist(all), nonTestFiles: dist(app), appCallersOfNonTestFiles: dist(appCallers), nonZero: dist(all.filter((x) => x > 0)), top } };
    out(`# ${store}`);
    out(`in-degree (callers the walk follows) over ${all.length} callable/value nodes: ${JSON.stringify(entry.inDegree)}`);
    if (args.diff) {
      const seeds = seedsOf(db, readFileSync(args.diff, "utf8")).sort(byPosition);
      const current = readerWalk(store, seeds, args.depth, args.maxNodes);
      const reached = new Set(current.walk.nodes.map((n) => n.id));
      const complete = runPolicy(db, seeds, args.depth, undefined, pages);
      const lostSeeds = complete.walks.filter((w) => [...w.reached.keys()].some((id) => !reached.has(id)));
      const lostPages = complete.walks.filter((w) => [...pagesOf(complete.graph, w.reached.keys(), pages)].some((p) => !pagesOf(complete.graph, [...w.reached.keys()].filter((id) => reached.has(id)), pages).has(p)));
      const currentReport = {
        policy: `today: depth ${args.depth}, maxNodes ${args.maxNodes} (store reader)`,
        seeds: seeds.length,
        truncated: current.walk.truncated,
        seedsMarkedHubByTheCut: current.walk.truncated ? seeds.length : 0,
        seedsWhoseOwnWalkWasCut: lostSeeds.length,
        seedsThatLostAPage: lostPages.length,
        nodesVisited: current.walk.nodes.length,
        pagesReached: pagesOf(complete.graph, reached, pages).size,
        routesReached: routesOf(complete.graph, reached).size,
        ms: current.ms,
      };
      const percentiles = [95, 99, 99.5];
      const policies = [
        complete.report,
        ...percentiles.map((p) => ({ ...runPolicy(db, seeds, args.depth, percentile(all, p), pages).report, policy: `fan-in ≤ p${p} (${percentile(all, p)}), depth ${args.depth}` })),
        runPolicy(db, seeds, args.depth, undefined, pages, true).report,
        ...percentiles.map((p) => ({ ...runPolicy(db, seeds, args.depth, percentile(appCallers, p), pages, true).report, policy: `fan-in ≤ p${p} of app callers (${percentile(appCallers, p)}), depth ${args.depth}, app callers only` })),
      ];
      entry.replay = { current: currentReport, policies };
      out(`seeds: ${seeds.length}`);
      out(`today: ${JSON.stringify(currentReport)}`);
      for (const p of policies) out(`${p.policy}: ${JSON.stringify(p)}`);
      if (args.watch.length > 0) {
        const deep = runPolicy(db, seeds, 6, undefined, pages);
        for (const w of args.watch) {
          const [file, symbol] = w.split("::");
          const hits = deep.walks.flatMap((sw) => [...sw.reached].filter(([id]) => { const r = deep.graph.row(id); return r !== null && r.file === file && r.symbol === symbol; }).map(([, d]) => `${sw.seed.file}::${sw.seed.symbol}@${d}`));
          out(`watch ${w}: ${hits.length === 0 ? "reached by no seed within depth 6 (complete walks)" : hits.join(", ")}`);
        }
      }
      for (const f of args.focus) {
        for (const w of complete.walks.filter((sw) => sw.seed.file === f)) {
          const p = [...pagesOf(complete.graph, w.reached.keys(), pages)].sort();
          const inCut = [...w.reached.keys()].filter((id) => reached.has(id));
          const pCut = [...pagesOf(complete.graph, inCut, pages)].sort();
          out(`focus ${w.seed.file}::${w.seed.symbol}:${w.seed.startLine}: complete walk ${w.reached.size} nodes, pages [${p.join(", ")}]; in today's cut walk ${inCut.length} of them, pages [${pCut.join(", ")}]`);
          const far = [...w.reached].filter(([, d]) => d > 0).map(([id, d]) => `${complete.graph.row(id)?.file}::${complete.graph.row(id)?.symbol}@${d}`).sort();
          out(`  reached: ${far.slice(0, 40).join(" | ")}${far.length > 40 ? ` | … ${far.length - 40} more` : ""}`);
        }
      }
    }
    db.close();
    result.push(entry);
  }
  if (args.json) out(JSON.stringify(result, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
