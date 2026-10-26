/* Builds the change-analysis context: the change classification port, the structural signal over the run's code graph, and the reader of a mirror's git history that other contexts' adapters are handed. */

import type { CodeExplorePort } from "@kernel/ports/code-explore.port.ts";
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import type { CoChangePort } from "@kernel/ports/co-change.port.ts";
import { join } from "node:path";
import type { ExecSandboxPort } from "../../../shared-infrastructure/process-sandbox/exec-sandbox.ts";
import type { ProcessKillPort } from "../../../shared-kernel/process-sandbox/process-kill.port.ts";
import type { Sandbox } from "../../../shared-infrastructure/process-sandbox/sandbox.ts";
import { createExecBinaryRunner } from "../../../shared-infrastructure/process-sandbox/exec-binary-runner.ts";
import { CodegraphCodeGraphAdapter } from "../../../shared-infrastructure/code-graph/codegraph-code-graph.adapter.ts";
import { CodegraphEngine } from "../../../shared-infrastructure/code-graph/codegraph-engine.ts";
import { CodegraphStoreCache } from "../../../shared-infrastructure/code-graph/codegraph-store-cache.ts";
import { LanguageRegistry } from "../../../shared-kernel/language-id.ts";
import type { SandboxedBinaryRunner } from "../../../shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";
import type { ChangeAnalysisPort, VcsReadPort } from "../application/index.ts";
import type { StructuralSignalPort } from "@kernel/ports/structural-signal.port.ts";
import { ChangeAnalysisPortAdapter } from "../infrastructure/adapters/change-analysis-port.adapter.ts";
import { ADVISORY_BUDGET, StructuralSignalPortAdapter } from "../infrastructure/adapters/structural-signal-port.adapter.ts";
import { GitMirrorReadAdapter } from "../infrastructure/git-mirror-read.adapter.ts";

/* What the code graph of any app is built from: the launcher it runs through, the trusted git runner that checks out its workspace, and where its store cache lives. */
export interface CodeGraphDeps {
  exec: ExecSandboxPort;
  git: SandboxedBinaryRunner;
  /* The data directory the sandbox uid cannot reach: the store cache lives under it. */
  dataDir: string;
  sandbox: Sandbox | null;
  processKill: ProcessKillPort;
}

/*
 * The code graph of one app, the same for a run and for onboarding's first index: the engine and its store reader run in the
 * launcher's graph profile, the workspace is checked out by the trusted git runner, and the store cache lives under the data
 * dir. Its scope is the language registry's declared languages and the app's exclusions.
 */
export function codeGraphFor(deps: CodeGraphDeps): (appName: string, exclude: readonly string[]) => CodegraphCodeGraphAdapter {
  return (appName, exclude) =>
    new CodegraphCodeGraphAdapter({
      engine: new CodegraphEngine(createExecBinaryRunner({ exec: deps.exec, profile: "graph", commandClass: "code-graph", processKill: deps.processKill }), undefined, process.execPath),
      git: deps.git,
      cache: new CodegraphStoreCache(join(deps.dataDir, "code-graph", appName)),
      workDir: () => deps.exec.workDir(),
      sandbox: deps.sandbox,
      scope: { extensions: LanguageRegistry.extensions, manifests: LanguageRegistry.manifests, exclude },
      isTestFile: (file) => LanguageRegistry.isTestFile(file),
    });
}

export interface ChangeAnalysisDeps {
  /* Reads the run's commit range. */
  vcs: VcsReadPort;
  /* Absent: the context builds no code graph. */
  graph?: CodeGraphDeps;
  /* The structural signal, wired only with the code graph and its co-change history. Absent: no signal. */
  structural?: {
    codeGraph: CodeGraphPort;
    coChange: CoChangePort;
    /* The classify-source repo root (the service mirror on a webhook, the primary otherwise), not the e2e subfolder. */
    repoDir: string;
    /* The engine's read-equivalent answers feeding the change dossier. Absent: no dossier. */
    explore?: CodeExplorePort;
  };
}

export interface ChangeAnalysisApi {
  changeAnalysis: ChangeAnalysisPort;
  structuralSignal?: StructuralSignalPort;
  /* The impact budget the advisory signals share. */
  advisoryBudget: typeof ADVISORY_BUDGET;
  /* A read-only reader of one mirror's history, run through the sandboxed binary runner. */
  mirrorReader(repoDir: string, runner: SandboxedBinaryRunner): VcsReadPort;
  /* The code graph of an app: one instance per call, because the index a run built lives in it. Served only when the graph deps were supplied. */
  codeGraphFor?: ReturnType<typeof codeGraphFor>;
}

export function buildChangeAnalysis(deps: ChangeAnalysisDeps): ChangeAnalysisApi {
  const structural = deps.structural;
  return {
    changeAnalysis: new ChangeAnalysisPortAdapter(deps.vcs),
    ...(structural
      ? { structuralSignal: new StructuralSignalPortAdapter(structural.codeGraph, structural.coChange, structural.repoDir, structural.explore ? { explore: structural.explore } : undefined) }
      : {}),
    advisoryBudget: ADVISORY_BUDGET,
    ...(deps.graph ? { codeGraphFor: codeGraphFor(deps.graph) } : {}),
    mirrorReader: (repoDir, runner) => new GitMirrorReadAdapter(repoDir, runner),
  };
}
