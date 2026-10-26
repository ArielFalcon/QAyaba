/* The assistant: POST /runs/:id/ask answers about one run, POST /help answers about the product. */

import { AskResponseSchema } from "../../../contract/commands";
import { sanitizeText } from "../../../../qa-engine/src/shared-infrastructure/redaction/pattern-redaction.adapter";
import { activityRouter } from "../../../integrations/opencode-client";
import { buildRunContext, buildLearningContext, buildRunChatContext } from "../../chat";
import { buildHelpContext } from "../../help";
import { ApiError } from "../api-error";
import type { ApiDeps } from "../deps";
import { reply, type ApiResult } from "../respond";

/* Truncate to prevent context window exhaustion. */
const MAX_QUESTION_LENGTH = 4000;

export async function askAboutRun(deps: ApiDeps, runId: string, readBody: () => Promise<Record<string, unknown>>): Promise<ApiResult> {
  const record = deps.getRecord(runId);
  if (!record) throw new ApiError(404, `run not found: ${runId}`, { bare: true });
  const ask = deps.ask;
  if (!ask) throw new ApiError(501, "ask is not available", { bare: true });

  const body = await readBody();
  let question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) throw new ApiError(400, "'question' is required", { bare: true });
  if (question.length > MAX_QUESTION_LENGTH) question = question.substring(0, MAX_QUESTION_LENGTH) + " [truncated]";

  const historyLines: string[] = [];
  if (Array.isArray(body.history)) {
    for (const entry of body.history) {
      if (typeof entry === "object" && entry !== null && "role" in entry && "text" in entry) {
        historyLines.push(`${entry.role === "q" ? "Operator" : "Assistant"}: ${String((entry as { text: unknown }).text)}`);
      }
    }
  }

  try {
    /* Load app config so the assistant knows what repo is being tested and where. */
    let appInfo: { repo: string; baseUrl?: string } | undefined;
    try {
      const cfg = deps.loadApp(record.app);
      appInfo = { repo: cfg.repo, baseUrl: cfg.dev?.baseUrl };
    } catch { /* app not configured — proceed without */ }

    /* Context is bounded (cases + logs capped) and sanitized on ingress (secrets redacted). */
    const activityCtx = activityRouter.contextForRun(record.id);
    const learningCtx = buildLearningContext(record.app);
    const runCtx = buildRunContext(record, undefined, appInfo, activityCtx || undefined, learningCtx || undefined);
    const productCtx = buildRunChatContext();
    const historyCtx = historyLines.length > 0 ? `\n\nRecent conversation:\n${historyLines.slice(-6).join("\n")}` : "";
    const answer = await ask({ context: `${productCtx}\n\n---\n\n${runCtx}${historyCtx}`, question });
    /* Sanitize on egress (logs→chat is a new egress path). */
    return reply.contract(200, AskResponseSchema, { answer: sanitizeText(answer).text });
  } catch (err) {
    throw new ApiError(502, `assistant failed: ${err instanceof Error ? err.message : String(err)}`, { bare: true });
  }
}

const HELP_INSTRUCTION =
  "You are a helpful assistant answering questions about qayaba (the TUI for qayaba). " +
  "Use ONLY the context below. " +
  "TERMINAL-FRIENDLY FORMATTING (this renders in a TUI via Ink <Text>): " +
  "allowed: blank lines, indentation, capitalized headers (RESUMEN, USO), " +
  "plain text lists with '-', '───' separators between topics. " +
  "forbidden: **bold**, `code`, # headings, code fences, emojis, HTML. " +
  "Respond in the SAME language as the question. Be concise. " +
  "If the context lacks the answer, say so and suggest what to ask instead.";

export async function answerHelp(deps: ApiDeps, readBody: () => Promise<Record<string, unknown>>): Promise<ApiResult> {
  const ask = deps.ask;
  if (!ask) throw new ApiError(501, "help chat is not available (ask not wired)", { bare: true });

  const body = await readBody();
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) throw new ApiError(400, "'question' is required", { bare: true });

  const historyLines: string[] = [];
  if (Array.isArray(body.history)) {
    for (const entry of body.history) {
      if (typeof entry === "object" && entry !== null && "role" in entry && "text" in entry) {
        const role = String((entry as { role: unknown }).role);
        const text = String((entry as { text: unknown }).text);
        historyLines.push(`${role}: ${text}`);
      }
    }
  }

  let fullContext = buildHelpContext();
  if (historyLines.length > 0) fullContext += `\n\n## Recent conversation\n${historyLines.slice(-10).join("\n")}`;

  try {
    const answer = await ask({ context: fullContext, question, instruction: HELP_INSTRUCTION });
    return reply.contract(200, AskResponseSchema, { answer: sanitizeText(answer).text });
  } catch (err) {
    throw new ApiError(502, `assistant failed: ${err instanceof Error ? err.message : String(err)}`, { bare: true });
  }
}
