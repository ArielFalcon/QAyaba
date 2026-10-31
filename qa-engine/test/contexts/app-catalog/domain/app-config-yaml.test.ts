import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { AppConfigSchema, buildYaml, suggestName, type OnboardInput } from "@contexts/app-catalog/application/index.ts";

test("suggestName extracts the repo name from org/name", () => {
  assert.equal(suggestName("facebook/react"), "react");
  assert.equal(suggestName("my-org/my-repo"), "my-repo");
  assert.equal(suggestName("single"), "single");
});

test("buildYaml generates valid YAML for an e2e project", () => {
  const input: OnboardInput = {
    name: "test-app",
    repo: "org/repo",
    baseBranch: "main",
    baseUrl: "https://dev.example.com",
    versionUrl: "https://dev.example.com/version",
    needsReview: true,
    shadow: true,
    testDataPrefix: "qa-bot",
  };
  const yaml = buildYaml(input);
  assert.match(yaml, /name: "test-app"/);
  assert.match(yaml, /repo: "org\/repo"/);
  assert.match(yaml, /baseUrl: "https:\/\/dev.example.com"/);
  assert.match(yaml, /versionUrl: "https:\/\/dev.example.com\/version"/);
  assert.match(yaml, /needsReview: true/);
  assert.match(yaml, /shadow: true/);
  assert.match(yaml, /testDataPrefix: "qa-bot"/);
  assert.match(yaml, /onFailure: "github-issue"/);
});

test("buildYaml omits versionUrl when empty", () => {
  const input: OnboardInput = {
    name: "no-version",
    repo: "org/repo",
    baseBranch: "main",
    baseUrl: "https://dev.example.com",
    needsReview: true,
    shadow: false,
    testDataPrefix: "qa",
  };
  const yaml = buildYaml(input);
  assert.doesNotMatch(yaml, /versionUrl/);
});

test("buildYaml handles special characters in repo name", () => {
  assert.equal(suggestName("org/my-repo_v2"), "my-repo-v2");
  assert.equal(suggestName("org/UPPERCASE"), "uppercase");
});

test("buildYaml renders services[] for e2e apps", () => {
  const yaml = buildYaml({
    name: "shop", repo: "org/shop-front", baseBranch: "main",
    baseUrl: "https://dev.shop.io", needsReview: true, shadow: true,
    testDataPrefix: "qa-shop",
    services: [
      { repo: "org/orders-svc", openapi: "api/*.yaml", versionUrl: "https://svc/version" },
      { repo: "org/payments-svc" },
    ],
  });
  assert.match(yaml, /services:/);
  assert.match(yaml, /- repo: "org\/orders-svc"/);
  assert.match(yaml, /openapi: "api\/\*\.yaml"/);
  assert.match(yaml, /versionUrl: "https:\/\/svc\/version"/);
  assert.match(yaml, /- repo: "org\/payments-svc"/);
});

test("buildYaml renders auth for form", () => {
  const yaml = buildYaml({
    name: "shop", repo: "org/shop-front", baseBranch: "main",
    baseUrl: "https://dev.shop.io", needsReview: true, shadow: true,
    testDataPrefix: "qa-shop",
    auth: { kind: "form", usernameEnv: "QA_SHOP_TEST_USER", passwordEnv: "QA_SHOP_TEST_PASS" },
  });
  assert.match(yaml, /auth:/);
  assert.match(yaml, /kind: form/);
  assert.match(yaml, /usernameEnv: "QA_SHOP_TEST_USER"/);
});

test("buildYaml renders a form login's path override, and never for a client-certificate login", () => {
  const base = { name: "shop", repo: "org/shop-front", baseBranch: "main", baseUrl: "https://dev.shop.io", needsReview: true, shadow: true, testDataPrefix: "qa-shop" } as const;
  const form = buildYaml({ ...base, auth: { kind: "form", usernameEnv: "QA_USER", passwordEnv: "QA_PASS", loginPath: "/signin" } });
  assert.match(form, /loginPath: "\/signin"/);
  const mtls = buildYaml({ ...base, auth: { kind: "mtls", certEnv: "QA_CERT", certPassEnv: "QA_CERT_PASS", loginPath: "/signin" } });
  assert.doesNotMatch(mtls, /loginPath/);
  const none = buildYaml({ ...base, auth: { kind: "form", usernameEnv: "QA_USER", passwordEnv: "QA_PASS" } });
  assert.doesNotMatch(none, /loginPath/);
});

test("buildYaml omits services when absent", () => {
  const none = buildYaml({ name: "a", repo: "o/a", baseBranch: "main", baseUrl: "https://x", needsReview: true, shadow: true, testDataPrefix: "qa" });
  assert.doesNotMatch(none, /services:/);
});

test("a config buildYaml writes for every option it carries passes the strict app-config schema", () => {
  const base = { name: "shop", repo: "org/shop-front", baseBranch: "main", baseUrl: "https://dev.shop.io", needsReview: true, shadow: false, testDataPrefix: "qa-shop" } as const;
  const inputs: OnboardInput[] = [
    base,
    { ...base, versionUrl: "https://dev.shop.io/version" },
    { ...base, services: [{ repo: "org/orders-svc" }, { repo: "org/pay-svc", openapi: "**/openapi/*.yaml", versionUrl: "https://dev-api.shop.io/version" }] },
    { ...base, auth: { kind: "form", usernameEnv: "QA_USER", passwordEnv: "QA_PASS", loginPath: "/signin" } },
    { ...base, auth: { kind: "mtls", certEnv: "QA_CERT", certPassEnv: "QA_CERT_PASS" } },
  ];
  for (const input of inputs) {
    const result = AppConfigSchema.safeParse(parse(buildYaml(input)));
    assert.equal(result.success, true, result.success ? "" : result.error.message);
  }
});
