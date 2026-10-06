import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

// The LLM gateway key expires daily, so the stack must start without it and receive it at run time
// (web console or TUI). compose would refuse to start any service whose interpolation uses the
// "required" form, so neither service may use it for the key.
const compose = parse(readFileSync(new URL("./compose.yml", import.meta.url), "utf8"));

function declaredValue(service, name) {
  const environment = compose.services[service].environment;
  assert.ok(environment, `${service} declares an environment block`);
  return environment[name];
}

for (const service of ["orchestrator", "agents"]) {
  test(`${service} receives the LLM gateway key when set and starts without it`, () => {
    const value = declaredValue(service, "OPENCODE_API_KEY");
    assert.equal(typeof value, "string", "the key is passed through to the service");
    assert.match(value, /\$\{OPENCODE_API_KEY:?-/, "unset or empty falls back to an empty value");
    assert.doesNotMatch(value, /\$\{OPENCODE_API_KEY:?\?/, "a missing key must not abort compose");
  });
}
