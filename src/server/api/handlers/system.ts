/* Routes about the service itself: liveness, telemetry health, the version handshake and the queue. */

import { appLogger } from "../../../integrations/redacting-logger";
import { QueueStatusSchema, TelemetryHealthSchema, VersionInfoSchema, type TelemetryHealthView } from "../../../contract/commands";
import type { TelemetryBackendsHealth } from "../../../telemetry/telemetry-health";
import { getOpenSessionCount } from "../../../integrations/opencode-client";
import { activeEnvironment } from "../../../settings/active";
import { describeSandboxHealth } from "../../sandbox-health";
import { handshake } from "../../version";
import { ApiError } from "../api-error";
import type { ApiContext } from "../context";
import { reply, type ApiResult } from "../respond";

export function health(ctx: ApiContext): ApiResult {
  const { deps } = ctx;
  /* Still 200 when the sandbox is degraded: the container stays up for the operator to read why. */
  const sandbox = describeSandboxHealth(activeEnvironment());
  /* Public route: a flag and a count each, never an endpoint or an error text. */
  const telemetry = deps.telemetryHealth?.();
  /* A degraded store never fails the route (the container stays up); it is a flag, with the reasons on the authenticated route. */
  let backends: TelemetryBackendsHealth | undefined;
  try {
    backends = deps.backendHealth?.peek();
  } catch {
    backends = undefined;
  }
  return reply.json(200, {
    ok: true,
    openSessions: getOpenSessionCount(),
    sandbox,
    ...(telemetry ? { telemetry: { mode: telemetry.mode, ledgerOk: telemetry.ledger.ok, otlpConfigured: telemetry.otlp.configured, ...(backends ? { backendsOk: backends.ok } : {}) } } : {}),
  });
}

export async function telemetryHealth(ctx: ApiContext): Promise<ApiResult> {
  const { deps } = ctx;
  if (!deps.telemetryHealth) throw new ApiError(501, "telemetry is not configured");
  let host: TelemetryHealthView["host"];
  try {
    host = deps.hostHealth?.();
  } catch (err) {
    appLogger.error(`[api] host health unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  let backends: TelemetryBackendsHealth | undefined;
  try {
    backends = await deps.backendHealth?.get();
  } catch (err) {
    appLogger.error(`[api] backend health unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  return reply.contract(200, TelemetryHealthSchema, { schemaVersion: 1, ...deps.telemetryHealth(), ...(backends ? { backends } : {}), ...(host ? { host } : {}) });
}

export function version(ctx: ApiContext): ApiResult {
  return reply.contract(200, VersionInfoSchema, handshake(ctx.url.searchParams.get("client") ?? undefined, ctx.deps.githubClientId));
}

export function queue(ctx: ApiContext): ApiResult {
  const running = ctx.deps.currentRun();
  return reply.contract(200, QueueStatusSchema, {
    pending: ctx.deps.queue.size,
    running: running ? { id: running.id, app: running.app } : null,
  });
}
