/*
 * The structured reader of a codegraph store: the one answer the engine's CLI does not give as JSON (a file's symbols with
 * their line ranges, an inbound walk with each node's predecessor, the route nodes with what they point at). It runs as a
 * child of the execution launcher's `graph` profile, never inside the orchestrator, and opens the store read-only.
 *
 * It is pinned to the store schema it was written against: a store of another schema or extraction version is refused
 * (exit 3) rather than read with queries that may mean something else there. Every answer is sorted, so identical stores
 * give identical bytes.
 *
 * Usage: node codegraph-store-reader.mjs <store path> <request JSON>
 *   {"op":"symbols","files":["a.ts"]}                       → {"symbols":[{id,file,symbol,kind,startLine,endLine}]}
 *   {"op":"walk","seeds":["<id>"],"depth":3,"maxNodes":300} → {"nodes":[{id,file,symbol,kind,startLine,depth,via?}],"truncated":bool}
 *   {"op":"routes"}                                         → {"routes":[{name,file,line,target?:{file,symbol,kind}}]}
 *   {"op":"find","symbols":[{"file":"a.ts","symbol":"f"}]}  → {"symbols":[...as symbols]}
 */

import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 11;
const EXTRACTION_VERSION = "27";

/* What a seed, a caller or a page anchor can be: code that runs or holds code. Fields, constants, imports and files are not. */
const CALLABLE_KINDS = ["function", "method", "class", "component", "interface"];
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

function strings(value, max, what) {
  if (!Array.isArray(value) || value.length > max || value.some((v) => typeof v !== "string" || v.length > 4096)) fail(2, `${what} must be at most ${max} strings`);
  return value;
}

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

const byPosition = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.startLine - b.startLine || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));

function symbolRow(row) {
  return { id: row.id, file: row.file_path, symbol: row.name, kind: row.kind, startLine: row.start_line, endLine: row.end_line };
}

function symbolsOf(db, files) {
  const kinds = CALLABLE_KINDS.map(() => "?").join(",");
  const stmt = db.prepare(`SELECT id, name, kind, file_path, start_line, end_line FROM nodes WHERE file_path = ? AND kind IN (${kinds})`);
  const out = [];
  for (const file of [...new Set(files)]) for (const row of stmt.all(file, ...CALLABLE_KINDS)) out.push(symbolRow(row));
  return out.sort(byPosition);
}

function find(db, symbols) {
  if (!Array.isArray(symbols) || symbols.length > MAX_SEEDS) fail(2, `symbols must be at most ${MAX_SEEDS} entries`);
  const kinds = CALLABLE_KINDS.map(() => "?").join(",");
  const stmt = db.prepare(`SELECT id, name, kind, file_path, start_line, end_line FROM nodes WHERE file_path = ? AND name = ? AND kind IN (${kinds})`);
  const out = new Map();
  for (const ref of symbols) {
    if (typeof ref?.file !== "string" || typeof ref?.symbol !== "string") fail(2, "a symbol is {file, symbol}");
    for (const row of stmt.all(ref.file, ref.symbol, ...CALLABLE_KINDS)) out.set(row.id, symbolRow(row));
  }
  return [...out.values()].sort(byPosition);
}

/*
 * Breadth-first, inbound: who calls or instantiates a reached symbol, and which route references it. A reached method also
 * stands for its class at the same depth, so a route that references a component is reached from a changed method of it.
 * Other references (a field's type, a constructor parameter) are not followed: they name a dependency, not a caller.
 */
function walk(db, seeds, depth, maxNodes) {
  const node = db.prepare("SELECT id, name, kind, file_path, start_line FROM nodes WHERE id = ?");
  const callers = db.prepare("SELECT DISTINCT e.source AS id FROM edges e JOIN nodes s ON s.id = e.source WHERE e.target = ? AND (e.kind IN ('calls', 'instantiates') OR (e.kind = 'references' AND s.kind = 'route'))");
  const containers = db.prepare(`SELECT e.source AS id FROM edges e JOIN nodes s ON s.id = e.source WHERE e.target = ? AND e.kind = 'contains' AND s.kind IN (${CONTAINER_KINDS.map(() => "?").join(",")})`);
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
  let frontier = withContainer([...new Set(seeds)].filter((id) => add(id, 0)), 0);
  for (let d = 1; d <= depth && frontier.length > 0 && !truncated; d++) {
    const next = [];
    for (const id of [...frontier].sort()) for (const { id: caller } of callers.all(id)) if (add(caller, d, refOf(id))) next.push(caller);
    frontier = withContainer(next, d);
  }
  const nodes = [...reached.values()].sort((a, b) => a.depth - b.depth || byPosition(a, b));
  return { nodes, truncated };
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
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
}

const [storePath, rawRequest] = process.argv.slice(2);
if (!storePath || rawRequest === undefined) fail(2, "usage: codegraph-store-reader.mjs <store path> <request JSON>");
const request = parseRequest(rawRequest);
const db = openStore(storePath);
let answer;
switch (request.op) {
  case "symbols":
    answer = { symbols: symbolsOf(db, strings(request.files, MAX_FILES, "files")) };
    break;
  case "find":
    answer = { symbols: find(db, request.symbols) };
    break;
  case "walk":
    answer = walk(db, strings(request.seeds, MAX_SEEDS, "seeds"), bounded(request.depth, 0, MAX_DEPTH, 3), bounded(request.maxNodes, 1, MAX_NODES, 300));
    break;
  case "routes":
    answer = { routes: routes(db) };
    break;
  default:
    fail(2, `unknown op ${JSON.stringify(request.op)}`);
}
db.close();
process.stdout.write(JSON.stringify(answer));
