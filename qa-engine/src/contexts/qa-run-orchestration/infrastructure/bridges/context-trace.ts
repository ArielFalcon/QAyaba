/*
 * The grounding sources as context spans (docs/observability-design.md §4.4): each source that supplies the agent something says what it
 * supplied, as stable item ids, in a `qayaba.context.<source>` span under the phase that is open. They are decorators over the ports that
 * produce the items, and a trace for the grounding adapter, which alone sees the context map, the brief and the pack as they are made.
 *
 * Read-only: what a port returns is returned as it was, and what it throws is thrown. Observability never changes what the agent receives or how a run ends.
 */

import { recordContextSpan } from "../../../../shared-infrastructure/telemetry/run-spans.ts";
import { advisoryLineIds, briefItemIds, changedValueFactIds, contextMapItemIds, itemId } from "@contexts/generation/domain/context-item-ids.ts";
import type { TelemetryPort } from "@kernel/telemetry/telemetry.port.ts";
import type {
  CrossRepoImpact,
  CrossRepoImpactPort,
  CurriculumFoldInput,
  CurriculumPort,
  LearningPort,
  RelevanceBias,
  RetrievedRule,
  SelectedExemplar,
  ServiceLink,
  ServiceLinksPort,
  StructuralSignalPort,
  StructuralSignalResult,
} from "../../application/ports/index.ts";
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

/* The context map, the explorer's brief and the context pack, as they are made by the grounding adapter. */
export function telemetryGroundingTrace(telemetry: TelemetryPort): GroundingTrace {
  return {
    contextMap: (map) => safely(() => recordContextSpan(telemetry, { source: "context-map", ids: contextMapItemIds(map), bytes: jsonBytes(map) })),
    brief: (brief) => safely(() => recordContextSpan(telemetry, { source: "explorer-brief", ids: briefItemIds(brief), bytes: jsonBytes(brief) })),
    pack: (assembly) => safely(() => {
      const trace = assembly.trace;
      if (trace && trace.capturablePages > 0) {
        recordContextSpan(telemetry, {
          source: "route-ranking",
          ids: trace.rankedRoutes.map(itemId.route),
          bytes: trace.rankedRoutes.reduce((sum, route) => sum + bytesOf(route), 0),
          truncatedItems: Math.max(0, trace.capturablePages - trace.rankedRoutes.length),
        });
      }
      recordContextSpan(telemetry, {
        source: "context-pack",
        ids: trace ? [...changedValueFactIds(trace.pages, trace.changedTestIds), ...trace.contractIds.map(itemId.op)] : [],
        bytes: assembly.text === undefined ? 0 : bytesOf(assembly.text),
        truncatedItems: trace?.omittedLines ?? 0,
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
    safely(() => recordContextSpan(this.telemetry, { source: "learning", ids: rules.map((rule) => itemId.rule(rule.id)), bytes: rules.reduce((sum, rule) => sum + bytesOf(rule.trigger) + bytesOf(rule.action), 0) }));
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
    safely(() => recordContextSpan(this.telemetry, { source: "curriculum", ids: exemplars.map((e) => itemId.exemplar(e.id)), bytes: exemplars.reduce((sum, e) => sum + bytesOf(e.template), 0) }));
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
    safely(() => recordContextSpan(this.telemetry, { source: "service-links", ids: resolved.links.map((link: ServiceLink) => itemId.svcLink(link)), bytes: jsonBytes(resolved.links) }));
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
    safely(() => recordContextSpan(this.telemetry, { source: "structural-signal", ids: advisoryLineIds(signal.text), bytes: bytesOf(signal.text) }));
    return signal;
  }
}

export class TracedCrossRepoImpactPort implements CrossRepoImpactPort {
  constructor(
    private readonly inner: CrossRepoImpactPort,
    private readonly telemetry: TelemetryPort,
  ) {}

  async resolve(triggerRepo: string, triggerSha: string, resolvedLinks: readonly ServiceLink[]): Promise<CrossRepoImpact | null> {
    const impact = await this.inner.resolve(triggerRepo, triggerSha, resolvedLinks);
    const links = impact?.impactedLinks ?? [];
    safely(() => recordContextSpan(this.telemetry, { source: "cross-repo-impact", ids: links.map((l) => itemId.impact(l.tier, l.link)), bytes: jsonBytes(links) }));
    return impact;
  }
}
