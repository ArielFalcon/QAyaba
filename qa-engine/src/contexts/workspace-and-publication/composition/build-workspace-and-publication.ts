/* Builds the workspace-and-publication context: the run's working copy and its handle, the setup and cleanup of the suite, the write confinement and mirror gc bound to that handle, the durable suite store and the publication route (PR, Issue or shadow log). Only this context reaches the VCS write seam. */

import type { Sha } from "@kernel/sha.ts";
import type { SpecSnapshotPort } from "@kernel/ports/spec-snapshot.port.ts";
import type { SuiteStorePort } from "@kernel/ports/suite-store.port.ts";
import type { RunMode, TestTarget } from "@kernel/run-mode.ts";
import type { TelemetryPort } from "@kernel/telemetry/telemetry.port.ts";
import type { CleanupPort, ConfinementPort, MirrorGcPort, PublicationPort, SetupPort, WorkspacePort } from "@contexts/run-orchestration/application/index.ts";
import type { ValidationPort } from "@contexts/test-execution/application/index.ts";
import { PublishWorkspace } from "../application/publish-workspace.use-case.ts";
import { publishKindFor } from "../domain/publish-policy.ts";
import { VcsWriteAdapter } from "../infrastructure/vcs-write.adapter.ts";
import { PublishDecisionService } from "../domain/publish-decision.service.ts";
import { renderIssue, renderPrBody } from "../domain/render-publication.ts";
import { CleanupPortAdapter, type CleanupPortCollaborators } from "../infrastructure/adapters/cleanup-port.adapter.ts";
import { ConfinementPortAdapter, type PathConfinementCollaborator } from "../infrastructure/adapters/confinement-port.adapter.ts";
import { MirrorGcPortAdapter, type PathMirrorGcCollaborator } from "../infrastructure/adapters/mirror-gc-port.adapter.ts";
import { PublicationPortAdapter, type GitHubIssueCollaborator, type GitHubPrCollaborator, type VcsPublishCollaborator } from "../infrastructure/adapters/publication-port.adapter.ts";
import { SetupPortAdapter, type SetupPortCollaborators } from "../infrastructure/adapters/setup-port.adapter.ts";
import { SpecSnapshotValidationPort } from "../infrastructure/adapters/spec-snapshot-validation.adapter.ts";
import { TracedSuiteStore } from "../infrastructure/adapters/suite-store-trace.ts";
import { WorkspacePortAdapter, type CheckoutFn } from "../infrastructure/adapters/workspace-port.adapter.ts";
import { WorkspaceRegistry } from "../infrastructure/adapters/workspace-registry.ts";
import { ShadowLogAdapter } from "../infrastructure/shadow-log.adapter.ts";

export interface PublishDeps {
  mode: RunMode;
  /* The git runner, already carrying the credentials and the commit identity the shell owns. */
  git: (args: string[], cwd?: string) => Promise<string>;
  writeExcludes: (dir: string, patterns: readonly string[]) => void | Promise<void>;
}

/* The publish step of one run: the policy of its kind over the git-write seam. Only this context holds the seam. */
export function buildPublishWorkspace(deps: PublishDeps & { isCode: boolean }): VcsPublishCollaborator {
  return new PublishWorkspace(publishKindFor(deps.isCode, deps.mode), new VcsWriteAdapter(deps.git, deps.writeExcludes));
}

export interface WorkspaceAndPublicationDeps {
  /* The run the context serves. */
  run: {
    repo: string;
    branch: string;
    target: TestTarget;
    isCode: boolean;
    e2eRelDir: string;
    baseUrl?: string;
    testIdAttribute?: string;
    shadow: boolean;
  };
  /* Resolves a Sha to its working-copy mirror directory; cross-repo routing stays opaque inside it. */
  checkout: (sha: Sha) => Promise<string>;
  /* Optional, no stub: absent leaves the run's setup phase a no-op. */
  setup?: SetupPortCollaborators;
  cleanup?: CleanupPortCollaborators;
  /* Optional, no stub: absent builds no confinement and no gc. */
  confinement?: PathConfinementCollaborator;
  mirrorGc?: PathMirrorGcCollaborator;
  /* The publication route. The sanitizer is required: there is no identity default. */
  publication: {
    githubPr: GitHubPrCollaborator;
    githubIssue: GitHubIssueCollaborator;
    /* The git runner and the local-exclude writer the shell supplies, with the run mode: the context turns them into the publish step. Absent: a "pr" route throws rather than open a PR against an unpushed branch. */
    publish?: PublishDeps;
    sanitize: (text: string) => string;
    containsSecret?: (text: string) => boolean;
    reviewerApproved?: boolean;
    coverageBlocks?: boolean;
    e2eChanged?: boolean;
  };
  /* The durable copy of the app's accepted suite; traced when telemetry is present. */
  suiteStore?: SuiteStorePort;
  /* Where the specs a run holds at validation are kept for grading (e2e only). */
  specSnapshots?: SpecSnapshotPort;
  telemetry?: TelemetryPort;
}

export interface WorkspaceAndPublicationApi {
  workspace: WorkspacePort;
  setup?: SetupPort;
  cleanup?: CleanupPort;
  confinement?: ConfinementPort;
  mirrorGc?: MirrorGcPort;
  publication: PublicationPort;
  suiteStore?: SuiteStorePort;
  /* Wraps a validation port so the specs it validated are kept as they stood; the port itself when no snapshot store is wired or the run is a code run. */
  snapshotValidation(validation: ValidationPort): ValidationPort;
}

export function buildWorkspaceAndPublication(deps: WorkspaceAndPublicationDeps): WorkspaceAndPublicationApi {
  const { run, publication } = deps;
  if (!publication.sanitize) {
    throw new Error("buildWorkspaceAndPublication: publication.sanitize is required to wire the publication port — the engine root must supply the real sanitizer, there is no identity default.");
  }
  /* One registry per build: the handle the workspace port issues is the only key the publication, confinement and gc adapters accept. */
  const registry = new WorkspaceRegistry();
  const checkout: CheckoutFn = deps.checkout;
  const workspace = new WorkspacePortAdapter(checkout, { specRelDir: run.isCode ? "" : run.e2eRelDir, isCode: run.isCode }, registry);

  return {
    workspace,
    ...(deps.setup ? { setup: new SetupPortAdapter(deps.setup, { target: run.target }) } : {}),
    ...(!run.isCode && deps.cleanup ? { cleanup: new CleanupPortAdapter(deps.cleanup, { baseUrl: run.baseUrl, testIdAttribute: run.testIdAttribute }) } : {}),
    ...(deps.confinement ? { confinement: new ConfinementPortAdapter(registry, deps.confinement) } : {}),
    ...(deps.mirrorGc ? { mirrorGc: new MirrorGcPortAdapter(registry, deps.mirrorGc) } : {}),
    publication: new PublicationPortAdapter(
      {
        decide: new PublishDecisionService(),
        pr: publication.githubPr,
        issue: publication.githubIssue,
        shadowLog: new ShadowLogAdapter(),
        sanitize: publication.sanitize,
        /* Pure Issue/PR renderers: not app-specific, so every build (shadow included) gets them. */
        render: { issue: renderIssue, prBody: renderPrBody },
        ...(publication.publish ? { vcsWrite: buildPublishWorkspace({ isCode: run.isCode, ...publication.publish }) } : {}),
        ...(publication.containsSecret ? { containsSecret: publication.containsSecret } : {}),
      },
      {
        repo: run.repo,
        branch: run.branch,
        reviewerApproved: publication.reviewerApproved ?? true,
        coverageBlocks: publication.coverageBlocks ?? false,
        shadow: run.shadow,
        e2eChanged: publication.e2eChanged ?? true,
        isCode: run.isCode,
      },
      registry,
    ),
    ...(deps.suiteStore ? { suiteStore: deps.telemetry ? new TracedSuiteStore(deps.suiteStore, deps.telemetry) : deps.suiteStore } : {}),
    snapshotValidation: (validation) =>
      deps.specSnapshots && !run.isCode ? new SpecSnapshotValidationPort(validation, { port: deps.specSnapshots, sanitize: publication.sanitize }) : validation,
  };
}
