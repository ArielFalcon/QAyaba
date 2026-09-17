/* Live RunEvent stream the Channel Gateway pushes to clients. Our vocabulary, not OpenCode's: producers map raw signals onto these events; model prose (delta/TextPart/ReasoningPart) is never represented. Adding a variant here is the only way to surface a new live signal — there is no raw passthrough. src/contract/events.ts re-exports this module. */

import { z } from "zod";

export const TestTargetSchema = z.enum(["e2e", "code"]);
export const RunModeSchema = z.enum(["diff", "complete", "exhaustive", "manual", "context"]);
export const RunVerdictSchema = z.enum(["pass", "fail", "flaky", "invalid", "infra-error", "skipped"]);
/* success = the engine produced a trustworthy result and acted (green→PR, real bug→Issue, flaky→quarantine, skip→no-op); error = it could not run or could not produce runnable tests. Distinct from the verdict — a fail (real bug) is engineStatus=success. */
export const RunEngineStatusSchema = z.enum(["success", "error"]);

/* An unknown raw step is omitted, never invented. */
export const RunStepSchema = z.enum([
  "gate", "classify", "setup", "generate", "validate", "health", "execute", "coverage", "retry", "decide", "done",
]);

/* Derived from OpenCode ToolPart, never from prose. analyzing = read/grep/glob/list/webfetch · writing = write/edit/patch · command = bash · subagent = task. */
export const AgentActivityKindSchema = z.enum(["analyzing", "writing", "command", "subagent"]);
export const ActivityStatusSchema = z.enum(["running", "completed"]);
export const TodoStatusSchema = z.enum(["pending", "in_progress", "completed", "cancelled"]);
export const LogLevelSchema = z.enum(["info", "warn", "error"]);

export const RunEventBodySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run.started"), app: z.string(), sha: z.string(), mode: RunModeSchema, target: TestTargetSchema }),
  z.object({ type: z.literal("step.changed"), step: RunStepSchema, detail: z.string().optional() }),
  z.object({
    type: z.literal("agent.activity"),
    kind: AgentActivityKindSchema,
    target: z.string(),
    status: ActivityStatusSchema,
    callId: z.string().optional(),
    workerId: z.string().optional(),
  }),
  z.object({ type: z.literal("plan.updated"), todos: z.array(z.object({ content: z.string(), status: TodoStatusSchema })) }),
  z.object({ type: z.literal("spec.written"), file: z.string() }),
  z.object({ type: z.literal("test.discovered"), name: z.string(), file: z.string().optional() }),
  z.object({ type: z.literal("test.started"), name: z.string() }),
  z.object({ type: z.literal("test.passed"), name: z.string(), durationMs: z.number().nonnegative() }),
  z.object({ type: z.literal("test.failed"), name: z.string(), durationMs: z.number().nonnegative().optional(), detail: z.string().optional() }),
  z.object({ type: z.literal("test.flaky"), name: z.string(), attempts: z.number().int().positive() }),
  z.object({ type: z.literal("reviewer.verdict"), approved: z.boolean(), reasons: z.array(z.string()) }),
  z.object({ type: z.literal("coverage.computed"), changedLines: z.number().int().nonnegative(), coveredLines: z.number().int().nonnegative() }),
  z.object({ type: z.literal("run.verdict"), verdict: RunVerdictSchema, engineStatus: RunEngineStatusSchema, passed: z.number().int().nonnegative().optional(), failed: z.number().int().nonnegative().optional(), outcome: z.string().optional() }),
  z.object({ type: z.literal("agent.error"), detail: z.string() }),
  z.object({ type: z.literal("log.line"), level: LogLevelSchema, text: z.string() }),
]);

/* Gateway stamps seq (monotonic per run = SSE id and Last-Event-ID resume cursor), ts, and runId. Producers emit only the body. */
export const RunEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  runId: z.string(),
  ts: z.number().int().nonnegative(),
  body: RunEventBodySchema,
});

export type RunEventBody = z.infer<typeof RunEventBodySchema>;
export type RunEvent = z.infer<typeof RunEventSchema>;
export type RunEventType = RunEventBody["type"];
