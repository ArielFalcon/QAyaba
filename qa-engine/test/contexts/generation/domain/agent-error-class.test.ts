import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentTimeoutError, StalledAgentError, AgentUnavailableError } from "@kernel/domain-error.ts";
import { AGENT_ERROR_TYPES, classifyAgentFault, classifyProviderError } from "@contexts/generation/domain/agent-error-class.ts";

test("a provider payload is classified by its error name and HTTP status", () => {
  const cases: Array<[Parameters<typeof classifyProviderError>[0], string]> = [
    [{ name: "ProviderAuthError" }, "auth"],
    [{ name: "APIError", data: { statusCode: 401 } }, "auth"],
    [{ name: "APIError", data: { statusCode: 403 } }, "auth"],
    [{ name: "APIError", data: { statusCode: 402 } }, "quota_exceeded"],
    [{ name: "APIError", data: { statusCode: 429, message: "Too many requests, slow down" } }, "rate_limited"],
    [{ name: "APIError", data: { statusCode: 429, message: "You exceeded your current quota" } }, "quota_exceeded"],
    [{ name: "APIError", data: { statusCode: 429, message: "Monthly usage limit reached" } }, "quota_exceeded"],
    [{ name: "APIError", data: { statusCode: 400, message: "Insufficient credits" } }, "quota_exceeded"],
    [{ name: "APIError", data: { statusCode: 500 } }, "provider_5xx"],
    [{ name: "APIError", data: { statusCode: 503 } }, "provider_5xx"],
    [{ name: "MessageOutputLengthError" }, "output_length"],
    [{ name: "MessageAbortedError" }, "aborted"],
    [{ name: "APIError", data: { statusCode: 418 } }, "unknown"],
    [{ name: "SomethingNew" }, "unknown"],
  ];
  for (const [payload, expected] of cases) assert.equal(classifyProviderError(payload), expected, JSON.stringify(payload));
});

test("a thrown fault is classified by its class, its socket code or its status", () => {
  const withCode = (code: string, message = "boom") => Object.assign(new Error(message), { code });
  const cases: Array<[unknown, string]> = [
    [new AgentTimeoutError("OpenCode prompt: timed out after 5ms"), "timeout"],
    [new StalledAgentError("no activity"), "timeout"],
    [new Error("OpenCode circuit breaker is OPEN (cooldown 3s remaining)"), "circuit_open"],
    [Object.assign(new Error("aborted"), { name: "AbortError" }), "aborted"],
    [withCode("ECONNRESET"), "socket_closed"],
    [withCode("UND_ERR_SOCKET"), "socket_closed"],
    [Object.assign(new TypeError("terminated"), { cause: withCode("UND_ERR_SOCKET") }), "socket_closed"],
    [new Error("other side closed"), "socket_closed"],
    [Object.assign(new Error("bad gateway"), { status: 502 }), "provider_5xx"],
    [Object.assign(new Error("payment required"), { statusCode: 402 }), "quota_exceeded"],
    [Object.assign(new Error("slow down"), { status: 429 }), "rate_limited"],
    [new Error("something else entirely"), "unknown"],
    ["a string", "unknown"],
    [undefined, "unknown"],
  ];
  for (const [fault, expected] of cases) assert.equal(classifyAgentFault(fault), expected, String(fault));
});

test("a fault that carries its provider classification keeps it", () => {
  const err = Object.assign(new AgentUnavailableError("out of credits"), { agentErrorType: "quota_exceeded" });
  assert.equal(classifyAgentFault(err), "quota_exceeded");
});

test("every class the classifiers can answer is a member of the exported set", () => {
  const answers = [
    classifyProviderError({ name: "ProviderAuthError" }),
    classifyProviderError({ name: "APIError", data: { statusCode: 503 } }),
    classifyProviderError({ name: "Unheard" }),
    classifyAgentFault(new AgentTimeoutError("t")),
    classifyAgentFault(new Error("circuit breaker is OPEN")),
    classifyAgentFault(undefined),
  ];
  for (const answer of answers) assert.ok((AGENT_ERROR_TYPES as readonly string[]).includes(answer), answer);
});

test("a cause cycle classifies as unknown instead of recursing, and a long chain stops at a bounded depth", () => {
  const a = new Error("a");
  const b = new Error("b");
  (a as { cause?: unknown }).cause = b;
  (b as { cause?: unknown }).cause = a;
  assert.equal(classifyAgentFault(a), "unknown");
  let deep: Error = Object.assign(new Error("root"), { code: "ECONNRESET" });
  for (let i = 0; i < 50; i++) deep = Object.assign(new Error("wrapper"), { cause: deep });
  assert.equal(classifyAgentFault(deep), "unknown", "a cause beyond the depth cap is not followed");
  const shallow = Object.assign(new Error("wrapper"), { cause: Object.assign(new Error("root"), { code: "ECONNRESET" }) });
  assert.equal(classifyAgentFault(shallow), "socket_closed");
});
