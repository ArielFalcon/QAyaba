import { test } from "node:test";
import assert from "node:assert/strict";
import { CampaignInputSchema, CreateRunInputSchema } from "./commands";

const ok = { id: "ab-2026-10:glm.1", variant: { model: "glm-5.3", closedLoop: "on" }, replicate: 3 };
const base = { app: "demo", target: "e2e", mode: "diff" };

test("a well-formed campaign and a capture mode are accepted on a run request", () => {
  const parsed = CreateRunInputSchema.safeParse({ ...base, campaign: ok, captureMode: "full" });
  assert.equal(parsed.success, true);
});

test("a campaign id is 1 to 100 characters of the allowed set", () => {
  assert.equal(CampaignInputSchema.safeParse({ ...ok, id: "" }).success, false);
  assert.equal(CampaignInputSchema.safeParse({ ...ok, id: "a".repeat(101) }).success, false);
  assert.equal(CampaignInputSchema.safeParse({ ...ok, id: "a".repeat(100) }).success, true);
  assert.equal(CampaignInputSchema.safeParse({ ...ok, id: "has space" }).success, false);
  assert.equal(CampaignInputSchema.safeParse({ ...ok, id: "a/b" }).success, false);
});

test("variant keys and values are bounded and limited to the same set, with at most 16 keys", () => {
  assert.equal(CampaignInputSchema.safeParse({ ...ok, variant: { "k y": "v" } }).success, false);
  assert.equal(CampaignInputSchema.safeParse({ ...ok, variant: { k: "v v" } }).success, false);
  assert.equal(CampaignInputSchema.safeParse({ ...ok, variant: { k: "" } }).success, false);
  assert.equal(CampaignInputSchema.safeParse({ ...ok, variant: { ["k".repeat(65)]: "v" } }).success, false);
  assert.equal(CampaignInputSchema.safeParse({ ...ok, variant: { k: "v".repeat(65) } }).success, false);
  const sixteen = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, "v"]));
  assert.equal(CampaignInputSchema.safeParse({ ...ok, variant: sixteen }).success, true);
  assert.equal(CampaignInputSchema.safeParse({ ...ok, variant: { ...sixteen, k16: "v" } }).success, false);
  assert.equal(CampaignInputSchema.safeParse({ ...ok, variant: {} }).success, true);
});

test("a replicate is a whole number from 1 to 1000", () => {
  for (const replicate of [0, -1, 1.5, 1001]) assert.equal(CampaignInputSchema.safeParse({ ...ok, replicate }).success, false);
  for (const replicate of [1, 1000]) assert.equal(CampaignInputSchema.safeParse({ ...ok, replicate }).success, true);
});

test("an unknown capture mode is refused", () => {
  assert.equal(CreateRunInputSchema.safeParse({ ...base, captureMode: "everything" }).success, false);
});
