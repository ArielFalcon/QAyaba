import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "@contexts/app-catalog/domain/app.aggregate.ts";

const e2e = { name: "portfolio", repo: "org/portfolio", baseBranch: "main", shadow: true, services: [], dev: { versionUrl: "https://dev/version" } };

test("service repo must not equal the primary (distinct error message)", () => {
  /* two distinct invariants → two distinct messages so operators can diagnose the violation. */
  assert.throws(() => App.fromConfig({ ...e2e, services: [{ repo: "org/portfolio" }] }), /circular dependency/);
});
test("service repos must be unique among themselves (distinct error message)", () => {
  assert.throws(() => App.fromConfig({ ...e2e, services: [{ repo: "org/svc" }, { repo: "org/svc" }] }), /unique/);
});

test("a valid e2e app exposes its repos", () => {
  const app = App.fromConfig({ ...e2e, services: [{ repo: "org/svc" }] });
  assert.equal(app.name, "portfolio");
  assert.equal(app.primaryRepo, "org/portfolio");
  assert.deepEqual(app.serviceRepos, ["org/svc"]);
});
