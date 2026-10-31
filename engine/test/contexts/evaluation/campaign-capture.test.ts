import { test } from "node:test";
import assert from "node:assert/strict";
import { CAMPAIGN_CAPTURE_MODE, CampaignCaptureMismatchError, assertUniformCapture, requestedCaptureMode } from "@contexts/evaluation/domain/campaign-capture.ts";

test("a campaign run that names no capture mode asks for full, an ordinary run asks for none", () => {
  assert.equal(requestedCaptureMode({ campaign: { id: "c" } }), CAMPAIGN_CAPTURE_MODE);
  assert.equal(requestedCaptureMode({}), undefined);
});

test("a mode the request names wins over the campaign default", () => {
  assert.equal(requestedCaptureMode({ captureMode: "metadata", campaign: { id: "c" } }), "metadata");
});

test("a run joins a campaign only with the mode its earlier runs applied", () => {
  assert.doesNotThrow(() => assertUniformCapture("c", "full", undefined));
  assert.doesNotThrow(() => assertUniformCapture("c", "full", "full"));
  assert.throws(
    () => assertUniformCapture("ab-1", "full", "metadata"),
    (err: unknown) => err instanceof CampaignCaptureMismatchError && err.expected === "metadata" && err.applied === "full" && err.campaignId === "ab-1" && /send captureMode 'metadata' or none/.test(err.message),
  );
});
