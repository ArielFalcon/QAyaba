/* Every attribute key the engine may put on a span, with its type, meaning, cardinality and content class. Typed: `Attrs` accepts only registered keys, so an unregistered key fails to compile; at run time the adapter drops an unknown key and counts it. `cardinality: "high"` keys (ids, hashes, shas) may sit on spans but never on a metric. `content` says what leaves the process: `none` (ids, enums, counts), `metadata` (hashes and sizes of content: structural values, but exported only when the capture mode is `metadata` or `full`), `redacted-text` (free text, passed through the span's redaction scope and the outbound sanitizer) or `content` (message bodies, dropped unless the capture mode allows them). The GenAI keys are spelled only in genai-semconv.ts. */

import { GENAI } from "./genai-semconv.ts";

/* The most item ids a context span exports (design §4.4); the engine counts the rest. */
export const MAX_ITEM_IDS_PER_SPAN = 200;

export type AttrType = "string" | "int" | "double" | "boolean" | "string[]";
export type Cardinality = "low" | "high";
export type ContentClass = "none" | "metadata" | "redacted-text" | "content";

export interface AttrSpec {
  readonly type: AttrType;
  readonly description: string;
  readonly cardinality: Cardinality;
  readonly content: ContentClass;
  /* The most elements of an array value that leave the process; absent, the adapter's default applies. */
  readonly arrayCap?: number;
}

const spec = (type: AttrType, description: string, cardinality: Cardinality = "low", content: ContentClass = "none", arrayCap?: number): AttrSpec => ({ type, description, cardinality, content, ...(arrayCap !== undefined ? { arrayCap } : {}) });
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
  "qayaba.run.end_reason": str("Why the run ended, from the closed set of end reasons; absent for a run that ended on an error nothing handled."),

  /* Host health (design §7): what the machine did to the process while a run was active. */
  "qayaba.host.suspend_ms": int("Milliseconds the process was frozen while wall time moved (VM paused, laptop asleep); on a host_suspended event."),
  "qayaba.host.blocked_ms": int("Milliseconds the event loop was blocked; on an event_loop_blocked event."),
  "qayaba.event_loop.stat": str("Which statistic of an event-loop delay window a measurement is: p50, p99 or max."),

  /* The app's browser position, when it declares one. */
  "qayaba.geo.lat": dbl("The browser latitude a sandboxed child was given."),
  "qayaba.geo.lng": dbl("The browser longitude a sandboxed child was given."),

  /* Configuration in effect for the run. */
  "qayaba.runtime": str("The agent runtime that served the turn."),
  "qayaba.closed_loop.enabled": bool("The run_spec closed loop is on."),
  "qayaba.agent_browser.enabled": bool("The authenticated agent browser is on."),
  "qayaba.coverage.policy": str("The change-coverage policy mode: off, signal or enforce."),
  "qayaba.coverage.status": str("The change-coverage decision: pass, fail or unknown."),
  "qayaba.coverage.ratio": dbl("Changed lines the green run executed, over the changed lines; absent when it measured nothing."),
  "qayaba.coverage.changed_lines": int("Lines the change adds or modifies."),
  "qayaba.coverage.covered_lines": int("Changed lines the green run executed."),
  "qayaba.coverage.changed_files": int("Files the change adds or modifies."),
  "qayaba.coverage.mapped_files": int("Changed files the executed code was mapped to."),
  "qayaba.coverage.unmeasured": str("Why the measurement decides nothing: no-diff, not-assembled, no-changed-lines, deletion-only, no-changed-file-mapped or no-source-maps (the scripts the page ran carried no source map)."),
  "qayaba.coverage.changed_branches": int("Arms of the decisions on changed lines (then/else, both sides of a conditional, a short circuit, each switch clause); absent when no decision was seen on a changed line."),
  "qayaba.coverage.taken_branches": int("Arms of the decisions on changed lines that ran in at least one test."),
  "qayaba.mutation.applied": int("Mutants of the changed code in the served script that reached a page and were judged; absent when none was."),
  "qayaba.mutation.survivors_routed": int("Surviving mutants a delivered spec's tests reached: each is sent, owned by that spec, in the run's one gap regeneration."),
  "qayaba.mutation.survivors_without_spec": int("Surviving mutants no spec was recorded as reaching: they are told to the lead without an owner."),
  "qayaba.mutation.killed": int("Judged mutants a test that passed before noticed (it failed)."),
  "qayaba.coverage.candidates": int("Use cases the change makes testable that the coverage measurement was asked about."),
  "qayaba.coverage.candidates_measured": int("Use cases that got a coverage ratio."),
  "qayaba.coverage.candidates_unmeasured": spec("string[]", "Use cases with no ratio, counted per reason as `reason: count` (backend, cross-repo, deletion-only or the aggregate's own reason).", "low", "none", 12),
  "qayaba.coordination.kind": str("What a coordination event is: proposal, delegation, lead-decision or another kind of the coordination ledger."),
  "qayaba.coordination.action": str("The coordination action of the event: direct, delegate or a lead-decision action."),
  "qayaba.coordination.reason": str("Why: the plan, a flow's turn and whether its files were taken back, a review action or a refusal.", "high"),
  "qayaba.coordination.attempt": int("The flow's turn the event is about, from 1."),
  "qayaba.coordination.flow_id": str("The flow the event is about.", "high"),
  "qayaba.coordination.candidate_ids": spec("string[]", "The ids of the use cases the flow covers.", "high", "none", 12),
  "qayaba.coordination.origin": str("What produced the correction: review, static, execution, flaky, pre-exec or coverage."),
  "qayaba.coordination.findings": int("The findings a correction turn routed."),
  "qayaba.coordination.findings_by_spec": int("Findings sent to the flow whose spec they name."),
  "qayaba.coordination.findings_by_candidate": int("Findings sent to the one flow covering a use case the changed file they name seeds."),
  "qayaba.coordination.findings_by_lead": int("Findings the lead's order sent to a flow, which no spec or seed file decided."),
  "qayaba.coordination.findings_by_candidate_flow": int("Findings taken by a flow the orchestrator opened for a use case no flow covered, or by a maintenance flow for a spec no flow owns."),
  "qayaba.coordination.findings_unrouted": int("Findings of a correction turn that no flow took: the coordination's own count, not the mutation survivors with no reaching spec."),
  "qayaba.coordination.unrouted_reasons": spec("string[]", "Why findings stayed unrouted, as distinct codes (no-seed-use-case, no-flow-took, flow-unavailable, maintenance-flow-empty).", "low", "none", 6),
  "qayaba.coordination.drop_bases": spec("string[]", "The bases of the plan's drops the event is about.", "low", "none", 12),
  "qayaba.coordination.drop_contradicted": bool("Whether the run's facts contradicted the plan's drops and the lead kept them."),
  "qayaba.coordination.decision": str("What the lead decided about a flow: accept, revise, replace or drop."),
  "qayaba.coordination.decision_overridden": bool("Whether the orchestrator did not take the lead's decision as given."),
  "qayaba.coordination.override_reason": str("The code of why the orchestrator did not take the decision as given."),
  "qayaba.coordination.failure_class": str("How a flow's turn failed, by the fixed classes of the coordination."),
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
  "qayaba.flaky.tail_reason": str("Why the steps after the execution ran for a run that ended flaky: flaky-green-bytes (the bytes ran green after a retry, so they are measured and reviewed, and still quarantined)."),
  "qayaba.flaky.cases": int("Cases that failed their first attempt and passed on retry."),
  "qayaba.flaky.data_instability": int("Flaky cases whose first attempt read an empty data state, or one other than the Context Pack read, while the same bytes passed on retry."),
  "qayaba.flaky.timing": int("Flaky cases with no data-state difference to blame: classified as timing."),
  "qayaba.flaky.outcome": str("What became of the flaky cases: no-flaky-case, no-pass (no lead's pass to route through), or the outcome of the correction that followed (accepted, empty, rejected, capped)."),
  "qayaba.review.outcome": str("How a review round's verdict read: approved, rejected, parse-miss or unavailable."),
  "qayaba.review.decided_by": str("What decided the review round: model, precheck or unchanged."),
  "qayaba.review.round": int("The review round, from 1."),
  "qayaba.review.rounds": int("Review rounds that ran."),
  "qayaba.review.model_rounds": int("Review rounds decided by a model."),
  "qayaba.review.correction_class": str("The class of the round's blocking correction: false-positive, wrong-objective, fragile-selector, no-cleanup, other or none."),
  "qayaba.review.blocking": int("Blocking corrections in the review round."),
  "qayaba.review.targets": spec("string[]", "The spec paths this run delivered and the reviewer judged.", "high", "none", 50),
  "qayaba.review.existing_specs": spec("string[]", "The existing suite paths shown as context only, never judged.", "high", "none", 50),
  "qayaba.review.corrections": spec("string[]", "The bounded correction texts of the review round.", "high", "redacted-text", 6),
  "qayaba.review.dropped_blocking": int("Reviewer-blocking findings the evidence filter dropped in the review round: rejections the run did not honor."),
  "qayaba.review.drop_reasons": str("Why those findings were dropped, as reason=count pairs: uncited, arm, unresolved (the citation names no spec of the suite), out-of-scope, not-executed."),
  "qayaba.review.rationale": text("The bounded rationale of the review round."),
  "qayaba.review.rebuttal.outcome": str("What became of a generator rebuttal: withdrawn (the orchestrator verified the basis it named) or disputed (it could not check it)."),
  "qayaba.limit.fired": str("The limit that ended the run or turn: tier-budget, run-deadline, repair-cap, session-timeout, prompt-budget, host-cap, stall, step-cap, cancel or none."),
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
  "qayaba.run_step.id": str("The id of a step of the run's step table, on a step event."),
  "qayaba.run_step.outcome": str("What became of a step: ran, skipped or ended (it ended the run)."),
  "qayaba.run_step.reason": str("Why the run ended, on the step event of the step that ended it."),

  /* Fix-loop phase outcomes. */
  "qayaba.fix_loop.rounds": int("Regeneration rounds the fix loop ran."),
  "qayaba.fix_loop.failing_before": int("Failing cases before the fix loop."),
  "qayaba.fix_loop.failing_after": int("Failing cases after the fix loop."),
  "qayaba.fix_loop.absent_selectors": int("Absent selectors from the first fix-loop round's divergence evidence."),
  "qayaba.fix_loop.triage_trigger": str("What made a failure a candidate for the fix loop's one triage re-read: pack-conflict or absent-selectors."),
  "qayaba.fix_loop.triage_outcome": str("What the triage came to: passed, dev-not-rendered, inconclusive, no-budget or unproven (no green proof, no re-read)."),
  "qayaba.fix_loop.triage_files": int("Spec files the triage re-read covered."),
  "qayaba.fix_loop.specs_changed": bool("The fix loop changed the spec set."),
  "qayaba.fix_loop.spec_sha_before": metaHash("sha256 of the spec set before the fix loop."),
  "qayaba.fix_loop.spec_sha_after": metaHash("sha256 of the spec set after the fix loop."),

  /* Evaluation scores (one measurement per graded score; never the run id, a comment or an observation id). */
  "qayaba.eval.name": str("A graded score's name from the grader catalog, a family member as `<base>.<suffix>`. Bounded by the catalog."),
  "qayaba.eval.source": str("Who produced the score: deterministic, llm_judge or human."),
  "qayaba.eval.data_type": str("The score's type: NUMERIC, BOOLEAN or CATEGORICAL."),
  "qayaba.eval.value": str("A categorical score's value, from the catalog's closed set (or `other` when a class is not in it)."),

  /* Execution children. */
  "qayaba.exec.profile": str("The sandbox profile: offline, suite, login, install or graph."),
  "qayaba.code_graph.repo": str("The repo a code-graph index belongs to (its mirror's name)."),
  "qayaba.code_graph.engine": str("The code-graph engine that built the index."),
  "qayaba.code_graph.engine_version": str("The code-graph engine's version."),
  "qayaba.code_graph.sha": str("The commit the run's index of the repo is at.", "high"),
  "qayaba.code_graph.outcome": str("How the run's index came to be: built, synced, reused, failed, timeout or skipped."),
  "qayaba.code_graph.duration_ms": int("How long indexing the repo took, in ms."),
  "qayaba.code_graph.node_count": int("Symbols the index holds."),
  "qayaba.code_graph.edge_count": int("Edges the index holds."),
  "qayaba.code_graph.reason": str("Why an index failed, timed out or was skipped; on a tool call or the structural signal, why the engine could not answer (redacted, bounded).", "high"),
  "qayaba.structural.walk": str("How the structural signal's impact walk ended: complete, truncated (stopped at its budget) or failed."),
  "qayaba.structural.dossier": str("What became of the change dossier in the structural block: shown, unavailable (the engine could not answer), empty (no source fit or the engine showed no file) or over-budget (the renderer left it out)."),
  "qayaba.change_scope.direct": int("Entry points (pages and operations) the change reaches directly: a map link of a changed file, or an implementing symbol within one call hop of a changed symbol."),
  "qayaba.change_scope.indirect": int("Entry points the change reaches only through a longer call path."),
  "qayaba.change_scope.cross_repo": int("Entry points the change reaches across repos, through a contract link or a frontend call site."),
  "qayaba.change_scope.omitted": int("Entry points the scope proved but its cap left out."),
  "qayaba.change_scope.hubs": int("Changed symbols that reached more entry points than the hub bound (or whose walk the budget cut) and added none."),
  "qayaba.change_scope.degraded": spec("string[]", "Repos whose index did not answer, as `repo: reason`: their absence from the reach proves nothing.", "high", "none", 20),
  "qayaba.change_scope.seed_basis": spec("string[]", "How each repo of the change seeded its walk, as `repo: lines | whole-file | none`.", "high", "none", 20),
  "qayaba.change_scope.hub_symbols": spec("string[]", "Changed symbols that reached more entry points than the hub bound (or whose walk the budget cut) and added none, as `file::symbol: entries`.", "high", "none", 50),
  "qayaba.change_scope.disagreements": spec("string[]", "Pages the engine and the map name different files for, as `route: engine file`; the map's files decide.", "high", "none", 50),
  "qayaba.candidates.count": int("Use-case candidates the change made testable."),
  "qayaba.candidates.entries": spec("string[]", "Each candidate as `id: entry [tier, reachability, basis]`, in the order they are offered.", "high", "none", 50),
  "qayaba.candidates.proofs": spec("string[]", "The evidence path of each candidate as `id: step > step > ...` (symbol and file names only).", "high", "none", 50),
  "qayaba.candidates.with_specs": int("Candidates the suite already holds a spec for."),
  "qayaba.candidates.shared_seeds": int("Changed symbols a hub reaches, attached to the candidates of the pages it reaches (sharedSeeds), summed over the candidates."),
  "qayaba.exec.command_class": str("A closed set taken from the call site: tsc, eslint, playwright-list, playwright-test, npm-ci, login, dom-capture, browser or code-test."),
  "qayaba.exec.signal": str("The signal that ended the child, if any."),
  "qayaba.exec.timed_out": bool("The child was killed by its timeout."),
  "qayaba.reaper.killed": int("Processes the sandbox reaper killed after the child."),
  "qayaba.egress.denied_cotemporal": spec("string[]", "Hosts denied while the span was alive (co-temporal, not causal). Every span whose lifetime overlaps a denial carries it: a sandboxed child, and the tool call that started it, so one denial can appear on several spans.", "high", "redacted-text"),
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
  "qayaba.delegation.status": str("What the sidekick reported its turn came to: completed, completed-with-concerns, needs-lead, blocked or failed; `unreadable` when its output held no answer of the contract, which is not a failure it reported."),
  "qayaba.delegation.last_run_spec": str("How the flow's last run_spec call ended when the sidekick reported: passed, failed, timedOut or error."),
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
  "qayaba.prompt.context.window_tokens": int("The context window, in tokens, of the model the prompt's role runs on; absent when the runtime reported none."),
  "qayaba.prompt.context.window_unknown": bool("Whether the role's context window was not known, so nothing was cut or split for it."),
  "qayaba.prompt.context.fit": str("Whether the prompt plus the working room its turn needs fits the window: fits, over or unknown."),
  "qayaba.prompt.context.working_room_tokens": int("The working room estimated for the turn: growth per step x usual steps of the role."),
  "qayaba.prompt.context.room_basis": str("Where the working room comes from: history (recorded turns of the role) or cold-start (the role's live step limit)."),
  "qayaba.tool.target": text("The sanitized, capped target of a tool call."),
  "qayaba.tool.bucket": str("The call bucket: code_read, code_graph, browser, write, validate_run, script_run, memory, subagent or other."),
  "qayaba.tool.status": str("How the call ended: completed, error or running (never finished)."),
  "qayaba.nav.outcome": str("What a browser navigation came to: ok, auth_challenge, http_error, blocked or unknown."),
  "qayaba.step.intent": str("What a step was for: write_spec, auth, run_spec, explore, review or other."),
  "qayaba.agent.step": int("The step's number within its turn, from 1."),
  "qayaba.agent.step_budget.remaining": int("Steps left under the cap after this one; absent when no cap was stated."),
  "qayaba.attempt": int("The attempt of a prompt: 1 for the primary model, 2 for the fallback."),
  "qayaba.time.source": str("Where a span's times come from: receive (when the orchestrator received the events), state (the runtime's own stamps) or report (the Playwright JSON report's own times)."),
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

  /* Context spans (design §4.4): one per grounding source, with the ids of what it supplied. */
  "qayaba.context.source": str("The grounding source: learning, curriculum, context-map, route-ranking, dom-capture, context-pack, service-links, structural-signal, cross-repo-impact."),
  "qayaba.context.stage": str("Which side of the supply a context span records: produced or delivered."),
  "qayaba.context.status": str("What a produced source came to: delivered, empty, skipped or failed."),
  "qayaba.context.reason": str("Why a produced source came to that status, from a closed set (no-map, capture-failed, disabled, ...)."),
  "qayaba.context.cut_class": str("The kind of loss a cut was: selection or truncation."),
  "qayaba.context.cut_reason": str("The closed reason a cut happened: route-cut, node-cap, section-shed, map-cap, ..."),
  "qayaba.context.location": str("The effective location a source was read from: db:context_maps, file:e2e/.qa/context.json, live:dev, mirror:stitcher, graph:codegraph, db:learning_rules, or db:curriculum."),
  "qayaba.context.effective_location": text("The effective location the DOM capture read, the first non-empty across routes."),
  "qayaba.context.captured_at": str("When a source was captured, ISO-8601.", "high"),
  "qayaba.context.captured_sha": str("The SHA a source was built from, when it has one.", "high"),
  "qayaba.context.age_ms": int("Milliseconds since the source was captured."),
  "qayaba.context.result_count": int("Results the source returned: routes+operations+links+flows, pages, claims, lines, rules, exemplars or DOM data results."),
  "qayaba.context.stale": bool("The source was stale when the generator used it."),
  "qayaba.context.stale_reason": str("Why a source was stale: sha-mismatch, older-than-max-age, dom-changed, data-state-unconfirmed, ... or none."),
  "qayaba.context.recapture.outcome": str("What a recapture request came to: not-needed, requested, completed, failed or skipped."),
  "qayaba.context.dom_changed": bool("The change-relevant DOM differed between two captures of the same page."),
  "qayaba.context.omitted": int("Items a delivered source left out (selection + truncation)."),
  "qayaba.context.omissions": spec("string[]", "Per-reason omissions of a delivered source, as class:reason:count[:route], at most 200.", "high", "none", 200),
  "qayaba.context.relevant_ids": spec("string[]", "The routes the change actually links to, as stable route ids, at most 200.", "high", "none", MAX_ITEM_IDS_PER_SPAN),
  "qayaba.context.relevant_groups": spec("string[]", "The component/page each relevant route belongs to, parallel to relevant_ids, at most 200.", "high", "none", MAX_ITEM_IDS_PER_SPAN),
  "qayaba.context.relevant_basis": spec("string[]", "Why each relevant route is one (implementation, source, spec or graph), parallel to relevant_ids, at most 200.", "low", "none", MAX_ITEM_IDS_PER_SPAN),
  "qayaba.context.items.count": int("Items the source supplied."),
  "qayaba.context.bytes": int("Bytes the source contributed to what the agent receives."),
  "qayaba.context.truncated": bool("The source was cut to fit a bound."),
  "qayaba.context.truncated_items": int("Items the source left out to fit its bound."),
  "qayaba.context.item_ids": spec("string[]", "Stable ids of the items the source supplied (design §4.4), at most 200; the rest are counted in qayaba.context.item_ids.overflow.", "high", "none", MAX_ITEM_IDS_PER_SPAN),
  "qayaba.context.item_ids.overflow": int("Item ids left out of qayaba.context.item_ids because of its cap."),

  /* One route of a DOM capture (an event on qayaba.context.dom-capture). */
  "qayaba.route.path": str("The route a capture event is about.", "high"),
  "qayaba.route.status": str("captured or degraded."),
  "qayaba.route.degrade_reason": str("Why a route's capture is degraded: capture-failed, empty-render or redirected."),
  "qayaba.route.settled": bool("The page reached network idle before it was read."),
  "qayaba.route.nodes": int("Accessibility-tree nodes read from the route."),
  "qayaba.route.test_ids": int("Distinct test ids found on the route."),
  "qayaba.route.runtime_errors": int("Runtime errors the page logged."),
  "qayaba.route.ids_overflow": int("Element ids of the route left out of the capture span because the route used its share of the id budget."),
  "qayaba.route.template": str("The route template of the map a page was opened from.", "high"),
  "qayaba.route.ms": int("Milliseconds the capture script spent on the route."),
  "qayaba.route.data_state": bool("The route matched a config-declared data state, so its readiness, result and location were read at capture time."),
  "qayaba.route.ready": bool("The route's readiness selector was found within the timeout."),
  "qayaba.route.result_expected": bool("A result selector or result text was configured for the route."),
  "qayaba.route.result_count": int("Results counted on the route (the first integer of the result text, or the result selector's count)."),
  "qayaba.route.effective_location": text("The route's effective location, read from its configured location selector."),
  "qayaba.route.capture_attempts": int("How many times the route's data state was read (1 or 2)."),

  /* Login attempts (design §6.3). */
  "qayaba.auth.method": str("How a login attempt signed in: discovery or seed."),
  "qayaba.auth.attempt": int("The attempt number within the login's preparation."),
  "qayaba.auth.outcome": str("authenticated, failed, inconclusive, setup-failed or precondition."),
  "qayaba.auth.precondition_kind": str("The precondition kind of a login that could not be completed."),
  "qayaba.auth.restored": bool("The login script in use was restored from the suite store."),
  "qayaba.auth.demoted": bool("A restored login was demoted earlier in this run."),
  "qayaba.auth.demoted_reason": str("Why the restored login was demoted: login-did-not-sign-in or other."),
  "qayaba.egress.denied": spec("string[]", "Hosts the egress filter refused while the login ran, apart from those the app blocks on purpose.", "high", "redacted-text"),
  "qayaba.egress.denied_intentional": spec("string[]", "Refused hosts the app declares as blocked on purpose.", "high", "redacted-text"),

  /* Suite store (design §4.2). */
  "qayaba.suite_store.restored": int("Files written into the working copy by a restore."),
  "qayaba.suite_store.restored_digest": str("A sha256 of the set of files (path and content hash) the restore put back; equal for runs that started from the same suite."),
  "qayaba.suite_store.overlaid": int("Tracked files whose unpublished change was put back."),
  "qayaba.suite_store.tracked_wins": int("Stored files left out because git tracks the path with other content."),
  "qayaba.suite_store.auth_restored": bool("The stored login was put back."),
  "qayaba.suite_store.entries": int("Entries the store holds after a capture."),
  "qayaba.suite_store.admitted": int("Entries added or changed by a capture."),
  "qayaba.suite_store.dropped": int("Entries removed by a capture."),
  "qayaba.suite_store.skipped": int("Files seen but not admitted by a capture."),
  "qayaba.suite_store.skip_reasons": spec("string[]", "The distinct reasons files were not admitted, from a closed set."),
  "qayaba.suite_store.reason": str("Why the stored login was demoted: login-did-not-sign-in or other."),

  /* Validation (design §6.2). */
  "qayaba.validate.check": str("The static check: typecheck, lint, list or manifest."),
  "qayaba.validate.ok": bool("The check passed."),
  "qayaba.validate.errors": int("Errors the check reported."),
  "qayaba.validate.infra": bool("The check failed for an infrastructure reason."),
  "qayaba.validate.first_error": str("Where a failed typecheck or lint's first error is: file:line:column and its rule or code.", "high"),
  "qayaba.catalog_gate.fabricated": int("Test ids a spec uses that a captured, settled route does not have (the gate fails closed on them)."),
  "qayaba.catalog_gate.in_window": int("Test id selectors the gate checked against a captured, settled route."),
  "qayaba.catalog_gate.advisory": int("Test id selectors the gate could only note, not check (route not captured or settled, or past the confident window)."),
  "qayaba.preexec.ambiguity_catches": int("Selector ambiguities the pre-execution advisory counted."),

  /* Execution, synthesized from the Playwright JSON report (design §6.2). */
  "qayaba.spec.file": text("A spec file of the suite, relative to the suite directory (the report is written by the test process)."),
  "qayaba.spans.synthesized_dropped": int("Spans a report would have produced that the per-report and per-run caps left out."),
  "qayaba.test.name": text("A test case's title chain."),
  "qayaba.test.status": str("passed, failed, flaky, skipped, timedOut or interrupted."),
  "qayaba.test.failure_category": str("selector, auth, data_state, timeout, assertion, infra or egress."),
  "qayaba.test.retries": int("Retries the case used."),
  "qayaba.test.http_status": int("The HTTP status of the page the case ended on, harvested from the capture dump."),
  "qayaba.test.network_error_count": int("Failed requests the page depends on (its own or a declared origin; document, fetch, xhr, script, style sheet), harvested from the capture dump. Background and third-party failures are not counted."),
  "qayaba.test.network_class": str("egress, backend, dns or other, derived from the harvested page-dependent network errors and the run's egress report."),
  "qayaba.test.attempt": int("The attempt number of a case (0 is the first run)."),
  /* An attempt's failure-point capture (the fixture's dump of that retry), on its qayaba.attempt span. */
  "qayaba.failure.captured": bool("The attempt that did not pass left its failure-point capture; false when the execution captured failure points and this attempt's is missing."),
  "qayaba.failure.final_url": text("The address the page was on when the attempt failed."),
  "qayaba.failure.http_status": int("The HTTP status of the page the attempt failed on."),
  "qayaba.failure.result_count": int("The result count the app's declared data state showed when the attempt failed."),
  "qayaba.failure.data_in_flight": int("Data requests (fetch/xhr) still in flight when the attempt failed."),
  "qayaba.failure.quiet_ms": int("Milliseconds since the last data response when the attempt failed."),
  "qayaba.failure.tree_stable": bool("Whether the accessibility tree was the same on a second read a moment after the failure."),
  "qayaba.failure.runtime_error_count": int("Console errors and uncaught page errors the page had raised when the attempt failed."),
  "qayaba.failure.runtime_error": text("The first runtime error the page raised before the attempt failed."),
  "qayaba.failure.network_error_count": int("Failed requests the page depends on before the attempt failed; fire-and-forget failures (beacons, images, fonts, media) are not counted."),
  "qayaba.failure.background_network_count": int("Failed background requests (beacons, third-party events) the page made before the attempt failed; they are not network errors of the case and are counted apart."),
  "qayaba.failure.dom_lines": int("Lines of the accessibility tree captured when the attempt failed."),
  "qayaba.failure.dom_sha256": metaHash("sha256 of the accessibility tree captured when the attempt failed (equal digests: the same page)."),
  "qayaba.selector.match_count": int("Elements a locator resolved to in a strict mode violation."),
  "qayaba.selector.strategy": str("The kind of locator that failed: testid, role, text or css."),

  /* Tool callbacks (design §5.5): the orchestrator's server span of a run_spec or authenticated-browser call. */
  "qayaba.tool.outcome": str("How a served tool call ended: for run_spec passed, failed, timedOut or error; for the browser ok; refused when the orchestrator declined it."),
  "qayaba.tool.refusal": str("The refusal code of a call the orchestrator declined (a closed set per tool)."),
  "qayaba.tool.message_id": str("The assistant message the tool reported for the call; the join key to the agent's execute_tool span.", "high"),
  "qayaba.tool.dev_writes": int("Requests a run_spec call sent to DEV that write."),
  "qayaba.lease.wait_ms": int("Milliseconds the call waited for the test account's lease."),
  "qayaba.lease.refused": bool("The call was refused because DEV was busy (the account's lease was not obtained)."),
  "qayaba.namespace": str("The namespace a run_spec call's data was created under.", "high"),
  "qayaba.spec.path": text("The confined spec path a run_spec call named, relative to the spec directory."),
  "qayaba.spec.sha256": metaHash("The sha256 of the spec bytes a run_spec call ran."),
  "qayaba.browser.action": str("The authenticated browser action: navigate, snapshot, click or type."),
  "qayaba.browser.blocks": int("Requests the route guard blocked during the call."),
  "qayaba.browser.block_reasons": spec("string[]", "The route guard's reasons for the requests it blocked (a closed set)."),
  "http.response.status_code": int("The status of the main document a browser call loaded."),
  "qayaba.auth.invalidated": bool("The call found the saved session gone."),
  "qayaba.auth.renewed": bool("The session was renewed after the call found it gone."),

  /* Langfuse viewing aids, set on the root. */
  "langfuse.trace.name": str("Langfuse trace name."),
  "langfuse.session.id": str("Langfuse session id.", "high"),
  "langfuse.trace.tags": spec("string[]", "Langfuse trace tags: the app and the run mode."),
  "langfuse.environment": str("Langfuse environment."),
  "langfuse.observation.type": str("Langfuse observation type: agent, generation, tool or span."),
  "langfuse.observation.usage_details": spec("string", "Langfuse usage buckets of a generation, as JSON (exclusive: input excludes the cache, output excludes reasoning)."),
  "langfuse.observation.cost_details": spec("string", "The provider-reported cost of a generation, as JSON."),

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
