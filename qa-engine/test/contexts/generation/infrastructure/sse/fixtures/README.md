# SSE fixtures

## `opencode-1.17.7-step-parts.json`

Captured 2026-09-28 from a live `opencode serve` v1.17.7 instance (the `agents`
container in this repo's own docker-compose stack), via the same
`@opencode-ai/sdk` `event.subscribe`/`session.prompt` primitives
`src/integrations/opencode-client.ts` uses. The prompt was a single trivial,
tool-free turn ("Reply with the single word: ack. Do not use any tools.")
against the `build` agent, run with no other session active.

**Finding:** `step-start` and `step-finish` **are**
emitted on the SSE stream as `message.part.updated` events whose
`properties.part.type` is `"step-start"` / `"step-finish"` (events 13 and 17,
zero-based, in the array). This means `stepsUsed` (the distinct count of
`step-start` parts) can be non-null for
OpenCode-backed turns — it is not resolvable from Codex, which never streams
tool/step events.

The array is otherwise unmodified raw output — no prompt/response content was
redacted because the fixture only carries the trivial ack exchange, not real
generation content.
