/* Which origins a run's sandboxed children may reach. The decision is the engine's: an app declares origins and the registries file names package registries; this rule turns both into the two lists the egress filter is built from. Pure: the shell reads the app's config and the registries file and hands the values in. */

import { compileEgressPolicy, originOf } from "@kernel/egress-policy.ts";

/* config/egress/registries.yaml, read by the shell: a group name to its origins. */
export type RegistryGroups = Readonly<Record<string, readonly string[]>>;

/* The part of an app's config this rule reads. */
export interface RunEgressDeclaration {
  dev: { baseUrl: string; allowedOrigins?: readonly string[] | undefined; blockedOrigins?: readonly string[] | undefined; thirdPartyOrigins?: readonly string[] | undefined };
  egress?: { installOrigins?: readonly string[] | undefined } | undefined;
}

export interface RunEgressOrigins {
  dev: string[];
  /* The origins among `dev` whose requests are a third party's: reachable, never the app's data. */
  thirdParty: string[];
  install: string[];
}

const unique = (origins: readonly string[]): string[] => [...new Set(origins)];

/* What a run's children may reach: a suite or a login reaches the app's own origin, the origins it declares and its third-party origins (one declaration opens them for egress and marks them third-party); an install reaches the npm registries and the app's own extra ones. */
export function resolveRunOrigins(app: Pick<RunEgressDeclaration, "dev" | "egress">, registries: RegistryGroups): RunEgressOrigins {
  const own = originOf(app.dev.baseUrl);
  const thirdParty = unique(app.dev.thirdPartyOrigins ?? []);
  const dev = unique([...(own ? [own] : []), ...(app.dev.allowedOrigins ?? []), ...thirdParty]);
  return { dev, thirdParty, install: installOriginsOf(app.egress, registries) };
}

/* An install reaches the npm registries and the extra origins an app declares for it. */
export function installOriginsOf(egress: RunEgressDeclaration["egress"], registries: RegistryGroups): string[] {
  return unique([...(registries["npm"] ?? []), ...(egress?.installOrigins ?? [])]);
}

/* Whether a host is one the app leaves blocked on purpose (dev.blockedOrigins). Only the name is matched: the filter refuses by name, and a refusal carries no scheme or port. */
export function blockedHostMatcher(app: Pick<RunEgressDeclaration, "dev">): (host: string) => boolean {
  const blocked = app.dev.blockedOrigins;
  if (!blocked || blocked.length === 0) return () => false;
  const policy = compileEgressPolicy(blocked);
  return (host) => policy.allowsName(host);
}
