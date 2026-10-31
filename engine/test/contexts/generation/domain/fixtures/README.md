# Domain fixtures

## `opencode-max-steps-instruction.txt`

Recorded-output fixture for `detectStepExhaustion`. Extracted
2026-09-28 from the compiled OpenCode 1.17.7 server binary itself
(`/usr/local/lib/node_modules/opencode-ai/bin/opencode.exe` in the `agents`
container), via `strings` on the binary followed by a targeted grep for the
step-limit template literal — this is the exact, verbatim system instruction
OpenCode injects into the conversation once `maxSteps` is reached (source:
the `StepLimitExceededError`/`SessionRunner` bundle chunk). It is the ground
truth `detectStepExhaustion` is checked against, both for a true positive (this
fixture) and — via the SSE fixture at `../../infrastructure/sse/fixtures/`, whose
captured turn never hit the step limit — a true negative.

## `exhausted-turn-outputs.json`

Turn outputs the step-exhaustion tests read, in two lists. App, feature,
commit and selector identifiers are replaced by placeholders (`<sha>`, `<app>`,
`<finding>`); the step-limit sentences and the closing verdict JSON keep their
recorded wording. No URLs, commit hashes or app names appear in it.

`outputs` — each entry is a persisted `agent_turns.output_text` (reasoning and
text joined) and says whether `detectStepExhaustion` should flag it:

- The exhausted entries are leading and closing excerpts of real outputs from
  exhausted generator, sidekick and recovery turns, recorded 2026-09-28 from
  benchmark runs of a web app. They show how a model restates the notice in its
  own turn.
- The verdict-JSON entry is constructed to the shape of a generator's closing
  verdict whose scenario names a maximum length and a reached page in different
  fields; it is the case a punctuation-blind matcher would flag.
- The acknowledgement entry is constructed: a turn that states its step
  allowance and progress without reaching the limit.

`turns` — each entry is a response as the parts the agent runtime returns
(`step-start`, `reasoning`, `text`), for the final-step tests:

- The recovery turn is an excerpt of a real repair turn: its reasoning recalls
  that the earlier turn hit max steps, and its text is the closing verdict.
- The declared-no-op turn is constructed to the no-op contract: its reasoning
  quotes the output-contract example, and its text is the statement itself. No
  recorded turn declares a no-op.
