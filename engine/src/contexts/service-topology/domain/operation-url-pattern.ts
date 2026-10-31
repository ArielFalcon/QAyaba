/*
 * The request paths an operation answers, as an anchored regular expression source. A literal segment is escaped, a parameter
 * (`{id}` or `:id`) takes any one segment, a trailing slash is tolerated, and a gateway or servlet prefix of up to three
 * segments may precede the path. A prefix segment never looks like an identifier (digits only, or a UUID's first group), so
 * `/items` does not answer `/orders/7/items`, a sibling resource; a slug in that position cannot be told apart from a prefix,
 * which is the one case the pattern accepts. An operation with no literal segment answers nothing (a bare `/{id}` would match every path).
 */

export const MAX_OPERATION_PATTERN_CHARS = 200;

const MAX_PREFIX_SEGMENTS = 3;
const PREFIX = `(?:/(?!\\d+(?:/|$))(?![0-9a-fA-F]{8}-)[^/]+){0,${MAX_PREFIX_SEGMENTS}}`;

const isParameter = (segment: string): boolean => /^\{.*\}$/.test(segment) || segment.startsWith(":");
const escapeLiteral = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/* The pattern source for the operation's path, or undefined when it has no literal segment or the source would exceed its bound. */
export function operationUrlPattern(operation: { path: string }): string | undefined {
  const segments = operation.path.split("/").filter((segment) => segment !== "");
  if (!segments.some((segment) => !isParameter(segment))) return undefined;
  const body = segments.map((segment) => (isParameter(segment) ? "/[^/]+" : `/${escapeLiteral(segment)}`)).join("");
  const source = `^${PREFIX}${body}/?$`;
  return source.length <= MAX_OPERATION_PATTERN_CHARS ? source : undefined;
}

/* Whether a request path (no query, no fragment) is answered by the operation. */
export function requestServesOperation(requestPath: string, operation: { path: string }): boolean {
  const source = operationUrlPattern(operation);
  return source !== undefined && new RegExp(source).test(requestPath);
}
