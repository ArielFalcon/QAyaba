/* Read-only views: an app's intelligence, context map, trends, report and telemetry; a run's report; fleet signals and coordination events. */

import {
  AppTelemetryViewSchema,
  ContextMapViewSchema,
  CoordinationEventsViewSchema,
  IntelligenceViewSchema,
  ReportViewSchema,
  RunReportViewSchema,
  SignalsViewSchema,
  TrendsViewSchema,
} from "../../../contract/commands";
import { reportToCsv, trendsToCsv } from "../../report-view";
import { ApiError } from "../api-error";
import { param, type ApiContext } from "../context";
import { reply, type ApiResult } from "../respond";
import { loadApp, parseLimit, parseWindow, redactionPort } from "../support";

const CSV = "text/csv; charset=utf-8";

export function appIntelligence(ctx: ApiContext): ApiResult {
  const { intelligence } = ctx.deps;
  if (!intelligence) throw new ApiError(501, "intelligence is not available");
  const name = param(ctx, "name");
  loadApp(ctx.deps, name);
  return reply.contract(200, IntelligenceViewSchema, intelligence(name));
}

export function appContextMap(ctx: ApiContext): ApiResult {
  const { contextMap } = ctx.deps;
  if (!contextMap) throw new ApiError(501, "context map is not available");
  const name = param(ctx, "name");
  loadApp(ctx.deps, name);
  const view = contextMap(name);
  if (!view) throw new ApiError(404, `no stored architecture map for app '${name}'`);
  return reply.contract(200, ContextMapViewSchema, view);
}

export function appTrends(ctx: ApiContext): ApiResult {
  const { trends } = ctx.deps;
  if (!trends) throw new ApiError(501, "trends is not available");
  const name = param(ctx, "name");
  loadApp(ctx.deps, name);
  const view = trends(name, parseWindow(ctx.url.searchParams.get("window")));
  if (ctx.url.searchParams.get("format") === "csv") return reply.text(200, CSV, trendsToCsv(view));
  return reply.contract(200, TrendsViewSchema, view);
}

export function appReport(ctx: ApiContext): ApiResult {
  const { report } = ctx.deps;
  if (!report) throw new ApiError(501, "report is not available");
  const name = param(ctx, "name");
  loadApp(ctx.deps, name);
  const view = report(name, parseWindow(ctx.url.searchParams.get("window")));
  /* ?format=csv → a spreadsheet-friendly flat table (one row per insight); default stays the contract-validated JSON ReportView. */
  if (ctx.url.searchParams.get("format") === "csv") return reply.text(200, CSV, reportToCsv(view));
  return reply.contract(200, ReportViewSchema, view);
}

export function runReport(ctx: ApiContext): ApiResult {
  const { reportForRun } = ctx.deps;
  if (!reportForRun) throw new ApiError(501, "report is not available");
  const runId = param(ctx, "id");
  const report = reportForRun(runId, parseWindow(ctx.url.searchParams.get("window")));
  if (!report) throw new ApiError(404, `run not found: '${runId}'`);
  /*
   * CSV exports the run's OWN facts (the current-execution report); the evolution half belongs to a
   * chart, not a flat table, and the app-level /report?format=csv already exports the trend table.
   */
  if (ctx.url.searchParams.get("format") === "csv") return reply.text(200, CSV, reportToCsv(report.current));
  return reply.contract(200, RunReportViewSchema, report);
}

export function appTelemetry(ctx: ApiContext): ApiResult {
  const { telemetryAnalysis } = ctx.deps;
  if (!telemetryAnalysis) throw new ApiError(501, "telemetry analysis is not available");
  const name = param(ctx, "name");
  loadApp(ctx.deps, name);
  try {
    return reply.contract(200, AppTelemetryViewSchema, telemetryAnalysis(name, parseWindow(ctx.url.searchParams.get("window"))));
  } catch (err) {
    throw new ApiError(500, `telemetry query failed: ${redactionPort.redactError(err)}`);
  }
}

export function signals(ctx: ApiContext): ApiResult {
  const read = ctx.deps.signals;
  if (!read) throw new ApiError(501, "signals is not available");
  try {
    return reply.contract(200, SignalsViewSchema, read());
  } catch (err) {
    /* A ledger read failure (e.g. permission error) is a real fault, not an empty-fleet view — surface it loudly instead of hanging the request or fabricating zeros. */
    throw new ApiError(500, `signals query failed: ${redactionPort.redactError(err)}`);
  }
}

export function coordinationEvents(ctx: ApiContext): ApiResult {
  const read = ctx.deps.coordinationEvents;
  if (!read) throw new ApiError(501, "coordinationEvents is not available");
  const runId = ctx.url.searchParams.get("runId") ?? undefined;
  const limit = parseLimit(ctx.url.searchParams.get("limit"));
  try {
    return reply.contract(200, CoordinationEventsViewSchema, read({ runId, limit }));
  } catch (err) {
    throw new ApiError(500, `coordination-events query failed: ${redactionPort.redactError(err)}`);
  }
}
