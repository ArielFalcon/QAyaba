/*
 * The names of the fields an OpenAPI document declares anywhere in an operation's successful JSON response: the properties of the
 * schema of a 2xx response and of every schema it holds (properties, array items, additional properties, `allOf`/`anyOf`/`oneOf`),
 * through local references. The capture reads the names of the whole answer at every depth, so the document is read the same way.
 * A reference to another file, an operation the document does not have and a schema with no properties declare nothing, which is
 * not the same as declaring that a field is absent. Pure: it takes the parsed document; reading it is the caller's.
 */
import { requestServesOperation } from "./operation-url-pattern.ts";
import { resolveLocalReferences } from "./operation-diff.ts";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/* The deepest schema nesting followed and the most names kept: a document is data the repository holds, and a response schema nests a few levels at most. */
const MAX_SCHEMA_DEPTH = 16;
const MAX_DECLARED_NAMES = 2_000;

function collectNames(schema: unknown, names: Set<string>, depth: number): void {
  if (!isRecord(schema) || depth > MAX_SCHEMA_DEPTH || names.size >= MAX_DECLARED_NAMES) return;
  if (isRecord(schema["properties"])) {
    for (const [name, child] of Object.entries(schema["properties"])) {
      names.add(name);
      collectNames(child, names, depth + 1);
    }
  }
  collectNames(schema["items"], names, depth + 1);
  collectNames(schema["additionalProperties"], names, depth + 1);
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    const parts = schema[keyword];
    if (Array.isArray(parts)) for (const part of parts) collectNames(part, names, depth + 1);
  }
}

/* The schema of the successful JSON response of an operation, as the document gives it. */
function successSchema(responses: unknown): unknown {
  if (!isRecord(responses)) return undefined;
  const status = Object.keys(responses).filter((code) => /^2\d\d$/.test(code)).sort()[0];
  const response = status === undefined ? undefined : responses[status];
  if (!isRecord(response)) return undefined;
  if (isRecord(response["schema"])) return response["schema"];
  const content = response["content"];
  if (!isRecord(content)) return undefined;
  const media = Object.keys(content).sort().find((type) => /json/i.test(type));
  const body = media === undefined ? undefined : content[media];
  return isRecord(body) ? body["schema"] : undefined;
}

const literalSegments = (path: string): number => path.split("/").filter((segment) => segment !== "" && !/^\{.*\}$/.test(segment) && !segment.startsWith(":")).length;

/*
 * The names of the fields the document declares anywhere in the successful response of the operation `method` + `requestPath`, or
 * undefined. The operation is the one of the document that serves the path, the one with the most literal segments when several do.
 */
export function responseFieldNames(document: unknown, method: string, requestPath: string): ReadonlySet<string> | undefined {
  if (!isRecord(document) || !isRecord(document["paths"])) return undefined;
  const verb = method.toLowerCase();
  const served = Object.keys(document["paths"])
    .filter((path) => isRecord((document["paths"] as Record<string, unknown>)[path]) && isRecord(((document["paths"] as Record<string, Record<string, unknown>>)[path])![verb]) && requestServesOperation(requestPath, { path }))
    .sort((a, b) => literalSegments(b) - literalSegments(a) || a.localeCompare(b));
  const path = served[0];
  if (path === undefined) return undefined;
  const operation = (document["paths"] as Record<string, Record<string, unknown>>)[path]![verb] as Record<string, unknown>;
  const responses = resolveLocalReferences(document, operation["responses"]);
  const names = new Set<string>();
  collectNames(successSchema(responses), names, 0);
  return names.size > 0 ? names : undefined;
}
