import { test } from "node:test";
import assert from "node:assert/strict";
import { suiteAccountFor } from "./exec-sandbox-factory";

const ENV = { DEV_TEST_USER: "default-user", DEV_TEST_PASS: "default-pass", QA_APP_USER: "declared-user", QA_APP_PASS: "declared-pass" };

test("a spec gets no account unless its app opted in", () => {
  assert.equal(suiteAccountFor({}, ENV), undefined);
  assert.equal(suiteAccountFor({ e2e: { specCredentials: "none" } }, ENV), undefined);
});

test("an opted-in app hands its specs the account its auth declaration names, else the conventional one", () => {
  assert.deepEqual(suiteAccountFor({ e2e: { specCredentials: "account" }, auth: { usernameEnv: "QA_APP_USER", passwordEnv: "QA_APP_PASS" } }, ENV), { user: "declared-user", pass: "declared-pass" });
  assert.deepEqual(suiteAccountFor({ e2e: { specCredentials: "account" } }, ENV), { user: "default-user", pass: "default-pass" });
});

test("opting in without an account in the environment hands nothing", () => {
  assert.equal(suiteAccountFor({ e2e: { specCredentials: "account" } }, {}), undefined);
});
