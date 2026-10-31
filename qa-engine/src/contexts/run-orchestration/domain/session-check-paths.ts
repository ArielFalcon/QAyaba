/*
 * The pages a check of the run's session opens: those the failing tests asked for (their `goto` calls), each a page of the app that a
 * session the app still accepts opens where it was asked. Only a literal pathname is a page (a template, a parameter or another host
 * names none), once each, in the order the specs open them. Pure.
 */

import { routesOpenedBy } from "./availability-triage.ts";

/* Whether a route is one page of the app's own origin, as written. */
const isPage = (path: string): boolean => path.startsWith("/") && !path.startsWith("//") && !path.includes("${") && !path.split("/").some((segment) => segment.startsWith(":"));

export function sessionCheckPaths(sources: readonly string[]): string[] {
  const out: string[] = [];
  for (const source of sources) for (const path of routesOpenedBy(source)) if (isPage(path) && !out.includes(path)) out.push(path);
  return out;
}
