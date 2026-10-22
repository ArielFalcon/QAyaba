import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MIN_OPAQUE_TOKEN_CHARS, OPAQUE_TOKEN_REMOVED, dropOpaqueTokens } from "../../src/shared-infrastructure/output-token-filter.ts";

/* Fixed, random-looking bytes: a digest of a seed, so the cases never change between runs. */
const bytesOf = (seed: string, length: number): Buffer => createHash("sha512").update(seed).digest().subarray(0, length);
const base64 = (length: number): string => bytesOf(`base64-${length}`, length).toString("base64");

test("a long high-entropy token that the page never showed is taken out of the text", () => {
  for (const token of [base64(30), base64(48), bytesOf("hex", 24).toString("hex"), bytesOf("url", 40).toString("base64url")]) {
    const out = dropOpaqueTokens(`expected visible but saw ${token} instead`, "");
    assert.equal(out, `expected visible but saw ${OPAQUE_TOKEN_REMOVED} instead`, token);
  }
});

test("the same token is kept when the page capture shows it: the agent can read it there already", () => {
  const token = base64(40);
  assert.equal(dropOpaqueTokens(`saw ${token}`, `heading: Order ${token}\nbutton: Save`), `saw ${token}`);
});

test("ordinary long text is kept: a selector, a path, a readable identifier, a uuid, a url", () => {
  for (const text of [
    "getByRole('button', { name: 'Save changes' }).toBeVisible",
    "/app/.mirrors/some-app/e2e/flows/checkout-submit-button-visible.spec.ts",
    "checkout-submit-button-with-a-very-long-readable-name",
    "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    "https://dev.example.com/organizations/settings/notification-preferences",
    "the quick brown fox jumps over the lazy dog and keeps running",
  ]) {
    assert.equal(dropOpaqueTokens(text, ""), text, text);
  }
});

test("a token one character short of the length floor is kept", () => {
  const short = base64(24).slice(0, MIN_OPAQUE_TOKEN_CHARS - 1);
  assert.equal(short.length, MIN_OPAQUE_TOKEN_CHARS - 1);
  assert.equal(dropOpaqueTokens(short, ""), short);
});

test("text with no token is returned as it is", () => {
  assert.equal(dropOpaqueTokens("", ""), "");
  assert.equal(dropOpaqueTokens("plain", "anything"), "plain");
});
