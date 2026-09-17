/* GenerationPort → GenerateTestsUseCase. Static per-run context is constructor config; specDir/objectives/signal/diff vary per call. Per-call `diff` is the live commit diff and takes precedence over ctx.diff. specSources come from optional readSpecSource — absent collaborator omits them (Lever-2 finds nothing). reexploreNavigations is omitted; FixLoop treats absent as 0. AbortSignal is forwarded into openSession. */

import type { Objective } from "@kernel/objective.ts";
import type { GenerationPort, GenerationEnrichment, RetrievedRule } from "../../application/ports/index.ts";
import { GenerateTestsUseCase } from "@contexts/generation/application/generate-tests.use-case.ts";
import type { OpencodeRunInput, CommitIntent as GenerationCommitIntent } from "@contexts/generation/application/ports/generation-ports.ts";
import type { RunMode, TestTarget } from "@kernel/run-mode.ts";

/* The barrel's CommitIntent (ports/index.ts) is kernel-resident/structural — `type` is a plain `string` there (this bridge, not the barrel, is where cross-context types are allowed). Generation's OWN CommitIntent narrows `type` to its CommitType union. The value ALWAYS originates from ChangeAnalysisPortAdapter's classifyCommit() call (commit-classification.ts's own CommitType union is structurally identical to generation's), so this is a same-shape re-assertion at the bridge boundary, never a fabricated narrowing. */
function toGenerationIntent(intent: GenerationEnrichment["intent"]): GenerationCommitIntent | undefined {
  return intent as GenerationCommitIntent | undefined;
}

export function renderLearnedRules(rules: readonly RetrievedRule[]): string {
  const active = rules.filter((r) => r.status === "active");
  const candidates = rules.filter((r) => r.status === "candidate");

  const lines: string[] = [];

  if (active.length > 0) {
    lines.push("## Proven rules from past QA runs");
    lines.push("These rules were earned from real failures and validated by measured outcomes. Apply them when they match the current change.");
    lines.push("");
    for (const r of active) {
      lines.push(`### Rule (${r.errorClass}, confidence=${r.confidence})`);
      lines.push(`- Trigger: ${r.trigger}`);
      lines.push(`- Action: ${r.action}`);
      lines.push("");
    }
  }

  if (candidates.length > 0) {
    lines.push("## Experimental rules (unproven — consider, not prescriptive)");
    lines.push("These are hypotheses from recent runs that have not yet been validated by enough measured outcomes. Consider them when clearly applicable, but do not let them override your judgment.");
    lines.push("");
    for (const r of candidates) {
      lines.push(`### Experimental rule (${r.errorClass})`);
      lines.push(`- Trigger: ${r.trigger}`);
      lines.push(`- Consider: ${r.action}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

export function renderLearnedRulesForReviewer(rules: readonly RetrievedRule[]): string {
  const proven = rules.filter((r) => r.status === "active");
  if (proven.length === 0) return "";

  const lines = [
    "## App-specific reject-on-sight rules (earned from past runs on this app)",
    "Each was learned from a real failure and proven by the value oracle or sustained prevention.",
    "Treat them as an extension of the anti-pattern catalog: if a spec violates one, REJECT.",
    "",
  ];
  for (const r of proven) {
    lines.push(`- ${r.trigger} → ${r.action} (${r.errorClass})`);
  }
  return lines.join("\n");
}

export interface GenerationPortStaticContext {
  repo: string;
  appName: string;
  mirrorDir: string;
  e2eRelDir: string;
  namespace: string;
  needsReview: boolean;
  target: TestTarget;
  mode: RunMode;
  diff: string;
  guidance?: string;
  /* Live DEV URL the agent must navigate to (Playwright MCP). Absent → the agent has no URL to ground selectors against and must not invent them. */
  baseUrl?: string;
  openapi?: string | string[];
  /* Triggering microservice for a cross-repo run — its repo, its own read-only mirror dir, and its own openapi hint (distinct from ctx.mirrorDir/ctx.openapi, which stay bound to the primary repo). App-static. Maps 1:1 onto OpencodeRunInput.service. Absent in the common same-repo case. */
  service?: { repo: string; mirrorDir: string; openapi?: string | string[] };
  /* Every declared service repo (read-only working copies) for context mode. Distinct from `service` (the single triggering service on a cross-repo run — mutually exclusive, since context mode cannot be service-triggered). App-static. Maps 1:1 onto OpencodeRunInput.services. */
  services?: Array<{ repo: string; mirrorDir: string; openapi?: string | string[] }>;
}

export interface GenerationPortCollaborators {
  /* Optional: re-reads a just-generated spec file's source text. Absent -> specSources omitted. */
  readSpecSource?: (absolutePath: string) => Promise<string>;
}

export interface GenerationPortResult {
  specs: string[];
  approved: boolean;
  note?: string;
  specSources?: string[];
  /* parsed: forwarded from GenerateTestsUseCase — FALSE means the agent runtime emitted no parseable verdict (empty/errored session), so the orchestrator can distinguish a genuine agent no-op from a runtime failure instead of silently skipping. See GenerationResult.parsed's own doc. */
  parsed?: boolean;
  specMetas?: { flow?: string; objective?: string }[];
}

export class GenerationPortAdapter implements GenerationPort {
  constructor(
    private readonly useCase: GenerateTestsUseCase,
    private readonly ctx: GenerationPortStaticContext,
    private readonly collaborators: GenerationPortCollaborators = {},
  ) {}

  async generate(_objectives: readonly Objective[], specDir: string, signal?: AbortSignal, diff?: string, enrichment?: GenerationEnrichment): Promise<GenerationPortResult> {
    const input: OpencodeRunInput = {
      repo: this.ctx.repo,
      /* Manifest changeRef.sha. From enrichment.sha when supplied; "" otherwise. */
      sha: enrichment?.sha ?? "",
      ...(enrichment?.runId ? { runId: enrichment.runId } : {}),
      diff: diff ?? this.ctx.diff,
      mirrorDir: this.ctx.mirrorDir,
      e2eRelDir: this.ctx.e2eRelDir,
      namespace: this.ctx.namespace,
      needsReview: this.ctx.needsReview,
      target: this.ctx.target,
      mode: this.ctx.mode,
      appName: this.ctx.appName,
      ...(this.ctx.guidance ? { guidance: this.ctx.guidance } : {}),
      ...(this.ctx.baseUrl ? { baseUrl: this.ctx.baseUrl } : {}),
      ...(this.ctx.openapi ? { openapi: this.ctx.openapi } : {}),
      ...(this.ctx.service ? { service: this.ctx.service } : {}),
      ...(this.ctx.services?.length ? { services: this.ctx.services } : {}),
      ...(enrichment?.reviewCorrections?.length ? { reviewCorrections: [...enrichment.reviewCorrections] } : {}),
      ...(enrichment?.fixCases?.length ? { fixCases: [...enrichment.fixCases] } : {}),
      ...(enrichment?.selectorContradictions?.length ? { selectorContradictions: [...enrichment.selectorContradictions] } : {}),
      ...(enrichment?.domSnapshot ? { domSnapshot: enrichment.domSnapshot } : {}),
      ...(enrichment?.coverageGap ? { coverageGap: enrichment.coverageGap } : {}),
      ...(enrichment?.intent ? { intent: toGenerationIntent(enrichment.intent) } : {}),
      ...(enrichment?.learnedRules?.length ? { learnedRules: renderLearnedRules(enrichment.learnedRules) } : {}),
      ...(enrichment?.contextPack ? { contextPack: enrichment.contextPack } : {}),
      ...(enrichment?.existingSpecFiles?.length ? { existingSpecFiles: [...enrichment.existingSpecFiles] } : {}),
      ...(enrichment?.contextMap ? { contextMap: enrichment.contextMap } : {}),
      ...(enrichment?.contextBrief ? { contextBrief: enrichment.contextBrief } : {}),
      /* Structural-blast-radius advisory. Absent → omitted. */
      ...(enrichment?.staticSignal ? { staticSignal: enrichment.staticSignal } : {}),
      /* Curriculum-ranked exemplars. Absent/empty → omitted, never []. */
      ...(enrichment?.skillExemplars?.length ? { skillExemplars: enrichment.skillExemplars.map((e) => ({ ...e })) } : {}),
      /* Service links / contract drift. Absent/empty → omitted, never []. */
      ...(enrichment?.serviceLinks?.length ? { serviceLinks: [...enrichment.serviceLinks] } : {}),
      ...(enrichment?.contractDrift?.length ? { contractDrift: [...enrichment.contractDrift] } : {}),
      ...(enrichment?.crossRepoImpact?.impactedLinks.length
        ? { crossRepoImpact: { impactedLinks: enrichment.crossRepoImpact.impactedLinks.map((x) => ({ ...x })) } }
        : {}),
      ...(enrichment?.classificationReason ? { classificationReason: enrichment.classificationReason } : {}),
      ...(enrichment?.contradiction ? { contradiction: true } : {}),
    };

    const generated = await this.useCase.generate(input, { ...(signal ? { signal } : {}) });

    const result: GenerationPortResult = {
      specs: generated.specs,
      approved: generated.approved,
      ...(generated.note !== undefined ? { note: generated.note } : {}),
      ...(generated.parsed !== undefined ? { parsed: generated.parsed } : {}),
      ...(generated.specMetas?.length
        ? { specMetas: generated.specMetas.map((m) => ({ flow: m.flow, objective: m.objective })) }
        : {}),
    };

    if (this.collaborators.readSpecSource && generated.specs.length > 0) {
      const sources = await Promise.all(
        generated.specs.map((spec) => this.collaborators.readSpecSource!(`${specDir}/${spec}`)),
      );
      result.specSources = sources;
    }

    return result;
  }
}
