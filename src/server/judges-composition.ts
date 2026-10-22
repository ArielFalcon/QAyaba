/*
 * Composes the LLM judges for the orchestrator (docs/observability-design.md section 11.3): the switch and budget from the environment, the
 * setup from the repository, the use case over the SQLite adapters and the OpenCode runtime, and the service that decides when they run.
 * Nothing here is reached unless a run is a campaign run (or a regrade names a judge) AND `QA_JUDGES_ENABLED=true`. The qa-engine
 * never imports any of it.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { RunJudgesUseCase } from "@contexts/evaluation/application/run-judges.use-case";
import { judgeCatalog, type JudgeCatalogEntry } from "@contexts/evaluation/domain/judges";
import { assertNoSecretLeak, sanitizeText } from "@contexts/generation/infrastructure/sanitize-text";
import { defaultAgentDeps, listAgentCaps } from "../integrations/opencode-client";
import { JUDGE_WORKDIR } from "../paths";
import { SqliteScoreStore } from "./evaluation-service";
import { SqliteCalibrationStore, SqliteJudgeLedger } from "./judge-adapters";
import { JUDGE_AGENT_NAME, createJudgeAgent } from "./judge-agent";
import { HistoryJudgeEvidence } from "./judge-evidence";
import { createJudgeService, type JudgeService } from "./judge-service";
import { resolveJudgeSetup, resolveJudgeSwitch } from "./judge-settings";
import { getRunCampaign } from "./history";
import type { JobQueue } from "./queue";
import type { AgentDeps } from "@contexts/generation/infrastructure/agent-transport-policy";

/* One judge call: a prompt of a few thousand tokens and a short JSON answer. */
export const JUDGE_TIMEOUT_MS = 180_000;

export interface JudgesComposition {
  service: JudgeService & { catalog(): JudgeCatalogEntry[] };
}

export interface ComposeJudgesOptions {
  env: Record<string, string | undefined>;
  /* The orchestrator's root: where agents/ is read from. */
  root: string;
  queue: Pick<JobQueue, "enqueueIdle">;
  /* The mirrors root; the judge's empty work directory lives under it. */
  mirrorsRoot: string;
  log?: (message: string) => void;
  /* Tests only: the runtime the judge talks to. */
  agentDeps?: () => Promise<AgentDeps>;
}

/* The text the judges are sent has the same redaction as every prompt: secrets taken out, and a refusal when one is still seen. */
function sanitizeForJudge(text: string): string {
  const redacted = sanitizeText(text, "model").text;
  assertNoSecretLeak(redacted, "model", "evidence→judge");
  return redacted;
}

export function composeJudges(opts: ComposeJudgesOptions): JudgesComposition {
  const swtch = resolveJudgeSwitch(opts.env);
  const setup = resolveJudgeSetup({ root: opts.root });
  const log = opts.log ?? ((m: string) => console.error(m));
  const workDir = (): string => {
    const dir = join(opts.mirrorsRoot, JUDGE_WORKDIR);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const evidence = new HistoryJudgeEvidence();
  const ledger = new SqliteJudgeLedger();
  const calibrations = new SqliteCalibrationStore();
  const runner = new RunJudgesUseCase({
    evidence,
    agent: createJudgeAgent({ deps: opts.agentDeps ?? defaultAgentDeps, workDir, timeoutMs: JUDGE_TIMEOUT_MS }),
    store: new SqliteScoreStore(),
    ledger,
    /* A refused setup has no version to judge under; the service never reaches the runner then. */
    promptVersion: setup.promptVersion ?? "unversioned",
    ...(setup.ok ? { configuredModel: setup.configuredModel } : {}),
    dailyTokenBudget: swtch.dailyTokens,
    sanitize: sanitizeForJudge,
    now: () => new Date().toISOString(),
    log,
  });
  const base = createJudgeService({
    queue: opts.queue,
    switch: swtch,
    setup,
    agentAvailable: async () => (await listAgentCaps(workDir())).some((agent) => agent.name === JUDGE_AGENT_NAME),
    runner,
    isCampaignRun: (runId) => getRunCampaign(runId) !== undefined,
    runIsFinished: (runId) => evidence.load(runId) !== undefined,
    calibrations,
    latestModel: (judge, promptVersion) => ledger.latestModel(judge, promptVersion),
    log,
  });
  const catalog = (): JudgeCatalogEntry[] => {
    const version = base.promptVersion();
    return version === undefined ? [] : judgeCatalog(version, (name) => base.statusOf(name));
  };
  return { service: Object.assign(base, { catalog }) };
}
