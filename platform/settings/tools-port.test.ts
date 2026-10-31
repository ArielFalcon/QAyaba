import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TOOLS_PORT, resolveToolsPort } from "./tools-port";

test("the port is QA_TOOLS_PORT, defaulting to a port the compose file does not publish", () => {
  assert.equal(resolveToolsPort({}), DEFAULT_TOOLS_PORT);
  assert.equal(resolveToolsPort({ QA_TOOLS_PORT: "4590" }), 4590);
  assert.throws(() => resolveToolsPort({ QA_TOOLS_PORT: "abc" }), /QA_TOOLS_PORT/);
  assert.throws(() => resolveToolsPort({ QA_TOOLS_PORT: "70000" }), /QA_TOOLS_PORT/);
});
