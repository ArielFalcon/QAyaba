/* The assistant: POST /runs/:id/ask answers about one run, POST /help answers about the product. */

import { HELP_INSTRUCTION, boundQuestion, buildHelpContext, buildRunChatContext, buildRunContext, helpHistoryLine, helpQuestionContext, recentOutcomesContext, runHistoryLine, runQuestionContext, type AssistantTextDeps } from "@contexts/operator-assistant/application/index";
import { AskResponseSchema } from "../../contract/commands";
import { sanitizeText } from "../../../../engine/src/shared-infrastructure/redaction/pattern-redaction.adapter";
import { activityRouter } from "../../../agent-runtime/opencode-client";
import { infraErrorGloss } from "../../infra-error-gloss";
import { DEFAULT_HOST } from "../../../settings/port";
import { getHistory } from "../../../persistence/index";
import { ApiError } from "../api-error";
import type { ApiDeps } from "../deps";
import { reply, type ApiResult } from "../respond";
import { redactionPort } from "../support";

/* What the assistant's texts borrow from the shell: the pattern redaction every text passes through on its way in, and the infra-error wording. */
const assistantText: AssistantTextDeps = { sanitize: (text) => sanitizeText(text).text, infraErrorGloss };

/* The app's recent run outcomes as the assistant's run context holds them; none when the read fails. */
function recentOutcomesOf(app: string): string | null {
  try {
    return recentOutcomesContext(getHistory().learning.listRunOutcomes(app, 10));
  } catch {
    return null;
  }
}

export async function askAboutRun(deps: ApiDeps, runId: string, readBody: () => Promise<Record<string, unknown>>): Promise<ApiResult> {
  const record = deps.getRecord(runId);
  if (!record) throw new ApiError(404, `run not found: ${runId}`);
  const ask = deps.ask;
  if (!ask) throw new ApiError(501, "ask is not available");

  const body = await readBody();
  let question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) throw new ApiError(400, "'question' is required");
  question = boundQuestion(question, (text) => redactionPort.redact(text));

  const historyLines: string[] = [];
  if (Array.isArray(body.history)) {
    for (const entry of body.history) {
      if (typeof entry === "object" && entry !== null && "role" in entry && "text" in entry) {
        historyLines.push(redactionPort.redact(runHistoryLine(entry)));
      }
    }
  }

  try {
    /* Load app config so the assistant knows what repo is being tested and where. */
    let appInfo: { repo: string; baseUrl?: string } | undefined;
    try {
      const cfg = deps.loadApp(record.app);
      appInfo = { repo: cfg.repo, baseUrl: cfg.dev.baseUrl };
    } catch { /* app not configured — proceed without */ }

    /* Context is bounded (cases + logs capped) and sanitized on ingress (secrets redacted). */
    const activityCtx = activityRouter.contextForRun(record.id);
    const learningCtx = recentOutcomesOf(record.app);
    const runCtx = buildRunContext(record, assistantText, { ...(appInfo ? { appInfo } : {}), activityContext: activityCtx || undefined, learningContext: learningCtx || undefined });
    const answer = await ask({ context: runQuestionContext({ orientation: buildRunChatContext(assistantText), run: runCtx, history: historyLines }), question });
    /* Sanitize on egress (logs→chat is a new egress path). */
    return reply.contract(200, AskResponseSchema, { answer: sanitizeText(answer).text });
  } catch (err) {
    throw new ApiError(502, `assistant failed: ${redactionPort.redactError(err)}`);
  }
}

export async function answerHelp(deps: ApiDeps, readBody: () => Promise<Record<string, unknown>>): Promise<ApiResult> {
  const ask = deps.ask;
  if (!ask) throw new ApiError(501, "help chat is not available (ask not wired)");

  const body = await readBody();
  const question = redactionPort.redact(typeof body.question === "string" ? body.question.trim() : "");
  if (!question) throw new ApiError(400, "'question' is required");

  const historyLines: string[] = [];
  if (Array.isArray(body.history)) {
    for (const entry of body.history) {
      if (typeof entry === "object" && entry !== null && "role" in entry && "text" in entry) {
        historyLines.push(redactionPort.redact(helpHistoryLine(entry)));
      }
    }
  }

  const fullContext = helpQuestionContext(buildHelpContext({ ...assistantText, defaultHost: DEFAULT_HOST }), historyLines);

  try {
    const answer = await ask({ context: fullContext, question, instruction: HELP_INSTRUCTION });
    return reply.contract(200, AskResponseSchema, { answer: sanitizeText(answer).text });
  } catch (err) {
    throw new ApiError(502, `assistant failed: ${redactionPort.redactError(err)}`);
  }
}
