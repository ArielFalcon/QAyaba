import { test } from "node:test";
import assert from "node:assert/strict";
import { staticFixAction, type StaticFixInput } from "@contexts/run-orchestration/domain/static-fix.ts";

const failing: StaticFixInput = { validation: { ok: false }, rounds: 0, max: 2, generating: true, hasDelivered: true };

test("a failing gate on delivered specs is repaired", () => {
  assert.equal(staticFixAction(failing), "repair");
  assert.equal(staticFixAction({ ...failing, rounds: 1 }), "repair");
});

test("a passing gate stops", () => assert.equal(staticFixAction({ ...failing, validation: { ok: true } }), "stop"));
test("a gate that could not run stops: no repair of the specs changes it", () => assert.equal(staticFixAction({ ...failing, validation: { ok: false, infra: true } }), "stop"));
test("a run with nothing delivered stops", () => assert.equal(staticFixAction({ ...failing, hasDelivered: false }), "stop"));
test("a run that does not author tests stops", () => assert.equal(staticFixAction({ ...failing, generating: false }), "stop"));
test("the last round spent stops", () => {
  assert.equal(staticFixAction({ ...failing, rounds: 2 }), "stop");
  assert.equal(staticFixAction({ ...failing, rounds: 3 }), "stop");
});
