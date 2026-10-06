/*
 * Stateless session tokens for the control-plane API. A session is a compact JWT
 * (HS256, HMAC-SHA256 over `header.payload`) so the server holds no session state — any
 * instance with the signing secret can validate it. Self-contained on node:crypto: no JWT
 * dependency, no per-provider key. Used by POST /api/auth/login (issue) and the request
 * authorizer (validate); the static QA_API_TOKEN remains the machine credential.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");

interface SessionClaims {
  sub: string;  /* the authenticated GitHub username */
  iat: number;  /* issued-at (epoch seconds) */
  exp: number;  /* expiry (epoch seconds) */
}

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

/*
 * timingSafeEqual requires equal-length buffers and throws otherwise; compare as base64url
 * strings of (almost always) equal length, but guard the length first so a forged signature
 * of a different length is a plain mismatch rather than a thrown error.
 */
function sigEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/*
 * issueSession mints a signed session for username, valid for ttlSeconds from now. `now` is
 * injectable (epoch ms) so tests are deterministic.
 */
export function issueSession(username: string, secret: string, ttlSeconds: number, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const claims: SessionClaims = { sub: username, iat, exp: iat + ttlSeconds };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const data = `${HEADER}.${payload}`;
  return `${data}.${sign(data, secret)}`;
}

/*
 * validateSession returns the username for a well-formed, unexpired, correctly-signed token,
 * or null for anything else — wrong/short signature, tampered payload, expired, malformed.
 * Never throws on bad input.
 */
export function validateSession(token: string, secret: string, now = Date.now()): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts as [string, string, string];

  /*
   * Pin the header to the one constant we issue. We never dispatch on the header's `alg`
   * (sign() is always HMAC-SHA256), so "alg:none" forgery is already impossible — but rejecting
   * any non-matching header closes the whole header-confusion class as defence in depth.
   */
  if (header !== HEADER) return null;
  if (!sigEqual(sig, sign(`${header}.${payload}`, secret))) return null;

  let claims: SessionClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionClaims;
  } catch {
    return null;
  }
  if (typeof claims.sub !== "string" || typeof claims.exp !== "number") return null;
  if (Math.floor(now / 1000) >= claims.exp) return null;
  return claims.sub;
}

/*
 * The principal a request is authorized as: the literal "machine" for a static-token
 * (CI/automation) caller, or the GitHub username for a user-session caller.
 */
export const MACHINE_PRINCIPAL = "machine";
/*
 * Same-origin web console bootstrap (GET /api/auth/local). Distinct from MACHINE_PRINCIPAL
 * so an audit can tell a pasted machine token from an auto-minted local session.
 */
export const LOCAL_CONSOLE_PRINCIPAL = "local-console";

export function isLoopbackAddress(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/*
 * The web console may mint a short-lived session without pasting QA_API_TOKEN when:
 * • QA_WEB_AUTO_LOGIN=true (local docker-compose.override — the browser hits the
 * published port, so the container sees a docker-bridge IP, not loopback), or
 * • the request is loopback (npm start on the host).
 * Docker-bridge / LAN IPs are NEVER trusted without the flag — that would make a
 * published orchestrator port an open control plane.
 */
export function allowLocalWebLogin(opts: { enabled: boolean; remoteAddress?: string }): boolean {
  return opts.enabled || isLoopbackAddress(opts.remoteAddress);
}

/*
 * DNS rebinding resolves an attacker-controlled hostname (e.g. "evil.example") to 127.0.0.1, so
 * the TCP peer genuinely IS loopback (allowLocalWebLogin's remoteAddress check passes) while the
 * browser's Host header still names the attacker's domain. isLoopbackHost is the missing check:
 * the request's Host header hostname must ALSO be loopback (localhost/127.0.0.1/::1) or an
 * explicitly configured allowlist entry — never just any hostname that happens to resolve here.
 */
/*
 * A Host header is exactly `host [":" port]`: an IPv6 literal in brackets, or a hostname / IPv4
 * address of letters, digits, dots, hyphens and underscores (Docker Compose service names use
 * them). The whole value must match — a lenient parse would read "[::1]evil.com" or
 * "localhost:458, evil.example" as loopback. null = malformed.
 */
const HOST_HEADER_RE = /^(?:\[([0-9a-f:.]+)\]|([a-z0-9._-]+))(?::[0-9]{1,5})?$/i;

function hostnameFromHostHeader(host: string): string | null {
  const m = HOST_HEADER_RE.exec(host);
  if (!m) return null;
  /* A match always captures exactly one of the two alternatives. */
  return (m[1] ?? m[2])!.toLowerCase();
}

/* A malformed header (null hostname) equals no loopback name and no allowlist entry. */
export function isLoopbackHost(host: string | undefined, allowlist?: readonly string[]): boolean {
  if (!host) return false;
  const hostname = hostnameFromHostHeader(host);
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return true;
  return allowlist?.some((h) => h.toLowerCase() === hostname) ?? false;
}

/*
 * The whole local-console login policy (GET /api/auth/local): the caller gets in when
 * QA_WEB_AUTO_LOGIN is exactly "true" or the TCP peer is loopback (allowLocalWebLogin), AND the
 * request's Host header names a loopback host or a QA_WEB_LOGIN_HOST_ALLOWLIST entry
 * (comma-separated) — the DNS-rebinding check.
 */
export function localWebLoginAllowed(
  request: { remoteAddress?: string; host?: string },
  env: { QA_WEB_AUTO_LOGIN?: string; QA_WEB_LOGIN_HOST_ALLOWLIST?: string },
): boolean {
  if (!allowLocalWebLogin({ enabled: env.QA_WEB_AUTO_LOGIN === "true", remoteAddress: request.remoteAddress })) return false;
  /* An empty entry (",," or a trailing comma) never equals a parsed hostname, which is never empty. */
  const allowlist = env.QA_WEB_LOGIN_HOST_ALLOWLIST?.split(",").map((h) => h.trim());
  return isLoopbackHost(request.host, allowlist);
}

/*
 * The same-origin web console's login (GET /api/auth/local): a short-lived session for
 * LOCAL_CONSOLE_PRINCIPAL, never the machine token, minted only when localWebLoginAllowed accepts
 * the TCP peer and the Host header; null otherwise. `env` is read on every request, so a live
 * change to QA_WEB_AUTO_LOGIN or the allowlist applies to the next login.
 */
export function createLocalConsoleLogin(
  env: { QA_WEB_AUTO_LOGIN?: string; QA_WEB_LOGIN_HOST_ALLOWLIST?: string },
  signingSecret: string,
  ttlSeconds: number,
): (remoteAddress: string, host: string | undefined) => { token: string; username: string; expiresAt: string } | null {
  return (remoteAddress, host) => {
    if (!localWebLoginAllowed({ remoteAddress, host }, env)) return null;
    const now = Date.now();
    return {
      token: issueSession(LOCAL_CONSOLE_PRINCIPAL, signingSecret, ttlSeconds, now),
      username: LOCAL_CONSOLE_PRINCIPAL,
      expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
    };
  };
}

/*
 * Pre-auth control-plane surface. Login MUST be public (it is how a client with no
 * token yet obtains one). /auth/local is public too — the handler itself refuses
 * untrusted callers with 404, so the gate does not have to know about docker IPs.
 */
export function isPublicControlPlaneRoute(method: string, apiPath: string): boolean {
  if (method === "GET" && (apiPath === "/api/health" || apiPath === "/api/version" || apiPath === "/api/auth/local")) {
    return true;
  }
  return method === "POST" && apiPath === "/api/auth/login";
}

/*
 * authorizeBearer is the request authorizer: it accepts EITHER the static machine token
 * (constant-time compared) OR a valid user-session JWT, and returns the principal it
 * authenticated — "machine" or the GitHub username — or null when neither matches. This is
 * the single home for "who is allowed to call the API", so index.ts's authorized() stays a
 * thin wrapper and the rule is unit-tested here.
 */
export function authorizeBearer(
  authHeader: string | undefined,
  staticToken: string,
  signingSecret: string,
  now = Date.now(),
): string | null {
  if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) return null;
  const presented = authHeader.slice("Bearer ".length);

  if (staticToken !== "" && sigEqual(presented, staticToken)) return MACHINE_PRINCIPAL;

  return validateSession(presented, signingSecret, now);
}
