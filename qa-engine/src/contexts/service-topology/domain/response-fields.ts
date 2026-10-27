/*
 * The fields an OpenAPI document declares for the items an operation's successful JSON response returns: the properties of the
 * schema of a 2xx response, through local references and `allOf`/`anyOf`/`oneOf`. The items are those the capture reads at runtime
 * (the elements of the array a response holds, else the response itself), so a schema is read the same way: an array's `items`, else
 * the one array-of-objects property of an object (or of an object property of it), else the object. A response with several such
 * arrays cannot be told from the document alone and declares nothing, as does a reference to another file, an operation the
 * document does not have and a schema with no properties. Pure: it takes the parsed document; reading it is the caller's.
 */
import { requestServesOperation } from "./operation-url-pattern.ts";
import { resolveLocalReferences } from "./operation-diff.ts";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/* The deepest allOf/anyOf/oneOf nesting followed: a document is data the repository holds, and a response schema nests a few levels at most. */
const MAX_SCHEMA_DEPTH = 8;

function propertyNames(schema: unknown, depth = 0): Set<string> {
  const names = new Set<string>();
  if (!isRecord(schema) || depth > MAX_SCHEMA_DEPTH) return names;
  if (isRecord(schema["properties"])) for (const name of Object.keys(schema["properties"])) names.add(name);
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    const parts = schema[keyword];
    if (Array.isArray(parts)) for (const part of parts) for (const name of propertyNames(part, depth + 1)) names.add(name);
  }
  return names;
}

/* The properties of a schema (allOf and the like merged) as schemas of their own. */
function propertySchemas(schema: unknown, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isRecord(schema) || depth > MAX_SCHEMA_DEPTH) return out;
  if (isRecord(schema["properties"])) Object.assign(out, schema["properties"]);
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    const parts = schema[keyword];
    if (Array.isArray(parts)) for (const part of parts) Object.assign(out, propertySchemas(part, depth + 1));
  }
  return out;
}

/* The schema of the items an array schema holds, when its items are objects with properties. */
function arrayItems(schema: unknown): unknown {
  if (!isRecord(schema) || !isRecord(schema["items"])) return undefined;
  return propertyNames(schema["items"]).size > 0 ? schema["items"] : undefined;
}

/* The schemas of the arrays of objects a schema's properties are, or those of its object properties' properties when it has none of its own. */
function collectionSchemas(schema: unknown): unknown[] {
  const own = Object.values(propertySchemas(schema)).map(arrayItems).filter((items) => items !== undefined);
  if (own.length > 0) return own;
  return Object.values(propertySchemas(schema)).flatMap((inner) => Object.values(propertySchemas(inner)).map(arrayItems).filter((items) => items !== undefined));
}

/* The schema of the items a response schema returns, or undefined when the document cannot say. */
function itemSchema(schema: unknown): unknown {
  if (!isRecord(schema)) return undefined;
  if (schema["type"] === "array" || isRecord(schema["items"])) return arrayItems(schema);
  const collections = collectionSchemas(schema);
  if (collections.length > 1) return undefined;
  return collections[0] ?? schema;
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
 * The names of the fields the document declares for the items the operation `method` + `requestPath` returns, or undefined. The
 * operation is the one of the document that serves the path, the one with the most literal segments when several do.
 */
export function responseItemFields(document: unknown, method: string, requestPath: string): ReadonlySet<string> | undefined {
  if (!isRecord(document) || !isRecord(document["paths"])) return undefined;
  const verb = method.toLowerCase();
  const served = Object.keys(document["paths"])
    .filter((path) => isRecord((document["paths"] as Record<string, unknown>)[path]) && isRecord(((document["paths"] as Record<string, Record<string, unknown>>)[path])![verb]) && requestServesOperation(requestPath, { path }))
    .sort((a, b) => literalSegments(b) - literalSegments(a) || a.localeCompare(b));
  const path = served[0];
  if (path === undefined) return undefined;
  const operation = (document["paths"] as Record<string, Record<string, unknown>>)[path]![verb] as Record<string, unknown>;
  const responses = resolveLocalReferences(document, operation["responses"]);
  const names = propertyNames(itemSchema(successSchema(responses)));
  return names.size > 0 ? names : undefined;
}
