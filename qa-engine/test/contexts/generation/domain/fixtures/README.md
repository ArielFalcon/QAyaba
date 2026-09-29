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

Leading and closing excerpts of real `agent_turns.output_text` values from
exhausted generator, sidekick and recovery turns, recorded 2026-09-28 from
benchmark runs of a web app. App, feature and commit identifiers are replaced by
placeholders; the step-limit wording is verbatim. They are the true positives
that show how a model restates the notice in its own turn.
