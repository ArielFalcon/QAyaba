/*
 * Bounded, sanitized run-context for the read-only qa-assistant. Sanitization is infra-enforced here, not trusted to the agent: cap
 * cases/logs, sanitize on the way in. The API handler sanitizes the answer on the way out — logs→chat is an egress.
 */
import { redactThenBound } from "@kernel/redact-then-bound.ts";
import type { RunOutcome } from "@kernel/run-outcome.ts";
import type { AssistantTextDeps } from "./assistant-text.ts";

/* The slice of a run's record the assistant reads. */
export interface AssistantRunRecord {
  readonly app: string;
  readonly sha: string;
  readonly target?: string | undefined;
  readonly mode: string;
  readonly status: string;
  readonly step?: string | undefined;
  readonly stepDetail?: string | undefined;
  readonly verdict?: string | undefined;
  readonly passed?: number | undefined;
  readonly failed?: number | undefined;
  readonly retrying?: boolean | undefined;
  readonly note?: string | undefined;
  readonly cases: ReadonlyArray<{ readonly name: string; readonly status: string; readonly detail?: string | undefined }>;
  readonly logs: readonly string[];
}

export function buildRunChatContext(deps: AssistantTextDeps): string {
  const gloss = deps.infraErrorGloss;
  return deps.sanitize([
    "## About this chat",
    "",
    "You are answering questions about a SPECIFIC QA run. The operator is looking at",
    "this run in the terminal. Focus on what happened with THEIR tests — do not explain",
    "what qayaba is or how the pipeline works in general. The run context below has",
    "everything you need: step, verdict, cases, and logs.",
    "",
    "## Verdicts (what each outcome means for the operator)",
    "· pass   → all tests green, reviewer approved → tests committed via PR",
    "· fail   → test failures detected → GitHub Issue opened for the team",
    "· flaky  → passes only after retries → quarantined (no action needed)",
    "· invalid → static checks failed (compilation, linting, or metadata)",
    `· infra-error → the run could not reach a verdict, never a code bug: DEV was unhealthy or unreachable; or, when the run says so, the agent ran out of steps (${gloss("E-STEP-BUDGET")}) or out of time (${gloss("E-TIME-BUDGET")}) or decided nothing (${gloss("E-NO-DECISION")}) or had no author sidekick to write the tests (${gloss("E-NO-AUTHOR")}); or the app's login failed before any test was written (${gloss("E-PRECONDITION")}); or the reviewer could not be reached (${gloss("E-REVIEWER-UNAVAILABLE")}), or a reviewer finding the generator disputed stayed unresolved (${gloss("E-REVIEW-DISPUTED")})`,
    "· skipped → the commit needed no testing (style-only, or the agent declared a no-op with a reason)",
    "",
    "## Boundaries of this chat",
    "· You have NO tools — cannot read files, run commands, or call MCPs.",
    "· Answer ONLY from the run context below. It is bounded (cases + logs are",
    "  capped) and ephemeral (runs leave memory after ~30 days).",
    "· You cannot trigger actions — only describe what already happened.",
  ].join("\n"));
}

/* The most characters of the recent-outcomes block the assistant is given. */
const MAX_OUTCOMES_CONTEXT_CHARS = 3000;

/* How many of the app's recent outcomes the block lists. */
const LISTED_OUTCOMES = 5;

/* The app's recent run outcomes, newest first, as one block of the assistant's run context; null when the app has none. */
export function recentOutcomesContext(outcomes: ReadonlyArray<Pick<RunOutcome, "verdict" | "errorClass" | "mode" | "target" | "sha">>): string | null {
  if (outcomes.length === 0) return null;
  const lines: string[] = ["## Learning state for this app", "", `### Recent outcomes (${outcomes.length}):`];
  for (const o of outcomes.slice(0, LISTED_OUTCOMES)) {
    const ec = o.errorClass ? ` ${o.errorClass}` : "";
    lines.push(`- ${o.verdict}${ec} (${o.mode}/${o.target}, ${o.sha.slice(0, 7)})`);
  }
  lines.push("");
  const text = lines.join("\n");
  return text.length > MAX_OUTCOMES_CONTEXT_CHARS ? text.slice(0, MAX_OUTCOMES_CONTEXT_CHARS) + "\n…(truncated)" : text;
}

export interface RunContextLimits {
  maxCases: number;
  caseDetailChars: number;
  logTailChars: number;
}

export const RUN_CONTEXT_LIMITS: RunContextLimits = { maxCases: 20, caseDetailChars: 300, logTailChars: 8000 };

/* What a run's context may add to its record: the app it tests, the agent's live activity and the app's recent outcomes. */
export interface RunContextExtras {
  readonly limits?: RunContextLimits;
  readonly appInfo?: { readonly repo: string; readonly baseUrl?: string | undefined };
  readonly activityContext?: string | undefined;
  readonly learningContext?: string | undefined;
}

export function buildRunContext(record: AssistantRunRecord, deps: Pick<AssistantTextDeps, "sanitize">, extras: RunContextExtras = {}): string {
  const { limits = RUN_CONTEXT_LIMITS, appInfo, activityContext, learningContext } = extras;
  const lines: string[] = [];

  lines.push(
    [
      "Pipeline phases for E2E target (browser tests against the live DEV environment):",
      "classify (reads commit diff + message, decides to skip/generate/regress),",
      "generate (AI agent analyzes code, explores DEV with Playwright MCP, writes E2E specs),",
      "validate (typecheck + lint + test discovery + metadata check),",
      "execute (runs Playwright tests against the live DEV environment),",
      "retry (tests failed — agent is re-generating with failure feedback).",
    ].join("\n"),
    "",
    "IMPORTANT: Trust the actual run data (logs, cases, step, verdict, target, mode) over these generic",
    "phase descriptions. If logs show unit tests but the description mentions Playwright, the logs are",
    "correct — the description is wrong for this run. Targets: e2e = browser + DEV; code = source only.",
    "",
  );

  lines.push(`App: ${record.app}   Commit: ${record.sha.slice(0, 12)}   Target: ${record.target ?? "e2e"}   Mode: ${record.mode}`);
  if (appInfo) {
    lines.push(`Repository: ${appInfo.repo}${appInfo.baseUrl ? `   DEV URL: ${appInfo.baseUrl}` : ""}`);
  }
  lines.push(
    `Status: ${record.status}   Step: ${record.step ?? "enqueued"}   Verdict: ${record.verdict ?? "running"}   Passed: ${record.passed ?? 0}   Failed: ${record.failed ?? 0}`,
  );
  if (record.stepDetail) lines.push(`Step detail: ${record.stepDetail}`);
  if (record.retrying) lines.push("Currently RETRYING after a test failure — re-generating with failure feedback.");
  if (record.note) lines.push(`Note: ${record.note}`);
  if (activityContext) lines.push("", `Agent activity: ${activityContext}`);

  const cases = record.cases.slice(0, limits.maxCases);
  if (cases.length > 0) {
    lines.push("", "Cases:");
    for (const c of cases) {
      const detail = c.detail ? `: ${redactThenBound(c.detail, limits.caseDetailChars, deps.sanitize)}` : "";
      lines.push(`  [${c.status}] ${c.name}${detail}`);
    }
    if (record.cases.length > cases.length) lines.push(`  … and ${record.cases.length - cases.length} more`);
  }

  const logLines: string[] = [];
  let logChars = 0;
  for (let i = record.logs.length - 1; i >= 0; i--) {
    const line = record.logs[i]!;
    if (logChars + line.length > limits.logTailChars) break;
    logLines.unshift(line);
    logChars += line.length + 1;
  }

  if (logLines.length > 0) {
    lines.push("", "Logs (tail):", ...logLines);
  }

  if (learningContext) {
    lines.push("", learningContext);
  }

  /* Sanitize the whole blob on ingress (run data can carry DEV secrets/PII). */
  return deps.sanitize(lines.join("\n"));
}
