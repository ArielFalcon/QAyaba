/* Every attribute key the engine may put on a span, with its type, meaning, cardinality and content class. Typed: `Attrs` accepts only registered keys, so an unregistered key fails to compile; at run time the adapter drops an unknown key and counts it. `cardinality: "high"` keys (ids, hashes, shas) may sit on spans but never on a metric. `content` says what leaves the process: `none` (ids, enums, counts), `metadata` (hashes and sizes of content: structural values, but exported only when the capture mode is `metadata` or `full`), `redacted-text` (free text, passed through the span's redaction scope and the outbound sanitizer) or `content` (message bodies, dropped unless the capture mode allows them). The GenAI keys are spelled only in genai-semconv.ts. */

import { GENAI } from "./genai-semconv.ts";

export type AttrType = "string" | "int" | "double" | "boolean" | "string[]";
export type Cardinality = "low" | "high";
export type ContentClass = "none" | "metadata" | "redacted-text" | "content";

export interface AttrSpec {
  readonly type: AttrType;
  readonly description: string;
  readonly cardinality: Cardinality;
  readonly content: ContentClass;
}

const spec = (type: AttrType, description: string, cardinality: Cardinality = "low", content: ContentClass = "none"): AttrSpec => ({ type, description, cardinality, content });
const str = (d: string, c: Cardinality = "low") => spec("string", d, c);
const int = (d: string, c: Cardinality = "low") => spec("int", d, c);
const bool = (d: string) => spec("boolean", d);
const dbl = (d: string) => spec("double", d);
const text = (d: string) => spec("string", d, "high", "redacted-text");
const metaHash = (d: string) => spec("string", d, "high", "metadata");
const metaInt = (d: string) => spec("int", d, "low", "metadata");

export const ATTRIBUTES = {
  /* Identity of the run (root span). */
  "qayaba.run.id": str("The run id.", "high"),
  "qayaba.app": str("The watched app's configured name."),
  "qayaba.commit.sha": str("The commit under test.", "high"),
  "qayaba.trigger": str("What started the run: webhook, api, cli, campaign, continuation, context or login-bootstrap."),
  "qayaba.mode": str("The run mode: diff, complete, exhaustive or manual."),
  "qayaba.target": str("The test target: e2e or code."),
  "qayaba.parent_run.id": str("The run this one continues.", "high"),
  "qayaba.trigger_repo": str("The service repo whose deploy triggered a cross-repo run.", "high"),
  "qayaba.shadow": bool("Whether the run is in shadow mode (nothing is published)."),
  "qayaba.queue.wait_ms": int("Milliseconds between enqueue and dequeue."),
  "qayaba.onboarding.wait_ms": int("Milliseconds spent waiting for onboarding before the run started."),
  "qayaba.run.cancelled": bool("The run was cancelled by an operator (never an error)."),

  /* Host health (design §7): what the machine did to the process while a run was active. */
  "qayaba.host.suspend_ms": int("Milliseconds the process was frozen while wall time moved (VM paused, laptop asleep); on a host_suspended event."),
  "qayaba.host.blocked_ms": int("Milliseconds the event loop was blocked; on an event_loop_blocked event."),
  "qayaba.event_loop.stat": str("Which statistic of an event-loop delay window a measurement is: p50, p99 or max."),

  /* Configuration in effect for the run. */
  "qayaba.runtime": str("The agent runtime: opencode or codex."),
  "qayaba.coordination.mode": str("single or lead-sidekicks."),
  "qayaba.closed_loop.enabled": bool("The run_spec closed loop is on."),
  "qayaba.agent_browser.enabled": bool("The authenticated agent browser is on."),
  "qayaba.coverage.policy": str("The change-coverage policy mode: off, signal or enforce."),
  "qayaba.reflector.enabled": bool("The reflector pass is on."),
  "qayaba.campaign.freeze": bool("Campaign freeze is on: the run neither reads nor writes learned state."),
  "qayaba.prompt.static_hash": str("Hash of the static prompt layers.", "high"),
  "qayaba.capture_mode": str("The content capture mode: off, metadata or full."),
  "qayaba.semconv.genai_rev": str("The revision of the GenAI conventions the GenAI attribute names follow."),

  /* Campaign. */
  "qayaba.campaign.id": str("The campaign the run belongs to.", "high"),
  "qayaba.campaign.replicate": int("The replicate number within the campaign."),

  /* Budgets. */
  "qayaba.deadline.label": str("The row of the run deadline table that applies."),
  "qayaba.deadline.budget_ms": int("The run deadline in milliseconds."),
  "qayaba.tier": str("The diff effort tier: tiny, focused or broad."),
  "qayaba.tier.budget_ms": int("The first pass time budget of the tier in milliseconds."),

  /* Outcome. */
  "qayaba.verdict": str("The run verdict."),
  "qayaba.error_class": str("The error class of an infra-error or invalid run."),
  "qayaba.generation.end": str("How the generation ended."),
  "qayaba.decision": str("The publication decision: pr, issue, shadow or none."),
  "qayaba.furthest_phase": str("The last phase the run entered."),
  "qayaba.specs.generated": int("Specs delivered by this run."),
  "qayaba.specs.valid": int("Delivered specs that passed validation."),
  "qayaba.specs.passed": int("Delivered specs that passed execution."),
  "qayaba.reviewer.turn_happened": bool("A reviewer turn took place."),
  "qayaba.limit.fired": str("The limit that ended the run or turn: tier-budget, run-deadline, repair-cap, explorer-timeout, session-timeout, prompt-budget, host-cap, stall, step-cap, cancel or none."),
  "qayaba.limit.applied": str("The time limit that bound the turn (the smallest that applied), named like the limit that fires."),
  "qayaba.limit.applied_ms": int("The time limit that bound the turn, in milliseconds."),
  "qayaba.cost.total": dbl("Total agent cost in USD."),
  "qayaba.agent.turns": int("Agent turns in the run."),
  "qayaba.agent.steps": int("Agent steps in the run."),
  "qayaba.span.orphaned": bool("The span was still open when its run ended and was closed by the harness."),
  "qayaba.span.synthesized": bool("The span was reconstructed from recorded times rather than observed live."),
  "qayaba.content.ref": str("A pointer to externally stored content (for example agent_turn:<id>).", "high"),

  /* Phases. */
  "qayaba.phase": str("The phase name, from the canonical phase list."),
  "qayaba.phase.outcome": str("How the phase ended."),

  /* Execution children. */
  "qayaba.exec.profile": str("The sandbox profile: offline, suite, login or install."),
  "qayaba.exec.command_class": str("A closed set taken from the call site: tsc, eslint, playwright-list, playwright-test, npm-ci, login, dom-capture, browser or code-test."),
  "qayaba.exec.signal": str("The signal that ended the child, if any."),
  "qayaba.exec.timed_out": bool("The child was killed by its timeout."),
  "qayaba.reaper.killed": int("Processes the sandbox reaper killed after the child."),
  "qayaba.egress.denied_cotemporal": spec("string[]", "Hosts denied while the child was alive (co-temporal, not causal).", "high", "redacted-text"),
  "process.exit.code": int("The child's exit code."),
  "error.type": str("The class of an infrastructure failure."),
  "exception.type": str("The class name of a recorded exception."),
  "exception.message": text("A recorded exception's message, redacted and capped; the stack is never recorded."),

  /* Host. */
  "qayaba.host.suspended_ms": int("Milliseconds the host was suspended during the run. A forward wall-clock step over 2 s (NTP, a manual change) reads as a suspend."),
  "qayaba.host.event_loop.max_ms": int("The longest event-loop delay seen during the run. Window-granular: 10 s sample windows can include time just before the run and miss the tail of its last window."),

  /* Agent turns. */
  "qayaba.agent.role": str("The agent role."),
  "qayaba.agent.round": int("The prompt's round number within its session, from 0."),
  "qayaba.agent.repair": bool("The turn is a contract repair."),
  "qayaba.agent.fallback_used": bool("The fallback model answered."),
  "qayaba.agent.abandoned": bool("The attempt kept running after its turn was abandoned."),
  "qayaba.agent.end": str("How the turn ended: completed, exhausted, timeout, aborted or failed."),
  "qayaba.delegation.id": str("The sidekick delegation id.", "high"),
  "qayaba.usage.source": str("How complete the token sum is: steps, final-message or none."),
  "qayaba.agent.steps.used": int("Steps the turn used."),
  "qayaba.agent.steps.limit": int("The step cap the prompt stated, read live from the runtime's resolved agent list. Never taken from the repository copy of the configuration."),
  "qayaba.config.source": str("Where the qayaba.config.* values come from: repo-copy, the orchestrator's copy of the agent configuration file (what is configured, not what the server proved it used)."),
  "qayaba.config.model": str("The model the repository copy of the agent configuration names for the agent."),
  "qayaba.config.reasoning_effort": str("The reasoning effort the repository copy of the agent configuration names for the agent."),
  "qayaba.config.steps_limit": int("The step cap the repository copy of the agent configuration declares for the agent."),
  "qayaba.agent.calls.denied": int("Tool calls the runtime denied."),
  "qayaba.agent.writes": int("File writes in the turn."),
  "qayaba.prompt.hash": metaHash("Hash of the redacted prompt bytes sent."),
  "qayaba.prompt.bytes": metaInt("Size of the prompt in bytes."),
  "qayaba.prompt.sections.dropped": int("Prompt sections dropped to fit the budget."),
  "qayaba.prompt.budget_bytes": int("The byte budget the prompt was assembled to."),
  "qayaba.tool.target": text("The sanitized, capped target of a tool call."),
  "qayaba.tool.bucket": str("The call bucket: code_read, browser, write, validate_run, script_run, memory, subagent or other."),
  "qayaba.tool.status": str("How the call ended: completed, error or running (never finished)."),
  "qayaba.nav.outcome": str("What a browser navigation came to: ok, auth_challenge, http_error, blocked or unknown."),
  "qayaba.step.intent": str("What a step was for: write_spec, auth, run_spec, explore, review or other."),
  "qayaba.agent.step": int("The step's number within its turn, from 1."),
  "qayaba.agent.step_budget.remaining": int("Steps left under the cap after this one; absent when no cap was stated."),
  "qayaba.attempt": int("The attempt of a prompt: 1 for the primary model, 2 for the fallback."),
  "qayaba.time.source": str("Where a span's times come from: receive (when the orchestrator received the events) or state (the runtime's own stamps)."),
  "qayaba.usage.input_tokens": int("Input tokens summed over the turn, cached tokens included (the conventions' count)."),
  "qayaba.usage.output_tokens": int("Output tokens summed over the turn."),
  "qayaba.usage.cache_read_tokens": int("Cache-read input tokens summed over the turn."),
  "qayaba.usage.cache_write_tokens": int("Cache-write input tokens summed over the turn."),
  "qayaba.usage.reasoning_tokens": int("Reasoning tokens summed over the turn."),
  "qayaba.usage.cost": dbl("Cost in USD summed over the turn."),
  "qayaba.agent.observation_complete": bool("Every step and call of the turn was observed."),
  "qayaba.agent.ms_to_first_step": int("Milliseconds from the turn's start to its first step."),
  "qayaba.agent.ms_to_first_call": int("Milliseconds from the turn's start to its first tool call."),
  "qayaba.agent.ms_to_first_write": int("Milliseconds from the turn's start to its first write."),
  "qayaba.agent.reasoning_tokens_before_first_call": int("Reasoning tokens spent in the steps up to and including the one that made the first call."),
  "qayaba.agent.reads.redundant": int("Reads of content the turn already had."),
  "qayaba.agent.reads.prompt_provided": int("Reads of content the prompt already contained."),
  "qayaba.agent.trace_truncated": bool("The turn made more steps or calls than its trace keeps."),
  "qayaba.error.message": text("A redacted, capped failure message."),

  /* Langfuse viewing aids, set on the root. */
  "langfuse.trace.name": str("Langfuse trace name."),
  "langfuse.session.id": str("Langfuse session id.", "high"),
  "langfuse.trace.tags": spec("string[]", "Langfuse trace tags: the app and the run mode."),
  "langfuse.environment": str("Langfuse environment."),
  "langfuse.observation.type": str("Langfuse observation type."),

  /* GenAI semantic conventions, spelled in genai-semconv.ts only. */
  [GENAI.attrs.operationName]: str("The GenAI operation: invoke_agent, chat or execute_tool."),
  [GENAI.attrs.agentName]: str("The agent's name."),
  [GENAI.attrs.conversationId]: str("The provider's real session id, never synthesized.", "high"),
  [GENAI.attrs.providerName]: str("The model provider."),
  [GENAI.attrs.requestModel]: str("The model the prompt named; absent when it named none and the agent's configured model applied."),
  [GENAI.attrs.responseModel]: str("The model that answered."),
  [GENAI.attrs.requestReasoningLevel]: str("The requested reasoning effort."),
  [GENAI.attrs.responseFinishReasons]: spec("string[]", "Why the model stopped."),
  [GENAI.attrs.toolName]: str("The tool called."),
  [GENAI.attrs.toolCallId]: str("The runtime's id of one tool call.", "high"),
  [GENAI.attrs.usageInputTokens]: int("Input tokens, cached tokens included."),
  [GENAI.attrs.usageOutputTokens]: int("Output tokens."),
  [GENAI.attrs.usageCacheReadInputTokens]: int("Input tokens read from cache (a subset of input tokens)."),
  [GENAI.attrs.usageCacheWriteInputTokens]: int("Input tokens written to cache (a subset of input tokens)."),
  [GENAI.attrs.usageReasoningOutputTokens]: int("Reasoning tokens (a subset of output tokens)."),
  [GENAI.attrs.inputMessages]: spec("string", "The request messages.", "high", "content"),
  [GENAI.attrs.outputMessages]: spec("string", "The response messages.", "high", "content"),
} as const satisfies Record<string, AttrSpec>;

export type RegisteredKey = keyof typeof ATTRIBUTES;

/* Keys with one variable segment. `{x}` matches a single non-empty segment without dots. */
export const ATTRIBUTE_TEMPLATES = [
  { template: "qayaba.prompt.section.{x}.bytes", spec: metaInt("Size in bytes of one prompt section, by section id.") },
  { template: "qayaba.prompt.section.{x}.hash", spec: metaHash("Hash of one prompt section, by section id.") },
  { template: "qayaba.campaign.variant.{x}", spec: str("A campaign variant label, by key (stored and echoed, never read by behaviour).", "high") },
  { template: "qayaba.agent.calls.{x}", spec: int("Tool calls in one bucket, by bucket name.") },
].map((t) => ({ ...t, pattern: new RegExp(`^${t.template.split("{x}").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^.]+")}$`) }));

export type TemplateKey =
  | `qayaba.prompt.section.${string}.bytes`
  | `qayaba.prompt.section.${string}.hash`
  | `qayaba.campaign.variant.${string}`
  | `qayaba.agent.calls.${string}`;

export type AttrKey = RegisteredKey | TemplateKey;
export type AttrValue = string | number | boolean | readonly string[] | readonly number[] | readonly boolean[];
export type Attrs = { readonly [K in AttrKey]?: AttrValue };

export function lookupAttribute(key: string): AttrSpec | undefined {
  if (Object.hasOwn(ATTRIBUTES, key)) return (ATTRIBUTES as Record<string, AttrSpec>)[key];
  return ATTRIBUTE_TEMPLATES.find((t) => t.pattern.test(key))?.spec;
}

/* Builders for template keys, so a caller never concatenates one by hand. */
export const attrKey = {
  promptSectionBytes: (id: string): TemplateKey => `qayaba.prompt.section.${id}.bytes`,
  promptSectionHash: (id: string): TemplateKey => `qayaba.prompt.section.${id}.hash`,
  campaignVariant: (key: string): TemplateKey => `qayaba.campaign.variant.${key}`,
  agentCalls: (bucket: string): TemplateKey => `qayaba.agent.calls.${bucket}`,
};
