# RFC-0004: Derive the log level from the typed outcome (H11)

- **Status:** Accepted, 2026-10-28 ([ADR-0012](../adr/0012-owner-decisions-rfc-0002-0010.md))
- **Code references at 4105c582:** `qa-engine/src/shared-kernel/ports/logger.port.ts`, `qa-engine/src/shared-kernel/ports/process-logger.ts`, `qa-engine/src/shared-kernel/coordination.ts`, `qa-engine/src/shared-kernel/telemetry/attribute-registry.ts`, `qa-engine/src/contexts/run-orchestration/application/run-qa.use-case.ts`, `qa-engine/src/contexts/run-orchestration/domain/helpers/precondition-terminal.ts`, `qa-engine/src/contexts/run-orchestration/application/run-flow/failure-policy.ts`, `qa-engine/src/contexts/run-orchestration/application/run-flow/run-state.ts`, `qa-engine/src/contexts/run-orchestration/application/run-flow/phases/setup.steps.ts`, `qa-engine/src/contexts/run-orchestration/application/run-flow/phases/review.steps.ts`, `qa-engine/src/contexts/run-orchestration/application/run-flow/phases/review-services.ts`, `qa-engine/src/contexts/coordination/application/lead-sidekicks.ts`, `qa-engine/src/contexts/coordination/application/flow-outcomes.ts`, `qa-engine/src/contexts/coordination/application/coordination-telemetry.ts`, `qa-engine/src/contexts/coordination/infrastructure/adapters/coordination-telemetry-trace.ts`, `qa-engine/src/contexts/workspace-and-publication/infrastructure/suite-store.adapter.ts`, `qa-engine/src/shared-infrastructure/process-sandbox/file-boundary.ts`, `src/server/file-boundary-check.ts`, `src/integrations/redacting-logger.ts`, `src/telemetry/log-shipper.ts`, `docs/observability-design.md`, `docs/telemetry-local.md`, `docs/lead-sidekicks.md`
- **Related:** [ADR-0001](../adr/0001-design-pillars.md), [ADR-0002](../adr/0002-architecture-direction.md), [ADR-0010](../adr/0010-maintainer-removal.md), [ADR-0011](../adr/0011-root-cause-fix-policy.md), [RFC-0002](./0002-platform-steps-0-1.md), [RFC-0005](./0005-suite-store-single-writer.md)

## Summary

1. Cause H11, confirmed in its narrow form: at nine seams the call site fixes the log level while the same seam holds the outcome (a typed value at eight, control flow at one); no rule, type or test ties the two (4105c582). The nine are the ones found; the other `error` sites were not swept.
2. Effect, on diagnosis only (no code reads a level to decide): an `ERROR` filter does not separate runs that ended from runs that carried on (13 of the 18 pass runs and 7 of the 11 other runs of #1 to #29 carry one; a count over the code epochs O0b to O10, not a rate), and run #3 logged one failed login as warn on the run's event stream and as error on the process log in the same millisecond.
3. Proposal (O2): write once what each level means, let the module that owns each outcome map it to a level, and make the seam log at the derived level. The `LoggerPort` interface is unchanged; no new module, no policy object.
4. The meaning of the levels is the owner's call (F1 to F5 below). The mechanism holds with any answer. Under the recommended F1 answer only table values change; the other F1 answer adds a fourth effect and a closed unrouted-code type (F5).
5. Not proposed: re-leveling the other `error` sites. They were not swept for an outcome beside them (a text search finds 53 whose message says the run goes on); the known members of the class are in the seams table.

## Problem

Evidence labels: a statement without a label is confirmed (the file was opened at 4105c582, or the fact was read from the run records); a hypothesis is marked.

### The cause, as confirmed

The logging port takes the level from the caller (`logger.port.ts:10-17`). No rule, type or test derives it from the typed outcome the same seam records next to the line, so the level follows the seam, not the outcome.

H11 was proposed wider and lost five parts in refutation: #24 is line placement, not severity; the #25 line reports that run's adverse final decision; `guarded` logs only for `fail-open` and `degrade`; `8d3bbafa` is not causal before O7; and "ERROR in a pass run" is not in itself a breach of a written rule. The missing rule is the defect.

The two refuters disagreed and the adjudication settled it. One confirmed the narrow form. The other refuted H11 as an explanation of the cited runs: the unrouted lines report real losses that the campaign later fixed (F10 and F11 in `odd/tasks/campaign-loop.md:75-76`, F18 at `:86`), and AGENTS.md asks that faults be surfaced loudly (`AGENTS.md:703`; "logged loudly" at `:280`). The adjudication kept that as the reason the events happen, not the reason for their level, and excluded "error is the convention for a tolerated loss": the engine's one written rule logs a carried-on failure at warn (`run-qa.use-case.ts:484`, `:488`), and one file logs a lost flow at warn when its brief does not fit (`lead-sidekicks.ts:678`), at error when its session fails (`:608`), and lost findings at error (`:1242`). Both agree that no decision was misled. That disagreement is why F1 below is the owner's.

### The causal chain, checked at 4105c582

| # | What happens | Where |
|---|---|---|
| 1 | The port offers four methods. The level is the method the caller names; no parameter or type ties it to an outcome. | `logger.port.ts:10-17` |
| 2 | A seam records its typed outcome with one statement and writes its line with another, naming a literal level. | the seams table below |
| 3 | The level also gates Loki: `warn` and `error` ship, `info` ships only with `ship: true`, and the record is labelled with the level. Before O7 (`8d3bbafa`, 2026-10-27) the console tap shipped log, warn and error alike while a span was active. | `redacting-logger.ts:82-85`, `:105`, `log-shipper.ts:56-57`, `AGENTS.md:712` |
| 4 | The design rule never says what `error` or `warn` mean, and contradicts itself on a line that restates a span fact: the table row says any warn or error ships; the sentence under the table says a fact a span records logs at info and ships nothing. | `observability-design.md:737`, `:739-740`, `logger.port.ts:8`, `docs/telemetry-local.md:73-76` |
| 5 | Nothing ties a seam's level to its outcome. The login test accepts warn or error. The fail-open test pins `console.error`, which is error. No test asserts the level of the unrouted line, of the flow-failure line or of the review lines: the tests at `lead-sidekicks.test.ts:859-867` and `run-qa.use-case.test.ts:8822-8845` assert the outcome and span attributes only. The store test passes its own `warn` writer, so the default never runs. | `run-qa.use-case.test.ts:7792`, `failure-policy.test.ts:87-99`, `lead-sidekicks.test.ts:1352`, `suite-store.adapter.test.ts:58` |
| 6 | Origin of the constants. Four are console streams copied as the port level in the logging refactors, which state "at the same text and level" (`a89c73a4`, `d2c250da`, `70d94164`, `b5b3be15`). The unrouted line was born at error on the port (`f67ef0c3`) and moved by `9aabf311`. | commit bodies; `git show <head>:<path>` |

Constants checked at the head of each code epoch (`e6c7d095`, `94f2b45e`, `f96f958f`, `e4efa50e`, `bd1d2e46`, `40513c1e`) and at 4105c582: the login line, both store writers, both pre-check lines, the unchanged line and the flow-failure line are error at every one of them; the unrouted line is error at every head from `f96f958f` on (`f67ef0c3` and `9aabf311` are not in `94f2b45e`). Tests live under `qa-engine/test/contexts`.

### The seams where the level and the outcome beside it disagree

Inclusion test: the seam writes a fixed level and, in the same branch, holds the outcome (a typed value, or control flow for the store). The nine below were found by reading the files this RFC edits and searching their `error` calls; the other `error` sites were not swept.

| Seam | Typed outcome beside the line | Level today | What the engine's own code says |
|---|---|---|---|
| Failed login | `terminalForPrecondition(mode)` gives `end` or `continue` (`precondition-terminal.ts:15-18`), read at `setup.steps.ts:73`. The run event's level is derived from it (`run-qa.use-case.ts:488`). | The process line is always error (`run-qa.use-case.ts:437`), written in `prepareAuth` before the terminal is known. | "an error when it ends the run, a warning when a context run carries on without a session" (`run-qa.use-case.ts:484`). |
| Fault carried past, 15 sites | `carryOn(err)` returns when the policy gives `fail-open` for the fault at an off-path step (`failure-policy.ts:136-138`). It returns `void`, so nothing reaches the line. | 10 at error: `ground.steps.ts:130`, `:229`, `:285`, `:295`; `run-services.ts:182`; `run-qa.use-case.ts:506`; `setup.steps.ts:136`, `:155`, `:176`, `:187`. 5 at warn: `decided-end.ts:165`, `:193`; `run-qa.use-case.ts:459`; `setup.steps.ts:34`; `fix-loop.steps.ts:427`. | The policy's answer is the same at all 15. A sixteenth `carryOn(` at `generate.steps.ts:83` ends the run (it throws at `:87`) and rightly logs error. |
| `guarded`, fail-open and degrade | `FailureAction` (`failure-policy.ts:56`) | error for both (`failure-policy.ts:118`, `:125`); `end` and `rethrow` log nothing | The run goes on, and `degrade` keeps what the run proved (`failure-policy.ts:6-8`). |
| Findings left unrouted | `unroutedReasons: [code]` recorded at `lead-sidekicks.ts:1241`, on the span as `qayaba.coordination.unrouted_reasons` (`coordination-telemetry-trace.ts:43`) | error (`lead-sidekicks.ts:1242`). `nothing()` records two more codes, `pass-released` and `no-time`, and logs nothing (`lead-sidekicks.ts:1009-1015`). | The sibling `overWindow` records a lost flow and logs warn (`lead-sidekicks.ts:675-679`). `docs/lead-sidekicks.md:388-390` documents "an error line in the log". |
| Stored suite copy unreadable | The dependency is named `warn` (`suite-store.adapter.ts:116`); the composition root passes none (`run-engine-factory.ts:1526`). The outcome beside the line is control flow: the entry is skipped and the restore goes on (`suite-store.adapter.ts:262-263`). | error through the default (`suite-store.adapter.ts:476`, `:478`) | The orchestrator's own store faults go through `announceSuite` at warn (`setup.steps.ts:34`, `run-qa.use-case.ts:459`, `fix-loop.steps.ts:427`, `decided-end.ts:193`). |
| Reviewer pre-check rejection | `decidedBy = "precheck"` (`review.steps.ts:216`, `run-state.ts:251`), on the span as `qayaba.review.decided_by` with the bounded corrections (`review-services.ts:207`, `:212`) | error: one line plus one per finding (`review.steps.ts:217-218`) | The decision and its corrections are span facts. |
| Reviewer verdict stands unchanged | `decidedBy = "unchanged"` (`review.steps.ts:188`, `run-state.ts:251`), on the span as `qayaba.review.decided_by` (`review-services.ts:207`). The run event of the same fact is level info (`review.steps.ts:190-194`). | error (`review.steps.ts:189`) | The #3 shape on a second seam: one fact, two channels, two levels. |
| A flow's session fails | `FLOW_OUTCOME.FAILED` with the reason "the sidekick's session failed" (`lead-sidekicks.ts:609`). The other flows go on and the failed one is carried beside them (`flow-outcomes.ts:2-4`). `settle` is the one place, called at `lead-sidekicks.ts:555`, `:903` and `:1102`. | error (`lead-sidekicks.ts:608`) | The sibling `overWindow` records a lost flow as `FLOW_OUTCOME.OVER_WINDOW` and logs warn (`lead-sidekicks.ts:675-679`). The run's own time spent is not a flow's failure and throws (`:607`). |
| File-boundary check passes | `verdict.holds` (`file-boundary-check.ts:99`), a `FileBoundaryVerdict` (`qa-engine/src/shared-infrastructure/process-sandbox/file-boundary.ts:32`) | error on the passing branch (`file-boundary-check.ts:100`) | The failing branch is error too (`file-boundary-check.ts:103`). |

Context, counted at 4105c582 over literal `engineLog` and `appLogger` calls in production `.ts`: 198 error (151 and 47), 177 warn, 50 info. Ten texts begin `[qa] WARNING:` and log at error: `ground.steps.ts:130`, `:180`, `:197`, `:229`, `:285`, `:295`; `review.steps.ts:151`; `provider-documents-port.adapter.ts:37`; `service-links-port.adapter.ts:43`; `resolve-cross-repo-impact.use-case.ts:104`. A one-line text search of the 198 error calls for wording that says the run goes on or the fault is non-fatal ("goes on", "continues", "non-fatal", "non-blocking", "off-path", "carries on") matches 53; some are among the seams above, none was read for a typed outcome beside it.

### What the runs show

`#N` is the investigation's run number, in timeline order, all name-webapp. The typed facts were re-read from the history database for this record (run spans, run events and run records). The Loki side is the investigation's Loki pull (32 orchestrator ERROR lines, 25 of them in #1 to #29), mapped to runs by trace id; Loki was not queried again. The multiplied time limits and the dump cap change how often a seam fires, not a level constant.

| Run (epoch, mode, verdict) | Seam | Typed fact in the same run | Loki ERROR lines |
|---|---|---|---|
| #1 `run-ed28973-mvpkbluk-e06d2a3b` (O0b `e6c7d095`, manual, infra-error) | login | run event seq 4, level error, 18:02:05.312Z, "the run ended before generation" | `auth precondition failed: kind=egress-denied`, same millisecond. The levels agree because the run ended. |
| #3 `run-ed28973-mvpkd7fc-600da1fc` (O0b, context, pass; invalid as a suite measurement) | login | run event seq 3, level **warn**, 18:02:37.085Z, "this context run continues without a session" | the same `auth precondition failed` line at **error**, same millisecond |
| #12 `run-ed28973-mvpoyt4e-6b1ff206` (O4 `94f2b45e`); #13 `run-ed28973-mvptanac-2600fbd4`, #14 `run-ed28973-mvptrv69-d4f52b7e`, #15 `run-ed28973-mvpu85em-1b65ceb1` (O5 `f96f958f`); all pass | store | `qayaba.suite_store.capture` with `dropped=1` in each | one `the stored copy cannot be read (ENOENT` line each |
| #19 `run-ed28973-mvq9r6vy-7f454004`, #20 `run-ed28973-mvqb6uob-69a66ac0`, #21 `run-ed28973-mvqc7x8j-2da31df4` (O6, `f96f958f`); all pass | unrouted | coordination events "finding(s) ... left unrouted": 10, 20 and 7 findings | one `left unrouted` line each |
| #23 `run-ed28973-mvqy1s7l-64c65862` (O7 `e4efa50e`, pass) | unrouted | `unrouted_reasons=[no-seed-use-case]`, findings 5 and 16 | one line |
| #26 `run-ed28973-mvra9a3s-09df0987` (O9 `58151b36`, diff, fail `E-EXEC-FAIL`) | flow failed | the same branch records `FLOW_OUTCOME.FAILED` (`lead-sidekicks.ts:609`); the run went on to phase `learn` (the `fail` is a test failure, not the flow's) | `flow filter-facets failed: fetch failed`, 2026-10-27T23:13:23Z |
| #27 `run-ed28973-mvruzwli-8bb3adcd`, #29 `run-ed28973-mvrxb30p-ecfe944b` (O10 `bd1d2e46`, pass) | unrouted | `no-seed-use-case` and `no-flow-took`; 22 and 24 findings (#27), 22 and 22 (#29) | two lines each |
| #28 `run-ed28973-mvrwjx2d-1bf83af5` (O10, diff, invalid `E-STATIC`) | flow failed | the same branch records `FLOW_OUTCOME.FAILED`; the run went on to phase `validate`, where the static gate ended it | `flow restaurant-list-detail failed: OpenCode API error 401 ...`, 2026-10-28T09:31:54Z |
| cycle 3 r1 `run-ed28973-mvs0onsn-6ad17f30` (`40513c1e`, flaky) | store, unrouted, `guarded` degrade | restore of 12 entries; unrouted events coded `no-seed-use-case`, `no-flow-took`, `flow-unavailable`, `no-time` | four lines: store, two unrouted (12 and 72 findings), `run-deadline fault degraded the run (deadline-after-proof)` |
| cycle 3 r2 `run-ed28973-mvs2ukug-c82da7be` (pass) | store | `qayaba.suite_store.capture` with `dropped=1` | one store line |
| cycle 3 r3 `run-ed28973-mvs49h5y-acdab309` (pass) | store, unrouted | an unrouted event coded `no-time` (1 finding), which `nothing()` records and never logs | one store line |

No line of the unchanged-verdict text is in the pull. That seam rests on the code (`review.steps.ts:189` against `:192`) and on the rig of `run-qa.use-case.test.ts:8822-8845`, whose second round it decides.

Counts over #1 to #29, recomputed from the pull and the run records: 25 ERROR lines. 16 fall in pass runs, spread over 13 of the 18 pass runs; 9 fall in 7 of the 11 other runs. Of the 16, 13 (in #3, #12 to #15, #19 to #21, #23, #27, #29) come through the seams above with the run carrying on; 2 are #25's pre-check lines and 1 is #24's maintainer line, both explained under "What H11 does not explain". Of the 9, 2 are the flow-failure lines of #26 and #28, where the run went on; the other 7 are lines whose fact ended the run (#1, #2, #5, #7, #9 and #28's static gate) and #26's maintainer line. In the pull the seam and the line match one to one: every `suite_store.capture` with `dropped>0` has its store line, every unrouted event that `leftUnrouted` records has exactly one line, and the five pass runs without an ERROR line (#4, #6, #10, #11, #17) show none of these facts (`dropped=0`, no unrouted event, no `precheck` decision).

A sibling symptom, already patched on main: in cycle 3 r1 the line said "no flow took them" for 72 findings while the summary attribute said `flow-unavailable` (`odd/tasks/campaign-loop.md:88`). `a1ea43eb` now derives the line and the code from one decision (`unroutedCodeOf`, `lead-sidekicks.ts:1116`, `:1437-1439`) and left the level at error. This RFC finishes that shape.

### What H11 does not explain

- Why the events happen: an undeclared egress origin (#1 to #3), a dangling store entry (H20, [RFC-0005](./0005-suite-store-single-writer.md)), findings no flow took (F10, F11, F18), a provider that answers 401 or a fetch that fails (#26, #28). Those are other causes.
- #24 `run-ed28973-mvr4s6br-7cfce5f0`: the maintainer's push failure is placed in the run by the open-root fallback (`otel-telemetry.adapter.ts:241`); its level fits the maintainer's own fault.
- #25 `run-ed28973-mvr9sbey-cb4eceda`: the pre-check lines report the run's adverse final decision. The run record says "would: issue" and the spans show a model rejection in round 1 and a `precheck` rejection in round 2. The lines are in scope only because they restate `qayaba.review.decision`.
- How often ERROR lines appear under default limits: not enough evidence.
- A verdict: nothing reads a level to decide. The only readers route or label the line (`logger.ts:174`, `redacting-logger.ts:58`, `:84`, `:113`, `log-shipper.ts:57`, `run-qa.use-case.ts:475`).

### Why it matters

"Tempo holds what happened, Loki how it happened" (`AGENTS.md:712`). The level decides two things about a line: its label, and whether Loki holds it at all (`info` does not ship unless `ship: true`). So a call site that picks a level is picking what an operator sees and how it is labelled.

- **`ERROR` does not mean one thing.** The operator guide shows `severity_text="ERROR"` as a filter for the agents' logs (`docs/telemetry-local.md:68`) and says every warn and error ships (`:74`). The same filter on `service_name="qayaba-orchestrator"` is the one the investigation's pull used: over #1 to #29 it finds a line in 13 of 18 pass runs and 7 of 11 other runs. It does not separate runs that ended from runs that carried on.
- **One seam, opposite outcomes, same level.** #1 ended the run and #3 carried on; both logged the failed login at error.
- **One fact, two channels, two levels.** In #3 the run's event stream says warn and the process line says error. The unchanged verdict has the same split in the code (`review.steps.ts:189` error, `:192` info).
- **One file, one kind of loss, two levels.** `lead-sidekicks.ts` logs a flow lost for its brief at warn (`:678`) and a flow lost for its session at error (`:608`), in #26 and #28 with the run carrying on.
- **One policy answer, two levels.** After the same `carryOn` return, 10 sites log error and 5 log warn.
- **A reader must open the seam to learn what a line means.** The investigation paid this cost itself: H11 as first written listed #24 and #25 among the runs it explains, and the refutation showed that their lines are not mis-leveled (a maintainer fault, a rejected final decision).
- **Lines that restate a span ship at error.** The unrouted, pre-check and unchanged lines repeat `qayaba.coordination.unrouted_reasons`, `qayaba.review.decided_by` and `qayaba.review.corrections`, which Tempo already holds, against `observability-design.md:739-740`.

The impact is diagnostic. Neither refutation nor the adjudication found a decision or a diagnosis misled by a level; the campaign read the unrouted lines correctly as an engine defect. This RFC fixes a missing rule and an unowned classification, not a failing verdict.

## Goals and non-goals

**Goals**

- The level of a process line follows the typed outcome recorded beside it, for the nine seams above.
- One written statement of what each level means, in the kernel and in `docs/observability-design.md`.
- The process line and the run event of one fact never disagree, at the login and at the unchanged verdict.
- Tests that fail when a seam's level and its outcome part ways.

**Non-goals**

- Re-leveling the `error` sites that were not swept, and the six `[qa] WARNING:` texts outside the carried-on set. They are reported, not swept: the 53 sites whose text says the run goes on are the first to read.
- Changing which facts get a line, the `ship` mechanism, or what Loki stores, except where F2 and F4 say so.
- Any effect on a verdict, a gate or a grader. Reading Loki from code. Alert rules.

## Options

### O0. Write the rule, change no code

Define each level in `observability-design.md` and settle the contradiction at `:737` against `:739-740`.

- **Removes:** the rule gap (chain step 4).
- **Adds:** a paragraph.
- **Risk:** nothing holds it. Since the investigation window, `62443ef5` logged an unread-files fault at error (`change-scope-port.adapter.ts:158`) and the same kind of event at warn (`implementation-resources.ts:51`), and `306d707a` and `a1ea43eb` took the `leftUnrouted` calls from 3 to 6, all at error.

### O1. Re-level the named constants by hand

Edit the 15 carried-on sites and the other eight seams to the level the rule gives, about 26 one-line changes.

- **Removes:** today's wrong constants.
- **Adds:** nothing.
- **Risk:** the cause stays. The next site picks a literal again and no test pins the choice. This treats the symptom, which the brief rules out ("Do not attack symptoms", quoted in ADR-0011, rule 7).

### O2. The owner of each outcome maps it to a level; the seam logs at the derived level (recommended)

One three-valued effect and one rule in the kernel, a total function or table in each module that already owns an outcome, and seams that log at the level their outcome gives. Detail under Recommendation.

- **Removes:** the call-site choice at the nine seams; the disagreement between the two channels of the login failure and of the unchanged verdict; the split among the 15 carried-on sites and between the two lost-flow lines.
- **Adds:** one type and one three-entry table next to the port, a return value on `carryOn`, a name for the `decidedBy` union with its mapping, and a mapping over `FlowOutcomeKind`. No new module, no port change. The unrouted codes stay strings (F5).
- **Risk:** low. Only levels change and nothing reads a level to decide. Anything an operator filters by `ERROR` for these lines changes meaning, which is the point; under F2 the review lines stop reaching Loki. The rule needs the owner's answer to F1 first.

### O3. Take the level out of every call site

Replace the four logger methods with a call that takes an effect, for all call sites.

- **Removes:** the call-site choice everywhere.
- **Adds:** a new logger vocabulary at about 425 literal calls (198 error, 177 warn, 50 info). Most have no typed outcome beside them, so the author would declare the effect at the call site: the same choice under another name.
- **Risk:** a large migration for no evidenced harm outside the nine seams. Rejected for now (ADR-0001 P7).

### O4. Derive the level when the line ships, from the ambient span

The shipper (`log-shipper.ts:46-61`) reads the span's attributes and sets the severity.

- **Removes:** the call-site choice for lines whose fact is on a span.
- **Adds:** a dependency of the carrying side on the engine's attribute names; the platform would decide what a level means.
- **Risk:** it breaks the placement rule (the engine decides, the platform carries; `docs/engine-platform-architecture.md`, "The placement rule"). It also fails for lines written before their fact exists: the store line is written at restore (`suite-store.adapter.ts:262`), while `qayaba.suite_store.dropped` is counted at the next capture (`suite-store-trace.ts:72`). Rejected.

## Recommendation

**O2**, with the rule below as a proposal for the owner to settle (F1 to F5).

**The rule.** A line's level answers one question: what did the fact do to the run?

| Effect | Level | Meaning |
|---|---|---|
| `ended` | error | the fact ended the run, or the process cannot do its job |
| `carried-on` | warn | the run went on past a fault or a loss |
| `expected` | info | nothing went off the expected path; a fact a span records is not shipped (`observability-design.md:739-740`) |

It generalizes the one rule the code already has, `ends ? "error" : "warn"` (`run-qa.use-case.ts:488`). "Loud" stays true: warn ships exactly as error does (`redacting-logger.ts:82-85`). Shipping follows the effect: an `expected` line that only restates a span fact is not shipped; a `carried-on` or `ended` line ships even when a span records the fact, unless the owner decides otherwise for the unrouted line (F4). A loss the verdict hides, such as unrouted findings, stays visible as typed facts: `qayaba.coordination.findings_unrouted` (`attribute-registry.ts:104`) and `corrections.unrouted` on the run's signals (`qa-engine/src/shared-kernel/coordination.ts:106`). It leaves the ERROR filter and stays in Loki at warn unless F4 withholds it. A search of `qa-engine/src`, `src` and `client` finds no code that renders it in a PR or Issue; whether it should be graded or shown is H17, open.

**The mapping, owned where the outcome is recorded.**

| Owner of the outcome | Outcome | Effect | Level |
|---|---|---|---|
| `terminalForPrecondition` (`precondition-terminal.ts:15`) | `end` | ended | error |
| | `continue` | carried-on | warn |
| `POLICY` and `FailureAction` (`failure-policy.ts:56`) | `end`, `rethrow` | ended | none: the end is recorded by `finalizeRun`, as today |
| | `fail-open`, `degrade` | carried-on | warn |
| `leftUnrouted` (`lead-sidekicks.ts:1238`) | a finding no flow took; the run goes on | carried-on | warn (F1 answer A). The codes stay strings; the closed `UnroutedCode` type returns only under F1 answer B (F5). |
| `FlowOutcomeKind` (`flow-outcomes.ts:11-20`) | `failed`, `over-window` | carried-on | warn |
| | `delivered`, `declined`, `timed-out`, `needs-lead` | none: no line is written for them | none |
| `SuiteStoreAdapter` | unreadable or mismatching blob; the restore goes on | carried-on | warn |
| `decidedBy` (`run-state.ts:251`) | `model` | none: no decision line is written | none |
| | `precheck`, `unchanged` | expected | info, not shipped (F2); one level on the process line and on the run event |
| `FileBoundaryVerdict` (`qa-engine/src/shared-infrastructure/process-sandbox/file-boundary.ts:32`) | `holds` | expected | info |
| | not `holds` | ended (exit 1) | error |

The file-boundary mapping is the exception to "owned where the outcome is recorded": it is the inline `verdict.holds ? info : error` in the shell caller (`file-boundary-check.ts:99`), because the verdict has two members and the caller is the only place that logs it.

**The shape of the change.**

1. `logger.port.ts` gains the effect type and its table, written with the repository's idiom for a total mapping (`satisfies Record<...>`, as `process-logger.ts:5`). Final names are for the implementation.
2. The failed login is announced once. `announcePrecondition` (`run-qa.use-case.ts:485`) writes the process line and the run event at the level it already derives, as `announceSuite` writes both channels from one level (`run-qa.use-case.ts:474-477`). Line `:437` goes and its phase text moves into the announcement.
3. `carryOn` returns the level of the fault it admitted. The 15 sites pass it on, and `guarded` uses it at `failure-policy.ts:118` and `:125`. `carryOn` returns only after `fail-open` (it throws otherwise, `failure-policy.ts:136-138`), so the value is always the `carried-on` level; what it buys is that the right call is the easy one. A smaller form, one helper that writes the line, is for the implementation to weigh.
4. `leftUnrouted` (`lead-sidekicks.ts:1242`) and the flow-failure line (`:608`) write at the level the kernel table gives `carried-on`. The over-window line (`:678`) takes its level from the same table through a mapping over `FlowOutcomeKind` in `flow-outcomes.ts` (`failed` and `over-window` are carried-on, the other four kinds write no line), so the two lost-flow lines cannot diverge again. The unrouted codes and `unroutedReasons` (`coordination-telemetry.ts:61`) stay `string` and `readonly string[]`.
5. The review lines. `decidedBy` gets a name at `run-state.ts:251` (`review.steps.ts:175` repeats the union) and, beside it, a mapping from each member to its effect. The lines at `review.steps.ts:189` and `:217-218` are written at the level the mapping gives, with the `ship` flag F2 settles, and the run event at `:190-194` takes the same level, so the two channels of one fact agree.
6. The store's default writer is `engineLog.warn`, the level its own dependency name states.
7. The file-boundary line becomes `verdict.holds ? info : error`, in a commit of its own because the file is governance-sensitive (AGENTS.md, Invariants: such changes ship alone).

**A function per owner, not a policy object.** ADR-0002 (addition 4) leaves this to this RFC. Each mapping is stateless, total over a closed type and has no variants, so a function or a table is the smaller. The precedent `DecideCoverageService` (`decide-coverage.service.ts:24-30`) holds two such rules in a class; a class adds a constructor and an injection point that no seam here needs.

**Why it is the smallest change that removes the cause.**

- The cause is a classification nobody owns. The rule is written once (three rows); each classification is a short total mapping in the module that already holds the outcome; the seam asks and no longer chooses.
- O1 leaves the choice in place, O3 spreads it over about 425 sites, O4 moves the decision to the carrying side. The smaller variant, each owner returning a level with no shared effect type, restates "carried on is warn" in each owner, which is the cause again.
- The added complexity is one three-valued type, one table, one return value and a name for the existing `decidedBy` union. No existing type is widened: under the recommended F1 answer all unrouted codes map to the same level, so a closed code type would decide no level (F5).
- The shared type is justified because three contexts emit these lines (run-orchestration, coordination, workspace-and-publication).
- The need is evidenced: the two lost-flow lines in one file already diverge (`lead-sidekicks.ts:608` against `:678`), and three commits after the window repeated the split (O0, Risk). ADR-0002 gives H11 additions 4 and 8 only (its reading table, rows 4 and 8); a closed union (addition 1) has no evidence here under F1 answer A.

**Why it is app-agnostic.** Every seam is engine code that runs for any app; the login failure, the policy, the store, the flow failure, the review rounds and the unrouted findings name no framework, route or app, and no app data enters the mapping. The run evidence came from one app, but the mechanism is a level constant, identical at every epoch head. Which seams fire depends on the app and the procedure: a cross-repo service run has no change coverage and so no coverage corrections (AGENTS.md, "Cross-repo runs"), while the login, policy, store, flow and review seams fire for any app.

**Where it lives in the engine and platform layout.** The rule is a shared-kernel type next to the port: three contexts need it (`docs/engine-platform-architecture.md`: "The shared kernel is for what two or more contexts need"). Each classification stays in the context that records the outcome. The redacting logger and the Loki shipper carry the level and stay as they are, wherever the platform steps place them (decision table row 6: a process-wide resource). The file-boundary check is a platform boot step. This slice moves nothing out of `src/`: the decisions are already in `qa-engine`, and what is left in `src/` only carries.

**The owner's direction.** On 2026-10-28 13:36Z (translated): "Regarding the Command pattern, if it brings no real value, do not do it. In general it is not about applying patterns just because; each decision must be grounded, and any added complexity, logical or cognitive, must be justified." The sentence is about one pattern and states a general rule; this RFC applies the rule, not the pattern. It is why the proposal is a function and not an object, why O3 is rejected, and why the unrouted codes are not closed into a type without a level to decide (F5). The owner's single-source-of-truth idea is under debate and not decided (ADR-0002, Decision 5); this proposal does not rely on it.

**Consequence for readers.** The `ERROR` label then means the fact ended the run or the process (F1 answer A), so an operator who filtered it to find lost corrections changes the filter. What they find depends on F4:

- F4 yes (recommended): the unrouted line is warn and still ships. They filter the warn lines or read the typed fact.
- F4 no: no unrouted line reaches Loki at any level (docker's json-file log still holds it). The loss stays visible as `qayaba.coordination.unrouted_reasons`, `qayaba.coordination.findings_unrouted`, the event's reason (finding numbers and why) and `corrections.unrouted`; nothing renders it in a PR or Issue (H17, open).
- F1 answer B: the unrouted line keeps the ERROR label, with F5.

## Patches it supersedes

No past commit targeted severity, so none becomes redundant. What the fix removes:

- the fixed-level login line: `run-qa.use-case.ts:437`
- the fixed levels after `carryOn(`: `ground.steps.ts:130`, `:229`, `:285`, `:295`; `run-services.ts:182`; `run-qa.use-case.ts:506`; `setup.steps.ts:136`, `:155`, `:176`, `:187`; and the literal `"warn"` at `decided-end.ts:165`, `:193`, `run-qa.use-case.ts:459`, `setup.steps.ts:34`, `fix-loop.steps.ts:427`
- the fixed levels of `guarded`: `failure-policy.ts:118`, `:125`
- the fixed unrouted level: `lead-sidekicks.ts:1242`
- the fixed levels of the two lost-flow lines: `lead-sidekicks.ts:608` and the literal `warn` at `:678`
- the store default: `suite-store.adapter.ts:476`, `:478` ([RFC-0005](./0005-suite-store-single-writer.md) also edits these two lines and changes what `readBlob` returns, its step 4; the order is free and the mapping row holds wherever the line ends up)
- the review lines (F2): `review.steps.ts:189` and `:217-218`, and the literal level of the event at `:192`
- the success line at error: `file-boundary-check.ts:100`
- the sentence "an error line in the log": `docs/lead-sidekicks.md:389` and `:414`, and the contradiction at `observability-design.md:737` against `:739-740`
- the two assertions that tolerate or pin today's level: `run-qa.use-case.test.ts:7792` and `failure-policy.test.ts:87-99`
- only under F1 answer B with F5: the loose unrouted codes (`lead-sidekicks.ts:1012`, `:1015`, `:1238`) and `string[]` at `coordination-telemetry.ts:61`

## Test plan

Per the testing standards: a bug fix in real logic starts with a test that fails for the bug's reason, through a public seam, with a decisive fixture. A test of the table against its literal would be a tautology and is not written.

| Rule | Test, through the public seam | Fails today because |
|---|---|---|
| A failed login logs one level on both channels: error when it ends the run, warn when a context run carries on | `RunQaUseCase` with the precondition rig (`preconditionRun`, `run-qa.use-case.test.ts:7707`) and a memory logger installed as `run-qa.closed-loop.test.ts:231-232` does; one context run and one diff run; compare the process entry with the run event naming the failure kind | the context run's process line is error and its event is warn (`run-qa.use-case.ts:437` against `:488`) |
| A fault the policy carries on logs at the level the policy gives | `guarded` with a fail-open and a degrade fault, and one real step (grounding) whose port throws | both log error (`failure-policy.ts:118`, `:125`) |
| An unrouted finding logs at the level of the carried-on effect | `LeadSidekicks` in the scenario of `lead-sidekicks.test.ts:1340`, with a memory logger that keeps the level and the `ship` field (the field is asserted under F4) | the line is error (`lead-sidekicks.ts:1242`) |
| A flow whose session fails logs at the level of its outcome, the same as a flow lost for its brief | `LeadSidekicks` in the scenario of `lead-sidekicks.test.ts:859-867` (a sidekick whose session throws), with a memory logger installed through `installProcessLogger` as `lead-sidekicks.test.ts:2505-2517` captures lines; assert the failure line is warn and the outcome is `failed` | the line is error (`lead-sidekicks.ts:608`) |
| A review round logs at the level of its `decidedBy` on both channels | `RunQaUseCase` in the rig of `run-qa.use-case.test.ts:8822-8845` (a round decided by `precheck`, then one by `unchanged`), with `fakeObserver()` as `preconditionRun` uses it (`:7719`) and a memory logger; assert the level and the `ship` field of each process line against `decidedBy`, and that the `unchanged` process line and its `log.line` event have the same level. A round decided by the model (the scenario of `:8625`) writes no decision line, as today. | the pre-check lines and the unchanged line are error (`review.steps.ts:217-218`, `:189`) and the unchanged event is info (`:192`) |
| A store copy that cannot be read logs at warn | `SuiteStoreAdapter` built as the composition root builds it (no `warn`), a stored blob removed, then `restore` | the default writes error (`suite-store.adapter.ts:478`) |

The diff run of the login test also pins that an ended run still logs error on both channels, the previous behavior of the shared line. The file-boundary change is one token in a governance-sensitive file whose `main` is not exported; a small contained fix gets no new test.

**The ownership fitness function** (ADR-0002, addition 8). The type is the guard for the four owners with a closed outcome (`terminalForPrecondition`, `FailureAction`, `decidedBy`, `FlowOutcomeKind`): a mapping `satisfies Record<...>` fails to compile when an outcome has no level, and a mapping that lacked `unchanged` would not compile. For the 15 `carryOn` sites a new architecture test under `qa-engine/test/arch` scans the sources and fails on a literal `engineLog` or `appLogger` level inside a catch block that follows `carryOn(`. `failure-scan.test.ts` (under `qa-engine/test/contexts/run-orchestration/application/run-flow`) is the precedent for a text scan of the run flow. It is a text scan, so it is the weakest guard; `carryOn` returning the level makes the right call the easy one. Both land in the commit that changes `carryOn`, not before. The done-criterion adds a global search for a literal level next to `carryOn(`, `leftUnrouted(`, `decidedBy =` and `FLOW_OUTCOME.FAILED`.

## Measurement

The proof is the RED tests: a level is a code constant, so a run measures only the direction. The signal on a run is the number of in-scope ERROR lines on a run that carried on, from Loki, read beside the typed fact in the span of the same run.

| | In-scope ERROR lines on runs that carried on | Source |
|---|---|---|
| Before, runs #1 to #29 (several code epochs) | 15 lines in 13 runs: 13 lines in 11 pass runs (#3, #12 to #15, #19 to #21, #23, #27, #29) and 2 flow-failure lines in #26 and #28. #25 (2 lines) and #24 (1 line) are not counted. | the investigation's Loki pull, mapped to run records |
| Before, the one baseline replicate `run-ed28973-mvs7oo0f-17041c71` on 4105c582 (pass) | expected 1, the store line: `qayaba.suite_store.restore` shows 12 restored and `qayaba.suite_store.capture` shows `dropped=1`; no unrouted event and no pre-check decision. The pull holds that line (trace `bff49415`, 2026-10-28T14:30:27Z); any later line of the run is unread. | history database; the pull |
| After, one replicate on the fix (the count is open in ADR-0011; one is recommended), same 12-entry snapshot, freeze off | expected 0 at ERROR; the store line, if it still fires, at WARN | to be measured |

One against one shows a direction, never proof (ADR-0011, rule 4). The baseline exercised only the store seam (unrouted 0), so the other seams rest on the RED tests. If [RFC-0005](./0005-suite-store-single-writer.md) is in the version under test, the dangling entry no longer exists, the store line does not fire, and the after-run shows nothing for this RFC; the RED tests are then the only proof.

## Owner decisions needed

- **F1. What does `error` mean?** Recommended: A, the fact ended the run or the process; a carried-on fault or loss is `warn`, and the loss stays visible as a typed fact. Alternative B: `error` also marks a carried-on loss nothing repairs (unrouted findings, a dropped store entry). B keeps the ERROR label on lines that mark a loss the verdict hides (the unrouted findings, which reported defects later fixed as F10, F11 and F18), at the cost of a fourth effect and a per-outcome judgment of what counts as a loss (a lost flow included), which is a call-site choice again, only in a table. B brings F5.
- **F2. Do the review lines that restate the decision leave Loki?** These are the pre-check lines (one summary plus one per finding, `review.steps.ts:217-218`) and the unchanged-verdict line (`:189`). Recommended: yes. They become info (`expected`), which ships nothing by default; `qayaba.review.decided_by` and `qayaba.review.corrections` hold the decision and the finding texts (`review-services.ts:207`, `:212`), as `observability-design.md:739-740` and `docs/telemetry-local.md:75-76` say. Cost: the span keeps at most 6 correction texts (`attribute-registry.ts:160`, `arrayCap`, applied at `otel-telemetry.adapter.ts:374`), so the findings past the sixth of one round stay only in docker's json-file log. The alternative is `ship: true` at info, which keeps them in Loki.
- **F3. The file-boundary success line becomes info, in a commit of its own.** Recommended: yes. An operator who reads that boot line by level would see it change.
- **F4. Does the unrouted line keep shipping to Loki?** Recommended: yes. It is warn (F1 answer A), and warn ships by default (`redacting-logger.ts:82-85`); `observability-design.md:739-740` would then be reworded: an expected fact a span records is not shipped, while a carried-on loss is. The alternative is `ship: false` (the flag exists, `redacting-logger.ts:83`, and no production call uses it today), as `:739-740` reads for a line that restates a span fact. The cost of the alternative, stated: no unrouted line would reach Loki at any level, and #27 and #29 lost 46 and 44 coverage-gap findings under a PASS. The loss would stay in `qayaba.coordination.unrouted_reasons` (`coordination-telemetry-trace.ts:43`), `qayaba.coordination.findings_unrouted` (`attribute-registry.ts:104`), the event's reason, `corrections.unrouted` (`coordination.ts:106`) and docker's json-file log, and nothing renders it in a PR or Issue (H17, open). The owner's pillar weighs against that silence, in this record's reading: on 2026-10-28 13:36Z, point 4 (translated): "The app is a QA Tester; if its priority is to make tests green, it becomes a garbage generator." A lost correction finding under a PASS is a test-quality loss that the verdict hides, and this line is the one place an operator reads it. Either answer leaves `nothing()` as it is: it records `pass-released` and `no-time` and logs nothing (`lead-sidekicks.ts:1009-1015`).
- **F5. Close the unrouted codes into one type?** Recommended: no, under F1 answer A. All seven codes (four in `UnroutedCode`, `lead-sidekicks.ts:1434`; `pass-released` and `no-time` in `nothing()`, `:1012`, `:1015`; the default `left-by-caller`, `:1238`) map to the same level, so the type would decide no level, and `unroutedReasons` stays `readonly string[]` (`coordination-telemetry.ts:61`). The array is read inside the coordination context (`lead-sidekicks.ts:1430`, `coordination-telemetry-trace.ts:43`), by the attribute registry (`attribute-registry.ts:105`) and by one telemetry test (`src/telemetry/coordination-coverage-trace.test.ts:47`); the API's `CoordinationEventSchema` does not carry it (`src/contract/commands.ts:836-854`). Under F1 answer B the mapping needs a per-code judgment, and the closed type is how that table stays total: the RFC then adds the type, the widening of `unroutedReasons` and a test that every code has an effect.

## Out of scope

- Which events happen and how often: F10, F11, F18, H20 ([RFC-0005](./0005-suite-store-single-writer.md) removes the cause of the store line), the egress gap behind #1 to #3, a provider that answers 401 (#28).
- Line placement in a run (`otel-telemetry.adapter.ts:241`). [ADR-0010](../adr/0010-maintainer-removal.md) removes the maintainer lines; the open-root fallback stays.
- Whether lost correction findings should feed a grader, a gate or the PR text (H17, open).
- Catch blocks that carry on without asking the policy (`ground.steps.ts:180`, `:197`), the other `[qa] WARNING:` texts at error, and the other `error` sites that were not swept (53 whose text says the run goes on). Reported for the refactor, not fixed here; the architecture scan can grow to cover them once their outcome is named.
- Whether `nothing()` should log (`lead-sidekicks.ts:1009-1015`).
- Production Loki alert rules or dashboards. None was found in the repository: a search for `severity_text` and `detected_level` finds only the operator guide.
