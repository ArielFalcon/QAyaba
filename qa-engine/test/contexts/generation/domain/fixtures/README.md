# Domain fixtures

## `opencode-max-steps-instruction.txt`

Recorded-output fixture for `detectStepExhaustion`. Extracted
2026-09-28 from the compiled OpenCode 1.17.7 server binary itself
(`/usr/local/lib/node_modules/opencode-ai/bin/opencode.exe` in the `agents`
container), via `strings` on the binary followed by a targeted grep for the
step-limit template literal — this is the exact, verbatim system instruction
OpenCode injects into the conversation once `maxSteps` is reached (source:
the `StepLimitExceededError`/`SessionRunner` bundle chunk). It is the ground
truth the pinned `MAX_STEPS_MARKER` ("maximum steps … reached",
case-insensitive) is checked against, both for a true positive (this fixture)
and — via the SSE fixture at `../../infrastructure/sse/fixtures/`, whose
captured turn never hit the step limit — a true negative.
