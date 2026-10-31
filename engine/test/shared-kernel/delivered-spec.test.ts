import { test } from "node:test";
import assert from "node:assert/strict";
import { upsertDeliveredSpec, type DeliveredSpec } from "@kernel/delivered-spec.ts";

/** Deep-frozen, so an upsert that writes into what it was given throws instead of passing silently. */
function frozen<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const inner of Object.values(value)) frozen(inner);
    Object.freeze(value);
  }
  return value;
}

test("a spec the run has not carried yet is added at the end, with what it declared", () => {
  const carried: DeliveredSpec[] = [{ file: "a.spec.ts", flow: "login", objective: "the user signs in" }];
  assert.deepEqual(upsertDeliveredSpec(carried, { file: "b.spec.ts", flow: "checkout", objective: "the order is placed" }), [
    { file: "a.spec.ts", flow: "login", objective: "the user signs in" },
    { file: "b.spec.ts", flow: "checkout", objective: "the order is placed" },
  ]);
});

test("a spec that declared nothing is carried as its path alone: no flow key and no objective key", () => {
  const [entry] = upsertDeliveredSpec([], { file: "a.spec.ts" });
  assert.deepEqual(entry, { file: "a.spec.ts" });
  assert.equal("flow" in entry!, false);
  assert.equal("objective" in entry!, false);
});

test("a spec carried by path only takes the flow and objective a later report declares", () => {
  assert.deepEqual(upsertDeliveredSpec([{ file: "a.spec.ts" }], { file: "a.spec.ts", flow: "login", objective: "the user signs in" }), [
    { file: "a.spec.ts", flow: "login", objective: "the user signs in" },
  ]);
});

test("a later report that declares a flow or an objective replaces the carried one: the newest wins", () => {
  const carried: DeliveredSpec[] = [{ file: "a.spec.ts", flow: "login", objective: "old objective" }];
  assert.deepEqual(upsertDeliveredSpec(carried, { file: "a.spec.ts", flow: "sign in", objective: "new objective" }), [
    { file: "a.spec.ts", flow: "sign in", objective: "new objective" },
  ]);
});

test("flow and objective are refreshed independently of each other", () => {
  const carried: DeliveredSpec[] = [{ file: "a.spec.ts", flow: "login", objective: "kept objective" }];
  assert.deepEqual(upsertDeliveredSpec(carried, { file: "a.spec.ts", flow: "sign in" }), [
    { file: "a.spec.ts", flow: "sign in", objective: "kept objective" },
  ]);
  assert.deepEqual(upsertDeliveredSpec(carried, { file: "a.spec.ts", objective: "new objective" }), [
    { file: "a.spec.ts", flow: "login", objective: "new objective" },
  ]);
});

test("a report that declares nothing, or only blanks, never clears what is carried", () => {
  const carried: DeliveredSpec[] = [{ file: "a.spec.ts", flow: "login", objective: "the user signs in" }];
  const same = [{ file: "a.spec.ts", flow: "login", objective: "the user signs in" }];
  assert.deepEqual(upsertDeliveredSpec(carried, { file: "a.spec.ts" }), same);
  assert.deepEqual(upsertDeliveredSpec(carried, { file: "a.spec.ts", flow: "", objective: "" }), same);
  assert.deepEqual(upsertDeliveredSpec(carried, { file: "a.spec.ts", flow: "  \t", objective: " \n " }), same);
});

test("declared text is carried trimmed", () => {
  assert.deepEqual(upsertDeliveredSpec([], { file: "a.spec.ts", flow: "  login ", objective: "\tsigns in\n" }), [
    { file: "a.spec.ts", flow: "login", objective: "signs in" },
  ]);
});

test("a blank flow or objective on a report is not carried as a value", () => {
  assert.deepEqual(upsertDeliveredSpec([], { file: "a.spec.ts", flow: "   ", objective: "signs in" }), [
    { file: "a.spec.ts", objective: "signs in" },
  ]);
  assert.deepEqual(upsertDeliveredSpec([], { file: "a.spec.ts", flow: "login", objective: "" }), [{ file: "a.spec.ts", flow: "login" }]);
});

test("a refreshed spec keeps its place: the order is the order each spec first appeared in", () => {
  const carried: DeliveredSpec[] = [{ file: "a.spec.ts" }, { file: "b.spec.ts" }, { file: "c.spec.ts" }];
  assert.deepEqual(
    upsertDeliveredSpec(carried, { file: "b.spec.ts", objective: "b objective" }).map((entry) => entry.file),
    ["a.spec.ts", "b.spec.ts", "c.spec.ts"],
  );
});

test("the same file spelled another way is the same spec, carried under its canonical path", () => {
  const carried: DeliveredSpec[] = [{ file: "flows/a.spec.ts", flow: "login" }];
  assert.deepEqual(upsertDeliveredSpec(carried, { file: "./flows\\a.spec.ts", objective: "the user signs in" }), [
    { file: "flows/a.spec.ts", flow: "login", objective: "the user signs in" },
  ]);
  assert.deepEqual(upsertDeliveredSpec([], { file: ".\\flows\\a.spec.ts" }), [{ file: "flows/a.spec.ts" }]);
});

test("a ./ inside the path and a doubled separator are no other file: one spec is carried once", () => {
  const carried: DeliveredSpec[] = [{ file: "flows/a.spec.ts", flow: "login" }];
  assert.deepEqual(upsertDeliveredSpec(carried, { file: "flows/./a.spec.ts", objective: "o1" }), [{ file: "flows/a.spec.ts", flow: "login", objective: "o1" }]);
  assert.deepEqual(upsertDeliveredSpec(carried, { file: "flows//a.spec.ts", objective: "o2" }), [{ file: "flows/a.spec.ts", flow: "login", objective: "o2" }]);
});

test("a spec that climbs out of the spec directory is carried as it was reported, so that the check of the file can refuse it", () => {
  assert.deepEqual(upsertDeliveredSpec([], { file: "flows/../../secret.txt" }), [{ file: "flows/../../secret.txt" }]);
  assert.deepEqual(upsertDeliveredSpec([], { file: "/etc/hostname" }), [{ file: "/etc/hostname" }]);
});

test("a carried entry spelled another way is found as well", () => {
  assert.deepEqual(upsertDeliveredSpec([{ file: "./a.spec.ts", flow: "login" }], { file: "a.spec.ts", objective: "o" }), [
    { file: "a.spec.ts", flow: "login", objective: "o" },
  ]);
});

test("a report that names no file adds nothing", () => {
  const carried: DeliveredSpec[] = [{ file: "a.spec.ts", flow: "login" }];
  assert.deepEqual(upsertDeliveredSpec(carried, { file: "", flow: "x" }), carried);
  assert.deepEqual(upsertDeliveredSpec(carried, { file: "./", objective: "x" }), carried);
});

test("a carried entry whose text is blank does not come back as a value", () => {
  assert.deepEqual(upsertDeliveredSpec([{ file: "a.spec.ts", flow: "  ", objective: "" }], { file: "a.spec.ts" }), [{ file: "a.spec.ts" }]);
});

test("the carried list and the report are left as they were, and a new list is returned", () => {
  const carried = frozen<DeliveredSpec[]>([{ file: "a.spec.ts", flow: "login" }]);
  const update = frozen<DeliveredSpec>({ file: "a.spec.ts", flow: "sign in" });
  const refreshed = upsertDeliveredSpec(carried, update);
  assert.notEqual(refreshed, carried);
  assert.deepEqual(carried, [{ file: "a.spec.ts", flow: "login" }]);
  const added = upsertDeliveredSpec(carried, { file: "b.spec.ts" });
  assert.notEqual(added, carried);
  assert.deepEqual(carried, [{ file: "a.spec.ts", flow: "login" }]);
  assert.notEqual(upsertDeliveredSpec(carried, { file: "" }), carried);
});
