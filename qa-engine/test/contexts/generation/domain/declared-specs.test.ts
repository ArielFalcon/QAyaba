import { test } from "node:test";
import assert from "node:assert/strict";
import { declareSpecs } from "@contexts/generation/domain/declared-specs.ts";

const meta = (file: string, flow: string, objective: string) => ({ file, flow, objective, targets: ["src/x.ts"], sha256: "abc" });

test("each reported spec is declared with the flow and objective its meta states", () => {
  assert.deepEqual(declareSpecs(["flows/login.spec.ts"], [meta("flows/login.spec.ts", "login", "the user signs in")]), [
    { file: "flows/login.spec.ts", flow: "login", objective: "the user signs in" },
  ]);
});

test("a spec with no meta is declared by its path alone", () => {
  const [entry] = declareSpecs(["flows/login.spec.ts"], []);
  assert.deepEqual(entry, { file: "flows/login.spec.ts" });
  assert.equal("flow" in entry!, false);
  assert.equal("objective" in entry!, false);
  assert.deepEqual(declareSpecs(["flows/login.spec.ts"], undefined), [{ file: "flows/login.spec.ts" }]);
});

test("the specs decide what is declared and in which order: a meta that names no reported spec is dropped", () => {
  assert.deepEqual(
    declareSpecs(["b.spec.ts", "a.spec.ts"], [meta("a.spec.ts", "a flow", "a objective"), meta("ghost.spec.ts", "ghost", "never reported")]),
    [{ file: "b.spec.ts" }, { file: "a.spec.ts", flow: "a flow", objective: "a objective" }],
  );
});

test("a meta joins its spec however the two spell the path", () => {
  assert.deepEqual(declareSpecs(["./flows/a.spec.ts"], [meta("flows\\a.spec.ts", "a flow", "a objective")]), [
    { file: "flows/a.spec.ts", flow: "a flow", objective: "a objective" },
  ]);
  assert.deepEqual(declareSpecs(["flows\\a.spec.ts"], [meta("./flows/a.spec.ts", "a flow", "a objective")]), [
    { file: "flows/a.spec.ts", flow: "a flow", objective: "a objective" },
  ]);
});

test("a spec reported twice, spelled two ways, is declared once, where it first appeared", () => {
  assert.deepEqual(declareSpecs(["a.spec.ts", "b.spec.ts", "./a.spec.ts"], [meta("a.spec.ts", "a flow", "a objective")]), [
    { file: "a.spec.ts", flow: "a flow", objective: "a objective" },
    { file: "b.spec.ts" },
  ]);
});

test("a blank flow or objective is not a declaration, and declared text is trimmed", () => {
  assert.deepEqual(declareSpecs(["a.spec.ts", "b.spec.ts"], [meta("a.spec.ts", "   ", "signs in"), meta("b.spec.ts", " login ", "")]), [
    { file: "a.spec.ts", objective: "signs in" },
    { file: "b.spec.ts", flow: "login" },
  ]);
});

test("several metas for one spec: each field takes the last text declared, and a later blank leaves it", () => {
  assert.deepEqual(
    declareSpecs(["a.spec.ts"], [meta("a.spec.ts", "first flow", "first objective"), meta("a.spec.ts", "second flow", ""), meta("./a.spec.ts", "", "third objective")]),
    [{ file: "a.spec.ts", flow: "second flow", objective: "third objective" }],
  );
});

test("a spec that names no file is not declared", () => {
  assert.deepEqual(declareSpecs(["", "./", "a.spec.ts"], [meta("", "x", "y")]), [{ file: "a.spec.ts" }]);
});

test("nothing reported, nothing declared", () => {
  assert.deepEqual(declareSpecs([], [meta("a.spec.ts", "a flow", "a objective")]), []);
  assert.deepEqual(declareSpecs([], undefined), []);
});

test("what it is given is left as it was", () => {
  const specs = Object.freeze(["a.spec.ts"]);
  const metas = Object.freeze([Object.freeze(meta("a.spec.ts", "a flow", "a objective"))]);
  assert.deepEqual(declareSpecs(specs, metas), [{ file: "a.spec.ts", flow: "a flow", objective: "a objective" }]);
});
