import { test } from "node:test";
import assert from "node:assert/strict";
import { LOGIN_BOOTSTRAP_GUIDANCE, PreworkMemory, contextMapRebuildRequest, contextMapRequest, loginBootstrapRequest, mayBePreceded, needsLoginBootstrap } from "@contexts/run-orchestration/domain/run-prework.ts";

test("work may precede only a plain run: not a frozen request, a context run, a run for a purpose, a cross-repo run or a continuation", () => {
  assert.equal(mayBePreceded({ mode: "diff" }, false), true);
  assert.equal(mayBePreceded({ mode: "manual" }, false), true);
  assert.equal(mayBePreceded({ mode: "diff" }, true), false);
  assert.equal(mayBePreceded({ mode: "context" }, false), false);
  assert.equal(mayBePreceded({ mode: "manual", purpose: "login-bootstrap" }, false), false);
  assert.equal(mayBePreceded({ mode: "diff", triggerRepo: "org/svc" }, false), false);
  assert.equal(mayBePreceded({ mode: "diff", parentRunId: "run-1" }, false), false);
});

test("a login bootstrap is needed for an app that declares a login and whose store holds none, and the store is asked only for such an app", () => {
  let asked = 0;
  const holds = (answer: boolean) => () => { asked += 1; return answer; };
  assert.equal(needsLoginBootstrap(true, holds(false)), true);
  assert.equal(needsLoginBootstrap(true, holds(true)), false);
  assert.equal(asked, 2);
  assert.equal(needsLoginBootstrap(false, holds(false)), false);
  assert.equal(asked, 2, "an app with no login is never asked about");
  assert.throws(() => needsLoginBootstrap(true, () => { throw new Error("store unreadable"); }), /store unreadable/);
});

test("the process remembers per app which login bootstrap it queued and per app and commit which context map it rebuilt", () => {
  const memory = new PreworkMemory();
  assert.equal(memory.loginBootstrapWasAsked("shop"), false);
  memory.askedLoginBootstrap("shop");
  assert.equal(memory.loginBootstrapWasAsked("shop"), true);
  assert.equal(memory.loginBootstrapWasAsked("orders"), false);
  assert.equal(memory.contextMapWasRebuilt("shop", "abc1234"), false);
  memory.rebuiltContextMap("shop", "abc1234");
  assert.equal(memory.contextMapWasRebuilt("shop", "abc1234"), true);
  assert.equal(memory.contextMapWasRebuilt("shop", "def5678"), false);
  assert.equal(memory.contextMapWasRebuilt("orders", "abc1234"), false);
});

test("the requests the pre-run work is made of: a manual e2e login run, a context run, and a context run that serves a queued run", () => {
  assert.deepEqual(loginBootstrapRequest("shop", "abc1234"), { app: "shop", sha: "abc1234", target: "e2e", mode: "manual", source: "manual", guidance: LOGIN_BOOTSTRAP_GUIDANCE, purpose: "login-bootstrap", trigger: "login-bootstrap" });
  assert.deepEqual(contextMapRequest("shop", "abc1234"), { app: "shop", sha: "abc1234", target: "e2e", mode: "context", source: "manual", trigger: "context" });
  assert.deepEqual(contextMapRequest("shop", "abc1234", "run-1"), { app: "shop", sha: "abc1234", target: "e2e", mode: "context", source: "manual", trigger: "context", parentRunId: "run-1" });
  assert.deepEqual(contextMapRebuildRequest("shop", "abc1234", "run-2"), { app: "shop", sha: "abc1234", target: "e2e", mode: "context", source: "manual", trigger: "context", parentRunId: "run-2", previousNamespace: "" });
});
