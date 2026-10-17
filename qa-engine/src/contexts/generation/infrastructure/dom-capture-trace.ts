/*
 * A DOM capture as a context span: `qayaba.context.dom-capture`, a child of the phase that is open, with the ids of the elements the capture
 * found (a test id names its element; a node without one is named by its role and a hash of its accessible name).
 *
 * Read-only on what the capture returned. Observability never changes what the agent receives.
 */

import { recordContextSpan } from "../../../shared-infrastructure/telemetry/run-spans.ts";
import type { TelemetryPort } from "../../../shared-kernel/telemetry/telemetry.port.ts";
import { domItemIds, type DomPageLike } from "../domain/context-item-ids.ts";
import { MAX_NODES_PER_ROUTE, capDomLines, type DomCaptureObserver, type DomCaptureReport, type RouteSnapshot } from "./dom-snapshot.ts";

/* What the agent is shown of one route, as the ids' input: the nodes within the per-route bound, the test ids within it, and how many of each were left out. */
export function pageOf(snap: RouteSnapshot): { page: DomPageLike; leftOut: number } {
  const nodes = snap.nodes ?? [];
  const testIds = [...(snap.testIds?.keys() ?? [])];
  const testIdOfNode = new Map<string, string>();
  for (const attr of snap.attrs ?? []) if (attr.testId !== undefined) testIdOfNode.set(attr.key, attr.testId);
  return {
    page: { route: snap.route, nodes: capDomLines(nodes, MAX_NODES_PER_ROUTE).kept, testIdOfNode, testIds: testIds.slice(0, MAX_NODES_PER_ROUTE) },
    leftOut: Math.max(0, nodes.length - MAX_NODES_PER_ROUTE) + Math.max(0, testIds.length - MAX_NODES_PER_ROUTE),
  };
}

export function recordDomCapture(telemetry: TelemetryPort, report: DomCaptureReport): void {
  const captured = report.snaps.filter((snap) => snap.error === undefined);
  const pages = captured.map(pageOf);
  recordContextSpan(telemetry, {
    source: "dom-capture",
    ids: domItemIds(pages.map((p) => p.page)),
    bytes: report.outputChars,
    truncatedItems: pages.reduce((sum, p) => sum + p.leftOut, 0),
  });
}

/* The observer the shell hands to createCaptureDomDeps. */
export function domCaptureObserver(telemetry: TelemetryPort): DomCaptureObserver {
  return (report) => recordDomCapture(telemetry, report);
}
