import { test } from "node:test";
import assert from "node:assert/strict";
import { missingVerdict, readVerdict } from "@contexts/generation/domain/verdict-parse.ts";

test("readVerdict reads the generator contract (specs, no approved): approval is the reviewer's job", () => {
  /* The generator does not self-report `approved`: the independent reviewer is the gate, and a MISSING `approved` must not be read as a rejection. */
  const v = readVerdict({
    specs: ["login.spec.ts"],
    specMetas: [{ file: "login.spec.ts", flow: "login", objective: "valid creds reach the dashboard", targets: [] }],
    note: "",
  });
  assert.equal(v.parsed, true);
  assert.deepEqual(v.specs, ["login.spec.ts"]);
  assert.equal(v.approved, true);
  assert.equal(v.specMetas?.length, 1);
});

test("readVerdict reads a declared no-op's reason, trimmed, and reads a blank or missing one as no decision", () => {
  assert.equal(readVerdict({ specs: [], noop: { reason: "  because  " } }).noopReason, "because");
  for (const noop of [{ reason: "   " }, {}, true, "because", { reason: 5 }]) {
    const v = readVerdict({ specs: [], noop });
    assert.equal(v.parsed, true, JSON.stringify(noop));
    assert.equal(v.noopReason, undefined, JSON.stringify(noop));
  }
});

test("readVerdict reads a verdict that carries only a no-op", () => {
  const v = readVerdict({ noop: { reason: "nothing to test" } });
  assert.equal(v.parsed, true);
  assert.deepEqual(v.specs, []);
  assert.equal(v.noopReason, "nothing to test");
});

test("readVerdict never reads `approved` as a no-op decision", () => {
  for (const answer of [{ approved: true }, { approved: true, specs: [] }]) {
    const v = readVerdict(answer);
    assert.deepEqual(v.specs, []);
    assert.equal(v.noopReason, undefined);
  }
});

test("readVerdict reads the specs and the reason of a verdict that carries both", () => {
  const v = readVerdict({ specs: ["a.spec.ts"], noop: { reason: "also nothing" } });
  assert.deepEqual(v.specs, ["a.spec.ts"]);
  assert.equal(v.noopReason, "also nothing");
});

test("readVerdict extracts specMetas with flow, objective, and targets", () => {
  const specMetas = [
    { file: "login.spec.ts", flow: "login", objective: "given valid credentials, when login, then redirect to dashboard", targets: ["LoginComponent", "/api/auth"] },
    { file: "checkout.spec.ts", flow: "checkout", objective: "given items in cart, when checkout, then order is created", targets: ["CheckoutPage", "createOrder"] },
  ];
  const v = readVerdict({ approved: true, specs: ["login.spec.ts", "checkout.spec.ts"], specMetas });
  assert.equal(v.approved, true);
  assert.deepEqual(v.specMetas, specMetas);
});

test("readVerdict drops specMetas entries missing required fields", () => {
  const v = readVerdict({
    specs: [],
    specMetas: [
      { file: "ok.spec.ts", flow: "ok", objective: "test something", targets: ["X"] },
      { file: "", flow: "bad", objective: "nope", targets: [] },
      { flow: "no-file", objective: "nothing" },
      "not-an-object",
    ],
  });
  assert.deepEqual(v.specMetas?.map((meta) => meta.file), ["ok.spec.ts"]);
});

test("readVerdict returns undefined specMetas when absent or empty", () => {
  assert.equal(readVerdict({ specs: ["a.spec.ts"] }).specMetas, undefined);
  assert.equal(readVerdict({ specMetas: "not-array" }).specMetas, undefined);
  assert.equal(readVerdict({ specMetas: [] }).specMetas, undefined);
});

test("a turn that delivered no submission is a fail-closed verdict with the reason, never a rejection or a no-op", () => {
  const v = missingVerdict("no accepted submission");
  assert.deepEqual([v.approved, v.parsed, v.specs, v.note], [false, false, [], "no accepted submission"]);
  assert.equal(v.noopReason, undefined);
});
