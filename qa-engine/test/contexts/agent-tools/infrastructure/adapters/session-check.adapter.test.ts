/* The session check never opens the app signed out: a run with no saved session has nothing to check. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionCheckAdapter } from "@contexts/agent-tools/infrastructure/adapters/session-check.adapter.ts";
import { AccountLock } from "@contexts/test-execution/application/index.ts";

test("with no saved session the check says so and starts no browser", async () => {
  let hosts = 0;
  const adapter = new SessionCheckAdapter({
    baseUrl: "https://dev.example",
    launcher: { launch: async () => { throw new Error("never"); } } as never,
    createHost: () => {
      hosts += 1;
      throw new Error("never");
    },
    material: () => ({}),
    denyRoutes: [],
    account: "demo/public",
    lock: new AccountLock(),
  });
  const result = await adapter.check(["/orders"]);
  assert.equal(result.state, "unknown");
  assert.equal(hosts, 0);
});
