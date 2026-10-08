import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSuiteEntry, suiteEntryFile } from "@contexts/generation/domain/suite-entry.ts";

/* The expected lines are written out by hand: they are what the grounding has always folded the manifest into. */

test("a spec with a flow and an objective is its path, a dash, the flow and the objective", () => {
  assert.equal(
    formatSuiteEntry({ file: "checkout.spec.ts", flow: "checkout", objective: "verify the discounted total after cart re-query" }),
    "checkout.spec.ts — flow: checkout, objective: verify the discounted total after cart re-query",
  );
});

test("a spec with nothing known about it is its path alone", () => {
  assert.equal(formatSuiteEntry({ file: "flows/login.spec.ts" }), "flows/login.spec.ts");
});

test("a spec with only a flow, or only an objective, states only that", () => {
  assert.equal(formatSuiteEntry({ file: "a.spec.ts", flow: "login" }), "a.spec.ts — flow: login");
  assert.equal(formatSuiteEntry({ file: "a.spec.ts", objective: "the user signs in" }), "a.spec.ts — objective: the user signs in");
});

test("a flow or objective that is empty text is still stated: the line says what the manifest holds", () => {
  assert.equal(formatSuiteEntry({ file: "a.spec.ts", flow: "", objective: "" }), "a.spec.ts — flow: , objective: ");
});

test("the text is folded as it is: a comma, a dash or a newline in it is not touched", () => {
  assert.equal(
    formatSuiteEntry({ file: "a.spec.ts", flow: "sign in, then out", objective: "the user — once signed in\nsees the home" }),
    "a.spec.ts — flow: sign in, then out, objective: the user — once signed in\nsees the home",
  );
});

test("the path is the text before the first dash that has a space on each side", () => {
  assert.equal(suiteEntryFile("checkout.spec.ts — flow: checkout, objective: verify the total"), "checkout.spec.ts");
  assert.equal(suiteEntryFile("flows/login.spec.ts"), "flows/login.spec.ts");
});

test("only the first dash separates: a dash in the flow or the objective is theirs", () => {
  assert.equal(suiteEntryFile("a.spec.ts — flow: x — y, objective: z — w"), "a.spec.ts");
});

test("a dash with no space on a side is part of a name", () => {
  assert.equal(suiteEntryFile("flows/a—b.spec.ts"), "flows/a—b.spec.ts");
  assert.equal(suiteEntryFile("flows/a —b.spec.ts"), "flows/a —b.spec.ts");
  assert.equal(suiteEntryFile("flows/a— b.spec.ts"), "flows/a— b.spec.ts");
});

test("a line that starts with the separator names no path, and an empty line names none", () => {
  assert.equal(suiteEntryFile(" — flow: x"), "");
  assert.equal(suiteEntryFile(""), "");
});

test("reading the path back from a folded line gives the path it was folded from", () => {
  for (const entry of [
    { file: "a.spec.ts" },
    { file: "flows/owners/add.spec.ts", flow: "add owner" },
    { file: "src/test/java/FooTest.java", flow: "foo", objective: "foo adds — twice" },
    { file: "flows/a—b.spec.ts", objective: "o" },
  ]) {
    assert.equal(suiteEntryFile(formatSuiteEntry(entry)), entry.file);
  }
});
