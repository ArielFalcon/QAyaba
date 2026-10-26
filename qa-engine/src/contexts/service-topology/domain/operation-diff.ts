/*
 * Which operations of an OpenAPI document differ between two versions of it: added, removed, or changed in what a caller
 * depends on (parameters, request body, responses, with local references resolved). Descriptive text never counts. A contract
 * part that references another file cannot be compared from this document alone, so such a document has no operation diff.
 * Pure: it takes the parsed documents; reading them is the caller's.
 */

export type OperationChangeKind = "added" | "removed" | "changed";

export interface OperationChange {
  verb: string;
  path: string;
  change: OperationChangeKind;
}

const VERBS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

/* The parts of an operation a caller depends on; everything else (operationId, summary, description, tags, vendor extensions) is prose or naming. */
export const CONTRACT_KEYS = ["parameters", "requestBody", "responses"] as const;

/* Keys inside the contract parts that are prose, dropped wherever they occur. */
const PROSE_KEYS = new Set(["summary", "description", "example", "examples", "externalDocs", "title"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/* Keywords whose value maps names (a field, a header) to definitions: a name that reads like prose is still a name. */
const NAME_MAPS = new Set(["properties", "patternProperties", "headers", "encoding"]);

/* Thrown when a contract part references another file: what it points at is not in this document. */
class RemoteReference extends Error {}

/*
 * A local `#/a/b` reference resolved against the document; a cycle is cut where it closes. `names` says the node's keys are
 * names, not keywords. Throws RemoteReference on a reference to another file.
 */
function resolve(doc: Record<string, unknown>, node: unknown, active: readonly string[], names = false): unknown {
  if (Array.isArray(node)) return node.map((n) => resolve(doc, n, active));
  if (!isRecord(node)) return node;
  const ref = node["$ref"];
  if (typeof ref === "string" && !names) {
    if (!ref.startsWith("#/")) throw new RemoteReference(ref);
    if (active.includes(ref)) return { $ref: ref };
    let target: unknown = doc;
    for (const part of ref.slice(2).split("/")) target = isRecord(target) ? target[part.replaceAll("~1", "/").replaceAll("~0", "~")] : undefined;
    return resolve(doc, target, [...active, ref]);
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(node).sort()) {
    if (!names && (PROSE_KEYS.has(key) || key.startsWith("x-"))) continue;
    out[key] = resolve(doc, node[key], active, !names && NAME_MAPS.has(key));
  }
  return out;
}

/* verb path -> the canonical form of the contract parts, path-level parameters included; undefined when a part references another file. */
function operationsOf(doc: Record<string, unknown>): Map<string, string> | undefined {
  try {
    return canonicalOperations(doc);
  } catch (err) {
    if (err instanceof RemoteReference) return undefined;
    throw err;
  }
}

function canonicalOperations(doc: Record<string, unknown>): Map<string, string> | undefined {
  const paths = doc["paths"];
  if (!isRecord(paths)) return undefined;
  const out = new Map<string, string>();
  for (const [path, item] of Object.entries(paths)) {
    if (!isRecord(item)) continue;
    for (const verb of VERBS) {
      const operation = item[verb];
      if (!isRecord(operation)) continue;
      const parts: Record<string, unknown> = {};
      const shared = item["parameters"];
      const own = operation["parameters"];
      if (shared !== undefined || own !== undefined) parts["parameters"] = [...(Array.isArray(shared) ? shared : []), ...(Array.isArray(own) ? own : [])];
      for (const key of CONTRACT_KEYS) if (key !== "parameters" && operation[key] !== undefined) parts[key] = operation[key];
      out.set(`${verb.toUpperCase()} ${path}`, JSON.stringify(resolve(doc, parts, [])));
    }
  }
  return out;
}

/* The operations that differ, ordered by path then verb; undefined when either side is not a document with operations, so the caller falls back to the whole file. */
export function diffOperations(base: unknown, head: unknown): OperationChange[] | undefined {
  if (!isRecord(base) || !isRecord(head)) return undefined;
  const before = operationsOf(base);
  const after = operationsOf(head);
  if (!before || !after) return undefined;
  const out: OperationChange[] = [];
  const split = (key: string): { verb: string; path: string } => ({ verb: key.slice(0, key.indexOf(" ")), path: key.slice(key.indexOf(" ") + 1) });
  for (const [key, signature] of after) {
    const was = before.get(key);
    if (was === undefined) out.push({ ...split(key), change: "added" });
    else if (was !== signature) out.push({ ...split(key), change: "changed" });
  }
  for (const key of before.keys()) if (!after.has(key)) out.push({ ...split(key), change: "removed" });
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.verb.localeCompare(b.verb));
}
