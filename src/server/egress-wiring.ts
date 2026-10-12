/* The composition root's wiring of the egress filter: which origins a run's children may reach, and the one process-wide controller that enforces them. The origins are data (the app's config and config/egress/registries.yaml); the controller is built once per process, because the proxy listeners and the kernel rules it brings up belong to the process, not to a run. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { DnsFilter } from "../../qa-engine/src/shared-infrastructure/egress/dns-filter";
import { EgressController } from "../../qa-engine/src/shared-infrastructure/egress/egress-controller";
import { compileEgressPolicy, originOf } from "../../qa-engine/src/shared-infrastructure/egress/egress-policy";
import { createIptablesApplier } from "../../qa-engine/src/shared-infrastructure/egress/iptables-runner";
import { TransparentProxy } from "../../qa-engine/src/shared-infrastructure/egress/transparent-proxy";
import type { EgressGate } from "../../qa-engine/src/shared-infrastructure/process-sandbox/exec-sandbox";
import type { Sandbox } from "../../qa-engine/src/shared-infrastructure/process-sandbox/sandbox";
import { loadAppConfig, type AppConfig } from "../orchestrator/config-loader";
import { qayabaRoot } from "../paths";
import { forwardDnsQuery } from "./dns-forward";

export type EgressMode = "enforce" | "warn";

/* QA_EGRESS_MODE: `enforce` (the default) ends a run that would execute agent code without the filter; `warn` lets it run unfiltered and says so in the run's gate signals. */
export function resolveEgressMode(env: NodeJS.ProcessEnv): EgressMode {
  const raw = env.QA_EGRESS_MODE;
  if (raw === undefined || raw === "") return "enforce";
  if (raw === "enforce" || raw === "warn") return raw;
  throw new Error(`QA_EGRESS_MODE must be "enforce" or "warn", got ${JSON.stringify(raw)}`);
}

export type RegistryGroups = Readonly<Record<string, readonly string[]>>;

/* config/egress/registries.yaml: group name to origins. A group that is not a list of strings is a configuration error, said with its name. */
let warnedNoRegistries = false;

/* A missing file declares no registry at all, which is the closed reading: installs then reach only the origins an app declares for them, and a registry that is needed shows up in the run's denied hosts. It is said once. */
export function loadRegistryGroups(root: string, read: (path: string) => string = (path) => readFileSync(path, "utf8")): RegistryGroups {
  let text: string;
  try {
    text = read(join(root, "config", "egress", "registries.yaml"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    if (!warnedNoRegistries) {
      warnedNoRegistries = true;
      console.warn("[qa] WARNING: config/egress/registries.yaml is missing: no package registry is reachable by an install child unless the app declares egress.installOrigins.");
    }
    return {};
  }
  const parsed: unknown = parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("config/egress/registries.yaml must map a registry group to a list of origins");
  const groups: Record<string, string[]> = {};
  for (const [name, origins] of Object.entries(parsed)) {
    if (!Array.isArray(origins) || !origins.every((o) => typeof o === "string")) throw new Error(`config/egress/registries.yaml: group ${JSON.stringify(name)} must be a list of origin strings`);
    compileEgressPolicy(origins);
    groups[name] = origins;
  }
  return groups;
}

export interface RunEgressOrigins {
  dev: string[];
  install: string[];
}

const unique = (origins: readonly string[]): string[] => [...new Set(origins)];

/* What a run's children may reach: a suite or a login reaches the app's own origin and the origins it declares; an install reaches the registries its target needs and the app's own extra ones. A code-mode app has no DEV site. */
export function resolveRunOrigins(app: Pick<AppConfig, "dev" | "egress">, target: "e2e" | "code", registries: RegistryGroups): RunEgressOrigins {
  const own = app.dev?.baseUrl ? originOf(app.dev.baseUrl) : undefined;
  const dev = target === "e2e" ? unique([...(own ? [own] : []), ...(app.dev?.allowedOrigins ?? [])]) : [];
  const groups = target === "e2e" ? ["npm"] : Object.keys(registries);
  const install = unique([...groups.flatMap((group) => registries[group] ?? []), ...(app.egress?.installOrigins ?? [])]);
  return { dev, install };
}

let shared: { gate: EgressController | undefined; key: string } | undefined;

/* The process-wide egress controller, or none when the sandbox uid does not apply (the filter matches on that uid). Created on first use; the proxy listeners, the DNS filter and the kernel rules it brings up live as long as the process. */
export function egressGateFor(env: NodeJS.ProcessEnv, sandbox: Sandbox | null): EgressGate | undefined {
  if (!sandbox) return undefined;
  const mode = resolveEgressMode(env);
  const key = `${mode}:${sandbox.uid}`;
  if (shared?.key === key) return shared.gate;
  const statusFile = env.QA_EGRESS_STATUS_FILE && env.QA_EGRESS_STATUS_FILE !== "" ? env.QA_EGRESS_STATUS_FILE : "/run/qa-egress.status";
  const gate = new EgressController({
    mode,
    uid: sandbox.uid,
    readStatus: () => {
      try {
        return readFileSync(statusFile, "utf8");
      } catch {
        return undefined;
      }
    },
    createProxy: (hooks) => new TransparentProxy({ allows: hooks.allows, onDenied: (host, port) => hooks.onDenied(host, port) }),
    createDns: (hooks) => new DnsFilter({ allowsName: hooks.allowsName, onDenied: (name) => hooks.onDenied(name), forward: (query) => forwardDnsQuery(query) }),
    iptables: createIptablesApplier(),
    warn: (line) => console.warn(line),
  });
  shared = { gate, key };
  return gate;
}

/* The origins an e2e run of the app would be held to, in the shape the operator scripts' scope takes: they run suites outside the queue and must be held to the same list as production, or their results would not be the pipeline's. */
export function scriptOriginsFor(appName: string): { devOrigins: string[]; installOrigins: string[] } {
  const origins = resolveRunOrigins(loadAppConfig(appName), "e2e", loadRegistryGroups(qayabaRoot()));
  return { devOrigins: origins.dev, installOrigins: origins.install };
}

/* The registries an e2e install reaches, with no app's own: for a script step that sets a project up without knowing which app it is for. */
export function scriptRegistryOrigins(): { installOrigins: string[] } {
  return { installOrigins: resolveRunOrigins({}, "e2e", loadRegistryGroups(qayabaRoot())).install };
}
