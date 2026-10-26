/*
 * A DOM capture as a context span: `qayaba.context.dom-capture`, a child of the phase that is open, with the ids of the elements the capture
 * found (a test id names its element; a node without one is named by its role and a hash of its accessible name).
 *
 * Read-only on what the capture returned. Observability never changes what the agent receives.
 */

import { recordContextSpan } from "../../../shared-infrastructure/telemetry/run-spans.ts";
import type { Attrs } from "../../../shared-kernel/telemetry/attribute-registry.ts";
import type { TelemetryPort } from "../../../shared-kernel/telemetry/telemetry.port.ts";
import { domItemIdsBudgeted, type DomPageLike } from "../../../shared-kernel/context-item-ids.ts";
import { buildRouteCatalog, ROUTE_STATUS } from "./route-catalog.ts";
import { dataStateUnconfirmed, pageDeliveryOf, type DomCaptureObserver, type DomCaptureReport, type RouteSnapshot } from "./dom-snapshot.ts";

/* What the agent is shown of one route, as the ids' input: the nodes within the per-route bound, the test ids within it, and how many of each were left out. */
export function pageOf(snap: RouteSnapshot): { page: DomPageLike; leftOut: number } {
  const delivery = pageDeliveryOf(snap, snap.template);
  return {
    /* A page opened from a template of the map is named by the template, as the map's own route ids are. */
    page: { route: delivery.route, nodes: delivery.keptNodes, testIdOfNode: delivery.testIdOfNode, testIds: delivery.keptTestIds },
    leftOut: delivery.nodeCapOmitted,
  };
}

/* One route of a capture, as the attributes of its event: whether it was captured or degraded and why, whether the page settled, how much it showed and how long the script took. */
export function routeEventAttrs(snap: RouteSnapshot, idsOverflow = 0): Attrs {
  const catalog = buildRouteCatalog(snap);
  return {
    "qayaba.route.path": snap.route,
    ...(snap.template !== undefined ? { "qayaba.route.template": snap.template } : {}),
    "qayaba.route.status": catalog.status,
    ...(catalog.status === ROUTE_STATUS.DEGRADED && catalog.degradeReason !== undefined ? { "qayaba.route.degrade_reason": catalog.degradeReason } : {}),
    "qayaba.route.settled": snap.settled === true,
    "qayaba.route.nodes": snap.nodes?.length ?? 0,
    "qayaba.route.test_ids": snap.testIds?.size ?? 0,
    "qayaba.route.runtime_errors": snap.runtimeErrors?.length ?? 0,
    ...(snap.dataState !== undefined ? { "qayaba.route.data_state": snap.dataState } : {}),
    ...(snap.ready !== undefined ? { "qayaba.route.ready": snap.ready } : {}),
    ...(snap.resultExpected !== undefined ? { "qayaba.route.result_expected": snap.resultExpected } : {}),
    ...(snap.resultCount !== undefined ? { "qayaba.route.result_count": snap.resultCount } : {}),
    ...(snap.effectiveLocation !== undefined ? { "qayaba.route.effective_location": snap.effectiveLocation } : {}),
    ...(snap.captureAttempts !== undefined ? { "qayaba.route.capture_attempts": snap.captureAttempts } : {}),
    ...(snap.ms !== undefined ? { "qayaba.route.ms": snap.ms } : {}),
    ...(idsOverflow > 0 ? { "qayaba.route.ids_overflow": idsOverflow } : {}),
  };
}

export function recordDomCapture(telemetry: TelemetryPort, report: DomCaptureReport): void {
  const captured = report.snaps.filter((snap) => snap.error === undefined);
  const pages = captured.map(pageOf);
  const budgeted = domItemIdsBudgeted(pages.map((p) => p.page));
  const overflowOf = new Map<RouteSnapshot, number>(captured.map((snap, i) => [snap, budgeted.overflow[i] ?? 0]));
  /* Freshness now reflects capture-time data state: an unconfirmed state is stale, and a recapture only happened when a data state needed a second read. */
  const unconfirmed = captured.some(dataStateUnconfirmed);
  const attempts = captured.reduce((max, snap) => Math.max(max, snap.captureAttempts ?? 0), 0);
  const recapture = attempts > 1 ? (unconfirmed ? "failed" : "completed") : "not-needed";
  const anyResultExpected = captured.some((snap) => snap.resultExpected === true);
  const resultCount = anyResultExpected ? captured.reduce((sum, snap) => sum + (snap.resultCount ?? 0), 0) : report.snaps.length;
  const effectiveLocation = captured.map((snap) => snap.effectiveLocation).find((loc) => loc !== undefined && loc !== "");
  recordContextSpan(
    telemetry,
    {
      source: "dom-capture",
      ids: budgeted.ids,
      bytes: report.outputChars,
      truncatedItems: pages.reduce((sum, p) => sum + p.leftOut, 0),
      freshness: { location: "live:dev", capturedAt: new Date().toISOString(), resultCount, stale: unconfirmed, staleReason: unconfirmed ? "data-state-unconfirmed" : "none", recapture },
      ...(effectiveLocation !== undefined ? { attrs: { "qayaba.context.effective_location": effectiveLocation } } : {}),
    },
    (span) => {
      /* One event per route, in the order the script was asked for them, errored ones included. */
      for (const snap of report.snaps) span.addEvent("route", routeEventAttrs(snap, overflowOf.get(snap) ?? 0));
    },
  );
}

/* The observer the shell hands to createCaptureDomDeps. */
export function domCaptureObserver(telemetry: TelemetryPort): DomCaptureObserver {
  return (report) => recordDomCapture(telemetry, report);
}
