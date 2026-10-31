/* buildAppCatalog: the auth session is served only when its adapter deps are supplied, and is the adapter built over them. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAppCatalog } from "@contexts/app-catalog/composition/build-app-catalog.ts";
import { AuthSessionAdapter } from "@contexts/app-catalog/infrastructure/auth-session.adapter.ts";

test("a composition without session deps serves no auth session", () => {
  assert.equal(buildAppCatalog({}).authSession, undefined);
});

test("the served auth session is the adapter built over the deps supplied", () => {
  const api = buildAppCatalog({ authSession: { env: {}, authDir: "/auth", spawnSetup: async () => ({ exitCode: 0 }) as never } });

  assert.ok(api.authSession instanceof AuthSessionAdapter);
});
