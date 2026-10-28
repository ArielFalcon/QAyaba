/* Builds the generation context: the generation and review ports over the run's agent runtime, the three groundings (before generation, before execution, before review) and the spans that tell what each grounding source supplied. */

import { join, relative, sep } from "node:path";
import type { CurriculumPort, LearningPort } from "@contexts/cross-run-learning/application/index.ts";
import type { StructuralSignalPort } from "@kernel/ports/structural-signal.port.ts";
import type { CrossRepoImpactPort, ProviderDocumentsPort, ServiceLinksPort } from "@contexts/service-topology/application/index.ts";
import type { ContextProvenance } from "@kernel/telemetry/context-provenance.ts";
import type { TelemetryPort } from "@kernel/telemetry/telemetry.port.ts";
import type { ContextBudget } from "@kernel/context-budget.ts";
import type { RunMode, TestTarget } from "@kernel/run-mode.ts";
import { readConfinedSpecFile } from "../../../shared-infrastructure/spec-path-confinement.ts";
import type { GenerateOpts, GenerationResult } from "../application/generate-tests.use-case.ts";
import type { AuthorPort, LeadPort, PreExecGroundingPort, PreGenerationGroundingPort, ReviewDomGroundingPort, ReviewPort } from "../application/index.ts";
import type { ArchitectureContext, OpencodeRunInput, StepLimitFor } from "../application/index.ts";
import { GenerationTurnsAdapter, type GenerationTurnsCollaborators } from "../infrastructure/adapters/generation-turns.adapter.ts";
import { PreExecGroundingPortAdapter, type PreExecGroundingCollaborators } from "../infrastructure/adapters/pre-exec-grounding-port.adapter.ts";
import { PreGenerationGroundingPortAdapter, type PreGenerationGroundingCollaborators } from "../infrastructure/adapters/pre-generation-grounding-port.adapter.ts";
import { ReviewDomGroundingPortAdapter, type ReviewDomGroundingCollaborators } from "../infrastructure/adapters/review-dom-grounding-port.adapter.ts";
import { ReviewPortAdapter, type ReviewPortRuntime } from "../infrastructure/adapters/review-port.adapter.ts";
import {
  TracedCrossRepoImpactPort,
  TracedCurriculumPort,
  TracedLearningPort,
  TracedServiceLinksPort,
  TracedStructuralSignalPort,
  telemetryGroundingTrace,
} from "../infrastructure/adapters/context-trace.ts";

export interface GenerationDeps {
  run: {
    repo: string;
    appName: string;
    mirrorDir: string;
    e2eRelDir: string;
    /* The per-run namespace the generated specs are written under. */
    branch: string;
    target: TestTarget;
    mode: RunMode;
    isCode: boolean;
    diff?: string;
    guidance?: string;
    baseUrl?: string;
    testIdAttribute?: string;
    openapi?: string | string[];
    /* Triggering microservice of a cross-repo run, and every declared service of a context-mode run: prompt context only. */
    triggerService?: { repo: string; mirrorDir: string; openapi?: string | string[] };
    services?: Array<{ repo: string; mirrorDir: string; openapi?: string | string[] }>;
  };
  /* An already-constructed use case: its own leaf ports are the generation context's concern. */
  generationUseCase: { author(input: OpencodeRunInput, opts?: GenerateOpts): Promise<GenerationResult> };
  /* Re-reads a just-generated spec. Absent: the confined reader, the one that never follows a path an agent reported out of the spec directory. */
  readSpecSource?: GenerationTurnsCollaborators["readSpecSource"];
  /* The step limit the runtime enforces for a role this run. Absent: no prompt states one. */
  stepLimitFor?: StepLimitFor;
  /* The run's context budget: its windows per role and the working room a turn needs. The shell's prompt rendering already holds it; it is handed on so a unit that fits content to a window reads the same one. Absent: no window is known. */
  contextBudget?: ContextBudget;
  deadline?: GenerationTurnsCollaborators["deadline"];
  review: { runtime: ReviewPortRuntime; timeoutMs?: number };
  grounding: {
    contextMap?: ArchitectureContext;
    /* Where the map was effectively read from and how fresh it was. */
    contextMapProvenance?: () => ContextProvenance | undefined;
    prChangedFiles?: string[];
    domPack?: boolean;
    contextPack?: boolean;
    /* The provider's OpenAPI documents the run's resolved links point at (from the service topology): the provider's contract a possible data contradiction is classified by. */
    providerDocuments?: ProviderDocumentsPort;
    /* One file of the run's repository at a commit (the confined mirror reader): the route table at the run's base. */
    readAtRef?: (ref: string, file: string) => Promise<string | undefined>;
    collaborators?: PreGenerationGroundingCollaborators;
    reviewDomCollaborators?: ReviewDomGroundingCollaborators;
    preExecCollaborators?: PreExecGroundingCollaborators;
  };
  /* With telemetry, the grounding reports what each source supplied and `traced` wraps the ports the run consumes. */
  telemetry?: TelemetryPort;
}

export interface GenerationApi {
  generation: LeadPort & AuthorPort;
  /* The run's context budget, as given. */
  contextBudget?: ContextBudget;
  review: ReviewPort;
  /* Absent for a code run: nothing is grounded on a DEV page. */
  preGenerationGrounding?: PreGenerationGroundingPort;
  reviewDomGrounding?: ReviewDomGroundingPort;
  preExecGrounding?: PreExecGroundingPort;
  /* Spans over the ports other contexts serve and a run consumes; each is the port itself when no telemetry is wired. */
  traced: {
    structuralSignal(port: StructuralSignalPort): StructuralSignalPort;
    serviceLinks(port: ServiceLinksPort): ServiceLinksPort;
    crossRepoImpact(port: CrossRepoImpactPort): CrossRepoImpactPort;
    learning(port: LearningPort): LearningPort;
    curriculum(port: CurriculumPort): CurriculumPort;
  };
}

/* Where a map may name the staged snapshot of the triggering service: from the working copy and from the e2e dir, each only when the snapshot lies inside it. The shell stages it under the e2e dir; which of the two a context run records is not settled, so both are offered. An empty list says no directory holds the snapshot, and the run is still a cross-repo run. */
function stagedRootsOf(workingCopyDir: string, e2eDir: string, stagedDir: string): string[] {
  const inside = (root: string): boolean => root !== "" && root !== ".." && !root.startsWith("../");
  const roots = [relative(workingCopyDir, stagedDir), relative(e2eDir, stagedDir)].map((root) => root.split(sep).join("/")).filter(inside);
  return [...new Set(roots)];
}

export function buildGeneration(deps: GenerationDeps): GenerationApi {
  const { run, grounding, telemetry } = deps;
  const generation = new GenerationTurnsAdapter(
    deps.generationUseCase as ConstructorParameters<typeof GenerationTurnsAdapter>[0],
    {
      repo: run.repo,
      appName: run.appName,
      mirrorDir: run.mirrorDir,
      e2eRelDir: run.e2eRelDir,
      namespace: run.branch,
      target: run.target,
      mode: run.mode,
      diff: run.diff ?? "",
      ...(run.guidance ? { guidance: run.guidance } : {}),
      /* Live DEV URL for the generator (Playwright MCP). Absent: the agent has no URL to ground selectors against. */
      ...(run.baseUrl ? { baseUrl: run.baseUrl } : {}),
      ...(run.openapi ? { openapi: run.openapi } : {}),
      ...(run.triggerService ? { service: run.triggerService } : {}),
      ...(run.services?.length ? { services: run.services } : {}),
    },
    { readSpecSource: deps.readSpecSource ?? readConfinedSpecFile, stepLimitFor: deps.stepLimitFor, ...(deps.deadline ? { deadline: deps.deadline } : {}) },
  );

  const review = new ReviewPortAdapter(
    deps.review.runtime,
    {
      diff: run.diff ?? "",
      mirrorDir: run.mirrorDir,
      e2eRelDir: run.e2eRelDir,
      appName: run.appName,
      mode: run.mode,
      target: run.target,
      ...(run.baseUrl ? { baseUrl: run.baseUrl } : {}),
      ...(run.guidance ? { guidance: run.guidance } : {}),
      ...(deps.review.timeoutMs !== undefined ? { timeoutMs: deps.review.timeoutMs } : {}),
    },
    { stepLimitFor: deps.stepLimitFor },
  );

  const e2eDir = join(run.mirrorDir, run.e2eRelDir);
  const location = { e2eDir, mirrorDir: run.mirrorDir, baseUrl: run.baseUrl, testIdAttribute: run.testIdAttribute };
  const groundingCollaborators: PreGenerationGroundingCollaborators = { ...grounding.collaborators, ...(grounding.providerDocuments ? { providerDocuments: grounding.providerDocuments } : {}) };
  const preGenerationGrounding = !run.isCode
    ? new PreGenerationGroundingPortAdapter(
        {
          ...location,
          contextMap: grounding.contextMap,
          ...(grounding.contextMapProvenance ? { contextMapProvenance: grounding.contextMapProvenance } : {}),
          prChangedFiles: grounding.prChangedFiles,
          domPack: grounding.domPack,
          contextPack: grounding.contextPack,
          ...(grounding.readAtRef ? { readAtRef: grounding.readAtRef } : {}),
          ...(run.openapi ? { openapi: run.openapi } : {}),
          ...(run.triggerService ? { stagedRoots: stagedRootsOf(run.mirrorDir, e2eDir, run.triggerService.mirrorDir) } : {}),
        },
        telemetry ? { ...groundingCollaborators, trace: telemetryGroundingTrace(telemetry, grounding.contextMapProvenance) } : groundingCollaborators,
      )
    : undefined;
  const reviewDomGrounding = !run.isCode ? new ReviewDomGroundingPortAdapter({ e2eDir, mirrorDir: run.mirrorDir, baseUrl: run.baseUrl, testIdAttribute: run.testIdAttribute }, grounding.reviewDomCollaborators ?? {}) : undefined;
  const preExecGrounding = !run.isCode ? new PreExecGroundingPortAdapter({ e2eDir, mirrorDir: run.mirrorDir, baseUrl: run.baseUrl, testIdAttribute: run.testIdAttribute }, grounding.preExecCollaborators ?? {}) : undefined;

  return {
    generation,
    review,
    ...(deps.contextBudget ? { contextBudget: deps.contextBudget } : {}),
    ...(preGenerationGrounding ? { preGenerationGrounding } : {}),
    ...(reviewDomGrounding ? { reviewDomGrounding } : {}),
    ...(preExecGrounding ? { preExecGrounding } : {}),
    traced: {
      structuralSignal: (port) => (telemetry ? new TracedStructuralSignalPort(port, telemetry) : port),
      serviceLinks: (port) => (telemetry ? new TracedServiceLinksPort(port, telemetry) : port),
      crossRepoImpact: (port) => (telemetry ? new TracedCrossRepoImpactPort(port, telemetry) : port),
      learning: (port) => (telemetry ? new TracedLearningPort(port, telemetry) : port),
      curriculum: (port) => (telemetry ? new TracedCurriculumPort(port, telemetry) : port),
    },
  };
}
