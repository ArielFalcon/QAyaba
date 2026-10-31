import { RUN_TIME_BUDGET_ENV, RUN_TIME_BUDGET_FORMER_ENV } from "@contexts/run-orchestration/application/index";

/*
 * Variables of features that were removed. Nothing reads them; one still set in an environment would be ignored in
 * silence, so a load reports each once. The operator's environment files are the operator's to edit.
 */
const RETIRED_SETTINGS: ReadonlyArray<{ readonly name: string; readonly gone: string }> = [
  { name: "SELF_MAINTAINER_AUTOMERGE", gone: "the self-maintainer was removed" },
  { name: "SELF_MAINTAINER_CI_CHECK", gone: "the self-maintainer was removed" },
  { name: "QAYABA_REPO", gone: "the self-maintainer was removed" },
  { name: "QA_REFLECTOR_ENABLED", gone: "the reflector was removed" },
  { name: "REFLECTOR_TIMEOUT_MS", gone: "the reflector was removed" },
  { name: "QA_JUDGES_ENABLED", gone: "the LLM judges were removed" },
  { name: "QA_JUDGES_DAILY_TOKENS", gone: "the LLM judges were removed" },
  { name: "LANGFUSE_BASE_URL", gone: "the Langfuse score sink was removed" },
  { name: "LANGFUSE_PUBLIC_KEY", gone: "the Langfuse score sink was removed" },
  { name: "LANGFUSE_SECRET_KEY", gone: "the Langfuse score sink was removed" },
  { name: "LANGFUSE_ALLOW_EXTERNAL", gone: "the Langfuse score sink was removed" },
  { name: "QA_RUN_TIME_BUDGET_MS_COMPLETE", gone: "the complete and exhaustive modes were removed" },
  { name: "QA_RUN_TIME_BUDGET_MS_EXHAUSTIVE", gone: "the complete and exhaustive modes were removed" },
  { name: "QA_DIFF_TIME_BUDGET_MS_TINY", gone: "the first-pass time cap of a diff tier was removed: the pass runs under what the run deadline allots it, so a shorter cap you set no longer applies" },
  { name: "QA_DIFF_TIME_BUDGET_MS_FOCUSED", gone: "the first-pass time cap of a diff tier was removed: the pass runs under what the run deadline allots it, so a shorter cap you set no longer applies" },
  { name: "QA_DIFF_TIME_BUDGET_MS_BROAD", gone: "the first-pass time cap of a diff tier was removed: the pass runs under what the run deadline allots it, so a shorter cap you set no longer applies" },
  { name: "COORDINATION_ESCALATED_MODEL", gone: "a replaced flow starts a fresh sidekick on the same model as the first" },
  { name: "AGENT_RUNTIME_MODE", gone: "every role runs on the one agent runtime" },
  { name: "AGENT_SINGLE_PROVIDER", gone: "every role runs on the one agent runtime" },
  { name: "AGENT_PRIMARY_PROVIDER", gone: "every role runs on the one agent runtime" },
  { name: "AGENT_REVIEWER_PROVIDER", gone: "every role runs on the one agent runtime" },
  { name: "AGENT_CHAT_PROVIDER", gone: "every role runs on the one agent runtime" },
];

/*
 * Variables a replacement variable supersedes but that are still read for one more release: a load reports each one that is set, with the
 * name to set instead.
 */
const DEPRECATED_SETTINGS: ReadonlyArray<{ readonly name: string; readonly use: string; readonly note: string }> = RUN_TIME_BUDGET_FORMER_ENV.map((name) => ({
  name,
  use: RUN_TIME_BUDGET_ENV.diff,
  note: "it applies only while that one is unset, the largest of the old per-size values winning",
}));

export function deprecatedSettingWarnings(env: Readonly<Record<string, string | undefined>>): string[] {
  return DEPRECATED_SETTINGS.filter(({ name }) => env[name] !== undefined && env[name] !== "").map(
    ({ name, use, note }) => `${name} is deprecated and read for one more release: set ${use} instead (${note})`,
  );
}

export function retiredSettingWarnings(env: Readonly<Record<string, string | undefined>>): string[] {
  return RETIRED_SETTINGS.filter(({ name }) => env[name] !== undefined && env[name] !== "").map(
    ({ name, gone }) => `${name} is set but no longer read: ${gone}; remove it from the environment`,
  );
}
