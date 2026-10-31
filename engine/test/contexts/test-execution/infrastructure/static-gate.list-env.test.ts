/* `playwright test --list` enumerates the tests with the execution contract's non-secret variables (RFC-0015, ADR-0023 #10), so top-level code that reads them enumerates what the executions run; it is never given the session, and the other checks are given nothing. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createValidateDeps } from "@contexts/test-execution/infrastructure/static-gate.checks.ts";

interface Spawned { commandClass?: string; profile: string; extraEnv?: Record<string, string>; geolocation?: { latitude: number; longitude: number } }

function fakeExec() {
  const spawned: Spawned[] = [];
  const exec = {
    isolated: false,
    workDir: () => "/tmp",
    allocDir: () => "/tmp",
    writeScript: () => "/tmp/x",
    spawn: (_cmd: string, _args: readonly string[], options: Spawned) => {
      spawned.push(options);
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      setImmediate(() => child.emit("close", 0, null));
      return child;
    },
  };
  return { exec, spawned };
}

const CONTRACT = { baseUrl: "https://dev.example", namespace: "run-7", testIdAttribute: "data-qa", geolocation: { latitude: 40.4818, longitude: -3.3643 } };

test("the list check gets the base URL, namespace, test-id attribute and durable position, in the offline profile", async () => {
  const { exec, spawned } = fakeExec();
  await createValidateDeps(exec as never, undefined, CONTRACT).listTests("/e2e");
  const [list] = spawned;
  assert.equal(list!.profile, "offline");
  assert.equal(list!.extraEnv?.PW_BASE_URL, "https://dev.example");
  assert.equal(list!.extraEnv?.PW_NAMESPACE, "run-7");
  assert.equal(list!.extraEnv?.PW_TEST_ID_ATTRIBUTE, "data-qa");
  assert.deepEqual(list!.geolocation, CONTRACT.geolocation);
});

test("the typecheck and the lint are given none of them, and a list without a contract is as before", async () => {
  const { exec, spawned } = fakeExec();
  const deps = createValidateDeps(exec as never, undefined, CONTRACT);
  await deps.typecheck("/e2e");
  await deps.lint("/e2e");
  await createValidateDeps(exec as never).listTests("/e2e");
  for (const s of spawned) {
    assert.equal(s.extraEnv, undefined, s.commandClass);
    assert.equal(s.geolocation, undefined, s.commandClass);
  }
});
