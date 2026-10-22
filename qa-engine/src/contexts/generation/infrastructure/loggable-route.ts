/* A route named in a log line. Some routes come from a link a page showed, so the page decides their text: it is redacted like everything else that leaves for a log, held to one line and cut at a bound. */

import { sanitizeText } from "./sanitize-text.ts";

/* The longest a route is written in a log line, and the most routes one line names. */
export const MAX_LOGGED_ROUTE_CHARS = 120;
export const MAX_LOGGED_ROUTES = 8;

const UNPRINTABLE = "[route not printable]";

export function loggableRoute(route: string): string {
  let text: string;
  try {
    text = sanitizeText(String(route)).text;
  } catch {
    /* A secret the redaction could not remove: the route is not written at all. */
    return UNPRINTABLE;
  }
  const oneLine = text.replace(/[\u0000-\u001f\u007f]+/g, " ");
  return oneLine.length > MAX_LOGGED_ROUTE_CHARS ? `${oneLine.slice(0, MAX_LOGGED_ROUTE_CHARS - 1)}…` : oneLine;
}

/** The routes as one comma-separated text, each cleaned, with the count of those beyond the bound. Empty for none. */
export function loggableRoutes(routes: readonly string[]): string {
  const listed = routes.slice(0, MAX_LOGGED_ROUTES).map(loggableRoute);
  const more = routes.length - listed.length;
  return `${listed.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`;
}
