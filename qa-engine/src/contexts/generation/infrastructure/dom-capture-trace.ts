/*
 * A DOM capture as a context span: `qayaba.context.dom-capture`, a child of the phase that is open, with the ids of the elements the capture
 * found (a test id names its element; a node without one is named by its role and a hash of its accessible name).
 *
 * Read-only on what the capture returned. Observability never changes what the agent receives.
 */

import { recordContextSpan } from "../../../shared-infrastructure/telemetry/run-spans.ts";
import type { Attrs } from "../../../shared-kernel/telemetry/attribute-registry.ts";
import type { TelemetryPort } from "../../../shared-kernel/telemetry/telemetry.port.ts";
import { domItemIdsBudgeted, type DomPageLike } from "../domain/context-item-ids.ts";
import { buildRouteCatalog, ROUTE_STATUS } from "./route-catalog.ts";
import { MAX_NODES_PER_ROUTE, capDomLines, type DomCaptureObserver, type DomCaptureReport, type RouteSnapshot } from "./dom-snapshot.ts";

/* What the agent is shown of one route, as the ids' input: the nodes within the per-route bound, the test ids within it, and how many of each were left out. */
export function pageOf(snap: RouteSnapshot): { page: DomPageLike; leftOut: number } {
  const nodes = snap.nodes ?? [];
  const testIds = [...(snap.testIds?.keys() ?? [])];
  const testIdOfNode = new Map<string, string>();
  for (const attr of snap.attrs ?? []) if (attr.testId !== undefined) testIdOfNode.set(attr.key, attr.testId);
  return {
    /* A page opened from a template of the map is named by the template, as the map's own route ids are. */
    page: { route: snap.template ?? snap.route, nodes: capDomLines(nodes, MAX_NODES_PER_ROUTE).kept, testIdOfNode, testIds: testIds.slice(0, MAX_NODES_PER_ROUTE) },
    leftOut: Math.max(0, nodes.length - MAX_NODES_PER_ROUTE) + Math.max(0, testIds.length - MAX_NODES_PER_ROUTE),
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
    ...(snap.ms !== undefined ? { "qayaba.route.ms": snap.ms } : {}),
    ...(idsOverflow > 0 ? { "qayaba.route.ids_overflow": idsOverflow } : {}),
  };
}

export function recordDomCapture(telemetry: TelemetryPort, report: DomCaptureReport): void {
  const captured = report.snaps.filter((snap) => snap.error === undefined);
  const pages = captured.map(pageOf);
  const budgeted = domItemIdsBudgeted(pages.map((p) => p.page));
  recordContextSpan(
    telemetry,
    {
      source: "dom-capture",
      ids: budgeted.ids,
      bytes: report.outputChars,
      truncatedItems: pages.reduce((sum, p) => sum + p.leftOut, 0),
    },
    (span) => {
      /* One event per route, in the order the script was asked for them, errored ones included. */
      for (const snap of report.snaps) span.addEvent("route", routeEventAttrs(snap, budgeted.overflowByRoute.get(snap.template ?? snap.route) ?? 0));
    },
  );
}

/* The observer the shell hands to createCaptureDomDeps. */
export function domCaptureObserver(telemetry: TelemetryPort): DomCaptureObserver {
  return (report) => recordDomCapture(telemetry, report);
}
