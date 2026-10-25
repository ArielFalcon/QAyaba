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
 * Usage: node codegraph-store-reader.mjs <store path> <request JSON>
 *   {"op":"symbols","files":["a.ts"]}                       → {"symbols":[{id,file,symbol,kind,startLine,endLine}],"truncated":bool}
 *   {"op":"walk","seeds":["<id>"],"depth":3,"maxNodes":300} → {"nodes":[{id,file,symbol,kind,startLine,depth,via?}],"truncated":bool}
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
 * Breadth-first, inbound: who calls or instantiates a reached symbol, which route references it, which code references a
 * module-level value it reads or a function it passes on. A reached method also stands for its class at the same depth, so a
 * route that references a component is reached from a changed method of it. A reached value or class no code calls (what
 * dependency injection hands over leaves no call edge) is reached through the top-level code of the files that import it.
 * Other references (a field's type, a constructor parameter) are not followed: they name a dependency, not a caller.
 */
function walk(db, seeds, cutSeeds, depth, maxNodes) {
  const node = db.prepare("SELECT id, name, kind, file_path, start_line FROM nodes WHERE id = ?");
  /* Ordered by position, so that when the budget cuts a walk it keeps the same nodes on every run. */
  /* A caller calls or instantiates the node; a route references its page; code that runs references a value it reads or a function it passes on. */
  const callers = db.prepare(`SELECT DISTINCT e.source AS id, s.file_path, s.start_line, s.name FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target WHERE e.target = ? AND (e.kind IN ('calls', 'instantiates') OR (e.kind = 'references' AND (s.kind = 'route' OR (t.kind IN (${REFERENCED_KINDS.map(() => "?").join(",")}) AND s.kind IN (${CALLABLE_KINDS.map(() => "?").join(",")}))))) ORDER BY s.file_path, s.start_line, s.name, s.id`);
  /* The top-level code of the files that import the node. */
  const importers = db.prepare(`SELECT DISTINCT c.id AS id, c.file_path, c.start_line, c.name FROM edges e JOIN nodes f ON f.id = e.source AND f.kind = 'file' JOIN edges ce ON ce.source = f.id AND ce.kind = 'contains' JOIN nodes c ON c.id = ce.target WHERE e.target = ? AND e.kind = 'imports' AND c.kind IN (${TOP_LEVEL_CODE_KINDS.map(() => "?").join(",")}) ORDER BY c.file_path, c.start_line, c.name, c.id`);
  const containers = db.prepare(`SELECT e.source AS id, s.file_path, s.start_line, s.name FROM edges e JOIN nodes s ON s.id = e.source WHERE e.target = ? AND e.kind = 'contains' AND s.kind IN (${CONTAINER_KINDS.map(() => "?").join(",")}) ORDER BY s.file_path, s.start_line, s.name, s.id`);
  const reached = new Map();
  let truncated = false;
  const add = (id, d, via) => {
    if (reached.has(id)) return false;
    if (reached.size >= maxNodes) {
      truncated = true;
      return false;
    }
    const row = node.get(id);
    if (!row || row.kind === "file" || row.kind === "import") return false;
    reached.set(id, { id, file: row.file_path, symbol: row.name, kind: row.kind, startLine: row.start_line, depth: d, ...(via ? { via } : {}) });
    return true;
  };
  const refOf = (id) => {
    const r = reached.get(id);
    return { file: r.file, symbol: r.symbol };
  };
  const withContainer = (ids, d) => {
    const out = [];
    for (const id of ids) {
      out.push(id);
      const r = reached.get(id);
      if (r?.kind !== "method") continue;
      for (const { id: owner } of containers.all(id, ...CONTAINER_KINDS)) if (add(owner, d, refOf(id))) out.push(owner);
    }
    return out;
  };
  /* Seeds enter the budget in position order, not in the order the request listed them. */
  const seedRows = seeds.map((id) => node.get(id)).filter((row) => row !== undefined).map((row) => ({ id: row.id, file: row.file_path, symbol: row.name, startLine: row.start_line }));
  let frontier = withContainer(seedRows.sort(byPosition).map((r) => r.id).filter((id) => add(id, 0)), 0);
  for (let d = 1; d <= depth && frontier.length > 0 && !truncated; d++) {
    const next = [];
    for (const id of [...frontier].sort((a, b) => byPosition(reached.get(a), reached.get(b)))) {
      let found = callers.all(id, ...REFERENCED_KINDS, ...CALLABLE_KINDS);
      if (found.length === 0 && INJECTABLE_KINDS.includes(reached.get(id).kind)) found = importers.all(id, ...TOP_LEVEL_CODE_KINDS);
      for (const { id: caller } of found) if (add(caller, d, refOf(id))) next.push(caller);
    }
    frontier = withContainer(next, d);
  }
  const nodes = [...reached.values()].sort((a, b) => a.depth - b.depth || byPosition(a, b));
  return { nodes, truncated: truncated || cutSeeds };
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

const [storePath, rawRequest] = process.argv.slice(2);
if (!storePath || rawRequest === undefined) fail(2, "usage: codegraph-store-reader.mjs <store path> <request JSON>");
const request = parseRequest(rawRequest);
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
    answer = walk(db, seeds.items, seeds.truncated, bounded(request.depth, 0, MAX_DEPTH, 3), bounded(request.maxNodes, 1, MAX_NODES, 300));
    break;
  }
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
