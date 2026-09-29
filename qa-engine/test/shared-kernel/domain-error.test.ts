import { test } from "node:test";
import assert from "node:assert/strict";
import { InfraError, AgentUnavailableError, StalledAgentError, UntrustedGitTreeError, isInfraError, isUntrustedGitTreeError, rethrowIfUntrusted } from "@kernel/domain-error.ts";

test("the taxonomy is a sealed hierarchy: agent errors are InfraErrors", () => {
  assert.ok(new AgentUnavailableError("x") instanceof InfraError);
  assert.ok(new StalledAgentError("x") instanceof InfraError);
  assert.equal(new AgentUnavailableError("x").name, "AgentUnavailableError");
  assert.equal(new StalledAgentError("x").name, "StalledAgentError");
});

test("isInfraError recognizes the taxonomy by instanceof", () => {
  assert.equal(isInfraError(new InfraError("x")), true);
  assert.equal(isInfraError(new AgentUnavailableError("x")), true);
  assert.equal(isInfraError(new StalledAgentError("x")), true);
  assert.equal(isInfraError(new Error("ordinary")), false);
});

test("isInfraError falls back to name + operator-cancel message across realms", () => {
  const crossRealm = new Error("oops");
  crossRealm.name = "StalledAgentError";
  assert.equal(isInfraError(crossRealm), true);
  assert.equal(isInfraError(new Error("run cancelled by operator")), true);
  assert.equal(isInfraError({ name: "InfraError" }), false); /* not an Error instance */
});

test("cause is preserved when provided", () => {
  const cause = new Error("root");
  assert.equal((new InfraError("x", { cause }) as { cause?: unknown }).cause, cause);
});

test("rethrowIfUntrusted throws an untrusted git tree error on, by type or by name across realms, and returns for anything else", () => {
  const refusal = new UntrustedGitTreeError("refusing to run git on /m: it is a symbolic link");
  assert.throws(() => rethrowIfUntrusted(refusal), (err: unknown) => err === refusal);
  const otherRealm = Object.assign(new Error("refusing"), { name: "UntrustedGitTreeError" });
  assert.throws(() => rethrowIfUntrusted(otherRealm), (err: unknown) => err === otherRealm);
  for (const soft of [new Error("git failed"), new InfraError("git could not run"), "text", undefined]) {
    assert.doesNotThrow(() => rethrowIfUntrusted(soft));
  }
});

test("an untrusted git tree is not an infrastructure error: it is a refusal of its own", () => {
  assert.equal(isInfraError(new UntrustedGitTreeError("refusing")), false);
  assert.equal(isUntrustedGitTreeError(new InfraError("git could not run")), false);
});
