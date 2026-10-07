import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeDeliveredSpecs } from "@contexts/qa-run-orchestration/domain/helpers/delivered-specs.ts";
import type { DeliveredSpec } from "@kernel/delivered-spec.ts";

const lead = (specs: string[], declaredSpecs?: DeliveredSpec[]) => ({ specs, ...(declaredSpecs ? { declaredSpecs } : {}) });

/** Deep-frozen, so a merge that writes into what it was given throws instead of passing silently. */
function frozen<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const inner of Object.values(value)) frozen(inner);
    Object.freeze(value);
  }
  return value;
}

test("a lead pass delivers its specs with the flow and objective it declared, in the order it declared them", () => {
  const declared = [
    { file: "a.spec.ts", flow: "login", objective: "the user signs in" },
    { file: "b.spec.ts", flow: "checkout", objective: "the order is placed" },
  ];
  assert.deepEqual(mergeDeliveredSpecs([], lead(["a.spec.ts", "b.spec.ts"], declared), "lead"), declared);
});

test("a later lead pass refreshes the flow and objective of a spec it delivers again: the newest wins", () => {
  const before = [{ file: "a.spec.ts", flow: "login", objective: "old objective" }];
  const after = mergeDeliveredSpecs(before, lead(["a.spec.ts"], [{ file: "a.spec.ts", flow: "sign in", objective: "new objective" }]), "lead");
  assert.deepEqual(after, [{ file: "a.spec.ts", flow: "sign in", objective: "new objective" }]);
});

test("a later lead pass that declares no objective for a spec leaves the one it had", () => {
  const before = [{ file: "a.spec.ts", flow: "login", objective: "the user signs in" }];
  assert.deepEqual(mergeDeliveredSpecs(before, lead(["a.spec.ts"], [{ file: "a.spec.ts" }]), "lead"), before);
  assert.deepEqual(mergeDeliveredSpecs(before, lead(["a.spec.ts"], [{ file: "a.spec.ts", flow: "  ", objective: "" }]), "lead"), before);
});

test("a lead pass with no declarations still delivers its specs, by path, and clears nothing", () => {
  const before = [{ file: "a.spec.ts", flow: "login", objective: "the user signs in" }];
  assert.deepEqual(mergeDeliveredSpecs(before, lead(["a.spec.ts", "b.spec.ts"]), "lead"), [
    { file: "a.spec.ts", flow: "login", objective: "the user signs in" },
    { file: "b.spec.ts" },
  ]);
});

test("a spec a lead pass reports but does not declare is still delivered", () => {
  assert.deepEqual(mergeDeliveredSpecs([], lead(["a.spec.ts", "b.spec.ts"], [{ file: "b.spec.ts", flow: "checkout", objective: "o" }]), "lead"), [
    { file: "a.spec.ts" },
    { file: "b.spec.ts", flow: "checkout", objective: "o" },
  ]);
});

test("a sidekick pass delivers its specs by path alone", () => {
  assert.deepEqual(mergeDeliveredSpecs([], lead(["d.spec.ts"]), "sidekick"), [{ file: "d.spec.ts" }]);
});

test("a sidekick pass never stores an objective: whatever it declares is synthetic and is ignored", () => {
  const synthetic = [{ file: "d.spec.ts", flow: "d.spec.ts", objective: "the delegation's objective" }];
  assert.deepEqual(mergeDeliveredSpecs([], lead(["d.spec.ts"], synthetic), "sidekick"), [{ file: "d.spec.ts" }]);
});

test("a sidekick pass that delivers a lead's spec again neither clears nor replaces its flow and objective", () => {
  const before = [{ file: "a.spec.ts", flow: "login", objective: "the lead's objective" }];
  const synthetic = [{ file: "a.spec.ts", flow: "sidekick flow", objective: "the delegation's objective" }];
  assert.deepEqual(mergeDeliveredSpecs(before, lead(["a.spec.ts"], synthetic), "sidekick"), before);
});

test("a sidekick pass keeps the order: the specs it delivers again stay where they were, new ones go last", () => {
  const before = [{ file: "a.spec.ts", flow: "login" }, { file: "b.spec.ts" }];
  assert.deepEqual(mergeDeliveredSpecs(before, lead(["b.spec.ts", "d.spec.ts", "a.spec.ts"]), "sidekick").map((e) => e.file), ["a.spec.ts", "b.spec.ts", "d.spec.ts"]);
});

test("a spec is the same spec however each pass spells its path", () => {
  const before = [{ file: "flows/a.spec.ts", flow: "login", objective: "the user signs in" }];
  assert.deepEqual(mergeDeliveredSpecs(before, lead(["./flows\\a.spec.ts"]), "sidekick"), before);
  assert.deepEqual(mergeDeliveredSpecs(before, lead(["flows/a.spec.ts"], [{ file: ".\\flows/a.spec.ts", objective: "newer" }]), "lead"), [
    { file: "flows/a.spec.ts", flow: "login", objective: "newer" },
  ]);
});

test("the passes of a run in turn: the lead's objective survives a sidekick re-delivery and a sidekick spec stays path-only", () => {
  const first = mergeDeliveredSpecs([], lead(["a.spec.ts"], [{ file: "a.spec.ts", flow: "login", objective: "O1" }]), "lead");
  const second = mergeDeliveredSpecs(first, lead(["a.spec.ts", "d.spec.ts"], [{ file: "a.spec.ts", flow: "x", objective: "synthetic" }, { file: "d.spec.ts", flow: "d", objective: "synthetic" }]), "sidekick");
  assert.deepEqual(second, [{ file: "a.spec.ts", flow: "login", objective: "O1" }, { file: "d.spec.ts" }]);
  const third = mergeDeliveredSpecs(second, lead(["d.spec.ts"], [{ file: "d.spec.ts", flow: "d flow", objective: "O2" }]), "lead");
  assert.deepEqual(third, [{ file: "a.spec.ts", flow: "login", objective: "O1" }, { file: "d.spec.ts", flow: "d flow", objective: "O2" }]);
});

test("a pass that delivered nothing leaves the delivered specs as they were", () => {
  const before = [{ file: "a.spec.ts", flow: "login", objective: "the user signs in" }];
  assert.deepEqual(mergeDeliveredSpecs(before, lead([]), "lead"), before);
  assert.deepEqual(mergeDeliveredSpecs(before, lead([]), "sidekick"), before);
  assert.deepEqual(mergeDeliveredSpecs([], lead([]), "lead"), []);
});

test("the delivered specs and the pass are left as they were, and a new list is returned", () => {
  const before = frozen<DeliveredSpec[]>([{ file: "a.spec.ts", flow: "login", objective: "O1" }]);
  const output = frozen({ specs: ["a.spec.ts", "b.spec.ts"], declaredSpecs: [{ file: "a.spec.ts", objective: "O2" }, { file: "b.spec.ts", flow: "b" }] });
  const merged = mergeDeliveredSpecs(before, output, "lead");
  assert.notEqual(merged, before);
  assert.deepEqual(before, [{ file: "a.spec.ts", flow: "login", objective: "O1" }]);
  assert.deepEqual(merged, [{ file: "a.spec.ts", flow: "login", objective: "O2" }, { file: "b.spec.ts", flow: "b" }]);
  assert.notEqual(mergeDeliveredSpecs(before, { specs: [] }, "sidekick"), before);
});
