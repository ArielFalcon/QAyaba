/* What a sandboxed child may reach, compiled from the origins declared for it. Pure: no network, no filesystem. The proxy asks `allows(host, port)` for each connection it is handed, and the DNS filter asks `allowsName(host)` for each name it is asked to resolve, so both enforce the same list. An origin is `scheme://host[:port]` with the host a name or, for plain http, an IP literal, or `scheme://*.suffix[:port]` for every subdomain of a suffix of at least two labels. No path, query or credentials. */

export class EgressPolicyError extends Error {
  constructor(origin: string, why: string) {
    super(`invalid egress origin ${JSON.stringify(origin)}: ${why}`);
    this.name = "EgressPolicyError";
  }
}

export interface EgressRule {
  host: string;
  wildcard: boolean;
  port: number;
}

export interface EgressPolicy {
  readonly rules: readonly EgressRule[];
  /* Every upstream port the rules name: the ports the proxy needs a listener for. */
  readonly ports: ReadonlySet<number>;
  allows(host: string, port: number): boolean;
  allowsName(host: string): boolean;
}

const DEFAULT_PORT: Record<string, number> = { "http:": 80, "https:": 443 };
const LABEL = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

const normalize = (host: string): string => (host.endsWith(".") ? host.slice(0, -1) : host).toLowerCase();

function isDnsName(host: string): boolean {
  return host.length <= 253 && host.split(".").every((label) => LABEL.test(label));
}

function compileOrigin(origin: string): EgressRule {
  const match = /^(https?):\/\/([^/?#@]*)\/?$/.exec(origin);
  if (!match) throw new EgressPolicyError(origin, "expected scheme://host[:port] with no path, query or credentials");
  const scheme = `${match[1]}:`;
  const authority = match[2]!;
  const portMatch = /^(.*?)(?::(\d+))?$/.exec(authority)!;
  const rawHost = portMatch[1]!;
  const port = portMatch[2] === undefined ? DEFAULT_PORT[scheme]! : Number(portMatch[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new EgressPolicyError(origin, "the port is not between 1 and 65535");
  if (rawHost === "" ) throw new EgressPolicyError(origin, "the host is missing");
  const wildcard = rawHost.startsWith("*.");
  const host = normalize(wildcard ? rawHost.slice(2) : rawHost);
  if (rawHost.includes("*") && !wildcard) throw new EgressPolicyError(origin, "a wildcard is only allowed as the whole first label (*.suffix)");
  if (wildcard) {
    if (host.split(".").length < 2) throw new EgressPolicyError(origin, "a wildcard needs a suffix of at least two labels");
    if (!isDnsName(host) || IPV4.test(host)) throw new EgressPolicyError(origin, "the wildcard suffix is not a DNS name");
    return { host, wildcard: true, port };
  }
  if (IPV4.test(host)) {
    if (scheme === "https:") throw new EgressPolicyError(origin, "an IP literal cannot be matched by a TLS server name; use a host name, or http");
    return { host, wildcard: false, port };
  }
  if (!isDnsName(host)) throw new EgressPolicyError(origin, "the host is not a DNS name");
  return { host, wildcard: false, port };
}

function matches(rule: EgressRule, host: string): boolean {
  return rule.wildcard ? host.endsWith(`.${rule.host}`) : host === rule.host;
}

function build(rules: readonly EgressRule[]): EgressPolicy {
  const ports = new Set(rules.map((rule) => rule.port));
  return {
    rules,
    ports,
    allows: (host, port) => {
      const name = normalize(host);
      return rules.some((rule) => rule.port === port && matches(rule, name));
    },
    allowsName: (host) => {
      const name = normalize(host);
      return rules.some((rule) => matches(rule, name));
    },
  };
}

export function compileEgressPolicy(origins: readonly string[]): EgressPolicy {
  return build(origins.map(compileOrigin));
}

export function mergeEgressPolicies(policies: readonly EgressPolicy[]): EgressPolicy {
  return build(policies.flatMap((policy) => policy.rules));
}

/* `scheme://host[:port]` of a URL, or undefined when it is not an http(s) URL. */
export function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}
