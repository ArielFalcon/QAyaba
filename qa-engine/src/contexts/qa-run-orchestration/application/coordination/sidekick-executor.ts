/* Sidekick executor: owns an AgentRuntimePort session for one DelegationBrief. Does not modify GenerateTestsUseCase. Model names stay out of this module — callers pass OpenSessionOpts.model for escalated capacity from external config. Free-form DelegationResult fields are scrubbed on parse — they re-enter lead context / notes. */
import type { AgentRole } from "@kernel/agent-role.ts";
import type { AgentRuntimePort } from "@kernel/ports/agent-runtime.port.ts";
import { sanitizeText } from "@contexts/generation/infrastructure/sanitize-text.ts";
import type { AgentCapability } from "./agent-capability.ts";
import type { DelegationBrief } from "./delegation-brief.ts";
import {
  belongsToBrief,
  DELEGATION_RECOMMENDATIONS,
  DELEGATION_STATUSES,
  type DelegationRecommendation,
  type DelegationResult,
  type DelegationStatus,
} from "./delegation-result.ts";
import type { EvidenceRef } from "./evidence-ref.ts";
import { renderSidekickBrief } from "./sidekick-prompt.ts";
import { applyPushback } from "./pushback.ts";
import { isPathWithinWritableRoots } from "./path-scope.ts";

function scrub(text: string): string {
  return sanitizeText(text).text;
}

function scrubStrings(values: readonly string[]): string[] {
  return values.map(scrub);
}

export function resolveCapabilityRole(capability: AgentCapability): AgentRole {
  if (capability === "lead") return "primary";
  /* Dedicated sidekick role: qa-sidekick.md matches the DelegationResult JSON contract and multi-file scope. Reusing "worker" would ship qa-worker.md's "write exactly ONE spec" instructions against a brief that may repair several failing specs. */
  return "sidekick";
}

export interface SidekickRender {
  (brief: DelegationBrief): { text: string; sectionSizes: Record<string, number> };
}

export interface SidekickExecutorDeps {
  runtime: Pick<AgentRuntimePort, "openSession">;
  render?: SidekickRender;
}

export interface SidekickExecuteOpts {
  cwd: string;
  capability: AgentCapability;
  model?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  feedback?: string;
}

/* Brace-balanced first-object scan (string/escape aware). lastIndexOf("{") false-fails on valid DelegationResults with nested objects followed by a trailing fence. */
function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === "string");
}

function parseDelegationResult(raw: unknown, brief: DelegationBrief): DelegationResult | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const status = o.status;
  const recommendation = o.recommendation;
  if (typeof o.delegationId !== "string" || typeof o.runId !== "string") return undefined;
  if (typeof status !== "string" || !(DELEGATION_STATUSES as readonly string[]).includes(status)) return undefined;
  if (
    typeof recommendation !== "string" ||
    !(DELEGATION_RECOMMENDATIONS as readonly string[]).includes(recommendation)
  ) {
    return undefined;
  }
  const filesChanged = Array.isArray(o.filesChanged)
    ? o.filesChanged
        .filter((f): f is { path: string } => !!f && typeof f === "object" && typeof (f as { path?: unknown }).path === "string")
        .map((f) => ({ path: f.path }))
    : [];
  const validation = Array.isArray(o.validation)
    ? o.validation
        .filter((v): v is { id: string; ok: boolean } => !!v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" && typeof (v as { ok?: unknown }).ok === "boolean")
        .map((v) => ({ id: v.id, ok: v.ok }))
    : [];
  const evidence: EvidenceRef[] = Array.isArray(o.evidence)
    ? o.evidence
        .filter((e): e is EvidenceRef => !!e && typeof e === "object" && typeof (e as EvidenceRef).id === "string")
        .map((e) => ({ ...e, summary: typeof e.summary === "string" ? scrub(e.summary) : e.summary }))
    : [];
  return {
    delegationId: o.delegationId,
    runId: o.runId,
    status: status as DelegationStatus,
    summary: typeof o.summary === "string" ? scrub(o.summary) : "",
    filesChanged,
    evidence,
    validation,
    assumptions: scrubStrings(asStringArray(o.assumptions)),
    concerns: scrubStrings(asStringArray(o.concerns)),
    unresolvedQuestions: scrubStrings(asStringArray(o.unresolvedQuestions)),
    recommendation: recommendation as DelegationRecommendation,
  };
}

function failedResult(brief: DelegationBrief, summary: string): DelegationResult {
  const safe = scrub(summary);
  return {
    delegationId: brief.delegationId,
    runId: brief.runId,
    status: "failed",
    summary: safe,
    filesChanged: [],
    evidence: [
      {
        id: "sidekick-parse",
        kind: "agent-observation",
        source: "SidekickExecutor",
        summary: safe,
        confidence: "inferred",
      },
    ],
    validation: [],
    assumptions: [],
    concerns: [safe],
    unresolvedQuestions: [],
    recommendation: "escalate",
  };
}

export class SidekickExecutor {
  private readonly render: SidekickRender;

  constructor(private readonly deps: SidekickExecutorDeps) {
    this.render = deps.render ?? renderSidekickBrief;
  }

  async execute(brief: DelegationBrief, opts: SidekickExecuteOpts): Promise<DelegationResult> {
    const role = resolveCapabilityRole(opts.capability);
    const session = await this.deps.runtime.openSession(role, opts.cwd, {
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      model: opts.model,
      descriptor: { runId: brief.runId, role, objective: scrub(brief.objective) },
    });
    try {
      const assembled = this.render(brief);
      const first = await session.prompt(assembled.text, { sectionSizes: assembled.sectionSizes });
      let output = first.output;
      if (opts.feedback) {
        const second = await session.prompt(
          [
            `## Feedback from lead`,
            scrub(opts.feedback),
            ``,
            `Respond with the SAME JSON output contract for delegationId=${brief.delegationId} runId=${brief.runId}.`,
          ].join("\n"),
          { isRepair: true },
        );
        output = second.output;
      }
      const parsed = parseDelegationResult(extractJsonObject(output), brief);
      if (!parsed) return failedResult(brief, "sidekick output was not a valid DelegationResult");
      if (!belongsToBrief(parsed, brief.delegationId, brief.runId)) {
        return failedResult(brief, "sidekick result did not belong to this brief");
      }
      const illegal = parsed.filesChanged.filter((f) => !isPathWithinWritableRoots(f.path, brief.scope.writablePaths));
      if (illegal.length > 0) {
        return {
          ...parsed,
          status: "blocked",
          summary: `write outside writablePaths: ${illegal.map((f) => f.path).join(", ")}`,
          recommendation: "escalate",
          concerns: [...parsed.concerns, `paths outside scope: ${illegal.map((f) => f.path).join(", ")}`],
        };
      }
      return applyPushback(brief, parsed);
    } finally {
      await session.dispose();
    }
  }
}
