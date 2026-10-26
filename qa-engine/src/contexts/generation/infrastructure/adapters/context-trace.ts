/*
 * The grounding sources as context spans (docs/observability-design.md §4.4): each source that supplies the agent something says what it
 * supplied, as stable item ids, in a `qayaba.context.<source>` span under the phase that is open. They are decorators over the ports that
 * produce the items, and a trace for the grounding adapter, which alone sees the context map and the pack as they are made.
 *
 * Read-only: what a port returns is returned as it was, and what it throws is thrown. Observability never changes what the agent receives or how a run ends.
 */

import type { CrossRepoImpact, ServiceLink } from "@kernel/service-links.ts";
import type { RetrievedRule, SelectedExemplar } from "@kernel/learned-rule.ts";
import { recordContextSpan } from "../../../../shared-infrastructure/telemetry/run-spans.ts";
import { advisoryLineIds, contextMapItemIds, itemId } from "@kernel/context-item-ids.ts";
import { packProducedItemIds } from "@contexts/generation/infrastructure/context-pack.ts";
import type { TelemetryPort } from "@kernel/telemetry/telemetry.port.ts";
import type { ContextProvenance } from "@kernel/telemetry/context-provenance.ts";
import type { CrossRepoImpactPort, ServiceLinksPort } from "@contexts/service-topology/application/index.ts";
import type { CurriculumFoldInput, CurriculumPort, LearningPort, RelevanceBias } from "@contexts/cross-run-learning/application/index.ts";
import type { StructuralSignalPort, StructuralSignalResult } from "@kernel/ports/structural-signal.port.ts";
import type { GroundingTrace } from "./pre-generation-grounding-port.adapter.ts";

const bytesOf = (text: string): number => Buffer.byteLength(text, "utf8");
const jsonBytes = (value: unknown): number => {
  try {
    return bytesOf(JSON.stringify(value) ?? "");
  } catch {
    return 0;
  }
};

/* Building a record is part of tracing: a fault in it (an item of an unexpected shape) is logged and the port's result goes on. */
function safely(record: () => void): void {
  try {
    record();
  } catch (err) {
    console.error(`[telemetry] a context span could not be built (the run goes on): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* A source's provenance for the span. The caller may override any field; a source with no known capture time still says where it came from. */
function provenanceOf(location: string, resultCount: number, extra: ContextProvenance = {}): ContextProvenance {
  return {
    location,
    capturedAt: new Date().toISOString(),
    resultCount,
    stale: false,
    staleReason: "none",
    recapture: "not-needed",
    ...extra,
  };
}

/* The context map and the context pack, as they are made by the grounding adapter. */
export function telemetryGroundingTrace(telemetry: TelemetryPort, mapProvenance?: () => ContextProvenance | undefined): GroundingTrace {
  return {
    contextMap: (map, provenance) => safely(() => recordContextSpan(telemetry, {
      source: "context-map",
      ids: contextMapItemIds(map),
      bytes: jsonBytes(map),
      freshness: provenance ?? mapProvenance?.(),
    })),
    contextMapLeftOut: (provenance) => safely(() => recordContextSpan(telemetry, {
      source: "context-map",
      ids: [],
      bytes: 0,
      freshness: provenance,
    })),
    pack: (assembly) => safely(() => {
      const trace = assembly.trace;
      if (trace && trace.capturablePages > 0) {
        const ids = trace.rankedRoutes.map(itemId.route);
        recordContextSpan(telemetry, {
          source: "route-ranking",
          ids,
          bytes: trace.rankedRoutes.reduce((sum, route) => sum + bytesOf(route), 0),
          truncatedItems: Math.max(0, trace.capturablePages - trace.rankedRoutes.length),
          freshness: mapProvenance?.(),
          ...(trace.relevantRoutes !== undefined && trace.relevantRoutes.length > 0
            ? { attrs: { "qayaba.context.relevant_ids": trace.relevantRoutes.map(itemId.route), "qayaba.context.relevant_groups": trace.relevantGroups ?? [], ...(trace.relevantBasis?.length ? { "qayaba.context.relevant_basis": trace.relevantBasis } : {}) } }
            : {}),
        });
      }
      recordContextSpan(telemetry, {
        source: "context-pack",
        ids: trace ? packProducedItemIds(assembly).ids : [],
        bytes: assembly.text === undefined ? 0 : bytesOf(assembly.text),
        truncatedItems: trace?.omittedLines ?? 0,
        freshness: provenanceOf("live:dev", trace?.pages.length ?? 0),
      });
    }),
  };
}

export class TracedLearningPort implements LearningPort {
  constructor(
    private readonly inner: LearningPort,
    private readonly telemetry: TelemetryPort,
  ) {}

  fold(outcome: Parameters<LearningPort["fold"]>[0]): Promise<void> {
    return this.inner.fold(outcome);
  }

  async retrieve(sha: Parameters<LearningPort["retrieve"]>[0], relevance?: RelevanceBias): Promise<RetrievedRule[]> {
    const rules = await this.inner.retrieve(sha, relevance);
    safely(() => recordContextSpan(this.telemetry, { source: "learning", ids: rules.map((rule) => itemId.rule(rule.id)), bytes: rules.reduce((sum, rule) => sum + bytesOf(rule.trigger) + bytesOf(rule.action), 0), freshness: provenanceOf("db:learning_rules", rules.length) }));
    return rules;
  }
}

export class TracedCurriculumPort implements CurriculumPort {
  constructor(
    private readonly inner: CurriculumPort,
    private readonly telemetry: TelemetryPort,
  ) {}

  fold(input: CurriculumFoldInput): Promise<void> {
    return this.inner.fold(input);
  }

  async select(diff: string | undefined, changedFiles: readonly string[]): Promise<readonly SelectedExemplar[]> {
    const exemplars = await this.inner.select(diff, changedFiles);
    safely(() => recordContextSpan(this.telemetry, { source: "curriculum", ids: exemplars.map((e) => itemId.exemplar(e.id)), bytes: exemplars.reduce((sum, e) => sum + bytesOf(e.template), 0), freshness: provenanceOf("db:curriculum", exemplars.length) }));
    return exemplars;
  }
}

export class TracedServiceLinksPort implements ServiceLinksPort {
  constructor(
    private readonly inner: ServiceLinksPort,
    private readonly telemetry: TelemetryPort,
  ) {}

  async resolve(): ReturnType<ServiceLinksPort["resolve"]> {
    const resolved = await this.inner.resolve();
    safely(() => recordContextSpan(this.telemetry, { source: "service-links", ids: resolved.links.map((link: ServiceLink) => itemId.svcLink(link)), bytes: jsonBytes(resolved.links), freshness: provenanceOf("mirror:stitcher", resolved.links.length + resolved.drift.length) }));
    return resolved;
  }
}

export class TracedStructuralSignalPort implements StructuralSignalPort {
  constructor(
    private readonly inner: StructuralSignalPort,
    private readonly telemetry: TelemetryPort,
  ) {}

  async render(repoDir: string, changed: Parameters<StructuralSignalPort["render"]>[1]): Promise<StructuralSignalResult> {
    const signal = await this.inner.render(repoDir, changed);
    const ids = advisoryLineIds(signal.text);
    /* The block is stale when the index it read is not at the change's commit; a graph that gave no answer names no commit. */
    const indexed = signal.indexedSha;
    const stale = indexed !== undefined && indexed !== changed.sha.value;
    safely(() => recordContextSpan(this.telemetry, { source: "structural-signal", ids, bytes: bytesOf(signal.text), freshness: provenanceOf("graph:codegraph", ids.length, indexed !== undefined ? { capturedSha: indexed, stale, staleReason: stale ? "index-sha-mismatch" : "none" } : {}) }));
    return signal;
  }
}

export class TracedCrossRepoImpactPort implements CrossRepoImpactPort {
  constructor(
    private readonly inner: CrossRepoImpactPort,
    private readonly telemetry: TelemetryPort,
  ) {}

  async resolve(triggerRepo: string, triggerSha: string, resolvedLinks: readonly ServiceLink[], baseRef?: string): Promise<CrossRepoImpact | null> {
    const impact = await this.inner.resolve(triggerRepo, triggerSha, resolvedLinks, baseRef);
    const links = impact?.impactedLinks ?? [];
    safely(() => recordContextSpan(this.telemetry, { source: "cross-repo-impact", ids: links.map((l) => itemId.impact(l.tier, l.link)), bytes: jsonBytes(links), freshness: provenanceOf("mirror:stitcher", links.length) }));
    return impact;
  }
}
