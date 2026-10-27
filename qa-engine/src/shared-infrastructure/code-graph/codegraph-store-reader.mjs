/*
 * The structured reader of a codegraph store: the one answer the engine's CLI does not give as JSON (a file's symbols with
 * their line ranges, an inbound walk with each node's predecessor, the route nodes with what they point at). It runs as a
 * child of the execution launcher's `graph` profile, never inside the orchestrator, and opens the store read-only.
 *
 * It is pinned to the store schema it was written against: a store of another schema or extraction version is refused
 * (exit 3) rather than read with queries that may mean something else there. Every answer is sorted, so identical stores
 * give identical bytes: every query that a limit can cut orders what it reads, and a request with more files, symbols or
 * seeds than the bound is cut to the bound (deduplicated, in a fixed order) and says so with `truncated`, never refused.
 *
 * Usage: node codegraph-store-reader.mjs <store path> <request JSON>...  (a long request comes in several arguments, joined in order)
 *   {"op":"symbols","files":["a.ts"]}                       → {"symbols":[{id,file,symbol,kind,startLine,endLine}],"truncated":bool}
 *   {"op":"walk","seeds":["<id>"],"depth":3,"excludeFiles":["<file>"],"fanIn":{"percentile":99,"floor":8,"ceiling":64}|"fanInLimit":N,"maxExpansions":N,"closureExpansions":N}
 *     → {"nodes":[{id,file,symbol,kind,startLine,endLine?,depth,confidence,via?,seeds:[[seed index, hops]]}],
 *        "seeds":[{id,file,symbol,status:"complete"|"partial"}],
 *        "hubNodes":[{id,file,symbol,kind,startLine,fanIn,depth,seeds:[seed index],closure:{nodes:[...as nodes, without seeds],complete}}],
 *        "cost":{expansions,budget,fanInLimit?,closureExpansions,closureBudget},"truncated":bool}
 *     (`confidence` is the lowest an edge on the path that first reached the node holds, 1 for a seed or an edge that states none;
 *     `endLine` is given for a seed; `truncated` says the request's seeds were cut to the bound. Without `fanIn` or `fanInLimit`
 *     no node is a hub; without `maxExpansions` the reader's own ceiling is the budget.)
 *   {"op":"degrees","percentile":99,"excludeFiles":[...]}   → {"callables":N,"value":N} (the in-degree at that percentile, nearest rank)
 *   {"op":"files"}                                          → {"files":["<file>"]} (every file the store holds a node of, sorted)
 *   (`excludeFiles`: files whose code is never a caller, the walk's or the fan-in's: the test files of the repo's languages.)
 *   {"op":"routes"}                                         → {"routes":[{name,file,line,target?:{file,symbol,kind}}]}
 *   {"op":"find","symbols":[{"file":"a.ts","symbol":"f"}]}  → {"symbols":[...as symbols],"truncated":bool}
 *   {"op":"ping"}                                           → {"ready":true} (the store opens and is of the pinned version)
 */

import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 11;
const EXTRACTION_VERSION = "27";

/* What a seed, a caller or a page anchor can be: code that runs or holds code. Fields, constants, imports and files are not. */
const CALLABLE_KINDS = ["function", "method", "class", "component", "interface"];
/* Module-level values: a change to one seeds the walk, and the code that references it is its caller. */
const VALUE_KINDS = ["constant", "variable"];
/* What code references by name to use it: a module-level value it reads, a function it passes on. */
const REFERENCED_KINDS = [...VALUE_KINDS, "function", "method"];
/* What a file hands to the code that imports it without a call: a value or a class (dependency injection, a token). */
const INJECTABLE_KINDS = [...VALUE_KINDS, "class", "component"];
/* The code a file declares at its top level. */
const TOP_LEVEL_CODE_KINDS = ["function", "class", "component"];
/* Where a method's behaviour lives for whoever references the type: its class (a route references the component, not its method). */
const CONTAINER_KINDS = ["class", "component", "interface"];
const MAX_FILES = 2000;
const MAX_SEEDS = 2000;
const MAX_DEPTH = 6;
const MAX_NODES = 5000;
const MAX_EXPANSIONS = 20000;
const MAX_EXCLUDED_FILES = 100000;

/* An edge the walk follows from a node to its caller: a call or an instantiation; a route referencing its page; code that runs referencing a value it reads or a function it passes on. `e`, `s` and `t` are the edge, its source and its target. */
const quoted = (kinds) => kinds.map((k) => `'${k}'`).join(",");
const CALLER_EDGE = `(e.kind IN ('calls', 'instantiates') OR (e.kind = 'references' AND (s.kind = 'route' OR (t.kind IN (${quoted(REFERENCED_KINDS)}) AND s.kind IN (${quoted(CALLABLE_KINDS)})))))`;

function fail(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function parseRequest(raw) {
  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    fail(2, "the request is not JSON");
  }
  if (typeof request !== "object" || request === null || typeof request.op !== "string") fail(2, "the request names no op");
  return request;
}

/* The distinct strings of a request, at most `max` of them: past the bound the first `max` in code-unit order are kept, whatever order the request came in. */
function strings(value, max, what) {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.length > 4096)) fail(2, `${what} must be strings`);
  const distinct = [...new Set(value)];
  if (distinct.length <= max) return { items: distinct, truncated: false };
  return { items: distinct.sort(compare).slice(0, max), truncated: true };
}

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function bounded(value, min, max, fallback) {
  return Number.isInteger(value) ? Math.min(Math.max(value, min), max) : fallback;
}

function openStore(path) {
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (err) {
    fail(4, `the store cannot be opened: ${err instanceof Error ? err.message : String(err)}`);
  }
  const schema = db.prepare("SELECT max(version) AS v FROM schema_versions").get()?.v;
  const extraction = db.prepare("SELECT value FROM project_metadata WHERE key = 'indexed_with_extraction_version'").get()?.value;
  if (schema !== SCHEMA_VERSION || String(extraction) !== EXTRACTION_VERSION) fail(3, `unsupported store: schema ${schema}, extraction ${extraction} (reader pinned to ${SCHEMA_VERSION}/${EXTRACTION_VERSION})`);
  return db;
}

const rowRef = (row) => ({ id: row.id, file: row.file_path, startLine: row.start_line, symbol: row.name });

const byPosition = (a, b) => compare(a.file, b.file) || a.startLine - b.startLine || compare(a.symbol, b.symbol) || compare(a.id, b.id);

function symbolRow(row) {
  return { id: row.id, file: row.file_path, symbol: row.name, kind: row.kind, startLine: row.start_line, endLine: row.end_line };
}

function symbolsOf(db, files) {
  const seedKinds = [...CALLABLE_KINDS, ...VALUE_KINDS];
  const stmt = db.prepare(`SELECT id, name, kind, file_path, start_line, end_line FROM nodes WHERE file_path = ? AND kind IN (${seedKinds.map(() => "?").join(",")})`);
  const out = [];
  for (const file of files) for (const row of stmt.all(file, ...seedKinds)) out.push(symbolRow(row));
  return out.sort(byPosition);
}

/* The distinct {file, symbol} references of a request, at most MAX_SEEDS of them, cut like `strings`. */
function references(symbols) {
  if (!Array.isArray(symbols)) fail(2, "symbols must be a list");
  const byKey = new Map();
  for (const ref of symbols) {
    if (typeof ref?.file !== "string" || typeof ref?.symbol !== "string") fail(2, "a symbol is {file, symbol}");
    byKey.set(JSON.stringify([ref.file, ref.symbol]), ref);
  }
  const keys = [...byKey.keys()];
  if (keys.length <= MAX_SEEDS) return { items: [...byKey.values()], truncated: false };
  return { items: keys.sort(compare).slice(0, MAX_SEEDS).map((k) => byKey.get(k)), truncated: true };
}

function find(db, symbols) {
  const kinds = CALLABLE_KINDS.map(() => "?").join(",");
  const stmt = db.prepare(`SELECT id, name, kind, file_path, start_line, end_line FROM nodes WHERE file_path = ? AND name = ? AND kind IN (${kinds})`);
  const out = new Map();
  for (const ref of symbols) {
    for (const row of stmt.all(ref.file, ref.symbol, ...CALLABLE_KINDS)) out.set(row.id, symbolRow(row));
  }
  return [...out.values()].sort(byPosition);
}

/*
 * Breadth-first, inbound, depth by depth: who calls or instantiates a reached symbol, which route references it, which code
 * references a module-level value it reads or a function it passes on. A reached method also stands for its class at the same
 * depth, so a route that references a component is reached from a changed method of it. A reached value or class no code calls
 * (what dependency injection leaves no call edge for) is reached through the top-level code of the files that import it. Other
 * references (a field's type, a constructor parameter) are not followed: they name a dependency, not a caller.
 *
 * Every seed walks at once and each reached node records which seeds reach it and at how many hops. Every seed gets depth 1
 * before any gets depth 2, and each depth is visited in position order, so the same store and request give the same answer.
 * Expanding a node is one query for its callers, made once per node; seeds that reach an expanded node later are passed on to
 * its callers without a new query. A node with more callers than the fan-in limit is a hub: it is recorded and not expanded,
 * so only the paths through it stop. A route node is an entry point and is not expanded. When the expansion budget is spent,
 * the seeds a node left unexpanded was carrying are `partial` (what they reached is a lower bound); the others are `complete`.
 * Each hub then gets its closure, what it reaches within the depth left, under a budget of its own shared by the hubs in
 * position order; a closure the budget or the node bound cut is not `complete`.
 */
function walk(db, seedIds, cutSeeds, depth, limits, excluded) {
  const nodeStmt = db.prepare("SELECT id, name, kind, file_path, start_line, end_line FROM nodes WHERE id = ?");
  /* An edge's confidence: a number in [0, 1] its metadata holds, else certain. A missing, malformed or out-of-domain value never fails the walk. */
  const EDGE_CONFIDENCE = `CASE WHEN json_valid(e.metadata) THEN (CASE WHEN json_type(e.metadata, '$.confidence') IN ('real', 'integer') AND json_extract(e.metadata, '$.confidence') BETWEEN 0 AND 1 THEN json_extract(e.metadata, '$.confidence') ELSE 1 END) ELSE 1 END`;
  /* Ordered by position, so what a budget leaves out is the same on every run. */
  const callersStmt = db.prepare(`SELECT e.source AS id, s.file_path AS file, MAX(${EDGE_CONFIDENCE}) AS confidence FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target WHERE e.target = ? AND ${CALLER_EDGE} GROUP BY e.source, s.file_path, s.start_line, s.name ORDER BY s.file_path, s.start_line, s.name, s.id`);
  /* The top-level code of the files that import the node. */
  const importersStmt = db.prepare(`SELECT c.id AS id, c.file_path AS file, MAX(${EDGE_CONFIDENCE}) AS confidence FROM edges e JOIN nodes f ON f.id = e.source AND f.kind = 'file' JOIN edges ce ON ce.source = f.id AND ce.kind = 'contains' JOIN nodes c ON c.id = ce.target WHERE e.target = ? AND e.kind = 'imports' AND c.kind IN (${TOP_LEVEL_CODE_KINDS.map(() => "?").join(",")}) GROUP BY c.id, c.file_path, c.start_line, c.name ORDER BY c.file_path, c.start_line, c.name, c.id`);
  const containersStmt = db.prepare(`SELECT e.source AS id FROM edges e JOIN nodes s ON s.id = e.source WHERE e.target = ? AND e.kind = 'contains' AND s.kind IN (${CONTAINER_KINDS.map(() => "?").join(",")}) ORDER BY s.file_path, s.start_line, s.name, s.id`);

  const rows = new Map();
  const rowOf = (id) => {
    if (!rows.has(id)) rows.set(id, nodeStmt.get(id) ?? null);
    return rows.get(id);
  };
  const containers = new Map();
  const containersOf = (id) => {
    if (!containers.has(id)) containers.set(id, containersStmt.all(id, ...CONTAINER_KINDS).map((r) => r.id));
    return containers.get(id);
  };
  /* A node's callers, queried once; null when it was never queried and the budget has none left. */
  const callers = new Map();
  const callersOf = (id, budget) => {
    if (callers.has(id)) return callers.get(id);
    if (budget.used >= budget.max) return null;
    budget.used++;
    const callable = (rows) => rows.filter((r) => !excluded.has(r.file));
    let found = callable(callersStmt.all(id));
    if (found.length === 0 && INJECTABLE_KINDS.includes(rowOf(id).kind)) found = callable(importersStmt.all(id, ...TOP_LEVEL_CODE_KINDS));
    callers.set(id, found);
    return found;
  };
  const position = (a, b) => byPosition(rowRef(rowOf(a)), rowRef(rowOf(b)));

  /*
   * One walk from `starts` (each with the seed indexes it carries) for `maxDepth` hops. `pruneHubs` is off for a closure: it
   * walks from a hub on purpose. Returns the reached nodes, the seed indexes left in an open frontier, and the hubs met.
   */
  const run = (starts, maxDepth, budget, pruneHubs) => {
    const reached = new Map();
    const open = new Set();
    let full = false;
    const hubs = new Map();
    /* Adds the node (or the seeds new to it); the seed indexes it did not hold before, or null when the node bound left it out. */
    const add = (id, d, via, confidence, carried) => {
      let rec = reached.get(id);
      if (!rec) {
        const row = rowOf(id);
        if (!row || row.kind === "file" || row.kind === "import") return [];
        if (reached.size >= MAX_NODES) {
          full = true;
          return null;
        }
        rec = { id, file: row.file_path, symbol: row.name, kind: row.kind, startLine: row.start_line, endLine: row.end_line, depth: d, confidence, ...(via ? { via } : {}), seeds: new Map() };
        reached.set(id, rec);
      }
      const fresh = carried.filter((s) => !rec.seeds.has(s));
      for (const s of fresh) rec.seeds.set(s, d);
      return fresh;
    };
    const refOf = (id) => ({ file: reached.get(id).file, symbol: reached.get(id).symbol });
    /* The node, and its class when it is a method, both carrying the seeds new to them into the next frontier. */
    const enter = (next, id, d, via, confidence, carried) => {
      const fresh = add(id, d, via, confidence, carried);
      if (fresh === null) {
        for (const s of carried) open.add(s);
        return;
      }
      if (fresh.length === 0) return;
      next.set(id, [...(next.get(id) ?? []), ...fresh]);
      if (reached.get(id).kind !== "method") return;
      for (const owner of containersOf(id)) enter(next, owner, d, refOf(id), reached.get(id).confidence, fresh);
    };
    let frontier = new Map();
    for (const { id, seeds } of [...starts].sort((a, b) => position(a.id, b.id))) enter(frontier, id, 0, undefined, 1, seeds);
    for (let d = 1; d <= maxDepth && frontier.size > 0; d++) {
      const next = new Map();
      for (const id of [...frontier.keys()].sort(position)) {
        const carried = frontier.get(id);
        const rec = reached.get(id);
        if (rec.kind === "route" || hubs.has(id)) continue;
        const found = callersOf(id, budget);
        if (found === null) {
          for (const s of carried) open.add(s);
          continue;
        }
        if (pruneHubs && found.length > limits.fanInLimit()) {
          hubs.set(id, found.length);
          continue;
        }
        for (const { id: caller, confidence } of found) enter(next, caller, d, refOf(id), Math.min(rec.confidence, confidence), carried);
      }
      frontier = next;
    }
    return { reached, open, hubs, full };
  };

  const seedRows = [...new Set(seedIds)].map((id) => rowOf(id)).filter((row) => row && row.kind !== "file" && row.kind !== "import").sort((a, b) => byPosition(rowRef(a), rowRef(b)));
  const budget = { used: 0, max: limits.maxExpansions };
  const main = run(seedRows.map((row, i) => ({ id: row.id, seeds: [i] })), depth, budget, true);
  const seeds = seedRows.map((row, i) => ({ id: row.id, file: row.file_path, symbol: row.name, status: main.open.has(i) ? "partial" : "complete" }));
  const nodeOut = (rec, withSeeds) => ({
    id: rec.id, file: rec.file, symbol: rec.symbol, kind: rec.kind, startLine: rec.startLine,
    ...(rec.depth === 0 && rec.via === undefined ? { endLine: rec.endLine } : {}),
    depth: rec.depth, confidence: rec.confidence, ...(rec.via ? { via: rec.via } : {}),
    ...(withSeeds ? { seeds: [...rec.seeds].sort((a, b) => a[0] - b[0]) } : {}),
  });
  const ordered = (recs) => [...recs].sort((a, b) => a.depth - b.depth || byPosition(a, b));

  const closureBudget = { used: 0, max: limits.closureExpansions };
  const hubNodes = [...main.hubs.keys()].sort(position).map((id) => {
    const hub = main.reached.get(id);
    const closure = run([{ id, seeds: [0] }], depth - hub.depth, closureBudget, false);
    const nodes = ordered([...closure.reached.values()].filter((r) => r.id !== id)).map((r) => nodeOut({ ...r, depth: hub.depth + r.depth, confidence: Math.min(hub.confidence, r.confidence), via: r.via }, false));
    return {
      id, file: hub.file, symbol: hub.symbol, kind: hub.kind, startLine: hub.startLine, fanIn: main.hubs.get(id), depth: hub.depth,
      seeds: [...hub.seeds.keys()].sort((a, b) => a - b),
      closure: { nodes, complete: closure.open.size === 0 && !closure.full },
    };
  });
  return {
    nodes: ordered(main.reached.values()).map((r) => nodeOut(r, true)),
    seeds,
    hubNodes,
    cost: { expansions: budget.used, budget: budget.max, ...(limits.known() !== undefined ? { fanInLimit: limits.known() } : {}), closureExpansions: closureBudget.used, closureBudget: closureBudget.max },
    truncated: cutSeeds,
  };
}

/* The in-degree of every callable node over the edges the walk follows, callers in excluded files left out, ascending. */
function inDegrees(db, excluded) {
  return db
    .prepare(`SELECT COUNT(DISTINCT CASE WHEN ${CALLER_EDGE} AND s.file_path NOT IN (SELECT value FROM json_each(?)) THEN e.source END) AS d FROM nodes t LEFT JOIN edges e ON e.target = t.id LEFT JOIN nodes s ON s.id = e.source WHERE t.kind IN (${quoted(CALLABLE_KINDS)}) GROUP BY t.id`)
    .all(JSON.stringify([...excluded]))
    .map((r) => r.d)
    .sort((a, b) => a - b);
}

/* Nearest rank: the smallest value at least `p` percent of the distribution does not exceed; 0 for an empty one. */
function percentileOf(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

function percentileRequest(value) {
  if (typeof value !== "number" || !(value > 0 && value <= 100)) fail(2, "a percentile is a number in (0, 100]");
  return value;
}

/*
 * The fan-in above which a node is a hub, computed on first use: the one the request states, or the store's own in-degree at
 * the requested percentile clamped to its floor and ceiling; with neither, no node is a hub.
 */
function fanInLimitOf(db, request, excluded) {
  let value = Number.isInteger(request.fanInLimit) ? bounded(request.fanInLimit, 1, MAX_NODES, MAX_NODES) : undefined;
  const spec = request.fanIn;
  if (value === undefined && spec !== undefined) {
    if (typeof spec !== "object" || spec === null || !Number.isInteger(spec.floor) || !Number.isInteger(spec.ceiling) || spec.floor < 1 || spec.ceiling < spec.floor) fail(2, "fanIn is {percentile, floor, ceiling} with 1 <= floor <= ceiling");
    percentileRequest(spec.percentile);
  }
  return {
    fanInLimit() {
      if (value === undefined) value = spec === undefined ? MAX_NODES : Math.min(Math.max(percentileOf(inDegrees(db, excluded), spec.percentile), spec.floor), Math.min(spec.ceiling, MAX_NODES));
      return value;
    },
    known: () => value,
  };
}

function routes(db) {
  const rows = db.prepare(`
    SELECT r.name AS name, r.file_path AS file, r.start_line AS line, t.name AS target_name, t.file_path AS target_file, t.kind AS target_kind
    FROM nodes r LEFT JOIN edges e ON e.source = r.id AND e.kind = 'references' LEFT JOIN nodes t ON t.id = e.target
    WHERE r.kind = 'route'`).all();
  const out = rows.map((row) => ({
    name: row.name,
    file: row.file,
    line: row.line,
    ...(row.target_name ? { target: { file: row.target_file, symbol: row.target_name, kind: row.target_kind } } : {}),
  }));
  const targetKey = (r) => (r.target ? `${r.target.file}\0${r.target.symbol}\0${r.target.kind}` : "");
  return out.sort((a, b) => compare(a.file, b.file) || a.line - b.line || compare(a.name, b.name) || compare(targetKey(a), targetKey(b)));
}

const [storePath, ...requestParts] = process.argv.slice(2);
if (!storePath || requestParts.length === 0) fail(2, "usage: codegraph-store-reader.mjs <store path> <request JSON>...");
const request = parseRequest(requestParts.join(""));
const excludedFiles = () => new Set(request.excludeFiles === undefined ? [] : strings(request.excludeFiles, MAX_EXCLUDED_FILES, "excludeFiles").items);
const db = openStore(storePath);
let answer;
switch (request.op) {
  case "symbols": {
    const files = strings(request.files, MAX_FILES, "files");
    answer = { symbols: symbolsOf(db, files.items), truncated: files.truncated };
    break;
  }
  case "find": {
    const refs = references(request.symbols);
    answer = { symbols: find(db, refs.items), truncated: refs.truncated };
    break;
  }
  case "walk": {
    const seeds = strings(request.seeds, MAX_SEEDS, "seeds");
    const excluded = excludedFiles();
    const limits = { ...fanInLimitOf(db, request, excluded), maxExpansions: bounded(request.maxExpansions, 0, MAX_EXPANSIONS, MAX_EXPANSIONS), closureExpansions: bounded(request.closureExpansions, 0, MAX_EXPANSIONS, 0) };
    answer = walk(db, seeds.items, seeds.truncated, bounded(request.depth, 0, MAX_DEPTH, 3), limits, excluded);
    break;
  }
  case "degrees": {
    const degrees = inDegrees(db, excludedFiles());
    answer = { callables: degrees.length, value: percentileOf(degrees, percentileRequest(request.percentile)) };
    break;
  }
  case "files":
    answer = { files: db.prepare("SELECT DISTINCT file_path AS file FROM nodes ORDER BY file_path").all().map((r) => r.file).sort(compare) };
    break;
  case "ping":
    answer = { ready: true };
    break;
  case "routes":
    answer = { routes: routes(db) };
    break;
  default:
    fail(2, `unknown op ${JSON.stringify(request.op)}`);
}
db.close();
process.stdout.write(JSON.stringify(answer));
