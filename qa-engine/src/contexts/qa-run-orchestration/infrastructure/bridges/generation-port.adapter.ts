/* GenerationPort → GenerateTestsUseCase. Static per-run context is constructor config; specDir/objectives/signal/diff vary per call. Per-call `diff` is the live commit diff and takes precedence over ctx.diff. specSources come from optional readSpecSource — absent collaborator omits them (Lever-2 finds nothing). stepLimit (and reviewerStepLimit, when the generation runs its reviewer) come from optional stepLimitFor — absent collaborator, or a role with no limit, omits the key. reexploreNavigations is omitted; FixLoop treats absent as 0. A regeneration turn carries the specs the run delivered so far (deliveredSpecs) and the ones a selector contradiction points at (attributedSpecFiles), minus every file the confined reader no longer finds; a first pass carries neither. AbortSignal is forwarded into openSession. */

import type { Objective } from "@kernel/objective.ts";
import type { GenerationPort, GenerationEnrichment, GenerationOutput, RetrievedRule } from "../../application/ports/index.ts";
import { GenerateTestsUseCase } from "@contexts/generation/application/generate-tests.use-case.ts";
import type { OpencodeRunInput, StepLimitFor, CommitIntent as GenerationCommitIntent } from "@contexts/generation/application/ports/generation-ports.ts";
import { isReGenTurn } from "@contexts/generation/domain/regen-turn.ts";
import type { RunMode, TestTarget } from "@kernel/run-mode.ts";
import { resolveConfinedSpecFile, type SpecRoot } from "../../../../shared-infrastructure/spec-path-confinement.ts";

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
  /* Optional: re-reads a just-generated spec file's source text. `reported` is the path as the agent reported it, relative to the root's spec directory: the collaborator must confine it (the composition root defaults to the confined reader), and it throws when the path is refused, as loudly as a missing file. Absent -> specSources omitted. */
  readSpecSource?: (root: SpecRoot, reported: string) => string;
  /* The step limit the runtime enforces for a role this run, asked for on every generation. Absent -> no input states a limit. */
  stepLimitFor?: StepLimitFor;
}

export class GenerationPortAdapter implements GenerationPort {
  constructor(
    private readonly useCase: GenerateTestsUseCase,
    private readonly ctx: GenerationPortStaticContext,
    private readonly collaborators: GenerationPortCollaborators = {},
  ) {}

  async generate(_objectives: readonly Objective[], specDir: string, signal?: AbortSignal, diff?: string, enrichment?: GenerationEnrichment): Promise<GenerationOutput> {
    const reviewerLearnedRules = enrichment?.learnedRules?.length ? renderLearnedRulesForReviewer(enrichment.learnedRules) : "";
    const stepLimit = await this.collaborators.stepLimitFor?.("generator");
    /* The in-generate reviewer's limit travels only with a generation that runs that reviewer's session. */
    const reviewerStepLimit = this.ctx.needsReview ? await this.collaborators.stepLimitFor?.("reviewer") : undefined;
    const root: SpecRoot = { mirrorDir: this.ctx.mirrorDir, specDir };
    /* On a regeneration turn only, what the run delivered and what a contradiction points at, minus the files that are no longer a regular file inside the spec directory (deleted, renamed away, a link out, a path that climbs): the agent can change the suite between passes, and a path it reported is never trusted. */
    const regenerating = enrichment !== undefined && isReGenTurn(enrichment) ? enrichment : undefined;
    const stillThere = (file: string): boolean => resolveConfinedSpecFile(root, file) !== undefined;
    const deliveredSpecs = regenerating?.deliveredSpecs?.filter((entry) => stillThere(entry.file)) ?? [];
    const attributedSpecFiles = regenerating?.attributedSpecFiles?.filter(stillThere) ?? [];
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
      /* The limit the runtime enforces for each session of this generation. Absent -> omitted, never a made-up number. */
      ...(stepLimit !== undefined ? { stepLimit } : {}),
      ...(reviewerStepLimit !== undefined ? { reviewerStepLimit } : {}),
      ...(enrichment?.reviewCorrections?.length ? { reviewCorrections: [...enrichment.reviewCorrections] } : {}),
      ...(enrichment?.fixCases?.length ? { fixCases: [...enrichment.fixCases] } : {}),
      ...(enrichment?.selectorContradictions?.length ? { selectorContradictions: [...enrichment.selectorContradictions] } : {}),
      /* Absent when there is none left, never []. */
      ...(deliveredSpecs.length ? { deliveredSpecs } : {}),
      ...(attributedSpecFiles.length ? { attributedSpecFiles } : {}),
      ...(enrichment?.domSnapshot ? { domSnapshot: enrichment.domSnapshot } : {}),
      ...(enrichment?.coverageGap ? { coverageGap: enrichment.coverageGap } : {}),
      ...(enrichment?.intent ? { intent: toGenerationIntent(enrichment.intent) } : {}),
      ...(enrichment?.learnedRules?.length ? { learnedRules: renderLearnedRules(enrichment.learnedRules) } : {}),
      ...(reviewerLearnedRules ? { reviewerLearnedRules } : {}),
      ...(enrichment?.contextPack ? { contextPack: enrichment.contextPack } : {}),
      ...(enrichment?.authSeedUnauthored ? { authSeedUnauthored: true } : {}),
      ...(enrichment?.existingSpecFiles?.length ? { existingSpecFiles: [...enrichment.existingSpecFiles] } : {}),
      ...(enrichment?.contextMap ? { contextMap: enrichment.contextMap } : {}),
      ...(enrichment?.contextBrief ? { contextBrief: enrichment.contextBrief } : {}),
      ...(enrichment?.harnessFacts ? { harnessFacts: enrichment.harnessFacts } : {}),
      /* Structural-blast-radius advisory, with the flag that says it names symbols. Absent → omitted; the flag never travels without its signal. */
      ...(enrichment?.staticSignal
        ? { staticSignal: enrichment.staticSignal, ...(enrichment.staticSignalHasSymbols ? { staticSignalHasSymbols: true } : {}) }
        : {}),
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

    const result: GenerationOutput = {
      specs: generated.specs,
      end: generated.end,
      reviewed: generated.reviewed,
      approved: generated.approved,
      ...(generated.note !== undefined ? { note: generated.note } : {}),
      ...(generated.parsed !== undefined ? { parsed: generated.parsed } : {}),
      ...(generated.turn ? { turn: generated.turn } : {}),
      ...(generated.specMetas?.length
        ? { specMetas: generated.specMetas.map((m) => ({ flow: m.flow, objective: m.objective })) }
        : {}),
      ...(generated.declaredSpecs?.length ? { declaredSpecs: generated.declaredSpecs.map((declared) => ({ ...declared })) } : {}),
    };

    if (this.collaborators.readSpecSource && generated.specs.length > 0) {
      result.specSources = generated.specs.map((spec) => this.collaborators.readSpecSource!(root, spec));
    }

    return result;
  }
}
