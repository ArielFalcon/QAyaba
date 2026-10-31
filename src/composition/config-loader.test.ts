import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLogShipper, type ShippedLine } from "../telemetry/redacting-logger";
import { AppConfigInvalidError, AppNotFoundError, describeAppLoadFailure, listAppConfigs, loadAppConfig, scanAppConfigs } from "./config-loader";

test("loadAppConfig expands placeholders against the active environment", () => {
  const root = makeRoot({ "shop.yaml": FRONT.replace("https://dev.shop.io", "${PIN_SHOP_URL}") });
  process.env.PIN_SHOP_URL = "https://dev.pinned.io";
  try {
    assert.equal(loadAppConfig("shop", root).dev.baseUrl, "https://dev.pinned.io");
  } finally {
    delete process.env.PIN_SHOP_URL;
    rmSync(root, { recursive: true, force: true });
  }
  const unset = makeRoot({ "shop.yaml": FRONT.replace("https://dev.shop.io", "${PIN_SHOP_URL}") });
  try {
    assert.throws(() => loadAppConfig("shop", unset), (err: Error) => err instanceof AppConfigInvalidError && /unset env var \$\{PIN_SHOP_URL\}/.test(err.message));
  } finally {
    rmSync(unset, { recursive: true, force: true });
  }
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

function describe_strictConfig(): void {
  const VALID_APP = `
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

  function captureLines(levels: readonly string[] = ["warn", "error"]): ShippedLine[] {
    const lines: ShippedLine[] = [];
    installLogShipper((line) => {
      if (levels.includes(line.level)) lines.push(line);
    });
    return lines;
  }
  afterEach(() => installLogShipper(undefined));

  const withQa = (extra: string) => VALID_APP.replace("  needsReview: true", `  needsReview: true\n${extra}`);
  const reasonOf = (yaml: string): string => {
    const root = makeRoot({ "shop.yaml": yaml });
    try {
      loadAppConfig("shop", root);
    } catch (err) {
      assert.ok(err instanceof AppConfigInvalidError, String(err));
      return err.reason;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    return assert.fail("the config loaded");
  };

  test("loadAppConfig refuses an unknown key, naming the app and the key path and never a value", () => {
    const yaml = `${VALID_APP}typo_key: "s3cr3t-unknown-value"\n`;
    const root = makeRoot({ "shop.yaml": yaml });
    try {
      assert.throws(
        () => loadAppConfig("shop", root),
        (err) => err instanceof AppConfigInvalidError && err.app === "shop" && /unknown key 'typo_key'/.test(err.reason) && !err.message.includes("s3cr3t-unknown-value"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loadAppConfig refuses the retired code key and an app that declares it with no dev block says both", () => {
    assert.match(reasonOf(`${VALID_APP}code: true\n`), /unknown key 'code'/);
    const noDev = VALID_APP.replace('dev:\n  baseUrl: "https://dev.shop.io"\n', "").replace('services:\n  - repo: "org/orders-svc"\n', "");
    const reason = reasonOf(`${noDev}code: true\n`);
    assert.match(reason, /dev is required/);
    assert.match(reason, /unknown key 'code'/);
  });

  test("loadAppConfig names the replacement of the retired qa.valueOracle key and says bundle mutation now runs unless it is off", () => {
    const reason = reasonOf(withQa("  valueOracle: signal"));
    assert.match(reason, /retired key 'qa\.valueOracle'/);
    assert.match(reason, /qa\.changeCoverage\.bundleMutation/);
    assert.match(reason, /runs unless .*off/);
  });

  test("loadAppConfig refuses the retired qa.wallClockBudgetMs key and says the run deadline is the only clock", () => {
    const reason = reasonOf(withQa("  wallClockBudgetMs: 5000"));
    assert.match(reason, /retired key 'qa\.wallClockBudgetMs'/);
    assert.match(reason, /run deadline/);
  });

  test("loadAppConfig refuses the retired reviewLoopIntegrity key as an unknown key, with no replacement named", () => {
    const reason = reasonOf(withQa("  reviewLoopIntegrity: false"));
    assert.match(reason, /unknown key 'qa\.reviewLoopIntegrity'/);
    assert.doesNotMatch(reason, /retired/);
  });

  test("loadAppConfig refuses the retired enforce value of qa.intentLock.mode with its advice, and loads the modes it has", () => {
    const withMode = (mode: string) => withQa(`  intentLock:\n    mode: ${mode}`);
    const reason = reasonOf(withMode("enforce"));
    assert.match(reason, /qa\.intentLock\.mode: /);
    assert.match(reason, /'enforce' is retired; use 'signal'/);
    for (const mode of ["signal", "off"]) {
      const root = makeRoot({ "shop.yaml": withMode(mode) });
      try {
        assert.equal(loadAppConfig("shop", root).qa.intentLock?.mode, mode);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("loadAppConfig names every unknown key of the file by its full path, nested in an object and in a list", () => {
    const yaml = withQa("  testDataPrefixx: oops").replace('  - repo: "org/orders-svc"', '  - repo: "org/orders-svc"\n    verionUrl: "https://v.example"') + "first_typo: 1\nsecond_typo: 2\n";
    const reason = reasonOf(yaml);
    for (const key of ["qa.testDataPrefixx", "services[0].verionUrl", "first_typo", "second_typo"]) assert.match(reason, new RegExp(`unknown key '${key.replace(/[[\].]/g, "\\$&")}'`));
  });

  test("loadAppConfig returns the config of a file that declares only known keys, and logs nothing", () => {
    const lines = captureLines();
    const root = makeRoot({ "shop.yaml": VALID_APP });
    try {
      const config = loadAppConfig("shop", root);
      assert.equal(config.repo, "org/shop-front");
      assert.equal(config.services?.[0]?.repo, "org/orders-svc");
      assert.deepEqual(lines, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("listAppConfigs skips an app whose file fails validation, keeps loading the others, and logs an error naming the file, the key and the reason", () => {
    const lines = captureLines();
    const root = makeRoot({
      "good.yaml": VALID_APP.replace('name: "shop"', 'name: "good"'),
      "typo.yaml": `${VALID_APP.replace('name: "shop"', 'name: "typo"')}typo_key: "s3cr3t-unknown-value"\n`,
      "old.yaml": withQa("  valueOracle: signal").replace('name: "shop"', 'name: "old"'),
    });
    try {
      assert.deepEqual(listAppConfigs(root).map((app) => app.name), ["good"]);
      const errors = lines.filter((line) => line.level === "error");
      assert.equal(errors.length, 2);
      const typo = errors.find((line) => /typo\.yaml/.test(line.message));
      assert.match(typo?.message ?? "", /unknown key 'typo_key'/);
      assert.match(typo?.message ?? "", /NOT be watched/);
      assert.deepEqual(typo?.fields, { app: "typo", file: "config/apps/typo.yaml" });
      assert.match(errors.find((line) => /old\.yaml/.test(line.message))?.message ?? "", /retired key 'qa\.valueOracle'/);
      assert.equal(lines.filter((line) => line.level === "warn").length, 0);
      assert.ok(!JSON.stringify(lines).includes("s3cr3t-unknown-value"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("scanAppConfigs lists every app that did not load with its file and reason, whatever stopped it", () => {
    captureLines();
    const root = makeRoot({
      "good.yaml": VALID_APP.replace('name: "shop"', 'name: "good"'),
      "typo.yaml": `${VALID_APP}typo_key: 1\n`,
      "unset.yaml": VALID_APP.replace("https://dev.shop.io", "${QA_TEST_UNSET_BASE_URL}"),
      "broken.yaml": "name: [unclosed",
      "example.yaml": "not an app",
    });
    try {
      const scan = scanAppConfigs(root);
      assert.deepEqual(scan.loaded.map((app) => app.name), ["good"]);
      assert.deepEqual(scan.notLoaded.map((entry) => [entry.app, entry.file]).sort(), [
        ["broken", "config/apps/broken.yaml"],
        ["typo", "config/apps/typo.yaml"],
        ["unset", "config/apps/unset.yaml"],
      ]);
      assert.match(scan.notLoaded.find((entry) => entry.app === "typo")?.reason ?? "", /unknown key 'typo_key'/);
      assert.match(scan.notLoaded.find((entry) => entry.app === "unset")?.reason ?? "", /unset env var \$\{QA_TEST_UNSET_BASE_URL\}/);
      assert.deepEqual(scanAppConfigs(makeRoot({})).notLoaded, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a config that cannot be read or parsed is an error line too, never a quiet warning", () => {
    const lines = captureLines();
    const root = makeRoot({ "broken.yaml": "name: [unclosed" });
    try {
      assert.deepEqual(listAppConfigs(root), []);
      assert.equal(lines.filter((line) => line.level === "error" && /broken\.yaml/.test(line.message)).length, 1);
      assert.equal(lines.filter((line) => line.level === "warn").length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a skipped app is reported once per reason, again when the reason changes, and again after it loaded and broke", () => {
    const lines = captureLines(["error"]);
    const root = makeRoot({ "shop.yaml": `${VALID_APP}typo_key: 1\n` });
    const file = join(root, "config", "apps", "shop.yaml");
    try {
      scanAppConfigs(root);
      scanAppConfigs(root);
      assert.equal(lines.length, 1);
      writeFileSync(file, `${VALID_APP}other_typo: 1\n`);
      scanAppConfigs(root);
      assert.equal(lines.length, 2);
      writeFileSync(file, VALID_APP);
      assert.deepEqual(scanAppConfigs(root).notLoaded, []);
      writeFileSync(file, `${VALID_APP}other_typo: 1\n`);
      scanAppConfigs(root);
      assert.equal(lines.length, 3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
describe_strictConfig();

test("describeAppLoadFailure words an absent app and an unloadable config, and leaves any other failure to the caller", () => {
  assert.equal(describeAppLoadFailure("shop", new AppNotFoundError("shop")), "app not found: 'shop'");
  assert.equal(describeAppLoadFailure("shop", new AppConfigInvalidError("shop", "bad yaml")), "app config invalid: 'shop': bad yaml");
  assert.equal(describeAppLoadFailure("shop", new Error("disk unreachable")), undefined);
});
