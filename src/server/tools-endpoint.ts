/*
 * The orchestrator's internal endpoint for the agents' custom tools: `run_spec`, which lets the generator run a spec it wrote
 * (POST /internal/run-spec), and the `authbrowser_*` tools, which let the authoring roles read DEV through the run's saved
 * session without holding it (POST /internal/authbrowser). It is a second listener on its own port (QA_TOOLS_PORT), which compose does
 * not publish: it is reachable from the agents container only, and the sandbox uid that runs the specs cannot reach it (the
 * egress filter rejects every loopback port but its own). A service secret (QA_TOOLS_TOKEN) is required on top of that.
 * The caller names a session and an agent; neither decides anything by itself: the call is served only when the session is
 * one the orchestrator bound to an authorized role of a live run (see ClosedLoopRegistry and AgentBrowserRegistry), and every
 * limit is the run's own.
 * Pure handler plus a thin Node wrapper; the handler never throws and never says what went wrong inside.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ClosedLoopRegistry } from "@contexts/qa-run-orchestration/infrastructure/closed-loop-registry";
import type { AgentBrowserRegistry } from "@contexts/qa-run-orchestration/infrastructure/agent-browser-registry";
import type { AgentBrowserRefusalCode } from "@contexts/test-execution/domain/agent-browser-capability";
import type { AgentBrowserRequest } from "@contexts/test-execution/application/agent-browser.use-case";
import type { RunSpecRefusalCode } from "@contexts/test-execution/application/run-spec.use-case";

export const QA_TOOLS_TOKEN_ENV = "QA_TOOLS_TOKEN";
export const QA_TOOLS_PORT_ENV = "QA_TOOLS_PORT";
export const DEFAULT_TOOLS_PORT = 459;
export const RUN_SPEC_PATH = "/internal/run-spec";
export const AUTHBROWSER_PATH = "/internal/authbrowser";
/* A call is a path, a short filter and two ids: anything near this is not one. */
export const MAX_TOOLS_BODY_BYTES = 8 * 1024;

const MAX_ID_CHARS = 200;
const MAX_PATH_CHARS = 512;
const MAX_GREP_CHARS = 400;

export interface ToolsRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: string;
}

export interface ToolsResponse {
  status: number;
  body: unknown;
}

export interface ToolsHandlerDeps {
  token: string;
  registry: ClosedLoopRegistry;
  /* Absent: no run is granted the authenticated browser and its endpoint answers like any session no run owns. */
  browsers?: AgentBrowserRegistry;
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
  path: string;
  grep?: string;
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
  return { sessionID, agent, path, ...(grep !== undefined ? { grep } : {}) };
}

/* The browser call a body names, built from its known keys alone (a key the caller adds is dropped), or undefined when it is not one. The use case judges the values. */
function parseBrowserCall(body: string): AgentBrowserRequest | undefined {
  const parsed = parseObject(body);
  if (!parsed) return undefined;
  const { sessionID, agent, action, url, ref, text, submit } = parsed;
  if (typeof sessionID !== "string" || sessionID === "" || sessionID.length > MAX_ID_CHARS) return undefined;
  if (typeof agent !== "string" || agent === "" || agent.length > MAX_ID_CHARS) return undefined;
  const envelope = { sessionId: sessionID, agent };
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

async function handleBrowserRequest(request: ToolsRequest, deps: ToolsHandlerDeps): Promise<ToolsResponse> {
  const call = parseBrowserCall(request.body);
  if (!call) return { status: 400, body: { ok: false, code: "invalid-request", message: "the call must be a JSON object with sessionID, agent and an action (navigate, snapshot, click or type) with its arguments" } };
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
  if (!bearerMatches(request.authorization, deps.token)) return { status: 401, body: { ok: false, code: "unauthorized", message: `the service token was rejected: ${QA_TOOLS_TOKEN_ENV} differs between the agents and the orchestrator services` } };
  if (request.path !== RUN_SPEC_PATH && request.path !== AUTHBROWSER_PATH) return { status: 404, body: { ok: false, code: "not-found", message: "no such tool endpoint" } };
  if (request.method !== "POST") return { status: 405, body: { ok: false, code: "method-not-allowed", message: "POST only" } };
  if (request.path === AUTHBROWSER_PATH) return handleBrowserRequest(request, deps);
  const call = parseCall(request.body);
  if (!call) return { status: 400, body: { ok: false, code: "invalid-request", message: "the call must be a JSON object with sessionID, agent, path and an optional grep" } };

  const loop = deps.registry.find(call.sessionID);
  if (!loop) return { status: 403, body: { ok: false, code: "unknown-session", message: "run_spec is not available to this session" } };
  try {
    const response = await loop.call({ sessionId: call.sessionID, agent: call.agent, path: call.path, ...(call.grep !== undefined ? { grep: call.grep } : {}) });
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
  if (configured) return { token: configured, generated: false };
  log.warn(`[qa] ${QA_TOOLS_TOKEN_ENV} is not set: generated a random one for this boot, so the run_spec and authenticated browser tools are refused until the same ${QA_TOOLS_TOKEN_ENV} is set on the orchestrator and agents services (see .env.example).`);
  return { token: randomBytes(32).toString("hex"), generated: true };
}

export function resolveToolsPort(env: Record<string, string | undefined>): number {
  const raw = env[QA_TOOLS_PORT_ENV]?.trim();
  if (!raw) return DEFAULT_TOOLS_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${QA_TOOLS_PORT_ENV} must be a TCP port number (1-65535), got "${raw}"`);
  return port;
}

function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
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

function send(res: ServerResponse, response: ToolsResponse): void {
  const payload = JSON.stringify(response.body);
  res.writeHead(response.status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

/* The listener. Not started here: the entrypoint decides when, and what a bind failure means. */
export function createToolsServer(deps: ToolsHandlerDeps): Server {
  return createServer(async (req, res) => {
    const body = await readBody(req);
    if (body === undefined) {
      send(res, { status: 400, body: { ok: false, code: "invalid-request", message: "the body could not be read within its limit" } });
      return;
    }
    const path = (req.url ?? "").split("?")[0] ?? "";
    send(res, await handleToolsRequest({ method: req.method ?? "", path, authorization: req.headers.authorization, body }, deps));
  });
}
