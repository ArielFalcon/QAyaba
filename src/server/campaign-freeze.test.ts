import { test } from "node:test";
import assert from "node:assert/strict";
import { CAMPAIGN_FREEZE_ENV, resolveCampaignFreeze } from "./campaign-freeze";

test("the campaign freeze is off when the variable is unset, blank, 0 or false", () => {
  assert.equal(resolveCampaignFreeze({}), false);
  for (const value of ["", "  ", "0", "false", "FALSE"]) {
    assert.equal(resolveCampaignFreeze({ [CAMPAIGN_FREEZE_ENV]: value }), false, JSON.stringify(value));
  }
});

test("the campaign freeze is on for 1 and true in any case", () => {
  for (const value of ["1", "true", "True", " 1 "]) {
    assert.equal(resolveCampaignFreeze({ [CAMPAIGN_FREEZE_ENV]: value }), true, JSON.stringify(value));
  }
});

test("a mistyped campaign freeze value stops the composition, naming the variable", () => {
  assert.throws(() => resolveCampaignFreeze({ [CAMPAIGN_FREEZE_ENV]: "yes" }), new RegExp(CAMPAIGN_FREEZE_ENV));
});
