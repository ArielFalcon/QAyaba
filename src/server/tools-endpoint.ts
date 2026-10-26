/*
 * The orchestrator's internal endpoint for the agents' custom tools: `run_spec`, which lets the generator run a spec it wrote
 * (POST /internal/run-spec), the `authbrowser_*` tools, which let the authoring roles read DEV through the run's saved
 * session without holding it (POST /internal/authbrowser), `set_geolocation`, which moves the authoring location of the
 * caller's scope (POST /internal/geolocation), and the lead's read-only `codegraph_explore` over the run's own code-graph index
 * (POST /internal/codegraph). It is a second listener on its own port (QA_TOOLS_PORT), which compose does not publish: it is reachable from the agents container only, and the sandbox uid that runs the specs cannot reach it (the
 * egress filter rejects every loopback port but its own). A service secret (QA_TOOLS_TOKEN) is required on top of that.
 * The caller names a session and an agent; neither decides anything by itself: the call is served only when the session is
 * one the orchestrator bound to an authorized role of a live run (see ClosedLoopRegistry, AgentBrowserRegistry,
 * GeolocationRegistry and CodeGraphToolRegistry), and every limit is the run's own.
 * Pure handler plus a thin Node wrapper; the handler never throws and never says what went wrong inside.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import type { ClosedLoopRegistry } from "@contexts/agent-tools/infrastructure/closed-loop-registry";
import type { AgentBrowserRegistry } from "@contexts/agent-tools/infrastructure/agent-browser-registry";
import type { GeolocationRegistry } from "@contexts/agent-tools/infrastructure/geolocation-registry";
import type { CodeGraphToolRegistry } from "@contexts/agent-tools/infrastructure/code-graph-tool-registry";
import { admitCodeGraphQuery, type CodeGraphRefusalCode, type CodeGraphToolRequest } from "@contexts/agent-tools/domain/code-graph-query";
import type { GeolocationRefusalCode } from "@contexts/agent-tools/domain/run-geolocation";
import { MAX_PLACE_NAME_CHARS, type GeolocationInput } from "@kernel/geolocation";
import type { AgentBrowserRefusalCode } from "@contexts/test-execution/domain/agent-browser-capability";
import type { AgentBrowserRequest } from "@contexts/test-execution/application/agent-browser.use-case";
import type { RunSpecRefusalCode } from "@contexts/test-execution/application/run-spec.use-case";

export const QA_TOOLS_TOKEN_ENV = "QA_TOOLS_TOKEN";
export const QA_TOOLS_PORT_ENV = "QA_TOOLS_PORT";
export const DEFAULT_TOOLS_PORT = 459;
export const RUN_SPEC_PATH = "/internal/run-spec";
export const AUTHBROWSER_PATH = "/internal/authbrowser";
export const GEOLOCATION_PATH = "/internal/geolocation";
export const CODEGRAPH_PATH = "/internal/codegraph";
export const QA_TOOLS_LISTEN_HOST_ENV = "QA_TOOLS_LISTEN_HOST";
/* The service token is a bearer secret on a port other containers can reach: a guessable one is no secret. 32 characters is 128 bits of hex, and what a generated token has. */
export const MIN_TOOLS_TOKEN_CHARS = 32;
/* A call is a path, a short filter and two ids: anything near this is not one. */
export const MAX_TOOLS_BODY_BYTES = 8 * 1024;

const MAX_ID_CHARS = 200;
const MAX_PATH_CHARS = 512;
const MAX_GREP_CHARS = 400;
/* An OpenCode message id (`msg_` and letters and digits). The tool reports it for the trace's sake alone. */
const MESSAGE_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

export interface ToolsRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: string;
  /* The caller's address, for the limit on failed authentications. */
  remote?: string;
}

/* Calls per session and failed authentications per address in a sliding window. In memory, bounded, and with an injectable clock. */
export interface ToolsRateLimiter {
  /* Whether this address has already failed authentication too often in the window. */
  blocked(remote: string | undefined): boolean;
  recordFailure(remote: string | undefined): void;
  /* Counts a call of the session; false when it is over its limit. */
  allowCall(sessionId: string): boolean;
}

export interface ToolsRateLimiterOptions {
  maxCallsPerWindow?: number;
  maxFailuresPerWindow?: number;
  windowMs?: number;
  now?: () => number;
}

const MAX_TRACKED_KEYS = 1000;

export function createToolsRateLimiter(options: ToolsRateLimiterOptions = {}): ToolsRateLimiter {
  const maxCalls = options.maxCallsPerWindow ?? 60;
  const maxFailures = options.maxFailuresPerWindow ?? 20;
  const windowMs = options.windowMs ?? 10_000;
  const now = options.now ?? Date.now;
  const calls = new Map<string, number[]>();
  const failures = new Map<string, number[]>();
  const recent = (table: Map<string, number[]>, key: string): number[] => {
    const at = now();
    const kept = (table.get(key) ?? []).filter((t) => at - t < windowMs);
    if (kept.length === 0) table.delete(key);
    else table.set(key, kept);
    return kept;
  };
  const note = (table: Map<string, number[]>, key: string): void => {
    const kept = recent(table, key);
    kept.push(now());
    table.set(key, kept);
    if (table.size > MAX_TRACKED_KEYS) table.delete(table.keys().next().value as string);
  };
  return {
    blocked: (remote) => remote !== undefined && recent(failures, remote).length >= maxFailures,
    recordFailure: (remote) => { if (remote !== undefined) note(failures, remote); },
    allowCall: (sessionId) => {
      if (recent(calls, sessionId).length >= maxCalls) return false;
      note(calls, sessionId);
      return true;
    },
  };
}

export interface ToolsResponse {
  status: number;
  body: unknown;
}

export interface ToolsHandlerDeps {
  token: string;
  registry: ClosedLoopRegistry;
  /* Absent: no limit on the rate of calls (a test); the listener always has one. */
  limiter?: ToolsRateLimiter;
  /* Absent: no run is granted the authenticated browser and its endpoint answers like any session no run owns. */
  browsers?: AgentBrowserRegistry;
  /* Absent: no run carries an authoring location and its endpoint answers like any session no run owns. */
  geolocations?: GeolocationRegistry;
  /* Absent: no run grants the lead the code graph and its endpoint answers like any session no run owns. */
  codeGraphs?: CodeGraphToolRegistry;
}

const REFUSAL_STATUS: Readonly<Record<RunSpecRefusalCode, number>> = {
  "invalid-request": 400,
  "not-found": 404,
  revoked: 403,
  expired: 403,
  "unknown-session": 403,
  "wrong-agent": 403,
  "no-calls": 429,
  "no-writes": 429,
  "no-time": 429,
  busy: 409,
};

const GEOLOCATION_REFUSAL_STATUS: Readonly<Record<GeolocationRefusalCode, number>> = {
  "invalid-location": 400,
  "unknown-place": 400,
  "unknown-scope": 409,
  closed: 403,
};

const BROWSER_REFUSAL_STATUS: Readonly<Record<AgentBrowserRefusalCode, number>> = {
  "invalid-request": 400,
  revoked: 403,
  expired: 403,
  "unknown-session": 403,
  "wrong-agent": 403,
  blocked: 403,
  "no-calls": 429,
  busy: 409,
  "session-invalidated": 409,
  failed: 422,
};

const CODE_GRAPH_REFUSAL_STATUS: Readonly<Record<CodeGraphRefusalCode, number>> = {
  "wrong-agent": 403,
  revoked: 403,
  "no-calls": 429,
  failed: 422,
};

function digest(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

/* Constant time on equal-length digests, so neither the token's length nor its first differing byte shows. */
function bearerMatches(header: string | undefined, token: string): boolean {
  if (header === undefined || !header.startsWith("Bearer ")) return false;
  return timingSafeEqual(digest(header.slice("Bearer ".length)), digest(token));
}

interface ParsedCall {
  sessionID: string;
  agent: string;
  /* Absent when the caller sent none or sent something that is not a plain identifier. */
  messageId?: string;
  path: string;
  grep?: string;
}

/*
 * The message id a body carries, or undefined. It joins the orchestrator's span of a call to the agent's own span of it and decides
 * nothing, so a value that is not a short plain identifier is dropped and the call is served without it, never refused for it.
 */
function messageIdOf(parsed: Record<string, unknown>): string | undefined {
  const { messageID } = parsed;
  return typeof messageID === "string" && MESSAGE_ID.test(messageID) ? messageID : undefined;
}

function parseObject(body: string): Record<string, unknown> | undefined {
  if (Buffer.byteLength(body, "utf8") > MAX_TOOLS_BODY_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

function parseCall(body: string): ParsedCall | undefined {
  const parsed = parseObject(body);
  if (!parsed) return undefined;
  const { sessionID, agent, path, grep } = parsed;
  if (typeof sessionID !== "string" || sessionID === "" || sessionID.length > MAX_ID_CHARS) return undefined;
  if (typeof agent !== "string" || agent === "" || agent.length > MAX_ID_CHARS) return undefined;
  if (typeof path !== "string" || path === "" || path.length > MAX_PATH_CHARS) return undefined;
  if (grep !== undefined && (typeof grep !== "string" || grep.length > MAX_GREP_CHARS)) return undefined;
  const messageId = messageIdOf(parsed);
  return { sessionID, agent, ...(messageId !== undefined ? { messageId } : {}), path, ...(grep !== undefined ? { grep } : {}) };
}

/* The browser call a body names, built from its known keys alone (a key the caller adds is dropped), or undefined when it is not one. The use case judges the values. */
function parseBrowserCall(body: string): AgentBrowserRequest | undefined {
  const parsed = parseObject(body);
  if (!parsed) return undefined;
  const { sessionID, agent, action, url, ref, text, submit } = parsed;
  if (typeof sessionID !== "string" || sessionID === "" || sessionID.length > MAX_ID_CHARS) return undefined;
  if (typeof agent !== "string" || agent === "" || agent.length > MAX_ID_CHARS) return undefined;
  const messageId = messageIdOf(parsed);
  const envelope = { sessionId: sessionID, agent, ...(messageId !== undefined ? { messageId } : {}) };
  switch (action) {
    case "snapshot":
      return { ...envelope, action };
    case "navigate":
      return typeof url === "string" ? { ...envelope, action, url } : undefined;
    case "click":
      return typeof ref === "string" ? { ...envelope, action, ref } : undefined;
    case "type":
      return typeof ref === "string" && typeof text === "string" && (submit === undefined || typeof submit === "boolean")
        ? { ...envelope, action, ref, text, ...(submit !== undefined ? { submit } : {}) }
        : undefined;
    default:
      return undefined;
  }
}

/* The location call a body names: a declared place, or a point. The domain judges the values; here only the shape is read. */
function parseGeolocationCall(body: string): { sessionID: string; agent: string; change: GeolocationInput } | undefined {
  const parsed = parseObject(body);
  if (!parsed) return undefined;
  const { sessionID, agent, place, latitude, longitude } = parsed;
  if (typeof sessionID !== "string" || sessionID === "" || sessionID.length > MAX_ID_CHARS) return undefined;
  if (typeof agent !== "string" || agent === "" || agent.length > MAX_ID_CHARS) return undefined;
  if (place !== undefined && (typeof place !== "string" || place.length > MAX_PLACE_NAME_CHARS)) return undefined;
  if (latitude !== undefined && (typeof latitude !== "number" || !Number.isFinite(latitude))) return undefined;
  if (longitude !== undefined && (typeof longitude !== "number" || !Number.isFinite(longitude))) return undefined;
  if (place === undefined && latitude === undefined && longitude === undefined) return undefined;
  return {
    sessionID,
    agent,
    change: {
      ...(place !== undefined ? { place } : {}),
      ...(latitude !== undefined ? { latitude } : {}),
      ...(longitude !== undefined ? { longitude } : {}),
    },
  };
}

async function handleGeolocationRequest(request: ToolsRequest, deps: ToolsHandlerDeps): Promise<ToolsResponse> {
  const call = parseGeolocationCall(request.body);
  if (!call) return { status: 400, body: { ok: false, code: "invalid-request", message: "the call must be a JSON object with sessionID, agent and a declared place or a latitude and longitude" } };
  if (deps.limiter && !deps.limiter.allowCall(call.sessionID)) return { status: 429, body: { ok: false, code: "rate-limited", message: "too many calls from this session in a short time; wait a few seconds and retry" } };
  const bound = deps.geolocations?.find(call.sessionID);
  if (!bound) return { status: 403, body: { ok: false, code: "unknown-session", message: "the authoring location is not available to this session" } };
  if (bound.agent !== call.agent) return { status: 403, body: { ok: false, code: "wrong-agent", message: "the authoring location is available only to the role this session was opened for" } };
  try {
    const response = bound.live.set(bound.delegationId, call.change);
    if (response.ok) return { status: 200, body: response };
    return { status: GEOLOCATION_REFUSAL_STATUS[response.code], body: response };
  } catch (err) {
    console.error(`[qa] the authoring location failed in the orchestrator: ${err instanceof Error ? err.message : String(err)}`);
    return { status: 500, body: { ok: false, code: "internal", message: "the authoring location failed in the orchestrator" } };
  }
}

/* The code-graph call a body names: the session and agent, and a query admitted by its known keys alone. */
function parseCodeGraphCall(body: string): CodeGraphToolRequest | undefined {
  const parsed = parseObject(body);
  if (!parsed) return undefined;
  const { sessionID, agent } = parsed;
  if (typeof sessionID !== "string" || sessionID === "" || sessionID.length > MAX_ID_CHARS) return undefined;
  if (typeof agent !== "string" || agent === "" || agent.length > MAX_ID_CHARS) return undefined;
  const query = admitCodeGraphQuery(parsed);
  if (!query) return undefined;
  const messageId = messageIdOf(parsed);
  return { sessionId: sessionID, agent, ...(messageId !== undefined ? { messageId } : {}), query };
}

async function handleCodeGraphRequest(request: ToolsRequest, deps: ToolsHandlerDeps): Promise<ToolsResponse> {
  const call = parseCodeGraphCall(request.body);
  if (!call) return { status: 400, body: { ok: false, code: "invalid-request", message: "the call must be a JSON object with sessionID, agent, the action explore and 1 to 8 terms (each a symbol name, a file path or a short code term of at most 200 characters, never starting with a dash)" } };
  if (deps.limiter && !deps.limiter.allowCall(call.sessionId)) return { status: 429, body: { ok: false, code: "rate-limited", message: "too many calls from this session in a short time; wait a few seconds and retry" } };
  const graph = deps.codeGraphs?.find(call.sessionId);
  if (!graph) return { status: 403, body: { ok: false, code: "unknown-session", message: "the code graph is not available to this session" } };
  try {
    const response = await graph.call(call);
    if (response.ok) return { status: 200, body: response };
    return { status: CODE_GRAPH_REFUSAL_STATUS[response.code], body: response };
  } catch (err) {
    console.error(`[qa] the code graph failed in the orchestrator: ${err instanceof Error ? err.message : String(err)}`);
    return { status: 500, body: { ok: false, code: "internal", message: "the code graph failed in the orchestrator" } };
  }
}

async function handleBrowserRequest(request: ToolsRequest, deps: ToolsHandlerDeps): Promise<ToolsResponse> {
  const call = parseBrowserCall(request.body);
  if (!call) return { status: 400, body: { ok: false, code: "invalid-request", message: "the call must be a JSON object with sessionID, agent and an action (navigate, snapshot, click or type) with its arguments" } };
  if (deps.limiter && !deps.limiter.allowCall(call.sessionId)) return { status: 429, body: { ok: false, code: "rate-limited", message: "too many calls from this session in a short time; wait a few seconds and retry" } };
  const browser = deps.browsers?.find(call.sessionId);
  if (!browser) return { status: 403, body: { ok: false, code: "unknown-session", message: "the authenticated browser is not available to this session" } };
  try {
    const response = await browser.call(call);
    if (response.ok) return { status: 200, body: response };
    return { status: BROWSER_REFUSAL_STATUS[response.code], body: response };
  } catch (err) {
    console.error(`[qa] the authenticated browser failed in the orchestrator: ${err instanceof Error ? err.message : String(err)}`);
    return { status: 500, body: { ok: false, code: "internal", message: "the authenticated browser failed in the orchestrator" } };
  }
}

export async function handleToolsRequest(request: ToolsRequest, deps: ToolsHandlerDeps): Promise<ToolsResponse> {
  /* A token this short is not a secret: the endpoint answers nothing rather than trust it. */
  if (deps.token.length < MIN_TOOLS_TOKEN_CHARS) return { status: 503, body: { ok: false, code: "unavailable", message: `the tools endpoint is disabled: ${QA_TOOLS_TOKEN_ENV} must be at least ${MIN_TOOLS_TOKEN_CHARS} characters` } };
  if (deps.limiter?.blocked(request.remote)) return { status: 429, body: { ok: false, code: "rate-limited", message: "too many rejected calls from this address; wait and retry" } };
  if (!bearerMatches(request.authorization, deps.token)) {
    deps.limiter?.recordFailure(request.remote);
    return { status: 401, body: { ok: false, code: "unauthorized", message: `the service token was rejected: ${QA_TOOLS_TOKEN_ENV} differs between the agents and the orchestrator services` } };
  }
  if (request.path !== RUN_SPEC_PATH && request.path !== AUTHBROWSER_PATH && request.path !== GEOLOCATION_PATH && request.path !== CODEGRAPH_PATH) return { status: 404, body: { ok: false, code: "not-found", message: "no such tool endpoint" } };
  if (request.method !== "POST") return { status: 405, body: { ok: false, code: "method-not-allowed", message: "POST only" } };
  if (request.path === AUTHBROWSER_PATH) return handleBrowserRequest(request, deps);
  if (request.path === GEOLOCATION_PATH) return handleGeolocationRequest(request, deps);
  if (request.path === CODEGRAPH_PATH) return handleCodeGraphRequest(request, deps);
  const call = parseCall(request.body);
  if (!call) return { status: 400, body: { ok: false, code: "invalid-request", message: "the call must be a JSON object with sessionID, agent, path and an optional grep" } };

  if (deps.limiter && !deps.limiter.allowCall(call.sessionID)) return { status: 429, body: { ok: false, code: "rate-limited", message: "too many calls from this session in a short time; wait a few seconds and retry" } };
  const loop = deps.registry.find(call.sessionID);
  if (!loop) return { status: 403, body: { ok: false, code: "unknown-session", message: "run_spec is not available to this session" } };
  try {
    const response = await loop.call({ sessionId: call.sessionID, agent: call.agent, ...(call.messageId !== undefined ? { messageId: call.messageId } : {}), path: call.path, ...(call.grep !== undefined ? { grep: call.grep } : {}) });
    if (response.ok) return { status: 200, body: response };
    return { status: REFUSAL_STATUS[response.code], body: response };
  } catch (err) {
    console.error(`[qa] run_spec failed in the orchestrator: ${err instanceof Error ? err.message : String(err)}`);
    return { status: 500, body: { ok: false, code: "internal", message: "run_spec failed in the orchestrator" } };
  }
}

/*
 * The service token: the same value on the orchestrator and agents services (compose). Unset, a random one is generated for this
 * boot so the endpoint is never open; the agents service generates its own, the two differ, and every call is then refused with a
 * message that names the variable (the same arrangement as the OpenCode server's password).
 */
export function resolveToolsToken(env: Record<string, string | undefined>, log: { warn: (message: string) => void } = console): { token: string; generated: boolean } {
  const configured = env[QA_TOOLS_TOKEN_ENV]?.trim();
  if (configured && configured.length >= MIN_TOOLS_TOKEN_CHARS) return { token: configured, generated: false };
  if (configured) {
    log.warn(`[qa] ${QA_TOOLS_TOKEN_ENV} is shorter than ${MIN_TOOLS_TOKEN_CHARS} characters and is not used: it must be at least ${MIN_TOOLS_TOKEN_CHARS} (for example the output of \`openssl rand -hex 32\`). Generated a random one for this boot, so the run_spec and authenticated browser tools are refused until the same long ${QA_TOOLS_TOKEN_ENV} is set on the orchestrator and agents services.`);
    return { token: randomBytes(32).toString("hex"), generated: true };
  }
  log.warn(`[qa] ${QA_TOOLS_TOKEN_ENV} is not set: generated a random one for this boot, so the run_spec and authenticated browser tools are refused until the same ${QA_TOOLS_TOKEN_ENV} is set on the orchestrator and agents services (see .env.example).`);
  return { token: randomBytes(32).toString("hex"), generated: true };
}

type InterfaceTable = Record<string, ReadonlyArray<{ address: string; family: string | number; internal: boolean }> | undefined>;

/*
 * Where the tools listener binds. Compose publishes nothing of it, so what can reach it is whatever shares the container's network:
 * the agents service, and any other container someone attaches. Docker gives a container one interface per network it joins and
 * decides its address at start, so the address cannot be written in the compose file; QA_TOOLS_LISTEN_HOST names it when it is
 * known (a user-defined network with a fixed subnet and a fixed address). Without it, a wildcard LISTEN_HOST narrows to the one
 * non-loopback IPv4 address when there is exactly one, which drops the loopback listener (nothing in the container, the sandbox uid
 * included, needs it); with several interfaces the wildcard stays and the choice is the operator's. A loopback LISTEN_HOST stays.
 */
export function resolveToolsListenHost(env: Record<string, string | undefined>, listenHost: string, interfaces: InterfaceTable = os.networkInterfaces()): string {
  const explicit = env[QA_TOOLS_LISTEN_HOST_ENV]?.trim();
  if (explicit) return explicit;
  if (listenHost !== "0.0.0.0" && listenHost !== "::") return listenHost;
  const addresses = Object.values(interfaces).flatMap((entries) => (entries ?? []).filter((entry) => !entry.internal && (entry.family === "IPv4" || entry.family === 4)).map((entry) => entry.address));
  return addresses.length === 1 ? addresses[0]! : listenHost;
}

export function resolveToolsPort(env: Record<string, string | undefined>): number {
  const raw = env[QA_TOOLS_PORT_ENV]?.trim();
  if (!raw) return DEFAULT_TOOLS_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${QA_TOOLS_PORT_ENV} must be a TCP port number (1-65535), got "${raw}"`);
  return port;
}

function readBody(req: IncomingMessage, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    /* A body that is not complete in time is a bad request: the connection is not held open for a client that sends a byte a minute. */
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    req.once("close", () => clearTimeout(timer));
    req.once("end", () => clearTimeout(timer));
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_TOOLS_BODY_BYTES) {
        resolve(undefined);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(undefined));
  });
}

function send(res: ServerResponse, response: ToolsResponse, close = false): void {
  const payload = JSON.stringify(response.body);
  res.writeHead(response.status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), ...(close ? { Connection: "close" } : {}) });
  res.end(payload);
}

/* How long the headers, a whole request and a body may take to arrive. A tool call is a few hundred bytes from a container on the same network; the time a call takes to be answered is not bounded here (a spec runs for minutes). */
export const TOOLS_HEADERS_TIMEOUT_MS = 10_000;
export const TOOLS_REQUEST_TIMEOUT_MS = 20_000;
export const TOOLS_BODY_TIMEOUT_MS = 10_000;

export interface ToolsServerOptions extends ToolsHandlerDeps {
  bodyTimeoutMs?: number;
}

/* The listener. Not started here: the entrypoint decides when, and what a bind failure means. */
export function createToolsServer(deps: ToolsServerOptions): Server {
  const limiter = deps.limiter ?? createToolsRateLimiter();
  const bodyTimeoutMs = deps.bodyTimeoutMs ?? TOOLS_BODY_TIMEOUT_MS;
  const server = createServer(async (req, res) => {
    const body = await readBody(req, bodyTimeoutMs);
    if (body === undefined) {
      send(res, { status: 400, body: { ok: false, code: "invalid-request", message: "the body could not be read within its limit" } }, true);
      return;
    }
    const path = (req.url ?? "").split("?")[0] ?? "";
    send(res, await handleToolsRequest({ method: req.method ?? "", path, authorization: req.headers.authorization, body, ...(req.socket.remoteAddress ? { remote: req.socket.remoteAddress } : {}) }, { ...deps, limiter }));
  });
  server.headersTimeout = TOOLS_HEADERS_TIMEOUT_MS;
  server.requestTimeout = TOOLS_REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 30;
  return server;
}
