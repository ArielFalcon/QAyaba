/* GenerationPort → GenerateTestsUseCase. Static per-run context is constructor config; specDir/objectives/signal/diff vary per call. Per-call `diff` is the live commit diff and takes precedence over ctx.diff. specSources come from optional readSpecSource — absent collaborator omits them (Lever-2 finds nothing). stepLimit comes from optional stepLimitFor — absent collaborator, or a role with no limit, omits the key. reexploreNavigations is omitted; FixLoop treats absent as 0. A regeneration turn carries the specs the run delivered so far (deliveredSpecs), the ones a selector contradiction points at (attributedSpecFiles) and the suite's own entries (existingSpecFiles), minus every file the confined reader no longer finds; a first pass carries no delivered or attributed spec, and the suite's entries exactly as the grounding folded them. AbortSignal is forwarded into openSession. */

import type { GenerationPort } from "../../application/ports/generation.port.ts";
import type { GenerationEnrichment } from "../../domain/generation-enrichment.ts";
import type { GenerationOutput } from "../../domain/generation.ts";
import { renderLearnedRules } from "@contexts/cross-run-learning/application/index.ts";
import type { PlanOutput } from "@kernel/plan-output.ts";
import { GenerateTestsUseCase } from "@contexts/generation/application/index.ts";
import type { OpencodeRunInput, StepLimitFor, CommitIntent as GenerationCommitIntent } from "@contexts/generation/application/index.ts";
import { isReGenTurn } from "@contexts/generation/application/index.ts";
import { suiteEntryFile } from "@contexts/generation/application/index.ts";
import { GENERATION_END } from "@kernel/generation-end.ts";
import type { RunMode, TestTarget } from "@kernel/run-mode.ts";
import { resolveConfinedSpecFile, type SpecRoot } from "../../../../shared-infrastructure/spec-path-confinement.ts";

/* The kernel's CommitIntent (shared-kernel/commit-intent.ts) is kernel-resident/structural — `type` is a plain `string` there (this adapter, not the port, is where cross-context types are allowed). Generation's OWN CommitIntent narrows `type` to its CommitType union. The value ALWAYS originates from ChangeAnalysisPortAdapter's classifyCommit() call (commit-classification.ts's own CommitType union is structurally identical to generation's), so this is a same-shape re-assertion at the adapter boundary, never a fabricated narrowing. */
function toGenerationIntent(intent: GenerationEnrichment["intent"]): GenerationCommitIntent | undefined {
  return intent as GenerationCommitIntent | undefined;
}

export interface GenerationPortStaticContext {
  repo: string;
  appName: string;
  mirrorDir: string;
  e2eRelDir: string;
  namespace: string;
  target: TestTarget;
  mode: RunMode;
  diff: string;
  /* The run has an independent review (its app asks for one and its product is tests): only then does a generation publish the manifest's flow and objective, for the review's "tested" section. Absent: false. */
  reviewRequired?: boolean;
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
  /** The run's deadline, handed to every first pass so it is never given more time than the run has left. Absent: nothing bounds the run. */
  deadline?: { allowance?(purpose: "first-pass"): number | null };
}

export class GenerationPortAdapter implements GenerationPort {
  constructor(
    private readonly useCase: GenerateTestsUseCase,
    private readonly ctx: GenerationPortStaticContext,
    private readonly collaborators: GenerationPortCollaborators = {},
  ) {}

  async plan(specDir: string, signal: AbortSignal | undefined, diff: string | undefined, enrichment: GenerationEnrichment): Promise<PlanOutput> {
    if (!enrichment.planning) throw new Error("GenerationPortAdapter.plan needs enrichment.planning: the limits the plan will be held to");
    const input = await this.buildInput(specDir, diff, enrichment);
    const planned = await this.useCase.plan(input, { ...(signal ? { signal } : {}) });
    return {
      ...(planned.plan ? { plan: planned.plan } : {}),
      ...(planned.noopReason ? { noopReason: planned.noopReason } : {}),
      parsed: planned.parsed,
      timedOut: planned.timedOut,
      ...(planned.turn ? { turn: planned.turn } : {}),
      ...(planned.lead ? { lead: planned.lead } : {}),
    };
  }

  async release(): Promise<void> {
    await this.useCase.releaseSession();
  }

  async generate(specDir: string, signal?: AbortSignal, diff?: string, enrichment?: GenerationEnrichment): Promise<GenerationOutput> {
    const input = await this.buildInput(specDir, diff, enrichment);
    const root: SpecRoot = { mirrorDir: this.ctx.mirrorDir, specDir };

    const { deadline } = this.collaborators;
    const generated = await this.useCase.generate(input, { ...(signal ? { signal } : {}), ...(deadline ? { deadline } : {}) });

    const result: GenerationOutput = {
      specs: generated.specs,
      end: generated.end,
      ...(generated.noopKind ? { noopKind: generated.noopKind } : {}),
      /* mutation-scope:begin note-and-parsed-passthrough */
      ...(generated.note !== undefined ? { note: generated.note } : {}),
      /* mutation-scope:end note-and-parsed-passthrough */
      ...(generated.parsed !== undefined ? { parsed: generated.parsed } : {}),
      ...(generated.turn ? { turn: generated.turn } : {}),
      ...(this.publishesSpecMetas(generated.end) && generated.specMetas?.length
        ? { specMetas: generated.specMetas.map((m) => ({ flow: m.flow, objective: m.objective })) }
        : {}),
      ...(generated.declaredSpecs?.length ? { declaredSpecs: generated.declaredSpecs.map((declared) => ({ ...declared })) } : {}),
      ...(generated.testCorrect ? { testCorrect: generated.testCorrect } : {}),
      ...(generated.rebuttals?.length ? { rebuttals: generated.rebuttals.map((rebuttal) => ({ ...rebuttal })) } : {}),
    };

    if (this.collaborators.readSpecSource && generated.specs.length > 0) {
      result.specSources = generated.specs.map((spec) => this.collaborators.readSpecSource!(root, spec));
    }

    return result;
  /* mutation-scope:begin generate-return-tail */
  }

  /* A generation that ends on its time budget or a declared no-op publishes nothing of its manifest, as does a run with no review. */
  private publishesSpecMetas(end: GenerationOutput["end"]): boolean {
    return this.ctx.reviewRequired === true && this.ctx.mode !== "context" && end !== GENERATION_END.TIME_BUDGET && end !== GENERATION_END.DECLARED_NOOP;
  }

  /* The run input of one turn, from the run's static context and the enrichment the caller hands. */
  private async buildInput(specDir: string, diff: string | undefined, enrichment: GenerationEnrichment | undefined): Promise<OpencodeRunInput> {
    const stepLimit = await this.collaborators.stepLimitFor?.("generator");
  /* mutation-scope:end generate-return-tail */
    const root: SpecRoot = { mirrorDir: this.ctx.mirrorDir, specDir };
    /* On a regeneration turn only, what the run delivered, what a contradiction points at and the suite's own entries, minus the files that are no longer a regular file inside the spec directory (deleted, renamed away, a link out, a path that climbs): the agent can change the suite between passes, and a path it reported is never trusted. A first pass hands the suite's entries on as the grounding folded them. */
    const regenerating = enrichment !== undefined && isReGenTurn(enrichment) ? enrichment : undefined;
    const stillThere = (file: string): boolean => resolveConfinedSpecFile(root, file) !== undefined;
    const deliveredSpecs = regenerating?.deliveredSpecs?.filter((entry) => stillThere(entry.file)) ?? [];
    const attributedSpecFiles = regenerating?.attributedSpecFiles?.filter(stillThere) ?? [];
    const existingSpecFiles = (regenerating ? regenerating.existingSpecFiles?.filter((line) => stillThere(suiteEntryFile(line))) : enrichment?.existingSpecFiles) ?? [];
    const input: OpencodeRunInput = {
      repo: this.ctx.repo,
      /* Manifest changeRef.sha. From enrichment.sha when supplied; "" otherwise. */
      sha: enrichment?.sha ?? "",
      ...(enrichment?.runId ? { runId: enrichment.runId } : {}),
      diff: diff ?? this.ctx.diff,
      mirrorDir: this.ctx.mirrorDir,
      e2eRelDir: this.ctx.e2eRelDir,
      namespace: this.ctx.namespace,
      target: this.ctx.target,
      mode: this.ctx.mode,
      appName: this.ctx.appName,
      ...(this.ctx.guidance ? { guidance: this.ctx.guidance } : {}),
      ...(this.ctx.baseUrl ? { baseUrl: this.ctx.baseUrl } : {}),
      ...(this.ctx.openapi ? { openapi: this.ctx.openapi } : {}),
      ...(this.ctx.service ? { service: this.ctx.service } : {}),
      /* mutation-scope:begin services-and-step-limit */
      ...(this.ctx.services?.length ? { services: this.ctx.services } : {}),
      /* The limit the runtime enforces for each session of this generation. Absent -> omitted, never a made-up number. */
      /* mutation-scope:end services-and-step-limit */
      ...(stepLimit !== undefined ? { stepLimit } : {}),
      ...(enrichment?.reviewCorrections?.length ? { reviewCorrections: [...enrichment.reviewCorrections] } : {}),
      ...(enrichment?.fixCases?.length ? { fixCases: [...enrichment.fixCases] } : {}),
      ...(enrichment?.selectorContradictions?.length ? { selectorContradictions: [...enrichment.selectorContradictions] } : {}),
      /* Absent when there is none left, never []. */
      ...(deliveredSpecs.length ? { deliveredSpecs } : {}),
      /* mutation-scope:begin attribution-and-dom-snapshot */
      ...(attributedSpecFiles.length ? { attributedSpecFiles } : {}),
      /* mutation-scope:end attribution-and-dom-snapshot */
      ...(enrichment?.domSnapshot ? { domSnapshot: enrichment.domSnapshot } : {}),
      ...(enrichment?.coverageGap ? { coverageGap: enrichment.coverageGap } : {}),
      ...(enrichment?.contractFeedback?.length ? { contractFeedback: enrichment.contractFeedback.map((violation) => ({ ...violation })) } : {}),
      ...(enrichment?.intent ? { intent: toGenerationIntent(enrichment.intent) } : {}),
      ...(enrichment?.learnedRules?.length ? { learnedRules: renderLearnedRules(enrichment.learnedRules) } : {}),
      ...(enrichment?.contextPack ? { contextPack: enrichment.contextPack } : {}),
      ...(enrichment?.contextPackItemIds ? { contextPackItemIds: enrichment.contextPackItemIds } : {}),
      ...(enrichment?.contextPackOmissions ? { contextPackOmissions: enrichment.contextPackOmissions } : {}),
      ...(enrichment?.authSeedUnauthored ? { authSeedUnauthored: true } : {}),
      ...(existingSpecFiles.length ? { existingSpecFiles: [...existingSpecFiles] } : {}),
      ...(enrichment?.contextMap ? { contextMap: enrichment.contextMap } : {}),
      ...(enrichment?.harnessFacts ? { harnessFacts: enrichment.harnessFacts } : {}),
      ...(enrichment?.closedLoop ? { closedLoop: enrichment.closedLoop } : {}),
      ...(enrichment?.agentBrowser ? { agentBrowser: enrichment.agentBrowser } : {}),
      ...(enrichment?.geolocation ? { geolocation: enrichment.geolocation } : {}),
      /* Structural-blast-radius advisory, with the flag that says it names symbols. Absent → omitted; the flag never travels without its signal. */
      ...(enrichment?.staticSignal
        ? {
            staticSignal: enrichment.staticSignal,
            ...(enrichment.staticSignalHasSymbols ? { staticSignalHasSymbols: true } : {}),
            ...(enrichment.staticSignalFiles?.length ? { staticSignalFiles: [...enrichment.staticSignalFiles] } : {}),
          }
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
      ...(enrichment?.planning ? { planning: { ...enrichment.planning } } : {}),
    };
    return input;
  }
}
