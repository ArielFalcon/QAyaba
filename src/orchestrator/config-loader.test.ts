import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppConfigInvalidError, AppNotFoundError, describeAppLoadFailure, expandEnv, loadAppConfig, loadAppConfigsByRepo } from "./config-loader";

test("expandEnv resolves mixed-case ${Var} names, not just UPPERCASE", () => {
  const out = expandEnv("a: ${myToken}\nb: ${UPPER}", { myToken: "x", UPPER: "y" });
  assert.equal(out, "a: x\nb: y");
});

test("expandEnv throws on an unset var (never passes ${...} through literally)", () => {
  assert.throws(() => expandEnv("k: ${missingVar}", {}), /unset env var \$\{missingVar\}/);
});

function makeRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cfg-"));
  mkdirSync(join(root, "config", "apps"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, "config", "apps", name), content);
  }
  return root;
}

const FRONT = `
name: "shop"
repo: "org/shop-front"
dev:
  baseUrl: "https://dev.shop.io"
services:
  - repo: "org/orders-svc"
qa:
  needsReview: true
  testDataPrefix: "qa-shop"
report:
  onFailure: "github-issue"
`;

const ORDERS_CODE = `
name: "orders"
repo: "org/orders-svc"
code: true
qa:
  needsReview: false
  testDataPrefix: "qa-orders"
report:
  onFailure: "github-issue"
`;

test("primary repo matches with role primary", () => {
  const root = makeRoot({ "shop.yaml": FRONT });
  try {
    const matches = loadAppConfigsByRepo("org/shop-front", root);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.role, "primary");
    assert.equal(matches[0]?.app.name, "shop");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("service repo matches the owning app with role service", () => {
  const root = makeRoot({ "shop.yaml": FRONT });
  try {
    const matches = loadAppConfigsByRepo("org/orders-svc", root);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.role, "service");
    assert.equal(matches[0]?.app.name, "shop");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a repo that is both its own app and a service of another fans out to BOTH", () => {
  const root = makeRoot({ "shop.yaml": FRONT, "orders.yaml": ORDERS_CODE });
  try {
    const matches = loadAppConfigsByRepo("org/orders-svc", root);
    const roles = matches.map((m) => `${m.app.name}:${m.role}`).sort();
    assert.deepEqual(roles, ["orders:primary", "shop:service"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unknown repo returns no matches; a malformed yaml is skipped, not fatal", () => {
  const root = makeRoot({ "shop.yaml": FRONT, "broken.yaml": "name: [unclosed" });
  try {
    assert.deepEqual(loadAppConfigsByRepo("org/nobody", root), []);
    assert.equal(loadAppConfigsByRepo("org/shop-front", root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe_loadAppConfig();

function describe_loadAppConfig(): void {
  const VALID = `
name: "shop"
repo: "org/shop-front"
dev:
  baseUrl: "https://dev.shop.io"
qa:
  needsReview: true
  testDataPrefix: "qa-shop"
report:
  onFailure: "github-issue"
`;

  test("loadAppConfig throws AppNotFoundError for an app with no config file", () => {
    const root = makeRoot({});
    try {
      assert.throws(() => loadAppConfig("ghost", root), (err) => err instanceof AppNotFoundError && err.app === "ghost" && /ghost\.yaml not found/.test(err.message));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loadAppConfig returns the config of a valid file", () => {
    const root = makeRoot({ "shop.yaml": VALID });
    try {
      assert.equal(loadAppConfig("shop", root).repo, "org/shop-front");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const INVALID: ReadonlyArray<{ cause: string; yaml: string; reason: RegExp }> = [
    { cause: "an unset env var", yaml: VALID.replace("https://dev.shop.io", "${QA_TEST_UNSET_BASE_URL}"), reason: /unset env var \$\{QA_TEST_UNSET_BASE_URL\}/ },
    { cause: "a YAML syntax error", yaml: "name: [unclosed", reason: /./ },
    { cause: "a schema error", yaml: VALID.replace('repo: "org/shop-front"', "repo: 42"), reason: /repo/ },
  ];
  for (const { cause, yaml, reason } of INVALID) {
    test(`loadAppConfig throws AppConfigInvalidError naming the app and the reason for ${cause}`, () => {
      const root = makeRoot({ "shop.yaml": yaml });
      try {
        assert.throws(
          () => loadAppConfig("shop", root),
          (err) => err instanceof AppConfigInvalidError && err.app === "shop" && reason.test(err.reason) && err.message === `app config invalid: 'shop': ${err.reason}` && err.cause !== undefined,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test("loadAppConfig never puts the value of an env var into the reason", () => {
    const root = makeRoot({ "shop.yaml": VALID.replace("https://dev.shop.io", "${QA_TEST_SECRET_URL}") });
    process.env.QA_TEST_SECRET_URL = "not-a-url-s3cr3t-value";
    try {
      assert.throws(
        () => loadAppConfig("shop", root),
        (err) => err instanceof AppConfigInvalidError && !err.message.includes("s3cr3t-value"),
      );
    } finally {
      delete process.env.QA_TEST_SECRET_URL;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("describeAppLoadFailure words an absent app and an unloadable config, and leaves any other failure to the caller", () => {
  assert.equal(describeAppLoadFailure("shop", new AppNotFoundError("shop")), "app not found: 'shop'");
  assert.equal(describeAppLoadFailure("shop", new AppConfigInvalidError("shop", "bad yaml")), "app config invalid: 'shop': bad yaml");
  assert.equal(describeAppLoadFailure("shop", new Error("disk unreachable")), undefined);
});
