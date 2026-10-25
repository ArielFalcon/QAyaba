# qayaba — context for the observability (OpenTelemetry GenAI) implementation

> **Audience.** An AI agent that will design and implement an OpenTelemetry layer, including the GenAI semantic conventions, for qayaba. You will get separate instructions on *how* to build it. This document tells you *what* matters to measure and *why*. It covers the parts of the system that matter for that, the interactions you will not see by reading the code at a glance, and the failures we are trying to diagnose today.
>
> **Author's stance.** I am writing as qayaba's product owner. Everything stated as a fact below was observed in real runs between 2026-10-11 and 2026-10-16, or was verified in the code at branch `feat/plan-v4`. Inferences are marked as such.

---

## 1. Why observability, why now

qayaba is an AI-assisted E2E QA engine. When a commit reaches DEV, an LLM agent writes Playwright tests for the change, the orchestrator runs them against the live DEV site, and an independent LLM reviewer judges them. Accepted tests are published to the app repo.

**The product problem: we cannot tell why runs fail without days of manual forensics.**

- On the main test app (`name-webapp`, an Angular front end with 5 Java microservices), **no run has ever reached the `execute` phase.** Out of ~18 runs, the trust loop (generate → execute → accept → learn) has never closed. So we do not know which of the many context resources we give the agent are worth their cost.
- Every failure in the last verification round was at a *seam*, never inside a unit. Each one took hours to diagnose by grepping two containers' logs, a SQLite DB, OpenCode's own log file and macOS's power log:
  - **A "32-minute hung agent turn" was the Mac sleeping.** The Docker Desktop VM froze, and so did every timer in it. That cost a day. Nothing recorded suspend/resume or event-loop stalls, so it looked like an engine bug.
  - **A generator that needed 115–266 s before its first tool call.** It turned out the provider had changed how much the model reasons. The *same* prompt took 2.7 s a few days earlier. We only proved it by replaying the old prompt by hand and reading 62k characters of reasoning out of OpenCode's session DB.
  - **The provider quota was exhausted** ("Go usage limit exceeded"). We found it only in `~/.local/share/opencode/log/opencode.log` inside the agents container. The orchestrator saw "grounding pass failed (non-blocking)", followed by a 240 s timeout (that agent pass has since been removed).
  - **A login timeout caused by a refused stylesheet.** Keycloak's theme CSS imports `fonts.googleapis.com`, and the egress filter refused it. The login form never mounted. The run reported only "test timeout of 30000 ms".
  - **A generator that read 45 source files in 60 s** and ran out of steps with 0 writes. The element it had to test was not rendered on DEV (0 rows of data), and nothing in the run said so.

**The goal of the observability layer is that any of the above can be answered in minutes from one trace and a handful of metrics.** It must not depend on someone who knows where every log lives.

**North-star metric:** the share of runs that reach `execute`, and of those, the share that pass and are valid on a no-retry re-run. Everything else is diagnostic detail under that number.

---

## 2. System map (only what matters for telemetry)

Two Docker services share a `mirrors` volume, which holds the working copies of the watched repos.

```
┌──────────────────────── orchestrator (Node 24, TypeScript via tsx, root + a sandbox uid) ────────────────────────┐
│ HTTP API :458 (Bearer token)   webhook   sequential run queue   SQLite history (/app/data/qayaba.db)                │
│ RunQaUseCase ── ports ──► gate · checkout · classify · setup · grounding · generation · validate · execute ·        │
│                            coverage · review · decide/publish · suite store                                        │
│ Exec launcher (sandbox uid 1002, per-profile env allowlist) ──► children: playwright, tsc, eslint, npm ci,          │
│      login script, DOM capture, authenticated browser (Chromium via playwright-core)                               │
│ Egress: iptables owner-match → DNS filter + transparent SNI proxy (allow only declared origins)                     │
│ Internal tools listener :459 (QA_TOOLS_TOKEN) ◄── run_spec / authbrowser_* calls FROM the agents                    │
└───────────────▲─────────────────────────────── HTTP + SSE ───────────────────────────────▲─────────────────────────┘
                │ Basic auth (OPENCODE_SERVER_PASSWORD)                                       │ tool callbacks
┌───────────────┴──────────────── agents (supervisor :4097, opencode serve :4096 pinned 1.17.7)   ──────────┐
│ OpenCode sessions per agent turn ──► provider "opencode-go" (one shared monthly quota)                              │
│ MCP servers per session: serena (code symbols), @playwright/mcp (browser)                                           │
│ Custom tools: agents/tool/run_spec.ts, agents/tool/authbrowser.ts → POST to orchestrator :459                       │
│ OpenCode's own log: ~/.local/share/opencode/log/opencode.log (provider stream errors, retries, cancels)             │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Boundaries you must respect.** They are enforced by `npm run arch:check` and described in the repo's `AGENTS.md`:
- `qa-engine/src` (the hexagonal engine) never imports from `src/` (the shell: composition root, API, provider I/O, persistence). Telemetry inside the engine must be a **port** with a no-op default, wired in `src/server/run-engine-factory.ts`.
- A new `child_process` import outside the launchers fails the build.
- The engine is model- and app-agnostic ("golden rule"). Telemetry attributes may *carry* the model id and app name as data. Code must never branch on them.
- Data that leaves the system must be sanitized. Use `src/orchestrator/sanitizer.ts`, the by-value run-secret redaction in `qa-engine/src/shared-infrastructure/run-secret-redaction.ts`, and `sanitize-text.ts` for prompt text. **Prompt and completion content must not be exported unredacted.** DEV credentials, session cookies and storage values pass through prompts and logs.

### Agent roles (OpenCode agents, `agents/opencode.json`)

| Role | When | What it produces | Notes for telemetry |
|---|---|---|---|
| `qa-generator` | Generation | Spec files plus a verdict JSON (`specs`, `specMetas`, `note`, `noop{reason,kind}`, `plan`) | Has per-call telemetry today (`agent_turns.tool_sequence`) |
| `qa-sidekick` | Lead+sidekicks mode only (off by default; never run live) | One flow per sidekick, run in parallel through `FanOutDispatcher` | Each sidekick is its own session and pays the full tool-schema cost again |
| `qa-reviewer` | After execute | Approve/reject plus correction classes | A different model from the generator, on purpose. No per-call data |
| `qa-reflector`, `qa-proposer`, `qa-assistant`, `qa-maintainer` | Learning (off by default) / onboarding / chat / self-repair | — | Lower priority |
| (OpenCode) `title` | **Every session**, automatically | A session title (`small=true`) | **A hidden extra LLM call per session.** It shows up in OpenCode's log as `agent=title`. It also fails and retries when the quota is exhausted |

---

## 3. The run lifecycle and the spans it should produce

The single engine is `RunQaUseCase` (`qa-engine/src/contexts/qa-run-orchestration/application/run-qa.use-case.ts`). The webhook, the CLI and the API all enter through `enqueueTrackedRun` (`src/server/runner.ts`). Run id format: `run-<sha7>-<base36>-<hex>`.

**One trace per run is the natural unit.** Suggested phase spans (names are illustrative; follow your instructions for naming):

1. **`queue.wait`**
   - From enqueue to dequeue. The queue is strictly sequential: one run at a time against DEV.
   - Campaigns (`scripts/campaign.ts`) wait for an idle queue and can **cancel** runs through the API. Cancellations must be distinguishable from failures.
2. **`gate`**
   - Waits until DEV serves the sha (`dev.versionUrl`). It is skipped **silently** when `versionUrl` is absent, which is the case for name-webapp, so the run never knows whether DEV runs the commit under test.
   - Record a "deploy verified / unverified" attribute.
3. **`classify`**
   - Checkout, diff, `classifyCommit` (Conventional Commits cross-checked against the diff).
   - Can end the run as `skipped` with no token spent.
   - Uses **synchronous** git calls (`execFileSync` in `git-hardening.ts`), which block the event loop.
4. **`setup`**, with child spans for:
   - **Suite store restore** (`suite-store.adapter.ts`): how many files restored, overlays, whether the login was restored.
   - **Seed** from `config/e2e/`.
   - **`npm ci`** (sandbox profile `install`): it can fail on egress or network; exit 243 was seen during host sleep.
   - **Orphan-data cleanup** of a prior interrupted run.
   - **Login** (`AuthSessionAdapter`, profile `login`):
     - attempts, the outcome kind (see `auth-precondition.ts`, including the new `EGRESS_DENIED`), duration;
     - whether the restored login was **demoted** (it used to be demoted for environmental failures; now it is not when egress denied hosts during the attempt).
5. **`ground`** (fail-open: every failure here only degrades the prompt, the run continues):
   - **Context map load** (`e2e/.qa/context.json`).
   - **Route ranking** (`route-ranking.ts`), plus **templated-route instantiation**: a second capture pass.
   - **DOM capture** (a sandboxed child, one Chromium run over N routes):
     - per route: grounded / degraded / redirected / empty / failed, node count, runtime errors;
     - per run: capture duration, which ranges from 13 s to 9 min.
   - **Context pack** assembly: sections and bytes, the new "Changed values" facts.
   - **Stitcher** service links and contract drift.
   - **Structural signal** from the code graph (codegraph, orchestrator-only).
6. **`generate`**. Agent spans for:
   - the first pass;
   - the contract **repair** turn (tools disabled, ≤ 2 min);
   - regenerations (static-fix rounds, pre-exec corrective, fix loop, enforce-mode coverage regen);
   - in lead+sidekicks mode: the **plan** turn (read-only), then N sidekick turns under `FanOutDispatcher`, with an escalation ladder (retry, then the lead takes over).

   The generation end is classified as one of `delivered`, `declared-noop`, `exhausted` (E-STEP-BUDGET), `time-budget` (E-TIME-BUDGET), `undecided-empty` (E-NO-DECISION) or `no-verdict`. See `generation/domain/generation-end.ts`.
7. **`validate`**: `tsc`, ESLint (`eslint-plugin-playwright`), `playwright --list`, the manifest check. Failure → `invalid`. Also the pre-exec grounding: the catalog gate (fabricated test-ids) and the selector-ambiguity advisory.
8. **`execute`**: Playwright against DEV (profile `suite`), per-test results, retries. Pass only on retry means flaky.
9. **`coverage`**: change-coverage. Did the green run exercise the diff's changed lines? `qa.coveragePolicy` is `off|signal|enforce`; `unknown` never blocks.
10. **`review`**: a reviewer agent span. Unreachable → `infra-error E-REVIEWER-UNAVAILABLE`.
11. **`decide`**: PR / Issue / shadow log line. When accepted, a suite-store capture.

**Verdicts:** `pass | fail | flaky | invalid | infra-error | skipped` (`qa-engine/src/shared-kernel/run-verdict.ts`).

**Error codes** to carry as attributes:

| Code | Meaning |
|---|---|
| `E-NO-DECISION` | Zero specs and no no-op declared |
| `E-STEP-BUDGET` | The step cap was hit |
| `E-TIME-BUDGET` | The tier budget or the run deadline was hit |
| `E-PRECONDITION` | The login could not complete (kinds incl. egress-denied) |
| `E-SANDBOX` | The sandbox uid, the egress filter or the file boundary is not proven |
| `E-REVIEWER-UNAVAILABLE` | The reviewer could not be reached |
| `E-STATIC` | Validation failed |

---

## 4. Agent turns: what one span must capture

A "turn" is one `session.prompt` on an OpenCode session. Inside it, OpenCode runs an agentic loop of **steps**. Each step is one LLM call that may emit tool calls, and **calls** are the tool invocations.

**The path a prompt takes**, all of it hidden from a quick reading:

```
engine port  →  RunDeadlineRuntime (qa-run-orchestration/infrastructure/run-deadline-runtime.adapter.ts)
             →  OpenCode strategy (src/agent-runtime/opencode-strategy.ts)
             →  agent-transport-policy (qa-engine/src/contexts/generation/infrastructure/agent-transport-policy.ts)
                  · withTimeout(prompt, timeoutMs)            ← the real deadline of the turn
                  · primary attempt, then FALLBACK MODEL retry  ← a hidden second attempt on a different model
                  · per-role circuit breaker                    ← recordCircuitFailure
                  · on timeout: abortRun() + recordUnansweredTurn("timeout"|"aborted")
             →  src/integrations/opencode-client.ts  (HTTP POST /session/:id/message, Basic auth;
                  per-prompt `tools` map hides tools; SSE /event stream for live activity)
             →  opencode serve  →  provider (with its OWN retries: "AI_RetryError: Failed after 3 attempts")
```

**Which limit actually ends a turn, smallest first.** Record the limit that applied and which one fired.

| Limit | Default | Where |
|---|---|---|
| Diff-tier first-pass budget | tiny 6 min, focused 12 min, broad none | `generation/domain/diff-stat.ts`, env `QA_DIFF_TIME_BUDGET_MS_*` |
| Run deadline | diff-tiny 25 min, focused 40, broad 60, manual 45, complete 90, exhaustive 150, context 60 | `run-time-budget.ts`, env `QA_RUN_TIME_BUDGET_MS_*`. Armed **after** classification |
| Repair turn cap | 2 min | `generation/domain/repair-turn.ts` |
| Host prompt cap | `OPENCODE_TIMEOUT_MS` (900 s in the current env) | `agentPromptCapMs()` in `opencode-client.ts` |
| Stall watchdog (no SSE activity) | 180 s default; 600 s in the current env | `OPENCODE_STALL_MS`. Not applied to a session opened with `liveObservation:false` (the judge's) |
| Step cap | generator 50, sidekick 60 | Read **live** from OpenCode `GET /agent` per run (`stepLimits`), not from the repo copy of `agents/opencode.json` |

### Attributes worth recording per agent turn

These map naturally onto the GenAI conventions: `invoke_agent` / `chat` / `execute_tool`.
- **Identity:** role (`gen_ai.agent.name`), OpenCode session id (the conversation id), run id, round (first pass, regen n, repair), mode, tier.
- **Model:** the requested model, the model that actually answered (the fallback can differ), provider, reasoning effort (`options.reasoningEffort` per role in `agents/opencode.json`).
- **Tokens:** input, output, **reasoning**, cache read and cache write, per step and totalled. Old turns recorded only the last message's usage, which understates.
- **Time:** time to first step response, **time to first tool call** (`timeToFirstCallMs`, already computed), time to first write, total duration, per-step durations.
- **Work:** steps used against the stated cap; tool calls by family (read/grep/glob, serena, codegraph, playwright, write/edit, run_spec, authbrowser, task, todowrite); denied calls; duplicate and redundant reads (the same window of a file again); same-file re-reads (a file read again in any window, with no write to it in between); reads of files the prompt already provided.
- **Ending:** completed / timeout / aborted / exhausted / no-verdict, and the parsed verdict shape (specs count, no-op kind `not-worth|unobservable|unspecified`).
- **Context composition:** prompt bytes **per section** (the run prompt is assembled from about 25 conditional sections in `qa-engine/src/contexts/generation/infrastructure/prompt-builders/prompts.ts`), static-layer bytes, and **bytes of tool schemas offered**.
  - The tool schemas are about **60% of the initial context**. The generator is offered 66 tools, ~60 KB. **Serena: 0 symbol calls in 56 runs.**
  - Denied tools cost nothing; only offered ones count.
- **Provider errors:** class (quota exceeded, socket closed, 5xx, unknown), retries performed by OpenCode, whether the fallback model was used, whether the circuit opened.

**Content capture.** Prompt and completion text can be large: a reasoning part was 62k characters, the reviewer's input up to ~100 KB. They carry redacted secrets only if redaction runs. If you capture content, make it opt-in, capped and passed through the run-secret redaction. The diagnostic that needed content most was the replay of a reasoning drift. Storing a **hash of the prompt and the bytes per section** by default would have been enough to prove "same prompt, different behaviour".

### Tool calls

OpenCode emits tool activity on its SSE stream. The orchestrator turns it into `toolSequence` (`qa-engine/src/contexts/generation/infrastructure/sse/call-efficiency-tracker.ts`). Every tool call can become an `execute_tool` span: tool name, target (path, URL, pattern), duration and status. Pay particular attention to:
- **`run_spec`** and **`authbrowser_*`**. These are **cross-container callbacks**: agent → orchestrator `:459` → sandboxed Playwright or Chromium → DEV. They should show up as children of the agent turn that called them, which needs context propagation through the tool's HTTP call. They also hold the per-account **DEV lease** (`AccountLock` / `DevLease`). Lease wait time and `DEV busy` refusals matter for the parallel sidekick mode.
- **Playwright MCP navigations from the generator.** On name-webapp **9 of 11 navigations were wasted**, because the MCP browser is launched without the DEV HTTP-Basic gate credentials. The agent "learned" this three times and saved it to engram three times.

---

## 5. Sandbox, egress and environment: the seams that broke

Every piece of agent-influenced code runs through the exec launcher (`qa-engine/src/shared-infrastructure/process-sandbox/exec-sandbox.ts`), in profiles `offline | suite | login | install`, as uid 1002. Per child, record: profile, command class, exit code, duration, whether the reaper killed leftovers (`sandbox-reaper.ts`), and denied hosts.

- **Egress** (`qa-engine/src/shared-infrastructure/egress/`): each child holds a lease on its profile's origins. The DNS filter and SNI proxy refuse undeclared names (NXDOMAIN or reset, fast). Denied hosts are collected per run (`gateSignals.sandbox.denied`, max 64) and **per login attempt** (`openDeniedWindow`).
  - **A denied host can break a page silently.** Keycloak's form never rendered because its CSS imports Google Fonts.
  - Hosts the app leaves blocked on purpose are declared in `dev.blockedOrigins`, e.g. telemetry such as Sentry.
- **File boundary.** At boot the entrypoint proves, as the sandbox uid, that it cannot read secrets or write code and config (`src/server/file-boundary-check.ts`, status in `/run/qa-file-boundary.status`). The egress filter's status is in `/run/qa-egress.status`.
  - `/api/health` exposes `sandbox: {degraded, isolation, egress, files}`.
  - Docker Desktop bind mounts (`fakeowner`) do not enforce permissions; that is why this proof exists.
- **Host suspension.** On a laptop, Docker Desktop's VM stops while the Mac sleeps. Wall-clock time jumps and monotonic timers inside the VM do not advance; we observed no logs at all for 32 minutes. **Telemetry must make a suspend visible**, e.g. via event-loop lag, a wall-versus-monotonic gap or heartbeat gaps. Otherwise every long campaign on a laptop produces phantom "hangs".
- **Zombies.** `headless_shell` processes owned by the sandbox uid, 2 days old, `<defunct>`, were seen in the orchestrator. They are cheap to count and a good health metric.

---

## 6. Data the system already records (reuse it; do not duplicate it blindly)

| Store | What | Gaps |
|---|---|---|
| SQLite `/app/data/qayaba.db` (`src/server/history.ts`) | `runs`, `run_outcomes`, `run_events`, `agent_turns` (toolSequence, callBuckets, tokens, timeToFirstCall, steps, writes, redundant and same-file reads, each read's window in toolSequence, promptBytes), `learning_rules`, `context_maps`, … | No reviewer or sidekick per-call data in recent runs. No OpenCode retries, title calls, provider error classes or event-loop health |
| `gateSignals` on the run outcome (`qa-engine/src/shared-kernel/run-outcome.ts`) | sandbox (egress mode, denied), closedLoop, agentBrowser, coordination, noop kind, coverage… | On an unhandled error before an outcome existed, only a minimal sandbox-only outcome is now persisted |
| `npm run probe-report -- <runId>` (`scripts/probe-report.ts`) | A per-run table of phases, turns, tools, tokens, cost, stitcher signals; JSON under `config/benchmarks/probe-results/` | A batch tool run after the fact |
| `npm run efficiency-benchmark` | Step and call telemetry across runs | Never a gate |
| Campaign runner (`scripts/campaign.ts`) | A/B arms; a no-retry validity re-run ×2 of what each arm delivered; a fake-pass detector; `campaign.json` / `.md` / `rubric.csv` | `QA_CAMPAIGN_FREEZE` must be on; engram is not isolated between replicates |
| OpenCode log (agents container) | Session create/cancel, per-step stream start, provider stream errors with class, retries, the title agent | Not correlated to run ids except through the session id |
| Container stdout logs | `[qa] …` lines, JSON API request logs | Unstructured, no trace or span ids |

**A good acceptance test for your work:** the probe report and the campaign tables should be derivable from your telemetry, and should mostly match today's numbers on the same runs.

**Sessions are deleted at the end of a run**, which destroys evidence. A turn's 62k-character reasoning could only be read on a replay. Decide deliberately what must outlive the session.

---

## 7. Failure catalog: what happened, and the signal that would have diagnosed it

| # | Observed (date) | What it looked like | Root cause | Signal that would have answered it immediately |
|---|---|---|---|---|
| F1 | No name-webapp run ever reached `execute` (through 10-16) | Endless infra-errors, invalids, skips | Many causes below | Funnel metric: runs by furthest phase reached × verdict × error code |
| F2 | A grounding agent turn "hung" 18–44 min (10-14) | A campaign wall-cap cancel, "Unexpected server error" | **The host slept**; the VM froze | Event-loop lag and suspend detection; heartbeat gap; the timeout that applied and whether it fired |
| F3 | Generator's first tool call at 115–266 s (10-12) | E-TIME-BUDGET with 0 writes | The provider's reasoning behaviour changed; the same prompt was fast earlier | Per-step reasoning tokens and duration; prompt hash plus bytes per section; time to first call; model and effort attributes |
| F4 | With `reasoningEffort: low`: 50 steps in 60 s, 45 file reads, 0 writes (10-12) | E-STEP-BUDGET | The changed element was not rendered on DEV (0 data rows) and nothing said so; the prompt offered no legitimate exit | Tool calls by family per turn; reads of prompt-provided files; the pack's "Changed values" facts versus the agent's outcome |
| F5 | Login timed out (10-12) | "Test timeout of 30000ms exceeded" waiting for the username field | Egress refused `fonts.googleapis.com`, so the Keycloak form never mounted | Denied hosts per login attempt; login step durations; page console errors (`Unable to preload CSS`) |
| F6 | The verified login was replaced by the stock seed (10-12) | The next run started cold; the generator spent its whole budget re-investigating the login | The store demoted a good login after an environmental failure (now fixed) | Suite-store events (restore, demote, capture) with reasons |
| F7 | Provider quota exhausted (10-16) | "grounding pass failed (non-blocking)", then a 240 s timeout | "Go usage limit exceeded" from opencode-go | Provider error class on the agent span; a quota-exceeded counter; the title-agent failures |
| F8 | Provider socket closed mid-stream (10-14) | Grounding pass error | Transient provider or network failure | Provider error class, OpenCode's internal retries, fallback model use |
| F9 | Agent browser cannot reach DEV (all of history) | 9/11 navigations wasted; repeated engram saves | Playwright MCP launched without the DEV Basic-gate credentials | Per-navigation outcome (HTTP status / auth error) on `execute_tool` spans |
| F10 | 5/5 earlier runs that produced specs ended `invalid` (E-STATIC strict-mode ambiguity) | Invalid | Ambiguous selectors (two same-label buttons) that were visible in the pack | Validation spans with the failing check and selector; the pre-exec ambiguity advisory count |
| F11 | DOM capture took 9 min instead of ~26 s (10-14) | Grounding ate the 25-minute run deadline before the generator ran | Partly host sleep, possibly slow pages | Per-route capture duration and state; capture child duration |
| F12 | Cleanup `npm ci` exit 243 (10-14) | The campaign replicate was marked invalid | Probably no network during host sleep (unconfirmed) | Install child: exit code, denied hosts, the registry it reached |
| F13 | The grounding brief claimed "the front has no dedicated duplicate-address message", which was false (10-11) | The spec asserted the generic toast | A grounding turn's variance; the generator was told "do NOT re-read that code" | Brief claims versus files actually read by the grounding turn (needed per-call data) |
| F14 | Sidekicks (September): median 65 calls, 52 reads, **0 writes** in 6 turns | No delivery | Unknown; that mode has never run live since its rebuild | Per-sidekick spans under the fan-out, with lease waits |
| F15 | The reviewer's model was rejected by the provider at one point (October) | E-REVIEWER-UNAVAILABLE path | Model availability | Provider error class on the reviewer span |
| F16 | Learned "experimental" rules told a shell-less generator to "run tsc" | No effect, or noise | The reflector invented a cause (the reflector is now off) | Which learned rules were injected per prompt, and the outcome per rule |

**What the data says about context resources** (measured over 56 runs, for your prioritisation):
- **Live DOM (context pack): essential**, but ~65% of it is filler (redirect advisory, `/home`, login stubs).
- **Grounding brief (removed): it was used.** Its risks became spec objectives. It was occasionally wrong.
- **Rendered context map** (4.8 KB) and **stitcher links/drift** (4.8 KB): pushed whole, rarely used by the agent.
- **Skill exemplars and learned rules:** unused.
- **Serena:** 0 calls. **The code graph:** reaches the agent only as the lead's `codegraph_explore`, served by the orchestrator.

**Telemetry must make "resource present vs. resource used vs. outcome" queryable per run.** That is how these verdicts get re-measured after each change, instead of argued about.

---

## 8. Questions the telemetry must answer (acceptance criteria)

You are done when each of these can be answered from your traces and metrics alone. No container shell, no SQLite, no OpenCode log.

1. For run X: which phase took the time, and which limit ended it (tier budget, run deadline, host cap, stall, step cap, cancellation)?
2. Was the process suspended, or the event loop blocked, during run X, and for how long?
3. For an agent turn: how long until the first tool call, how many reasoning tokens before it, and which model and effort actually answered (fallback included)?
4. Was the prompt of turn A identical to that of turn B? If not, which sections differed, and by how many bytes?
5. Which provider errors happened (quota, socket, 5xx), how many internal retries, and did a hidden title-agent call fail?
6. Which hosts did the egress filter refuse during the login, and during each spec execution?
7. What did the suite store do (restore, demote, capture) and why?
8. Per route of the DOM capture: grounded, degraded, redirected or empty? How long? Did the changed element appear (the "Changed values" facts)?
9. Per agent turn: tool calls by family; reads of files the prompt already supplied; wasted browser navigations (auth errors).
10. When the generator declared a no-op: which kind, and did it contradict the pack's facts?
11. In lead+sidekicks mode: per sidekick, steps, calls, writes, lease wait, escalation outcome.
12. Across runs: the funnel (furthest phase reached), the verdict mix by error code, p50/p95 per phase, tokens and cost per role, and the share of context bytes that are tool schemas.

---

## 9. Constraints and gotchas for the implementer

- **Never block or fail a run because telemetry failed.** Exporters fail open, and a missing collector is a no-op. This mirrors how grounding is fail-open; the difference is that telemetry must never alter a verdict.
- **Deterministic engine.** Do not add sampling decisions that differ between the arms of an A/B campaign.
- **One runtime.** OpenCode (via HTTP + SSE), supervised by `agents/agent-supervisor.mjs`. Another runtime is added behind the same port, and it must emit the same span shape per agent turn.
- **Cross-container propagation.** The agents container calls back into the orchestrator (`run_spec`, `authbrowser_*`) through tools that live in `agents/tool/*.ts`, run inside OpenCode and are re-verified by smokes in `agents/smoke/`. Correlating those callbacks with the calling turn needs either context headers through the tool's POST, or the session id plus agent name (already sent) as a join key.
- **Pinned versions on the execution path.** Playwright 1.60.0 and OpenCode 1.17.7. Do not upgrade them for telemetry.
- **Tests.** `docs/testing-standards.md` applies: behaviour through public seams, fakes for ports, no real network or time, writes only under `os.tmpdir()`. Telemetry as a port makes this straightforward. Wire the real SDK in the composition root.
- **Local operability.** The owner runs the stack on a Mac (Docker Desktop) and diagnoses from there. A local collector and viewer in a compose profile, off by default, is the expected way to look at traces.
- **Language.** Everything in code, comments and docs is in English.

## 10. Glossary

| Term | Meaning |
|---|---|
| Run | One pipeline execution for an (app, sha, mode) |
| Turn | One prompt to an agent session |
| Step | One LLM call inside a turn |
| Call | One tool invocation inside a step |
| Grounding | What the orchestrator pre-computes for the agent (brief, live DOM pack, map, facts) |
| Context pack | The prompt section carrying the live DOM of ranked routes plus related facts |
| Suite store | Per-app storage of accepted specs and a verified login across runs (`/app/data/suites/<app>/`) |
| Shadow | A mode where PRs and Issues are replaced by log lines (name-webapp runs in shadow) |
| Campaign | An A/B measurement: pipeline (arm B) vs plain agent (arm A), with no-retry validity re-runs |
| Tier | The diff size class: tiny ≤2 files and 40 lines, focused ≤8 and 400, broad above |
| Cross-repo run | A service repo's change triggering the front end's suite (stitcher links FE↔BE) |
