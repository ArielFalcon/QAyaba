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
  /* Whether a rule declares exactly this IP literal on this port: the only thing that lets a name lead to a private, link-local or otherwise internal address (see address-class.ts). A name is never an address. */
  declaresAddress(address: string, port: number): boolean;
}

const DEFAULT_PORT: Record<string, number> = { "http:": 80, "https:": 443 };
const LABEL = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/* Suffixes under which anyone can register a name, so a wildcard over one would be every tenant of it. A small list of the ones an app is likely to name (country second-level registries, hosting platforms), not the Public Suffix List: a wildcard should be a suffix the operator owns, and a plain host on a public suffix (acme.github.io) is fine. */
export const PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "co.nz", "org.nz", "net.nz", "co.jp", "or.jp", "ne.jp", "co.kr", "co.in", "net.in", "org.in", "co.za", "org.za",
  "com.br", "net.br", "org.br", "com.ar", "com.mx", "com.co", "com.pe", "com.ve", "com.cn", "net.cn", "org.cn", "com.hk", "com.tw", "com.sg", "com.my", "com.tr", "com.ua", "com.pl", "com.es", "com.pt", "co.il", "co.id", "co.th",
  "github.io", "gitlab.io", "bitbucket.io", "herokuapp.com", "herokussl.com", "appspot.com", "web.app", "firebaseapp.com", "vercel.app", "now.sh", "netlify.app", "netlify.com", "pages.dev", "workers.dev", "onrender.com", "fly.dev", "railway.app", "up.railway.app",
  "azurewebsites.net", "azurestaticapps.net", "cloudapp.net", "cloudapp.azure.com", "blob.core.windows.net", "trafficmanager.net", "cloudfront.net", "amazonaws.com", "s3.amazonaws.com", "elasticbeanstalk.com", "execute-api.amazonaws.com",
  "ngrok.io", "ngrok-free.app", "ngrok.app", "trycloudflare.com", "loca.lt", "localtunnel.me", "surge.sh", "glitch.me", "repl.co", "replit.app", "blogspot.com", "wordpress.com", "myshopify.com", "wixsite.com", "weebly.com", "squarespace.com", "tumblr.com", "000webhostapp.com", "dynu.net", "duckdns.org", "no-ip.org", "ddns.net", "hopto.org", "zapto.org", "dyndns.org",
]);

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
    if (PUBLIC_SUFFIXES.has(host)) throw new EgressPolicyError(origin, `${host} is a public suffix: a wildcard over it would allow every tenant of it; declare the hosts you use, or a wildcard below a name you own`);
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
    declaresAddress: (address, port) => rules.some((rule) => !rule.wildcard && rule.port === port && IPV4.test(rule.host) && rule.host === address),
  };
}

export function compileEgressPolicy(origins: readonly string[]): EgressPolicy {
  return build(origins.map(compileOrigin));
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
