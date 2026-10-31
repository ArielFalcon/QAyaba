import { parse as parseYaml } from "yaml";

const VERBS = new Set(["get", "post", "put", "patch", "delete"]);

export interface IngressOp {
  service: string;
  path: string;
  verb: string;
  operationId: string;
  segs: string[];
}

export function segs(p: string): string[] {
  return String(p).replace(/^\/+/, "").replace(/\/+$/, "").split("/").filter(Boolean);
}

export function isParam(s: string): boolean {
  return s.startsWith("{") && s.endsWith("}");
}

/** Parse a backend's OpenAPI YAML using the yaml package; return typed operation entries. */
export function parseOpenApiYaml(service: string, content: string): IngressOp[] {
  const ops: IngressOp[] = [];
  let doc: Record<string, unknown>;
  try {
    doc = parseYaml(content) as Record<string, unknown>;
  } catch {
    return ops;
  }
  const paths = doc["paths"] as Record<string, unknown> | undefined;
  if (!paths) return ops;
  for (const [path, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [verb, operation] of Object.entries(pathItem as Record<string, unknown>)) {
      if (!VERBS.has(verb.toLowerCase())) continue;
      if (typeof operation !== "object" || operation === null) continue;
      const operationId = (operation as Record<string, unknown>)["operationId"];
      if (typeof operationId !== "string") continue;
      ops.push({ service, path, verb: verb.toUpperCase(), operationId, segs: segs(path) });
    }
  }
  return ops;
}

/** Find an ingress operation matching (service, verb, frontSegments) via structural segment match. Determinism rule: when the contract has both a literal segment (e.g. /orders/active) and a param segment (e.g. /orders/{id}) at the same slot, the all-literal match wins. */
export function findOp(ingress: IngressOp[], service: string, verb: string, frontSegs: string[]): IngressOp | undefined {
  const candidates = ingress.filter((o) =>
    o.service === service &&
    o.verb === verb &&
    o.segs.length === frontSegs.length &&
    o.segs.every((c, i) => isParam(c) || c === (frontSegs[i] ?? "")),
  );
  if (candidates.length === 0) return undefined;
  const exact = candidates.find((o) => o.segs.every((c) => !isParam(c)));
  return exact ?? candidates[0];
}

/** Same structural match as findOp, but across every known service — used when a BE→BE call already carries a full OpenAPI path (e.g. */
export function findOpAnyService(ingress: IngressOp[], verb: string, frontSegs: string[]): IngressOp | undefined {
  const candidates = ingress.filter((o) =>
    o.verb === verb &&
    o.segs.length === frontSegs.length &&
    o.segs.every((c, i) => isParam(c) || c === (frontSegs[i] ?? "")),
  );
  if (candidates.length === 0) return undefined;
  const exact = candidates.find((o) => o.segs.every((c) => !isParam(c)));
  return exact ?? candidates[0];
}
