# RFC-0010: Derive a tool call's record from its outcome (N12)

- **Status:** Accepted, 2026-10-28 ([ADR-0012](../adr/0012-owner-decisions-rfc-0002-0010.md))
- **Code references at 4105c582:** `qa-engine/src/contexts/generation/infrastructure/sse/call-efficiency-tracker.ts`, `qa-engine/src/contexts/generation/infrastructure/sse/activity-mapper.ts`, `qa-engine/src/contexts/generation/infrastructure/sse/event-stream.ts`, `qa-engine/src/contexts/generation/infrastructure/telemetry/turn-children.ts`, `qa-engine/src/contexts/generation/infrastructure/agent-transport-policy.ts`, `qa-engine/src/contexts/generation/domain/tool-sequence.ts`, `qa-engine/src/contexts/generation/domain/turn-trace.ts`, `qa-engine/src/contexts/generation/domain/call-sequence.ts`, `qa-engine/src/shared-kernel/telemetry/attribute-registry.ts`, `qa-engine/src/shared-kernel/contract/events.ts`, `qa-engine/src/contexts/coordination/infrastructure/adapters/delegation-workspace.adapter.ts`, `src/integrations/opencode-client.ts`, `src/telemetry/otel-telemetry.adapter.ts`, `src/server/run-events.ts`, `src/contract/commands.ts`, `docs/observability-design.md`
- **Related:** [ADR-0001](../adr/0001-design-pillars.md), [ADR-0002](../adr/0002-architecture-direction.md), [ADR-0011](../adr/0011-root-cause-fix-policy.md), [RFC-0004](./0004-log-level-from-outcome.md) (H11, the nearest neighbour, not the same slice: see Recommendation), [RFC-0003](./0003-coverage-dump-harvest.md) and [RFC-0005](./0005-suite-store-single-writer.md) (no shared file or cause), [RFC-0002](./0002-platform-steps-0-1.md); by title, in the same wave: [RFC-0008](./0008-acceptance-records-what-it-ran.md), [RFC-0009](./0009-pack-record-matches-prompt.md)

## Summary

1. Cause N12, confirmed by both refuters in a narrower form: the record of a runtime-native tool call (span, sequence entry, run event) is built from the call's input and its status. The runtime's error text, and the attempted tool and message of an `invalid` call, reach the engine and enter no record (4105c582).
2. Effect, on diagnosis only (no code decides from failure text): 50 of 50 failed, denied or invalid `execute_tool` spans in the history database (22 runs, epochs O0b to main) carry the same ten keys (nine for `invalid`), no event and no message. The investigation could not say why 10 `invalid` calls happened; the operator cannot tell a failed read from a good one in `/turns`.
3. Proposal (O2): derive one closed `ToolOutcome` from the tool part, once; the span, the sequence entry and the run event read it. The message is redacted where the target is and exported as a registered text attribute. No new module, no log line.
4. The same class is alive at two more sites: the run-event detail reads fields an error state does not have (40 of 40 generic), and the counters record every call as `completed`. The first is in scope; the second is the owner's call (N5).
5. Not one slice with H11: the mechanism is related, no file or type is shared. The owner settles N1 to N8 below.

## Problem

Evidence labels: a statement without a label is confirmed (the file was opened at 4105c582, or the fact was read from the history database for this record); a hypothesis is marked. "Refutation" means the two independent refutations of N12 in the investigation's narrowing round; what only they report is said so.

### The cause, as confirmed

A tool call is recorded by whoever reads the input: the tracker takes a target from `toolCallSubject(input)` and a status from the part, and nothing derives what happened to the call from the part's answer. Both refuters confirmed this and narrowed it in four ways:

- It is the error text of runtime-native calls that is never kept, not outcome in general. The record keeps outcome where a consumer reads it: `status`, `denied`, the navigation outcome (`navOutput`), a read sample and a code-graph answer (`call-efficiency-tracker.ts:562-574`).
- Engine-served tools are not affected. `run_spec`, the authenticated browser and the code-graph tool keep their outcome on a linked server span: 969 spans carry `qayaba.tool.outcome` (run_spec passed 84, failed 51, refused 28, error 3; authenticated browser ok 698, refused 43; code graph ok 62).
- For `invalid` the record keeps the replacement tool name (`execute_tool invalid`) and loses the attempted tool and the message.
- The count is 50 of 50 (35 `error`, 5 `denied`, 10 `invalid`), re-counted from the history database for this record; the narrowing round counted 33 of 33 over an earlier harvest.

### The causal chain, checked at 4105c582

| # | What happens | Where |
|---|---|---|
| 1 | The runtime sends the error. The SDK's error state is `{ status, input, error: string, metadata?, time }` (`ToolStateError`, `@opencode-ai/sdk` 1.17.7, `package.json:49`) and the tracker declares `state.error` (`call-efficiency-tracker.ts:63`). The 5 `denied` spans prove the string arrives: a denial is detected only by a pattern on it. | `call-efficiency-tracker.ts:521`, `tool-sequence.ts:78-83` |
| 2 | The tracker reads the error for one decision, whether the runtime refused the call under a permission rule, and for the answer of a navigation call (kept bounded, never exported). A call whose first sighting is an error is dropped; a test pins that on purpose. | `call-efficiency-tracker.ts:521-524`, `:562-567`, `:527`; `call-efficiency-tracker.test.ts:123` |
| 3 | Everything else about a failed call is its status plus a target from the input. `toolCallSubject` states that "content, text and bodies are deliberately not read", and its key lists do not include `tool` or `error`, so an `invalid` call gets target `null`. | `tool-sequence.ts:51-77`, `call-efficiency-tracker.ts:292-302` |
| 4 | The sequence entry has no status and no outcome beyond `denied`. A failed read is `{ tool: "read", target }`, the same as a good one. The API view matches. | `tool-sequence.ts:14-21`, `commands.ts:1042-1048` |
| 5 | The `execute_tool` span emits operation, tool name, call id, bucket, status, target, step and time source. An `invalid` call is recorded `completed` (the runtime's own state). The registry describes the status as "How the call ended: completed, error or running" and omits `denied`, which this line also writes. | `turn-children.ts:110-125`, `attribute-registry.ts:282` |
| 6 | No other channel holds the text. The run event is generic (site A below). The runtime's copy is deleted when the session is disposed. The documented channel, OpenCode logs carrying "tool errors" to Loki, is empty (the refutation read 33 Loki lines and 27,694 runtime log lines for 2026-10-26 to 10-28, none a tool error; not re-queried for this record). | `agent-transport-policy.ts:639`, `:655`, `opencode-client.ts:675-677`, `observability-design.md:742` |
| 7 | The stance on input is deliberate ("never what it typed or wrote"); extending it to the runtime's answer was never decided, and the default capture mode is documented to ship "error messages (redacted, capped at 1 KB)". | `commands.ts:1050`, `observability-design.md:706` |

Step 3 for `invalid` rests on the refutation's reading of the pinned runtime binary: the call's input is `{ tool: <attempted>, error: <message> }`. I did not re-read the binary; the recorded `{"tool":"invalid","target":null}` is consistent with it. The proposal below fails soft if the shape differs.

The code is the same at every epoch head. The refutation hashed the three files at eleven heads (O0b to main) and ran a probe at five trees (O0b, O3, O8, O10, main): the message survives in no field at any of them. I re-ran that probe against a tree equal to 4105c582 for the four files involved: 3 of 3 pass, i.e. the absence reproduces.

### The same class at two more sites (4105c582)

**A. The run event reads the wrong fields.** `toolActivity` turns an error part into `agent.error` with `detail: cap(state.output || state.title || "tool X failed")` (`activity-mapper.ts:66-68`). The local state type has no `error` (`:18-23`) and the SDK's error state has no `output` or `title`, so the detail is always the generic text. History: 40 of 40 tool-failure events read `tool <name> failed` (the 44 `agent.error` events are those 40 and 4 others). The sibling branch keeps its text: `session.error` becomes `cap(String(p.error))` (`:126-127`). An `invalid` call is `completed`, so it raises no event at all. Probe at main: `[{"type":"agent.error","detail":"tool read failed"}]`.

**B. The counters record every call as `completed`.** `toCallRecord` and `toReadWriteEvent` set `status: "completed"` for every call (`call-efficiency-tracker.ts:310`, `:324`). So a failed edit counts in the write bucket and a failed repeated read counts as a duplicate. Probe at main: two failed reads of one path and one failed edit give `totalCalls` 3, `writeCount` 1, `duplicateCallCount` 1. In production, run `run-ed28973-mvptanac-2600fbd4` (O5, `f96f958f`) has 4 `execute_tool edit` spans, one of them `error`, and the `/turns` row of its author turn 34 reports `write_count` 2 for a sequence that lists one `write` and one `edit` and no status, so the history cannot say which edit failed (the refutation placed the failed edit inside that turn by timestamp; not re-run). Whether counting a failed attempt is wrong is a measurement question, not a defect shown here (N5). Note the constant is load-bearing: `firstSeenInOrder` counts a call only at a `running` or `completed` sighting (`call-sequence.ts:46-53`), so passing the true status would drop failed calls from every count.

A third reading was found and is not a record site: the status of an engine-served tool's `execute_tool` span is the runtime's transport status, `completed` for a refused `run_spec` (104 of 104, per the refutation, not re-run). The outcome is on the linked server span. It is named in Out of scope.

### The runs

All name-webapp. The record shape is a code constant, so a run adds only "the constant fired"; epochs are listed because the ADR-0011 rule asks for them. Failed spans re-counted from the history database.

| Run | Engine code | Failed spans | What the record keeps |
|---|---|---|---|
| #24 `run-ed28973-mvr4s6br-7cfce5f0` | O8 `27238792` | 2 read errors | status `error` + target; run event `tool read failed` |
| #26 `run-ed28973-mvra9a3s-09df0987` | O9 `58151b36` | 2 read errors | the same; `/turns` entry `{tool: read, target}` |
| #27 `run-ed28973-mvruzwli-8bb3adcd` | O10 `bd1d2e46` | 1 read error | the same |
| #28 `run-ed28973-mvrwjx2d-1bf83af5` | O10 | 2 `invalid` | `completed`, nine keys, no target; `/turns` `{tool: invalid, target: null}`; no event |
| cycle 3: `run-ed28973-mvs0onsn-6ad17f30`, `run-ed28973-mvs2ukug-c82da7be`, `run-ed28973-mvs49h5y-acdab309` | O11 `40513c1e` | 3 + 3 + 3 (reads, 1 `denied` grep, 2 `invalid`) | the same shapes |
| baseline `run-ed28973-mvs7oo0f-17041c71` | `4105c582` | 2 `invalid` of 326 `execute_tool` spans | `completed`, nine keys, no target; no `agent.error` event |

Across the history database: 5,359 `execute_tool` spans; 35 `error` (21 `read`, 13 `grep`, 1 `edit`), 5 `denied` (2 `read`, 1 `glob`, 2 `grep`), 10 `invalid`, in 22 of the 34 runs with spans. Every one has `events` empty and no status message. Falsifiability: this is deterministic code, so holding is expected; the evidence is the probe and the absence of a counterexample (no span with the text, no other sink found), not the run count.

### What it does not explain

- Any failed test, verdict, coverage or review result. Nothing decides from failure text. The one reader is the navigation classifier, which takes a failed navigation call's bounded answer and writes a span label (`qayaba.nav.outcome`, `turn-children.ts:120`); a search of production code finds no reader of that label. A call's status feeds only the span label and that classifier (`turn-children.ts:117`).
- Why the 50 calls failed. The grep errors have a parent absent from the sidekick workspace (H08, plausible); reads of paths absent from the app commit are model guesses (four checked in the refutation, not re-checked here).
- The thrown-turn record (H02), the `run_spec` answer that dropped a spec's load error (`8f4a4519`, patched).

### What the missing outcome cost

- **The investigation.** It could not establish why 10 `invalid` calls happened. 5 of the 10 are the first call of an author turn (history `tool_sequence`, index 0; the other 5 are 4 later author calls and 1 lead call); without the message nothing says whether that is a model argument error or an engine contract mismatch such as a hidden tool (hypothesis; the evidence is the lost field). The causes of 13 `grep` and 21 `read` errors were inferred from the target, by joining spans with `/turns` scopes and checking the app commit, instead of read. Absence itself took three negative searches (runtime store: 0 sessions; runtime log: no tool-failure line; Loki: none), all reported by the refutation.
- **The operator.** `/turns` shows a failed read as a good read (only `denied` is marked); the live event says "tool read failed" with no reason; after the turn nothing holds the reason. The design doc sends the operator to a Loki channel that is empty, which is how the gap stayed undetected.
- **What it did not cost.** The agent saw every error in its own session; no verdict moved. This is the H11 shape: a diagnosis defect.

## Goals and non-goals

**Goals**

- A failed, denied or invalid call's span, sequence entry and run event say what happened, from one derivation.
- The message is redacted before it leaves the tracker and again at the span; nothing decides from its text.
- A test fails when a consumer reads the part's outcome by hand again.

**Non-goals**

- Changing which calls count (N5), the `error`-first drop (`:527`), or any verdict.
- A Loki line for tool errors, or a collector channel.
- Retaining the runtime's session.

## Options

### O0. Reword the doc, change no code

Make `observability-design.md:742` say the tool error is not shipped.

- **Removes:** the false promise.
- **Adds:** a sentence.
- **Risk:** the loss stays; the next investigation pays it again.

### O1. Add an optional `error` string at each reader

Give the span, the sequence entry and the mapper their own `error` field, read from `state.error`.

- **Removes:** the missing text for failed calls.
- **Adds:** three hand-written readings of one part, with `invalid` still unexpressible (a completed call whose meaning is in its input).
- **Risk:** the cause stays: the next consumer reads another field. Treats the symptom (ADR-0011, rule 2).

### O2. One derived outcome, read by every consumer (recommended)

A pure function derives a closed `ToolOutcome` from the tool part once; each consumer reads the outcome, not the part. Detail under Recommendation.

- **Removes:** the three divergent readings (tracker: denial pattern only; mapper: `output`/`title`; span: status), the silent `invalid`, and the denial special case as a separate flag.
- **Adds:** one closed type, one function, two registered attributes, two optional contract fields.
- **Risk:** low and additive; the contract change is optional fields. `qayaba.tool.status` of an `invalid` call changes from `completed` to `error` if N3 is answered as recommended.

### O3. Keep the runtime's sessions, read the store at analysis time

Do not delete the session at dispose.

- **Removes:** the unrecoverable copy.
- **Adds:** unbounded runtime state and a second reader of a store the engine does not own; the reaper rules exist because sessions leaked (`agent-transport-policy.ts:639-655` is the cleanup).
- **Risk:** high for a diagnostic gain a span gives for free. Rejected.

### O4. Capture the whole tool part in `full` mode

Export `state` as content.

- **Removes:** the loss, in `full` capture only.
- **Adds:** a content-class payload up to 32 KB per call, with the input echoed.
- **Risk:** the default mode (`metadata`) still loses it, and a bigger redaction surface. Rejected.

## Recommendation

**O2**, with N1 to N8 for the owner.

**The rule.** A tool call's record says what happened to the call, derived from the part once. The input says what it pointed at; the outcome says how it ended.

**The type.** A closed union, final names for the implementation:

| Kind | When | Carries |
|---|---|---|
| `completed` | status `completed`, not the `invalid` pseudo-tool | nothing |
| `failed` | status `error`, not a denial | message (redacted, capped) |
| `denied` | status `error` whose text is the permission-rule wording | message (the wording names the rules, fixture at `call-efficiency-tracker.test.ts:1001-1002`) |
| `invalid` | the runtime's repair pseudo-tool | attempted tool, message (absent if the runtime gave none) |
| `running` | seen, never finished | nothing |

**Consumers.**

| Consumer | Today | With the outcome |
|---|---|---|
| `execute_tool` span: `qayaba.tool.status` | `completed`/`error`/`running`, or `denied` from a flag | derived from the kind (`invalid` becomes `error`, N3) |
| span: `qayaba.tool.error` (new, text class) | none | the message of `failed`, `denied`, `invalid` |
| span: `qayaba.tool.attempted` (new) | none | the attempted tool of `invalid` |
| sequence entry (`/turns`, history) | `tool`, `target`, `scope`, `window`, `denied` | plus optional `outcome` (the kind) and `attempted`; `denied` stays (N4); no message (N1) |
| run event | generic `tool X failed`; nothing for `invalid` | `agent.error` with the message for `failed` and `denied` (N2); `invalid` unchanged |
| `deniedCallCount` | set size of a flag | counts the `denied` kind; same value (pinned by `call-efficiency-tracker.test.ts:1012`, `:1033`) |

**Shape of the change.**

1. A domain module beside `tool-sequence.ts` holds the type and the pure derivation over a neutral shape (`status`, `error`, `output`, `tool`, `input`). The OpenCode-specific literals (the `invalid` tool name, the denial wording) live in one adapter-side function in `generation/infrastructure/sse`, so another runtime strategy brings its own mapping (N8). `isPermissionDenial` moves there from `tool-sequence.ts:78-83`.
2. The tracker computes the outcome at each sighting and keeps it on the tracked call. Counting is unchanged (N5): the outcome rides beside the existing record.
3. `toolAttrs`, `toSequenceEntry` and the mapper read the outcome. The mapper's local state type gains `error` through the shared derivation, not a second hand-copied field.
4. `qayaba.tool.error` and `qayaba.tool.attempted` are registered in `attribute-registry.ts` (the registry makes an unregistered key fail to compile). Contract fields are optional.
5. Docs: `observability-design.md:742`, `commands.ts:1050` and the registry text for `qayaba.tool.status` say what is now true.

**Redaction of the error text.** The text is untrusted input from tool execution over a workspace the agent influences (AGENTS.md, Invariants: "What the agent writes or reports is untrusted input"). Tool errors may echo absolute paths, file excerpts and URLs (hypothesis: which tools echo what was not enumerated; no sample of a real message exists, that is the problem). The record applies the existing layers, in order:

1. **At entry, in the tracker:** a bounded prefix goes through `sanitizeText` and a cap, exactly as `safeTarget` treats a target (`call-efficiency-tracker.ts:274-283`); a fault in redaction yields the marker `[redacted]`, never the raw text. This is the only place the message is built, so there is no path from the raw `state.error` to a record.
2. **At the span:** the attribute is registered in the `redacted-text` class (`attribute-registry.ts:26`). The adapter applies the run's by-value scope, then the outbound sanitizer, then the 1,024-character cap, and exports it in `metadata` (the default) and `full` capture, never in `off` (`otel-telemetry.adapter.ts:356-365`, `:367-383`). That matches the documented default (`observability-design.md:706`). The span ledger mirrors the exported attributes into the history database, as it does for `qayaba.tool.target`.
3. **At the run event:** the store's pattern sanitizer runs at publish (`run-events.ts:22-30`, `:61`). It is pattern-only: the by-value scope is not applied on this path, the same as the existing `session.error` text (`activity-mapper.ts:127`). The agents container never holds the test account (AGENTS.md, Invariants), which bounds the by-value risk (hypothesis; the by-value coverage of the event path was not traced). Cap 200, as the mapper's `cap` does today.
4. **Logs:** no log line is proposed, so "Logging is redacted at the port" has nothing new to cover. A tool call is a span fact: under the rule at `observability-design.md:739-740` a line restating it ships nothing, and under RFC-0004's table a failed call is `carried-on` (warn). Both hold if the owner later asks for a line.
5. **Never a decision input:** nothing decides from the text. The one text-keyed decision, the denial wording, stays in the single classifier; consumers branch on the kind.

**Why it is the smallest change that removes the cause.** The cause is that nobody owns "what happened to this call": three consumers each pick from the part what they need (tracker: a denial pattern and a navigation answer; mapper: two fields the error state lacks; span: status). One derivation replaces the three readings; the type is justified by an evidenced need, not by taste: `invalid` is a call whose meaning sits in its input and whose status lies, which an optional `error` string (O1) cannot express, and `denied` already exists as a flag derived from the text. The added surface is one type, one function and two optional fields. It covers every site of the class that exports a call's outcome (span, sequence entry, run event). The counters (site B) are left alone on purpose, because changing them moves existing numbers (N5); that is the one place the class is named and not removed.

**Why it is app-agnostic.** The tracker runs for any app and any tool. On another app the mechanism shows the same way. On a Spring app (hypothesis, not run), reads and greps under `target/`, `build/` and `.gradle` fail for the same engine-induced reason that `node_modules` does here: those directories are not copied into a sidekick's workspace (`delegation-workspace.adapter.ts:44-47`). Only the message separates that class from a model guess. No branch names an app, a framework or a model; the only provider-shaped parts are the `invalid` name and the denial wording, kept in one adapter-side function.

**Where it lives in the engine and platform layout.** The type and derivation: `qa-engine` context `generation`, domain (pure, no import outward). The OpenCode mapping: `generation/infrastructure/sse` (already the strategy-specific adapter). The attributes: the kernel registry, which every span already uses. The contract fields stay in `src/contract/commands.ts` and move with the wire contract at platform steps 4-6 (`docs/engine-platform-architecture.md`, `entrypoints/`). This slice moves nothing out of `src/`: the decision is already in the engine. ADR-0002 addition 1 (discriminated unions) gets a second evidenced edge here (the `invalid` status that lies, F-C), and addition 8 (fitness functions) a small one: a consumer map `satisfies Record<kind, ...>` that fails to compile when a kind has no reading.

**Relation to H11 ([RFC-0004](./0004-log-level-from-outcome.md)).** Both are an emitter choosing what a record says while the typed outcome sits beside it. Different causes (a level constant; a field nobody reads) and different surfaces: RFC-0004 edits the logger port, run-orchestration, coordination and the suite store; this RFC edits only `generation`, the registry and the wire contract. They share no file, type or test, and RFC-0004 is waiting on the owner's F1 to F5. They share one doc region (`observability-design.md:737-742`: RFC-0004 rewrites `:737` against `:739-740`, this RFC `:742`), so the second to land rebases a few lines. Recommended: two slices, order free, not one (N7).

## Patches it supersedes

No past commit stored the message; the denial detection patches (`707d379a`, `00b486f7`) and the tracker origin (`dbc8b2cc`) kept the same projection. What the fix removes:

- the denial flag and its set as a separate path from the outcome: `call-efficiency-tracker.ts:521-524` (the `denied` boolean on the tracked call and `deniedIds` become the kind; `deniedCallCount` keeps its value)
- the pattern's home in the domain: `tool-sequence.ts:78-83` (moves to the adapter-side classifier)
- the status expression that mixes a flag and a status: `turn-children.ts:117`
- the wrong-field detail: `activity-mapper.ts:66-68`, and the second hand-copied part shape `activity-mapper.ts:18-23`
- the doc promise: `observability-design.md:742`; the registry text that omits `denied`: `attribute-registry.ts:282`; the contract comment that reads as if the answer were out of bounds: `commands.ts:1050`
- not removed: `status: "completed"` at `call-efficiency-tracker.ts:310`, `:324` (stays unless N5 is answered "no"), and the error-first drop at `:527` (pinned by `call-efficiency-tracker.test.ts:123`; AGENTS.md:20-21 asks to confirm a guard is not deliberate)

## Test plan

Per the testing standards: a RED test through a public seam that fails for the bug's reason, with a decisive fixture. The turn rig of `src/telemetry/agent-turn-trace.test.ts` (its `tool` helper takes no `error` today and gains one) drives a whole turn and reads real spans.

| Rule | Test, through the public seam | Fails today because |
|---|---|---|
| A failed call's span says why | the rig turn with a `read` that errors with a distinctive message; assert the `execute_tool read` span has status `error`, its target and `qayaba.tool.error` containing the message | the span has ten keys and no message (`turn-children.ts:110-125`) |
| An `invalid` call is not silent | the same rig with an `invalid` call whose input names an attempted tool and a message; assert `qayaba.tool.attempted`, `qayaba.tool.error`, status `error` (N3) and the sequence entry's `outcome` | nine keys, status `completed`, no target |
| A denied call keeps the rule it hit | a denial with the fixture wording; assert the kind, the message on the span and `deniedCallCount` 1 | only `denied: true` survives |
| The live event says why | `mapOpencodeEvent` on an error state carrying `error`; assert the detail starts with the message and is capped; a state with no text still reads `tool X failed`; `session.error` unchanged | the detail is always `tool read failed` (`activity-mapper.ts:66-68`) |
| The message never leaves raw (guard) | the rig and the mapper with a message holding a pattern-matching secret and a run-secret value; assert neither appears in span attributes, the sequence entry or the published event, and a throwing redactor yields `[redacted]` | green before the change (no text exists) and red on an implementation that copies `state.error` raw; the guard is written with the feature, not before |
| Previous behavior holds | `CallEfficiencyTracker`: denial counted once whether or not it ran; error-first call absent from the sequence; two failed reads and a failed edit give the same `totalCalls`, `writeCount`, `duplicateCallCount` as today (N5) | green before and after: pins what the change must not move |

Differential check (ODD): run the recorded event streams of the baseline through the base commit and the change; the difference is the new attributes, the optional entry fields and the event detail, and the counters are equal. The ownership guard: the consumers' mapping over the kind is `satisfies Record<ToolOutcome["kind"], ...>`, and a text scan (the precedent is `failure-scan.test.ts` under `qa-engine/test/contexts/run-orchestration/application/run-flow`) fails when a module outside the classifier reads `state.error`. The scan is the weakest guard; the type is the strong one.

## Measurement

The proof is the RED tests: the record shape is a constant, so a run measures only the direction. The signal on a run is the share of its failed, denied and invalid `execute_tool` spans that carry `qayaba.tool.error` or `qayaba.tool.attempted`, read from `run_spans`.

| | Failed/denied/invalid spans with a message or attempted tool | Source |
|---|---|---|
| Before, all 50 spans in 22 runs (O0b to main) | 0 of 50 | history database |
| Before, baseline `run-ed28973-mvs7oo0f-17041c71` (`4105c582`, pass) | 0 of 2 (both `invalid`, 326 spans) | history database |
| After, one replicate on the fix, same 12-entry snapshot, freeze off | expected 2 of 2 if invalid calls recur; any other failed call counts | to be measured |

One against one shows a direction, never proof (ADR-0011, rule 4). The trigger may not recur: 22 of the 34 runs with spans carried a failed call, so a replicate with none is likely enough (hypothesis; no rate is claimed) to leave the fix "unproven", as ADR-0011 says of an unfired trigger. If it fires, the first use is the open question: the message of the baseline's kind of `invalid` call answers whether they are model argument errors or an engine contract mismatch.

## Owner decisions needed

- **N1. Where does the message live?** Recommended: on the span only (Tempo, and `run_spans` through the ledger), plus the closed `outcome` kind and `attempted` on the sequence entry; the message does not go into `agent_turns` or the API. Alternative: add it to the entry, which puts redacted error text in the history table and the `/turns` response, pattern-redacted at the tracker only (no by-value scope there).
- **N2. Does the live run event carry the message?** Recommended: yes for `failed` and `denied` (cap 200, pattern sanitizer at publish; same trust class as `session.error`); `invalid` keeps today's activity event. Alternative: spans only.
- **N3. What is `qayaba.tool.status` for an `invalid` call?** Recommended: `error`, because the registry defines it as how the call ended and no code reads it. Alternative: keep `completed` (the runtime's word) and let the kind carry it. Either way history before and after differs for these 10 spans.
- **N4. Contract.** Recommended: add optional `outcome` and `attempted` to `ToolSequenceEntryViewSchema` and keep `denied` for now (additive, regenerated contract). Alternative: replace `denied` with `outcome`, a breaking change for consumers of `/turns`.
- **N5. Do failed calls keep counting as calls?** Recommended: yes, unchanged in this slice (a failed write was an attempt; changing it moves `writeCount`, `duplicateCallCount` and the buckets, whose consumers I did not enumerate). Alternative: count by outcome, with a differential check on every grader that reads them.
- **N6. The Loki promise (`observability-design.md:742`).** Recommended: reword to what exists (the span) and add no Loki line. Alternative: build the OpenCode log channel the doc describes; the refutation found the runtime logs no tool failure at any level.
- **N7. Same slice as H11?** Recommended: no, two slices in either order; they share only a doc region.
- **N8. Where do the provider-shaped literals live?** Recommended: the `invalid` tool name and the denial wording in one adapter-side function (move `isPermissionDenial` out of the domain). Alternative: leave the wording in the domain and add the `invalid` literal beside it.

## Out of scope

- Why the 50 calls failed. The sidekick workspace omits dependency and build directories (`delegation-workspace.adapter.ts:44-47`); whether the 13 greps and the `invalid` calls are model errors or engine-induced is H08, plausible. The fix makes the question answerable and decides nothing.
- A call whose first sighting is an error (`call-efficiency-tracker.ts:527`). No run shows it (all 50 failed spans were seen running first, per the refutation); a test pins it as deliberate.
- Whether failed calls should count as calls (N5), and any grader or gate that reads failure text. Nothing does today.
- The transport status of engine-served tools (`qayaba.tool.status` is `completed` for a refused `run_spec`; the outcome is on the linked server span, `attribute-registry.ts:418`). A separate naming question; N3 and the registry text touch it only in wording.
- Retaining the runtime's session (O3), and other runtime strategies' failure shapes.
- A log line or alert for tool errors. Production alert rules: none found in the repository.
