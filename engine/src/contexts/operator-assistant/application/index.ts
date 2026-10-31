/* Public surface of this context: other contexts import only from this file. It declares nothing. */
export type { AssistantTextDeps } from "../domain/assistant-text.ts";
export { buildRunChatContext, buildRunContext, recentOutcomesContext } from "../domain/run-context.ts";
export type { AssistantRunRecord } from "../domain/run-context.ts";
export { buildHelpContext } from "../domain/help-context.ts";
export type { HelpContextDeps } from "../domain/help-context.ts";
export { HELP_INSTRUCTION, boundQuestion, helpHistoryLine, helpQuestionContext, runHistoryLine, runQuestionContext } from "../domain/question-context.ts";
