import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getHistory } from "../../server/persistence/index";

/* The SQLite DB persists across runs; suffix the app so repeated suite runs never collide. */
function uniqueApp(): string {
  return `veto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe("human veto / restore (setRuleStatusByHuman)", () => {
  it("vetoing forces a rule to deprecated; restoring returns it to active", () => {
    const app = uniqueApp();
    const id = `${app}-r`;
    getHistory().learning.upsertLearningRule({ id, app, trigger: "Applies when x changes", action: "do y", errorClass: "E-FRAGILE-SELECTOR", source: "run-1" });

    assert.equal(getHistory().learning.setRuleStatusByHuman(id, "deprecated"), true, "veto reports success");
    assert.equal(getHistory().learning.listAllLearningRules(app, 10).find((x) => x.id === id)?.status, "deprecated");

    assert.equal(getHistory().learning.setRuleStatusByHuman(id, "active"), true, "restore reports success");
    assert.equal(getHistory().learning.listAllLearningRules(app, 10).find((x) => x.id === id)?.status, "active");
  });

  it("returns false for an unknown rule id (no silent success)", () => {
    assert.equal(getHistory().learning.setRuleStatusByHuman(`${uniqueApp()}-missing`, "deprecated"), false);
  });

  it("a vetoed rule vanishes from the retrieval list — so it is never re-injected (the veto sticks)", () => {
    const app = uniqueApp();
    const id = `${app}-r`;
    getHistory().learning.upsertLearningRule({ id, app, trigger: "Applies when x changes", action: "do y", errorClass: "E-FRAGILE-SELECTOR", source: "run-1" });
    /* original intent — without it these outcomes would leave the rule at candidate, which is
       also retrievable, but the precondition below is written to assert the ACTIVE, proven case).
     */
    for (let i = 0; i < 3; i++) getHistory().learning.recordRuleOutcome(id, 1, null, true); /* earn promotion → active → retrievable */
    assert.equal(getHistory().learning.listAllLearningRules(app, 10).find((r) => r.id === id)?.status, "active", "precondition: the rule earned promotion to active");
    assert.ok(getHistory().learning.listLearningRules(app, 10).some((r) => r.id === id), "precondition: an active rule is in the retrieval list");

    getHistory().learning.setRuleStatusByHuman(id, "deprecated");
    assert.equal(getHistory().learning.listLearningRules(app, 10).some((r) => r.id === id), false, "vetoed → excluded from retrieval → no new outcomes → cannot auto-resurrect");
  });
});
