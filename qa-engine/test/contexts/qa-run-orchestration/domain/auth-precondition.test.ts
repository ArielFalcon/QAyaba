import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthPreconditionError, PRECONDITION_KIND } from "@contexts/qa-run-orchestration/domain/auth-precondition.ts";

const KINDS = Object.values(PRECONDITION_KIND);

test("every precondition kind is distinct and builds an error carrying that kind, its note and its duration", () => {
  assert.ok(KINDS.length > 0);
  assert.equal(new Set(KINDS).size, KINDS.length);
  for (const [i, kind] of KINDS.entries()) {
    const error = new AuthPreconditionError(kind, `note ${i}`, 100 + i);
    assert.equal(error.kind, kind);
    assert.equal(error.note, `note ${i}`);
    assert.equal(error.ms, 100 + i);
  }
});

test("a precondition error is told apart from a generic error, and is still an Error", () => {
  const precondition = new AuthPreconditionError(PRECONDITION_KIND.CREDENTIALS_REJECTED, "the login was rejected", 5);
  assert.ok(precondition instanceof AuthPreconditionError);
  assert.ok(precondition instanceof Error);
  assert.equal(new Error("auth setup failed") instanceof AuthPreconditionError, false);
});

test("a precondition error prints under a name of its own, so a log line tells it apart from a generic failure", () => {
  const precondition = new AuthPreconditionError(PRECONDITION_KIND.CAPTCHA_PRESENT, "a challenge is visible", 9);
  const generic = new Error("a challenge is visible");
  assert.notEqual(precondition.name, generic.name);
  assert.notEqual(String(precondition), String(generic));
  assert.ok(String(precondition).includes("a challenge is visible"));
});

test("a precondition error prints only its note, and carries no evidence or cause to leak", () => {
  const error = new AuthPreconditionError(PRECONDITION_KIND.LOGIN_DID_NOT_COMPLETE, "the password field stayed visible", 7);
  assert.equal(error.message, "the password field stayed visible");
  assert.equal("evidence" in error, false);
  assert.equal("cause" in error, false);
});
