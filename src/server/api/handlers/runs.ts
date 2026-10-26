/* Routes about runs: launch, read, list, cancel, stream events, agent turns, continue, ask. */

import { appLogger } from "../../../integrations/redacting-logger";
import { z } from "zod";
import { AgentTurnViewSchema, RunDetailSchema, RunRecordSchema } from "../../../contract/commands";
import { RunEventSchema, type RunEvent } from "../../../contract/events";
import { sanitizeText } from "../../../../qa-engine/src/shared-infrastructure/redaction/pattern-redaction.adapter";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError } from "../api-error";
import { param, type ApiContext } from "../context";
import { JsonFieldsSchema, parseJsonBody } from "../request";
import { reply, type ApiResult } from "../respond";
import { sanitizeRecord } from "../support";
import { askAboutRun } from "../use-cases/ask";
import { ContinueBodySchema, continueRun, findContinuable } from "../use-cases/continue-run";
import { createRun } from "../use-cases/create-run";

/*
 * SSE durable-poll cadence: how often an open run-event stream re-reads the durable store
 * for events produced out-of-process and re-checks the record for a terminal state. Small
 * enough to feel live, large enough not to hammer SQLite per open connection.
 */
const DEFAULT_SSE_POLL_MS = 1000;

export async function postRun(ctx: ApiContext): Promise<ApiResult> {
  return createRun(ctx.deps, await parseJsonBody(ctx.req, JsonFieldsSchema));
}

export function getRun(ctx: ApiContext): ApiResult {
  const id = param(ctx, "id");
  const record = ctx.deps.getRecord(id);
  if (!record) throw new ApiError(404, `run not found: ${id}`);
  const extras = ctx.deps.runExtras?.(id);
  if (extras) return reply.contract(200, RunDetailSchema, { schemaVersion: 1, ...sanitizeRecord(record), ...extras });
  return reply.contract(200, RunRecordSchema.extend({ schemaVersion: z.literal(1) }), { schemaVersion: 1, ...sanitizeRecord(record) });
}

export function listRuns(ctx: ApiContext): ApiResult {
  const app = ctx.url.searchParams.get("app");
  const limit = Number(ctx.url.searchParams.get("limit")) || 10;
  if (!app) throw new ApiError(400, "?app=<name> query parameter is required");
  return reply.contract(200, z.array(RunRecordSchema), ctx.deps.listRecords(app, limit).map(sanitizeRecord));
}

export function cancelRun(ctx: ApiContext): ApiResult {
  const { deps } = ctx;
  const id = param(ctx, "id");
  if (!deps.cancelRun) throw new ApiError(501, "cancel is not available");

  const record = deps.getRecord(id);
  if (!record) throw new ApiError(404, `run not found: ${id}`);
  if (record.status !== "running" && record.status !== "enqueued") {
    throw new ApiError(409, `run ${id} is not running (status: ${record.status})`);
  }

  const cancelled = deps.cancelRun(id);
  if (cancelled) return reply.json(200, { id, status: "cancelled" });
  if (deps.getRecord(id)?.status === "done") {
    /*
     * cancelRun returned false but finalized the record: it was either still enqueued (pulled
     * from the queue before it could start) or a stale "running" record the live queue no longer
     * held (finalized so the operator's stop clears it). Either way it is no longer active.
     */
    return reply.json(200, { id, status: "cancelled", message: "run was not actively executing — finalized and removed from the queue" });
  }
  /*
   * Running per the (stale) record, but it is no longer the run holding the queue —
   * it already finished or a successor is now executing. Do NOT report it cancelled.
   */
  throw new ApiError(409, "run is no longer the active run (it finished or a successor is now running)");
}

export function runTurns(ctx: ApiContext): ApiResult {
  const { deps } = ctx;
  const id = param(ctx, "id");
  if (!deps.getAgentTurns) throw new ApiError(501, "agent turns are not available");
  if (!deps.getRecord(id)) throw new ApiError(404, `run not found: ${id}`);
  /*
   * Defensive egress sanitization, matching sanitizeRecord on the sibling run-read endpoints.
   * prompt_text embeds the live-DEV domSnapshot and is persisted RAW (output_text and partial_text are
   * sanitized at capture, but re-sanitizing is idempotent and keeps the egress pass uniform across the fields).
   */
  const turns = deps.getAgentTurns(id).map((t) => ({
    ...t,
    promptText: sanitizeText(t.promptText).text,
    outputText: sanitizeText(t.outputText).text,
    partialText: t.partialText ? sanitizeText(t.partialText).text : null,
  }));
  return reply.contract(200, z.array(AgentTurnViewSchema), turns);
}

export async function continueRunRoute(ctx: ApiContext): Promise<ApiResult> {
  const continuable = findContinuable(ctx.deps, param(ctx, "id"));
  /* Optional body: { cases?: string[], guidance?: string }. */
  const input = await parseJsonBody(ctx.req, ContinueBodySchema, { optional: true, invalid: () => new ApiError(400, "invalid JSON") });
  return continueRun(ctx.deps, continuable, input);
}

export function askRun(ctx: ApiContext): Promise<ApiResult> {
  return askAboutRun(ctx.deps, param(ctx, "id"), () => parseJsonBody(ctx.req, JsonFieldsSchema));
}

function sseWrite(res: ServerResponse, event: unknown): void {
  /*
   * Guard the write-after-close race: the bus is synchronous, so an event emitted
   * as the socket closes can reach here after the stream already ended.
   */
  if (res.writableEnded) return;
  const result = RunEventSchema.safeParse(event);
  if (!result.success) {
    appLogger.error("[sse] dropped malformed RunEvent:", { issues: result.error.issues });
    return;
  }
  const parsed = result.data;
  res.write(`id: ${parsed.seq}\n`);
  res.write(`event: ${parsed.body.type}\n`);
  res.write(`data: ${JSON.stringify(parsed)}\n\n`);
}

function parseLastEventId(req: IncomingMessage): number {
  const raw = req.headers["last-event-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return -1;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : -1;
}

export function streamRunEvents(ctx: ApiContext): ApiResult {
  const { req, res, deps } = ctx;
  const id = param(ctx, "id");
  const runEvents = deps.runEvents;
  if (!runEvents) throw new ApiError(501, "run event stream is not available");
  const record = deps.getRecord(id);
  if (!record) throw new ApiError(404, `run not found: ${id}`);

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.writeHead(200);

  /*
   * Track the high-water seq streamed so the durable poll never re-sends an event the live
   * bus already delivered (and vice-versa).
   */
  let lastSentSeq = parseLastEventId(req);
  const send = (event: RunEvent): void => {
    sseWrite(res, event);
    if (event.seq > lastSentSeq) lastSentSeq = event.seq;
  };

  for (const event of runEvents.replay(id, lastSentSeq)) send(event);

  /*
   * A terminated run emits nothing more: replay, then close so the client stops
   * waiting on a stream that will never produce another event.
   */
  if (record.status === "done") {
    res.end();
    return reply.streamed;
  }

  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: () => void = () => {};
  const finish = (): void => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    unsubscribe();
    if (!res.writableEnded) res.end();
  };

  /* Live tail for a run executing IN THIS process: the in-process bus delivers each publish. */
  unsubscribe = runEvents.subscribe(id, (event) => {
    send(event);
    /*
     * run.verdict is terminal — close the stream once the run finishes so the
     * connection (and its bus listener) is not held open indefinitely.
     */
    if (event.body.type === "run.verdict") finish();
  });

  /*
   * Durable poll — the robustness net. The bus above only sees SAME-PROCESS publishes, so a
   * run produced by another process (e.g. the CLI's own queue) would otherwise stream nothing
   * and never close. Each tick (a) flushes events persisted since lastSentSeq — surfacing an
   * out-of-process run's progress through the shared store — then (b) ends the stream once the
   * record is terminal, so a missed/absent run.verdict can never leave the connection hanging.
   */
  timer = setInterval(() => {
    if (closed) return;
    for (const event of runEvents.replay(id, lastSentSeq)) send(event);
    /*
     * Close only on an EXPLICIT terminal record. getRecord is durable (SQLite), so a missing
     * record mid-stream is anomalous — treating it as terminal could drop a healthy stream, so
     * we don't; the run record reaching "done" is the single close trigger here.
     */
    if (deps.getRecord(id)?.status === "done") finish();
  }, deps.ssePollMs ?? DEFAULT_SSE_POLL_MS);
  timer.unref?.();

  /*
   * Client disconnect → tear everything down. The write-after-close race is also guarded
   * centrally in sseWrite (writableEnded), so a late event is a no-op.
   */
  req.on("close", () => finish());
  return reply.streamed;
}
