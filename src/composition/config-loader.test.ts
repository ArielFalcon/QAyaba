import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLogShipper, type ShippedLine } from "../telemetry/redacting-logger";
import { AppConfigInvalidError, AppNotFoundError, describeAppLoadFailure, listAppConfigs, loadAppConfig } from "./config-loader";

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

function describe_unknownKeys(): void {
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

  function captureWarnings(): ShippedLine[] {
    const lines: ShippedLine[] = [];
    installLogShipper((line) => {
      if (line.level === "warn") lines.push(line);
    });
    return lines;
  }
  afterEach(() => installLogShipper(undefined));

  function loadWith(extra: string, files = VALID_APP): { root: string; yaml: string } {
    const yaml = `${files}${extra}`;
    return { root: makeRoot({ "shop.yaml": yaml }), yaml };
  }

  test("loadAppConfig warns once for an unknown key, naming the app and the key path and never a value", () => {
    const lines = captureWarnings();
    const { root } = loadWith('typo_key: "s3cr3t-unknown-value"\n');
    try {
      loadAppConfig("shop", root);
      loadAppConfig("shop", root);
      const unknown = lines.filter((l) => /unknown key/.test(l.message));
      assert.equal(unknown.length, 1);
      assert.match(unknown[0]?.message ?? "", /'shop'/);
      assert.match(unknown[0]?.message ?? "", /'typo_key'/);
      assert.ok(!JSON.stringify(unknown[0]).includes("s3cr3t-unknown-value"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loadAppConfig warns that the retired code key is ignored and still loads the e2e app that carries it", () => {
    const lines = captureWarnings();
    const { root } = loadWith("code: true\n");
    try {
      assert.equal(loadAppConfig("shop", root).repo, "org/shop-front");
      const unknown = lines.filter((l) => /unknown key/.test(l.message));
      assert.equal(unknown.length, 1);
      assert.match(unknown[0]?.message ?? "", /'code'/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loadAppConfig names the replacement of the retired qa.valueOracle key and says bundle mutation now runs unless it is off", () => {
    const lines = captureWarnings();
    const { root } = loadWith("", VALID_APP.replace("  needsReview: true", "  needsReview: true\n  valueOracle: signal"));
    try {
      assert.equal(loadAppConfig("shop", root).repo, "org/shop-front");
      const retired = lines.filter((l) => /qa\.valueOracle/.test(l.message));
      assert.equal(retired.length, 1);
      assert.match(retired[0]?.message ?? "", /'shop'/);
      assert.match(retired[0]?.message ?? "", /qa\.changeCoverage\.bundleMutation/);
      assert.match(retired[0]?.message ?? "", /runs unless .*off/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loadAppConfig reports the retired qa.wallClockBudgetMs key and says the run deadline is the only clock", () => {
    const lines = captureWarnings();
    const { root } = loadWith("", VALID_APP.replace("  needsReview: true", "  needsReview: true\n  wallClockBudgetMs: 5000"));
    try {
      assert.equal(loadAppConfig("shop", root).repo, "org/shop-front");
      const retired = lines.filter((l) => /qa\.wallClockBudgetMs/.test(l.message));
      assert.equal(retired.length, 1);
      assert.match(retired[0]?.message ?? "", /'shop'/);
      assert.match(retired[0]?.message ?? "", /is retired/);
      assert.match(retired[0]?.message ?? "", /run deadline/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loadAppConfig reports the retired reviewLoopIntegrity key as an unknown key, with no replacement named", () => {
    const lines = captureWarnings();
    const { root } = loadWith("", VALID_APP.replace("  needsReview: true", "  needsReview: true\n  reviewLoopIntegrity: false"));
    try {
      loadAppConfig("shop", root);
      const warned = lines.filter((l) => /reviewLoopIntegrity/.test(l.message));
      assert.equal(warned.length, 1);
      assert.match(warned[0]?.message ?? "", /unknown key 'qa\.reviewLoopIntegrity' is ignored/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loadAppConfig loads an app that still sets the retired enforce value of qa.intentLock.mode, runs it as signal and warns", () => {
    const withMode = (mode: string) => VALID_APP.replace("  needsReview: true", `  needsReview: true\n  intentLock:\n    mode: ${mode}`);
    const lines = captureWarnings();
    const retired = loadWith("", withMode("enforce"));
    try {
      assert.equal(loadAppConfig("shop", retired.root).qa.intentLock?.mode, "signal");
      loadAppConfig("shop", retired.root);
      const warned = lines.filter((l) => /intentLock/.test(l.message));
      assert.equal(warned.length, 1);
      assert.match(warned[0]?.message ?? "", /'shop'/);
      assert.match(warned[0]?.message ?? "", /'enforce'/);
      assert.match(warned[0]?.message ?? "", /runs as 'signal'/);
      assert.deepEqual(listAppConfigs(retired.root).map((app) => app.name), ["shop"]);
    } finally {
      rmSync(retired.root, { recursive: true, force: true });
    }
    for (const mode of ["signal", "off"]) {
      const accepted = loadWith("", withMode(mode));
      try {
        assert.equal(loadAppConfig("shop", accepted.root).qa.intentLock?.mode, mode);
        assert.equal(lines.filter((l) => /intentLock/.test(l.message)).length, 1, `${mode} adds no warning`);
      } finally {
        rmSync(accepted.root, { recursive: true, force: true });
      }
    }
  });

  test("loadAppConfig keeps the generic unknown-key warning for every other unknown key of the qa block", () => {
    const lines = captureWarnings();
    const { root } = loadWith("", VALID_APP.replace("  needsReview: true", "  needsReview: true\n  valueOraclee: signal"));
    try {
      const unknown = lines.filter((l) => /unknown key/.test(l.message));
      loadAppConfig("shop", root);
      const warned = lines.filter((l) => /valueOraclee/.test(l.message));
      assert.equal(unknown.length, 0);
      assert.equal(warned.length, 1);
      assert.match(warned[0]?.message ?? "", /unknown key 'qa\.valueOraclee' is ignored/);
      assert.doesNotMatch(warned[0]?.message ?? "", /bundleMutation/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loadAppConfig refuses an app that declared code: true and has no dev block", () => {
    captureWarnings();
    const noDev = VALID_APP.replace('dev:\n  baseUrl: "https://dev.shop.io"\n', "").replace('services:\n  - repo: "org/orders-svc"\n', "");
    const root = makeRoot({ "shop.yaml": `${noDev}code: true\n` });
    try {
      assert.throws(() => loadAppConfig("shop", root), (err) => err instanceof AppConfigInvalidError && /dev is required/.test(err.reason));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loadAppConfig names an unknown key nested in an object and in a list by its full path", () => {
    const lines = captureWarnings();
    const yaml = VALID_APP.replace("  needsReview: true", "  needsReview: true\n  testDataPrefixx: oops").replace('  - repo: "org/orders-svc"', '  - repo: "org/orders-svc"\n    verionUrl: "https://v.example"');
    const root = makeRoot({ "shop.yaml": yaml });
    try {
      loadAppConfig("shop", root);
      const messages = lines.map((l) => l.message).join("\n");
      assert.match(messages, /'qa\.testDataPrefixx'/);
      assert.match(messages, /'services\[0\]\.verionUrl'/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loadAppConfig warns for each distinct unknown key of the same file", () => {
    const lines = captureWarnings();
    const { root } = loadWith("first_typo: 1\nsecond_typo: 2\n");
    try {
      loadAppConfig("shop", root);
      const keys = lines.filter((l) => /unknown key/.test(l.message)).map((l) => /'(first_typo|second_typo)'/.exec(l.message)?.[1]);
      assert.deepEqual(keys.sort(), ["first_typo", "second_typo"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loadAppConfig warns about nothing for a config that declares only known keys", () => {
    const lines = captureWarnings();
    const root = makeRoot({ "shop.yaml": VALID_APP });
    try {
      loadAppConfig("shop", root);
      assert.deepEqual(lines, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loadAppConfig returns the same config with an unknown key as without it", () => {
    captureWarnings();
    const withKey = loadWith('typo_key: "x"\n');
    const without = makeRoot({ "shop.yaml": VALID_APP });
    try {
      assert.equal(JSON.stringify(loadAppConfig("shop", withKey.root)), JSON.stringify(loadAppConfig("shop", without)));
    } finally {
      rmSync(withKey.root, { recursive: true, force: true });
      rmSync(without, { recursive: true, force: true });
    }
  });
}
describe_unknownKeys();

test("describeAppLoadFailure words an absent app and an unloadable config, and leaves any other failure to the caller", () => {
  assert.equal(describeAppLoadFailure("shop", new AppNotFoundError("shop")), "app not found: 'shop'");
  assert.equal(describeAppLoadFailure("shop", new AppConfigInvalidError("shop", "bad yaml")), "app config invalid: 'shop': bad yaml");
  assert.equal(describeAppLoadFailure("shop", new Error("disk unreachable")), undefined);
});
