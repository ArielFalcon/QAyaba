import { test } from "node:test";
import assert from "node:assert/strict";
import { ManifestEntrySchema, WebhookPayloadSchema } from "./schemas";

const manifestEntry = {
  id: "login",
  objective: "valid credentials reach the dashboard",
  flow: "login",
  targets: ["AuthService.login"],
  changeRef: { sha: "abc123", type: "feat" },
};

test("ManifestEntrySchema accepts a well-formed entry", () => {
  assert.equal(ManifestEntrySchema.safeParse(manifestEntry).success, true);
});

test("ManifestEntrySchema rejects empty targets / empty objective — write uses the read invariant", () => {
  /* Write uses the same schema as read — a bad entry is dropped rather than corrupting the manifest. */
  assert.equal(ManifestEntrySchema.safeParse({ ...manifestEntry, targets: [] }).success, false);
  assert.equal(ManifestEntrySchema.safeParse({ ...manifestEntry, objective: "" }).success, false);
});

test("a webhook payload names one of the run modes and refuses any other", () => {
  const payload = { repo: "org/app", sha: "abcdef1" };
  for (const mode of ["diff", "manual", "context"]) assert.equal(WebhookPayloadSchema.safeParse({ ...payload, mode }).success, true, mode);
  assert.equal(WebhookPayloadSchema.safeParse(payload).success, true);
  assert.equal(WebhookPayloadSchema.safeParse({ ...payload, mode: "exhaustive" }).success, false);
});
