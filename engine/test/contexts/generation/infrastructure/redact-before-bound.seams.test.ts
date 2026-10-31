/* A secret at the edge of what the redactor saw never reaches an event, a log or a turn's record: the bound of a producer is applied to redacted text, and redaction that shrank the text it saw does not bring the unseen edge into the kept part (shared-kernel/redact-then-bound.ts). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentDeps, type AgentTurnEvent, type RawAgentTransport } from "@contexts/generation/infrastructure/agent-transport-policy.ts";
import { resetCircuit } from "@contexts/generation/infrastructure/resilience/circuit-breaker.ts";
import { mapOpencodeEvent } from "@contexts/generation/infrastructure/sse/activity-mapper.ts";
import { CallEfficiencyTracker, STREAMED_TEXT_MAX_CHARS, type StreamToken } from "@contexts/generation/infrastructure/sse/call-efficiency-tracker.ts";
import { sanitizeText } from "../../../../src/shared-infrastructure/redaction/pattern-redaction.adapter.ts";
import { REDACTION_LOOKAHEAD_CHARS } from "../../../../src/shared-kernel/redact-then-bound.ts";
import { RUN_PASS, base64Run, filler, withRunSecrets } from "../../../support/straddling-secrets.ts";

const PASS_WORDS = /violet|cobalt|meadow|seventeen|olet c|eadow/;
const ACTIVITY_BOUND = 200;

test("a run event's command keeps no part of a run secret that stands at the edge of a window a base64 blob shrank", () => {
  const window = ACTIVITY_BOUND + REDACTION_LOOKAHEAD_CHARS;
  const head = `echo ${base64Run(8300)} | base64 -d > e2e/fixtures/avatar.png && npx qa-login --password `;
  const command = `${head}${" ".repeat(window - 15 - head.length)} ${RUN_PASS} --headed`;
  const events = withRunSecrets(() => mapOpencodeEvent({ type: "command.executed", properties: { sessionID: "s1", name: "bash", arguments: command } }, new Map([["s1", "run-1"]])));
  const leaving = withRunSecrets(() => sanitizeText(JSON.stringify(events)).text);
  assert.doesNotMatch(leaving, PASS_WORDS);
});

test("a timed-out turn's partial text keeps no part of a run secret at the start of the tail the tracker retained", async () => {
  resetCircuit();
  const turns: AgentTurnEvent[] = [];
  const directory = "/mirrors/org__app";
  const tracker = new CallEfficiencyTracker();
  const stream: StreamToken = Symbol("stream");
  tracker.streamOpening(directory, stream);
  tracker.streamConnected(directory, stream);
  tracker.attach("sess-1", directory);
  await tracker.prepareAttempt("sess-1", 0);
  const retained = STREAMED_TEXT_MAX_CHARS + REDACTION_LOOKAHEAD_CHARS;
  const after = ` I decoded the fixture: ${base64Run(retained - 15 - 40)} and moved on.`;
  const text = `${filler(300)} the login form takes ${RUN_PASS}${after}`;
  tracker.record({ type: "message.part.updated", properties: { part: { id: "step-1", sessionID: "sess-1", messageID: "msg_1", type: "step-start" } } });
  tracker.record({ type: "message.part.updated", properties: { part: { id: "p1", sessionID: "sess-1", messageID: "msg_1", type: "text", text } } });
  const hung: RawAgentTransport = { createSession: async () => ({ id: "sess-1" }), promptSession: () => new Promise(() => {}), abortSession: async () => {}, deleteSession: async () => {} };
  const deps = createAgentDeps(hung, { defaultPromptTimeoutMs: 15, getFallbackModel: () => undefined, takeTurnCalls: (id, prompt) => tracker.take(id, prompt) });
  await withRunSecrets(async () => {
    const session = await deps.open("qa-author", directory, { onTurn: (turn: AgentTurnEvent) => void turns.push(turn) });
    await assert.rejects(() => session.prompt("write the specs"), /timed out/);
  });
  const partial = turns[0]!.partialText ?? "";
  assert.ok(partial.length > 0);
  assert.doesNotMatch(partial, PASS_WORDS);
});
