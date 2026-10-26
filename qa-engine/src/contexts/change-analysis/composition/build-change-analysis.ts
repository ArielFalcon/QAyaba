/* Builds the change-analysis context: the change classification port, the structural signal over the run's code graph, and the reader of a mirror's git history that other contexts' adapters are handed. */

import type { CodeExplorePort } from "@kernel/ports/code-explore.port.ts";
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import type { CoChangePort } from "@kernel/ports/co-change.port.ts";
import type { SandboxedBinaryRunner } from "../../../shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";
import type { ChangeAnalysisPort, StructuralSignalPort, VcsReadPort } from "../application/index.ts";
import { ChangeAnalysisPortAdapter } from "../infrastructure/adapters/change-analysis-port.adapter.ts";
import { ADVISORY_BUDGET, StructuralSignalPortAdapter } from "../infrastructure/adapters/structural-signal-port.adapter.ts";
import { GitMirrorReadAdapter } from "../infrastructure/git-mirror-read.adapter.ts";

export interface ChangeAnalysisDeps {
  /* Reads the run's commit range. */
  vcs: VcsReadPort;
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
}

export function buildChangeAnalysis(deps: ChangeAnalysisDeps): ChangeAnalysisApi {
  const structural = deps.structural;
  return {
    changeAnalysis: new ChangeAnalysisPortAdapter(deps.vcs),
    ...(structural
      ? { structuralSignal: new StructuralSignalPortAdapter(structural.codeGraph, structural.coChange, structural.repoDir, structural.explore ? { explore: structural.explore } : undefined) }
      : {}),
    advisoryBudget: ADVISORY_BUDGET,
    mirrorReader: (repoDir, runner) => new GitMirrorReadAdapter(repoDir, runner),
  };
}
