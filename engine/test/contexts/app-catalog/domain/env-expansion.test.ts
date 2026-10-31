import { test } from "node:test";
import assert from "node:assert/strict";
import { expandEnv } from "@contexts/app-catalog/application/index.ts";

test("expandEnv resolves mixed-case ${Var} names, not just UPPERCASE", () => {
  const out = expandEnv("a: ${myToken}\nb: ${UPPER}", { myToken: "x", UPPER: "y" });
  assert.equal(out, "a: x\nb: y");
});

test("expandEnv throws on an unset var (never passes ${...} through literally)", () => {
  assert.throws(() => expandEnv("k: ${missingVar}", {}), /unset env var \$\{missingVar\}/);
});

test("expandEnv expands every placeholder form the way the loader reads a config", () => {
  const env = { A: "1", EMPTY: "", UNI: "ñandú-✓", _under: "u", n9: "nine" };
  const cases: [string, string][] = [
    ["", ""],
    ["no placeholders", "no placeholders"],
    ["${A}${A}", "11"],
    ["x-${A}-y-${n9}-${_under}", "x-1-y-nine-u"],
    ["[${EMPTY}]", "[]"],
    ["${UNI}", "ñandú-✓"],
    ["$A and $${A} and ${ A }", "$A and $1 and ${ A }"],
    ["${A", "${A"],
    ["${9bad}", "${9bad}"],
    ["${A${n9}}", "${Anine}"],
    ["${${A}}", "${1}"],
    ["multi\nline: ${A}\n  - ${n9}", "multi\nline: 1\n  - nine"],
  ];
  for (const [input, expected] of cases) assert.equal(expandEnv(input, env), expected, JSON.stringify(input));
});

test("expandEnv names the first unset variable, and a variable set to undefined is unset", () => {
  assert.throws(() => expandEnv("${A}${B}${C}", { A: "1" }), (err: Error) => err.message === "config references unset env var ${B}");
  assert.throws(() => expandEnv("${A}", { A: undefined }), /unset env var \$\{A\}/);
});
