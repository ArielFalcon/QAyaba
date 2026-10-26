/*
 * The judges' switch, budget and setup (docs/observability-design.md section 11.3). Resolved once, in the composition root.
 *
 * The switch and the budget are the operator's: `QA_JUDGES_ENABLED` (default off) and `QA_JUDGES_DAILY_TOKENS`. A mistyped value stops the
 * boot, like the other budget settings: a judge that silently ran, or silently did not, would be a surprise on a shared provider quota.
 *
 * The setup is what the repository declares: the version header of the pinned judge prompt (agents/agent/qa-judge.md) and the model the
 * `qa-judge` role of agents/opencode.json is assigned. No model is named in code. A judge is refused when its model is not declared, or is
 * the generator's own: a model grading its own work is not an independent opinion.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJudgePromptVersion } from "@contexts/evaluation/application/index";

/* Judge calls are 5k to 15k tokens each: this is a few dozen calls a day, enough to calibrate on and small next to a run's own spend. */
export const DEFAULT_JUDGE_DAILY_TOKENS = 200_000;

export interface JudgeSwitch {
  enabled: boolean;
  dailyTokens: number;
}

export function resolveJudgeSwitch(env: Record<string, string | undefined>): JudgeSwitch {
  const rawEnabled = env.QA_JUDGES_ENABLED;
  if (rawEnabled !== undefined && rawEnabled !== "" && rawEnabled !== "true" && rawEnabled !== "false") {
    throw new Error(`QA_JUDGES_ENABLED must be "true" or "false", got ${JSON.stringify(rawEnabled)}`);
  }
  const rawTokens = env.QA_JUDGES_DAILY_TOKENS;
  let dailyTokens = DEFAULT_JUDGE_DAILY_TOKENS;
  if (rawTokens !== undefined && rawTokens !== "") {
    if (!/^[1-9]\d*$/.test(rawTokens)) throw new Error(`QA_JUDGES_DAILY_TOKENS must be a positive whole number of tokens, got ${JSON.stringify(rawTokens)}`);
    dailyTokens = Number(rawTokens);
  }
  return { enabled: rawEnabled === "true", dailyTokens };
}

/* A refused setup still names the prompt version when the prompt declared one: the catalog lists the judges (and their status, experimental) by it. */
export type JudgeSetup = { ok: true; promptVersion: string; configuredModel: string } | { ok: false; reason: string; promptVersion?: string };

export const JUDGE_PROMPT_FILE = join("agents", "agent", "qa-judge.md");

export function resolveJudgeSetup(deps: { root: string; readFile?: (path: string) => string }): JudgeSetup {
  const read = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  let promptText: string;
  try {
    promptText = read(join(deps.root, JUDGE_PROMPT_FILE));
  } catch (err) {
    return { ok: false, reason: `the judge prompt ${JUDGE_PROMPT_FILE} cannot be read (${err instanceof Error ? err.message : String(err)})` };
  }
  const promptVersion = parseJudgePromptVersion(promptText);
  if (promptVersion === undefined) return { ok: false, reason: `${JUDGE_PROMPT_FILE} declares no <!-- judge-prompt-version: N --> header` };

  let agents: Record<string, { model?: unknown } | undefined>;
  try {
    const parsed = JSON.parse(read(join(deps.root, "agents", "opencode.json"))) as { agent?: Record<string, { model?: unknown } | undefined> };
    agents = parsed.agent ?? {};
  } catch (err) {
    return { ok: false, promptVersion, reason: `agents/opencode.json cannot be read (${err instanceof Error ? err.message : String(err)})` };
  }
  const judge = agents["qa-judge"];
  if (!judge) return { ok: false, promptVersion, reason: "agents/opencode.json declares no qa-judge role (the owner's live step adds it, see docs/observability-design.md section 19)" };
  const judgeModel = typeof judge.model === "string" && judge.model.trim() !== "" ? judge.model : undefined;
  if (judgeModel === undefined) return { ok: false, promptVersion, reason: "the qa-judge role of agents/opencode.json declares no model" };
  const generatorModel = typeof agents["qa-generator"]?.model === "string" ? (agents["qa-generator"]!.model as string) : undefined;
  if (generatorModel === undefined) return { ok: false, promptVersion, reason: "the qa-generator role declares no model, so the judge's independence cannot be checked" };
  if (judgeModel === generatorModel) return { ok: false, promptVersion, reason: `the qa-judge model (${judgeModel}) is the generator's own: a judge must run a different model` };
  return { ok: true, promptVersion, configuredModel: judgeModel };
}
