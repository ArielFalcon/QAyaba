/*
 * Which of the app's declared data states (dev.dataState routes) a pathname is a page of: an exact key first, then a
 * key with parameters (`/restaurantes/:province/:city`) the pathname fills segment by segment, then a key ending "/*"
 * (its prefix and its root). The capture script, the seed's fixtures and the setup's capture block keep a copy of this
 * same matching in their own runtime. Pure.
 */

/* Whether `pathname` fills `key` segment by segment: as many segments, each literal equal and each parameter (`:name`) non-empty. A key with no parameter is no template. */
export function fillsDataStateTemplate(key: string, pathname: string): boolean {
  const keyParts = key.split("/").filter((part) => part !== "");
  if (!keyParts.some((part) => part.startsWith(":"))) return false;
  const parts = pathname.split("/").filter((part) => part !== "");
  return keyParts.length === parts.length && keyParts.every((part, i) => (part.startsWith(":") ? part.length > 1 : part === parts[i]));
}

export function dataStateRouteFor<T>(routes: Readonly<Record<string, T>>, pathname: string): T | undefined {
  if (Object.prototype.hasOwnProperty.call(routes, pathname)) return routes[pathname];
  const keys = Object.keys(routes);
  const template = keys.find((key) => fillsDataStateTemplate(key, pathname));
  if (template !== undefined) return routes[template];
  const prefix = keys.find((key) => key.endsWith("/*") && (pathname === key.slice(0, -2) || pathname.startsWith(key.slice(0, -1))));
  return prefix === undefined ? undefined : routes[prefix];
}
