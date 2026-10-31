/* The guidance of a run request, a continuation and a webhook is redacted before it is bounded. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ContinueBodySchema } from "./api/use-cases/continue-run";
import { MAX_GUIDANCE_LENGTH, boundGuidance } from "./guidance";
import { parseWebhook } from "./webhook";

const TOKEN = `sk-${"Q7x9Zk2M".repeat(6)}`;
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const words = "check the cart totals after applying the discount code and ";
const straddling = (): string => `${words.repeat(Math.ceil(MAX_GUIDANCE_LENGTH / words.length)).slice(0, MAX_GUIDANCE_LENGTH - 12)}${TOKEN} then log out`;

test("a token straddling the bound of a webhook's guidance leaves no part of itself", () => {
  const payload = parseWebhook({ repo: "org/app", sha: SHA, mode: "manual", guidance: straddling() });
  assert.ok(payload !== null);
  assert.ok(!(payload.guidance ?? "").includes("sk-Q7x9"), payload.guidance?.slice(-40));
});

test("a token straddling the bound of a continuation's guidance leaves no part of itself", () => {
  const body = ContinueBodySchema.parse({ guidance: straddling() });
  assert.ok(!(body.guidance ?? "").includes("sk-Q7x9"), body.guidance?.slice(-40));
});

test("guidance that is not text is ignored and short guidance is kept as written", () => {
  assert.equal(boundGuidance(42), undefined);
  assert.equal(boundGuidance("test the contact form"), "test the contact form");
});
