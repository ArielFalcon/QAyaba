import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { createApp, updateApp, deleteApp, type AppAdminDeps } from "./app-admin";
import { expandEnv, type AppConfig } from "../orchestrator/config-loader";
import { AppConfigSchema } from "../orchestrator/schemas";
import { buildYaml, type OnboardInput } from "./onboard";
import { serializeBoundary, spliceBoundariesBlock } from "./onboarding/write-boundaries";
import type { HttpBoundaryProfile, EventBoundaryProfile } from "@contexts/service-topology/domain/index.ts";

const HTTP_BOUNDARY: HttpBoundaryProfile = {
  transport: "http",
  frontFiles: "**/*.api.ts",
  frontCallSite: { kind: "receiver-verb-call", receiver: "this.rest" },
  servicePrefixTemplate: "name-{service}-api",
  serviceRepoTemplate: "ms-name-{service}",
  openApiPath: "src/main/resources/openapi/api-definition.yaml",
};

const EVENT_BOUNDARY: EventBoundaryProfile = {
  transport: "event",
  files: "**/*.java",
  eventPattern: {
    kind: "class-based-domain-events",
    listenerBaseType: "ListenerMessageDelegate",
    listenerEventCall: "convertMsgToSpecificType",
    subscriberBaseType: "DomainEventSubscriber",
    publishCall: "publishGenericMessage",
  },
};

/* What onboarding writes for a plain e2e app. */
const STOCK_ONBOARD: OnboardInput = {
  name: "shop",
  repo: "org/shop-front",
  baseBranch: "main",
  baseUrl: "https://x",
  target: "e2e",
  needsReview: true,
  shadow: true,
  testDataPrefix: "qa",
};
const STOCK_YAML = buildYaml(STOCK_ONBOARD);

/* A config an operator has kept up by hand: comments, a placeholder, tuning and blocks updateApp does not manage. */
const SHOP_ENV = { SHOP_DEV_URL: "https://dev.shop.example" };
const SHOP_YAML = `# Shop front (synthetic).
name: "shop"
repo: "org/shop-front" # primary repo
baseBranch: "main"

dev:
  baseUrl: \${SHOP_DEV_URL}

openapi:
  - "**/openapi/*.yaml"

auth:
  kind: form
  usernameEnv: SHOP_USER
  passwordEnv: SHOP_PASS
  futureOption: keep-me

e2e:
  testIdAttribute: data-cy

qa:
  needsReview: true
  shadow: true
  testDataPrefix: "qa-shop"
  changeCoverage:
    mode: enforce

report:
  onFailure: "github-issue"
`;

/* The config as the loader hands it to updateApp: env-expanded and schema-parsed. */
function loadedFrom(yaml: string, env: Record<string, string>): AppConfig {
  return AppConfigSchema.parse(parse(expandEnv(yaml, env))) as AppConfig;
}

/* The raw text and its loaded form, from ONE file, as in production. */
function withConfig(yaml: string, env: Record<string, string> = SHOP_ENV): Partial<AppAdminDeps> {
  return { readConfig: () => yaml, loadApp: () => loadedFrom(yaml, env), env };
}

function writtenConfig(deps: { written: Record<string, string> }): Record<string, unknown> {
  return parse(deps.written["shop"] ?? "") as Record<string, unknown>;
}

function makeDeps(overrides: Partial<AppAdminDeps> = {}): AppAdminDeps & { written: Record<string, string>; removed: string[] } {
  const written: Record<string, string> = {};
  const removed: string[] = [];
  return Object.assign(
    {
      written,
      removed,
      getRepoInfo: async (repo: string) => ({
        name: repo.split("/")[1] ?? repo,
        fullName: repo,
        private: false,
        defaultBranch: "main",
        description: null,
      }),
      configExists: () => false,
      writeConfig: (name: string, yaml: string) => { written[name] = yaml; return `/app/config/apps/${name}.yaml`; },
      deleteConfig: (name: string) => { removed.push(`config:${name}`); },
      deleteMirror: (repo: string) => { removed.push(`mirror:${repo}`); },
      deleteHistory: (app: string) => { removed.push(`history:${app}`); return 1; },
      deleteAuthMaterial: (app: string) => { removed.push(`auth:${app}`); },
      applyEnv: (vars: Record<string, string>) => Object.keys(vars),
      readConfig: () => STOCK_YAML,
      loadApp: () => loadedFrom(STOCK_YAML, {}),
      env: {} as Record<string, string | undefined>,
    },
    overrides,
  ) as AppAdminDeps & { written: Record<string, string>; removed: string[] };
}

test("validateOnly returns repoInfo without writing anything", async () => {
  const deps = makeDeps();
  const r = await createApp({ repo: "org/shop-front", validateOnly: true }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.repoInfo?.defaultBranch, "main");
  assert.deepEqual(deps.written, {});
});

test("dryRun returns the YAML (with services) without writing", async () => {
  const deps = makeDeps();
  const r = await createApp(
    {
      repo: "org/shop-front", name: "shop", baseUrl: "https://dev.shop.io", target: "e2e",
      needsReview: true, shadow: true, testDataPrefix: "qa-shop",
      services: [{ repo: "org/orders-svc", openapi: "api/*.yaml" }],
      dryRun: true,
    },
    deps,
  );
  assert.equal(r.ok, true);
  assert.match(r.yaml ?? "", /- repo: "org\/orders-svc"/);
  assert.deepEqual(deps.written, {});
});

test("dryRun writes an auth block the app schema accepts", async () => {
  const deps = makeDeps();
  const r = await createApp(
    {
      repo: "org/shop-front", name: "shop", baseUrl: "https://dev.shop.io", target: "e2e",
      needsReview: true, shadow: true, testDataPrefix: "qa-shop",
      auth: { kind: "form", usernameEnv: "QA_SHOP_TEST_USER", passwordEnv: "QA_SHOP_TEST_PASS" },
      dryRun: true,
    },
    deps,
  );
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.match(r.yaml ?? "", /kind: form/);
  assert.match(r.yaml ?? "", /usernameEnv: "QA_SHOP_TEST_USER"/);
});

test("updateApp keeps an existing auth block when the edit omits it", async () => {
  const deps = makeDeps(withConfig(SHOP_YAML));
  const r = await updateApp({ name: "shop", baseUrl: "https://new.shop.example" }, deps);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(writtenConfig(deps)["auth"], parse(SHOP_YAML).auth);
});

test("updateApp clearAuth drops the auth block", async () => {
  const deps = makeDeps(withConfig(SHOP_YAML));
  const r = await updateApp({ name: "shop", clearAuth: true }, deps);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(writtenConfig(deps)["auth"], undefined);
  assert.equal(deps.written["shop"], SHOP_YAML.replace(/auth:\n(?: {2}.*\n)+\n/, ""));
});

test("updateApp with a login that names only its kind and variables keeps the login keys it does not know", async () => {
  const deps = makeDeps(withConfig(SHOP_YAML));
  const r = await updateApp({ name: "shop", auth: { kind: "form", usernameEnv: "SHOP_OTHER_USER", passwordEnv: "SHOP_PASS" } }, deps);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const auth = writtenConfig(deps)["auth"] as Record<string, unknown>;
  assert.equal(auth["usernameEnv"], "SHOP_OTHER_USER");
  assert.equal(auth["futureOption"], "keep-me");
});

test("updateApp of an unrelated field writes the config back as it was: comments, placeholders, tuning and blocks included", async () => {
  const deps = makeDeps(withConfig(SHOP_YAML));
  const r = await updateApp({ name: "shop", shadow: false }, deps);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(deps.written["shop"], SHOP_YAML.replace("shadow: true", "shadow: false"));
  assert.equal((deps.written["shop"] ?? "").includes(SHOP_ENV.SHOP_DEV_URL), false, "the expanded url must never replace its placeholder");
});

test("updateApp dryRun returns the patched config and writes nothing", async () => {
  const deps = makeDeps(withConfig(SHOP_YAML));
  const r = await updateApp({ name: "shop", shadow: false, dryRun: true }, deps);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.yaml, SHOP_YAML.replace("shadow: true", "shadow: false"));
  assert.deepEqual(deps.written, {});
});

test("updateApp with a new repo writes that repo and the default branch the lookup returned", async () => {
  const deps = makeDeps({
    ...withConfig(SHOP_YAML),
    getRepoInfo: async (repo: string) => ({ name: "new-repo", fullName: repo, private: false, defaultBranch: "trunk", description: null }),
  });
  const r = await updateApp({ name: "shop", repo: "org/new-repo" }, deps);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const written = writtenConfig(deps);
  assert.equal(written["repo"], "org/new-repo");
  assert.equal(written["baseBranch"], "trunk");
  assert.deepEqual(written["auth"], parse(SHOP_YAML).auth);
});

test("updateApp switching an app to the code target drops the login and keeps the rest, and the result is valid", async () => {
  const deps = makeDeps(withConfig(SHOP_YAML));
  const r = await updateApp({ name: "shop", target: "code" }, deps);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const written = writtenConfig(deps);
  assert.equal(written["code"], true);
  assert.equal(written["auth"], undefined);
  assert.deepEqual(written["openapi"], parse(SHOP_YAML).openapi);
});

test("updateApp reports a config it cannot read, and writes nothing", async () => {
  const deps = makeDeps({ readConfig: () => { throw new Error("EACCES"); } });
  const r = await updateApp({ name: "shop", shadow: false }, deps);
  assert.equal(r.ok, false);
  assert.match(r.errors?.[0] ?? "", /EACCES/);
  assert.deepEqual(deps.written, {});
});

test("updateApp reports a config that is not valid YAML, and writes nothing", async () => {
  const deps = makeDeps({ readConfig: () => "name: [unclosed\nrepo: x\n" });
  const r = await updateApp({ name: "shop", shadow: false }, deps);
  assert.equal(r.ok, false);
  assert.ok((r.errors ?? []).length > 0);
  assert.deepEqual(deps.written, {});
});

test("create applies env FIRST, validates the expanded YAML, then writes", async () => {
  const order: string[] = [];
  const deps = makeDeps({
    applyEnv: (vars: Record<string, string>) => { order.push("env"); return Object.keys(vars); },
    writeConfig: (name: string, _yaml: string) => { order.push("write"); return `/x/${name}.yaml`; },
  });
  const r = await createApp(
    {
      repo: "org/shop-front", name: "shop", baseUrl: "https://dev.shop.io", target: "e2e",
      needsReview: true, shadow: true, testDataPrefix: "qa-shop",
      env: { SHOP_TOKEN: "t" },
    },
    deps,
  );
  assert.equal(r.ok, true);
  assert.deepEqual(order, ["env", "write"]);
  assert.deepEqual(r.envApplied, ["SHOP_TOKEN"]);
  assert.equal(JSON.stringify(r).includes("\"t\""), false); /* the secret value never leaves */
});

test("invalid config returns the Zod errors and writes nothing", async () => {
  const deps = makeDeps();
  const r = await createApp(
    { repo: "org/shop-front", name: "shop", baseUrl: "not-a-url", target: "e2e", needsReview: true, shadow: true, testDataPrefix: "qa" },
    deps,
  );
  assert.equal(r.ok, false);
  assert.ok((r.errors ?? []).length > 0);
  assert.deepEqual(deps.written, {});
});

test("duplicate name or invalid name is rejected", async () => {
  const dup = await createApp(
    { repo: "o/r", name: "shop", baseUrl: "https://x", target: "e2e", needsReview: true, shadow: true, testDataPrefix: "qa" },
    makeDeps({ configExists: () => true }),
  );
  assert.equal(dup.ok, false);
  const bad = await createApp(
    { repo: "o/r", name: "../evil", baseUrl: "https://x", target: "e2e", needsReview: true, shadow: true, testDataPrefix: "qa" },
    makeDeps(),
  );
  assert.equal(bad.ok, false);
});

/* Login material (session cookies, client certificate and its passphrase) is a credential for an app
   that no longer exists once it is deleted, so every delete removes it, purge or not. */
test("deleteApp without purge removes the config and the stored login material, and keeps the mirror and run history", () => {
  const deps = makeDeps();
  const result = deleteApp("shop", false, deps);
  for (const gone of ["config:shop", "auth:shop"]) {
    assert.ok(deps.removed.includes(gone), `a delete must remove ${gone}`);
  }
  for (const kept of ["mirror:org/shop-front", "history:shop"]) {
    assert.equal(deps.removed.includes(kept), false, `${kept} must be kept without purge`);
  }
  assert.deepEqual([...result.removed].sort(), [...deps.removed].sort(), "the report lists exactly what was removed");
});

test("deleteApp with purge also removes the primary mirror, the run history and the stored login material", () => {
  const deps = makeDeps();
  const result = deleteApp("shop", true, deps);
  for (const gone of ["config:shop", "mirror:org/shop-front", "history:shop", "auth:shop"]) {
    assert.ok(deps.removed.includes(gone), `purge must remove ${gone}`);
  }
  assert.deepEqual([...result.removed].sort(), [...deps.removed].sort(), "the report lists exactly what was removed");
});

test("updateApp loads existing config, merges changes, and writes", async () => {
  const deps = makeDeps();
  const r = await updateApp(
    { name: "shop", baseUrl: "https://new.dev.shop.io", shadow: false },
    deps,
  );
  assert.equal(r.ok, true);
  assert.equal(r.name, "shop");
  const yaml = deps.written["shop"] ?? "";
  assert.match(yaml, /baseUrl: "https:\/\/new\.dev\.shop\.io"/);
  assert.match(yaml, /shadow: false/);
  assert.match(yaml, /repo: "org\/shop-front"/);
});

test("updateApp validates repo when it changes", async () => {
  const deps = makeDeps();
  const r = await updateApp(
    { name: "shop", repo: "org/new-repo" },
    deps,
  );
  assert.equal(r.ok, true);
  assert.match(deps.written["shop"] ?? "", /repo: "org\/new-repo"/);
});

test("updateApp rejects invalid config", async () => {
  const deps = makeDeps();
  const r = await updateApp(
    { name: "shop", baseUrl: "not-a-url" },
    deps,
  );
  assert.equal(r.ok, false);
  assert.ok((r.errors ?? []).length > 0);
  assert.deepEqual(deps.written, {});
});

test("updateApp returns 404 when app does not exist", async () => {
  const deps = makeDeps({
    loadApp: () => { throw new Error("not found"); },
  });
  const r = await updateApp({ name: "missing", baseUrl: "https://x" }, deps);
  assert.equal(r.ok, false);
  assert.match(r.errors?.[0] ?? "", /not found/);
});

test("updateApp dryRun returns yaml without writing", async () => {
  const deps = makeDeps();
  const r = await updateApp({ name: "shop", shadow: false, dryRun: true }, deps);
  assert.equal(r.ok, true);
  assert.ok(r.yaml);
  assert.deepEqual(deps.written, {});
});

test("updateApp keeps an existing boundaries block, in order, when it changes another field", async () => {
  const withBoundaries = spliceBoundariesBlock(SHOP_YAML, [...serializeBoundary(HTTP_BOUNDARY), ...serializeBoundary(EVENT_BOUNDARY)]);
  const deps = makeDeps(withConfig(withBoundaries));

  const r = await updateApp({ name: "shop", baseUrl: "https://new.shop.example" }, deps);

  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const yaml = deps.written["shop"] ?? "";
  assert.deepEqual(writtenConfig(deps)["boundaries"], parse(withBoundaries).boundaries);
  assert.match(yaml, /openApiPath: "src\/main\/resources\/openapi\/api-definition\.yaml"/);
  assert.match(yaml, /listenerBaseType: "ListenerMessageDelegate"/);
  /* order: the http entry (first in the input array) must appear before the event entry */
  assert.ok(yaml.indexOf("transport: http") < yaml.indexOf("transport: event"));
});

test("an app onboarding wrote comes back from an update as the rebuild would have written it", async () => {
  const deps = makeDeps();

  const r = await updateApp({ name: "shop", baseUrl: "https://new" }, deps);

  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(deps.written["shop"], buildYaml({ ...STOCK_ONBOARD, baseUrl: "https://new" }));
});
