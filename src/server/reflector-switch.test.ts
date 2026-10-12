import { test } from "node:test";
import assert from "node:assert/strict";
import { REFLECTOR_ENABLED_ENV, resolveReflectorEnabled } from "./reflector-switch";

test("the reflector is off when the variable is unset, blank, 0 or false", () => {
  assert.equal(resolveReflectorEnabled({}), false);
  for (const value of ["", "  ", "0", "false", "FALSE"]) {
    assert.equal(resolveReflectorEnabled({ [REFLECTOR_ENABLED_ENV]: value }), false, JSON.stringify(value));
  }
});

test("the reflector is on for 1 and true in any case", () => {
  for (const value of ["1", "true", "True", " 1 "]) {
    assert.equal(resolveReflectorEnabled({ [REFLECTOR_ENABLED_ENV]: value }), true, JSON.stringify(value));
  }
});

test("a mistyped reflector value stops the composition, naming the variable", () => {
  assert.throws(() => resolveReflectorEnabled({ [REFLECTOR_ENABLED_ENV]: "yes" }), new RegExp(REFLECTOR_ENABLED_ENV));
});
