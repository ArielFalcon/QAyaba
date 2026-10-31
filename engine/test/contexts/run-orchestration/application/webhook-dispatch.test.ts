import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveWebhookDispatch } from "@contexts/run-orchestration/application/index.ts";
import type { AppRepositoryPort } from "@contexts/app-catalog/application/index.ts";

type Match = Awaited<ReturnType<AppRepositoryPort["resolveByRepo"]>>[number];
const app = (name: string): Match["app"] => ({ name, repo: `org/${name}`, baseBranch: "main", shadow: false, services: [] });
const catalog = (matches: Match[]): AppRepositoryPort => ({
  load: async () => { throw new Error("not used"); },
  list: async () => [],
  resolveByRepo: async () => matches,
});

test("a push to an app's primary repo runs the event's mode, guidance and base", async () => {
  const dispatch = await resolveWebhookDispatch(catalog([{ app: app("shop"), role: "primary" }]), "org/shop", { mode: "manual", guidance: "test the cart", baseSha: "b1" });
  assert.deepEqual(dispatch, [{ app: "shop", target: "e2e", mode: "manual", guidance: "test the cart", baseSha: "b1" }]);
});

test("a push to a service repo is always a diff run of the owning app naming the repo, whatever mode the event asked", async () => {
  const dispatch = await resolveWebhookDispatch(catalog([{ app: app("shop"), role: "service" }]), "org/orders", { mode: "manual", guidance: "g", baseSha: "b1" });
  assert.deepEqual(dispatch, [{ app: "shop", target: "e2e", mode: "diff", guidance: "g", baseSha: "b1", triggerRepo: "org/orders" }]);
});

test("a repo that is the primary of one app and a service of another fans out to both, and an unwatched repo to none", async () => {
  const both = await resolveWebhookDispatch(catalog([{ app: app("orders"), role: "primary" }, { app: app("shop"), role: "service" }]), "org/orders", { mode: "diff" });
  assert.deepEqual(both, [
    { app: "orders", target: "e2e", mode: "diff" },
    { app: "shop", target: "e2e", mode: "diff", triggerRepo: "org/orders" },
  ]);
  assert.deepEqual(await resolveWebhookDispatch(catalog([]), "org/nobody", { mode: "diff" }), []);
});
