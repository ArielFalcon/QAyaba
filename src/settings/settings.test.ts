import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { DEFAULT_PORT, DEFAULT_LISTEN_HOST } from "./port";
import { DEFAULT_TOOLS_PORT } from "../entrypoints/tools-endpoint";
import { DEFAULT_CAMPAIGN_RETENTION_DAYS, DEFAULT_SERVICE_NAME, DEFAULT_SPAN_RETENTION_DAYS } from "../telemetry/config";
import { resolveRunTimeBudgets } from "@contexts/run-orchestration/application/index";
import { renderSettingsDocs } from "../../scripts/gen-settings-docs";
import { settingsDocStaleness } from "../../scripts/check-settings-fresh";
import { DEFAULT_DRAIN_MS, DEFAULT_REVIEWER_TIMEOUT_MS, DEFAULT_SESSION_TTL_SECONDS, DEFAULT_STALL_MS } from "./defaults";
import { SETTINGS_REGISTRY, settingDef } from "./registry";
import { describeSettings, loadSettings, SettingsError } from "./settings";
import { createSettingsStore } from "./store";

const SECRET_VALUE = "s3cr3t-value-that-must-not-leak";

test("a minimal environment yields the defaults each parser yields on its own", () => {
  const settings = loadSettings({});
  assert.equal(settings.server.port, DEFAULT_PORT);
  assert.equal(settings.server.listenHost, DEFAULT_LISTEN_HOST);
  assert.equal(settings.server.toolsPort, DEFAULT_TOOLS_PORT);
  assert.equal(settings.server.drainMs, DEFAULT_DRAIN_MS);
  assert.equal(settings.auth.sessionTtlSeconds, DEFAULT_SESSION_TTL_SECONDS);
  assert.equal(settings.webhook.allowUnsigned, false);
  assert.equal(settings.agent.reviewerTimeoutMs, DEFAULT_REVIEWER_TIMEOUT_MS);
  assert.equal(settings.agent.stallMs, DEFAULT_STALL_MS);
  assert.equal(settings.agent.timeoutMs, undefined);
  assert.equal(settings.sandbox.egressMode, "enforce");
  assert.equal(settings.run.runTimeBudgets.diff, resolveRunTimeBudgets({}).diff);
  assert.equal(settings.telemetry.config.serviceName, DEFAULT_SERVICE_NAME);
  assert.equal(settings.retention.spanDays, DEFAULT_SPAN_RETENTION_DAYS);
  assert.equal(settings.retention.campaignDays, DEFAULT_CAMPAIGN_RETENTION_DAYS);
});

test("an empty value counts as unset", () => {
  const settings = loadSettings({ PORT: "", LISTEN_HOST: "", MIRROR_DIR: "", OPENCODE_TIMEOUT_MS: "" });
  assert.equal(settings.server.port, DEFAULT_PORT);
  assert.equal(settings.server.listenHost, DEFAULT_LISTEN_HOST);
  assert.equal(settings.git.mirrorDir, undefined);
  assert.equal(settings.agent.timeoutMs, undefined);
});

test("set values reach their typed fields", () => {
  const settings = loadSettings({
    PORT: "8458",
    MIRROR_DIR: "/data/mirrors",
    OPENCODE_TIMEOUT_MS: "120000",
    WEBHOOK_ALLOW_UNSIGNED: "true",
    QA_TELEMETRY_RETENTION_DAYS: "7",
  });
  assert.equal(settings.server.port, 8458);
  assert.equal(settings.git.mirrorDir, "/data/mirrors");
  assert.equal(settings.agent.timeoutMs, 120_000);
  assert.equal(settings.webhook.allowUnsigned, true);
  assert.equal(settings.retention.spanDays, 7);
});

test("an agent timeout that is not a positive number is ignored, as the value was always read", () => {
  assert.equal(loadSettings({ OPENCODE_TIMEOUT_MS: "soon" }).agent.timeoutMs, undefined);
  assert.equal(loadSettings({ OPENCODE_TIMEOUT_MS: "-5" }).agent.timeoutMs, undefined);
});

test("an invalid PORT and an invalid retention window in one environment fail with one error naming both", () => {
  assert.throws(
    () => loadSettings({ PORT: "99999", QA_TELEMETRY_RETENTION_DAYS: "soon" }),
    (error: unknown) => {
      assert.ok(error instanceof SettingsError);
      const names = error.problems.map((problem) => problem.env);
      assert.ok(names.includes("PORT"));
      assert.ok(names.includes("QA_TELEMETRY_RETENTION_DAYS"));
      assert.match(error.message, /PORT/);
      assert.match(error.message, /QA_TELEMETRY_RETENTION_DAYS/);
      return true;
    },
  );
});

test("a mistyped switch stops the load and names the variable", () => {
  assert.throws(() => loadSettings({ QA_EGRESS_MODE: "sometimes" }), /QA_EGRESS_MODE/);
  assert.throws(() => loadSettings({ AUTH_SESSION_TTL_SECONDS: "0" }), /AUTH_SESSION_TTL_SECONDS/);
});

test("a secret value never appears in an error text", () => {
  const env = { PORT: `bad-${SECRET_VALUE}`, QA_API_TOKEN: SECRET_VALUE, WEBHOOK_SECRET: SECRET_VALUE };
  assert.throws(
    () => loadSettings(env),
    (error: unknown) => {
      assert.ok(error instanceof SettingsError);
      assert.ok(!error.message.includes(SECRET_VALUE));
      assert.ok(error.problems.every((problem) => !problem.message.includes(SECRET_VALUE)));
      return true;
    },
  );
});

test("a secret value never appears in a dump of the settings", () => {
  const env: Record<string, string> = {};
  for (const def of SETTINGS_REGISTRY) if (def.secret) env[def.env] = `${SECRET_VALUE}-${def.env}`;
  const settings = loadSettings(env);
  assert.ok(settings.auth.apiToken, "the real value stays available to the code that needs it");
  const dumps = [JSON.stringify(settings), JSON.stringify(describeSettings(settings)), inspect(settings, { depth: 8 }), `${JSON.stringify({ settings })}`];
  for (const dump of dumps) assert.ok(!dump.includes(SECRET_VALUE), "no dump carries a secret value");
  assert.ok(!JSON.stringify(settings).includes("environment"), "the live environment is not part of a dump");
});

test("a set secret shows as set and an unset one as absent in the redacted view", () => {
  const view = describeSettings(loadSettings({ QA_API_TOKEN: SECRET_VALUE }));
  assert.equal(view.auth?.apiToken, "[set]");
  assert.equal(view.auth?.signingKey, undefined);
});

test("the loaded settings are read-only", () => {
  const settings = loadSettings({});
  assert.throws(() => {
    (settings.server as { port: number }).port = 1;
  }, TypeError);
});

test("every registry entry names one variable and a field that exists in the loaded settings", () => {
  const settings = loadSettings({}) as unknown as Record<string, Record<string, unknown>>;
  const seen = new Set<string>();
  for (const def of SETTINGS_REGISTRY) {
    assert.ok(!seen.has(def.env), `${def.env} is listed once`);
    seen.add(def.env);
    assert.equal(settingDef(def.env), def);
    if (def.secret) assert.equal(def.default, undefined, `${def.env} is a secret and carries no default`);
    if (def.key !== "-") assert.ok(def.key in (settings[def.group] ?? {}), `${def.group}.${def.key} exists for ${def.env}`);
  }
});

test("an unregistered variable cannot be read through the registry", () => {
  assert.throws(() => settingDef("NOT_A_SETTING"), /NOT_A_SETTING/);
});

test("the store reloads after the environment changes and keeps the old settings when the new ones are invalid", () => {
  const env: Record<string, string | undefined> = { PORT: "8000" };
  const store = createSettingsStore(env);
  assert.equal(store.current().server.port, 8000);
  env.PORT = "8001";
  assert.equal(store.current().server.port, 8000, "settings are a snapshot until reloaded");
  assert.equal(store.reload().server.port, 8001);
  env.PORT = "not-a-port";
  assert.throws(() => store.reload(), SettingsError);
  assert.equal(store.current().server.port, 8001);
});

test("the generated settings document is deterministic and lists every registry entry", () => {
  const first = renderSettingsDocs();
  assert.equal(renderSettingsDocs(), first);
  for (const def of SETTINGS_REGISTRY) assert.ok(first.includes(`\`${def.env}\``), `${def.env} is documented`);
});

test("the generated settings document carries no secret default", () => {
  const docs = renderSettingsDocs();
  for (const def of SETTINGS_REGISTRY) {
    if (!def.secret) continue;
    const row = docs.split("\n").find((line) => line.startsWith(`| \`${def.env}\``));
    assert.ok(row, `${def.env} has a row`);
    assert.match(row, /\| - \| (?:required, )?secret \|/, `${def.env} shows no default and is marked secret`);
  }
});

test("a settings document that differs from the registry is stale and a missing one is reported", () => {
  const fresh = renderSettingsDocs();
  assert.equal(settingsDocStaleness(() => fresh), undefined);
  assert.match(settingsDocStaleness(() => `${fresh}drift`) ?? "", /stale/);
  assert.match(
    settingsDocStaleness(() => {
      throw new Error("ENOENT");
    }) ?? "",
    /does not exist/,
  );
});

test("each retired variable that is still set is reported once at load; an unset or empty one is not", () => {
  const retired = ["SELF_MAINTAINER_AUTOMERGE", "SELF_MAINTAINER_CI_CHECK", "QAYABA_REPO", "QA_REFLECTOR_ENABLED", "REFLECTOR_TIMEOUT_MS", "QA_JUDGES_ENABLED", "QA_JUDGES_DAILY_TOKENS", "LANGFUSE_BASE_URL", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_ALLOW_EXTERNAL", "COORDINATION_ESCALATED_MODEL", "QA_DIFF_TIME_BUDGET_MS_TINY", "QA_DIFF_TIME_BUDGET_MS_FOCUSED", "QA_DIFF_TIME_BUDGET_MS_BROAD", "QA_RUN_TIME_BUDGET_MS_COMPLETE", "QA_RUN_TIME_BUDGET_MS_EXHAUSTIVE", "AGENT_RUNTIME_MODE", "AGENT_SINGLE_PROVIDER", "AGENT_PRIMARY_PROVIDER", "AGENT_REVIEWER_PROVIDER", "AGENT_CHAT_PROVIDER", "QA_CAMPAIGN_FREEZE"];
  assert.deepEqual(loadSettings({}).warnings, []);
  assert.deepEqual(loadSettings(Object.fromEntries(retired.map((name) => [name, ""]))).warnings, []);
  const warnings = loadSettings(Object.fromEntries(retired.map((name) => [name, "true"]))).warnings;
  assert.equal(warnings.length, retired.length);
  for (const name of retired) assert.equal(warnings.filter((w) => w.startsWith(`${name} is set but no longer read`)).length, 1, name);
});

test("a parse error is recorded against the variable it names, never against another whose name is a prefix of it", () => {
  const envOf = (input: Record<string, string>): string[] => {
    try {
      loadSettings(input);
    } catch (error) {
      if (error instanceof SettingsError) return error.problems.map((problem) => problem.env);
    }
    return [];
  };
  assert.deepEqual(envOf({ QA_RUN_TIME_BUDGET_MS_DIFF_FOCUSED: "soon" }), ["QA_RUN_TIME_BUDGET_MS_DIFF_FOCUSED"]);
  assert.deepEqual(envOf({ QA_RUN_TIME_BUDGET_MS_DIFF: "soon" }), ["QA_RUN_TIME_BUDGET_MS_DIFF"]);
  assert.deepEqual(envOf({ QA_TELEMETRY_MAX_CAPTURE: "everything" }), ["QA_TELEMETRY_MAX_CAPTURE"]);
});

test("the former per-size diff run budgets keep working for one release: the largest set value applies, each set name is reported once, and the new name wins over them", () => {
  const former = { QA_RUN_TIME_BUDGET_MS_DIFF_TINY: "600000", QA_RUN_TIME_BUDGET_MS_DIFF_BROAD: "1200000" };
  const loaded = loadSettings(former);
  assert.equal(loaded.run.runTimeBudgets.diff, 1_200_000);
  assert.equal(loaded.warnings.length, 2);
  for (const name of Object.keys(former)) {
    const warning = loaded.warnings.filter((w) => w.startsWith(`${name} is deprecated`));
    assert.equal(warning.length, 1, name);
    assert.match(warning[0]!, /QA_RUN_TIME_BUDGET_MS_DIFF instead/);
  }
  assert.equal(loadSettings({ ...former, QA_RUN_TIME_BUDGET_MS_DIFF: "900000" }).run.runTimeBudgets.diff, 900_000);
  assert.deepEqual(loadSettings({ QA_RUN_TIME_BUDGET_MS_DIFF: "900000" }).warnings, [], "the new name warns about nothing");
  assert.throws(() => loadSettings({ QA_RUN_TIME_BUDGET_MS_DIFF_FOCUSED: "soon" }), /QA_RUN_TIME_BUDGET_MS_DIFF_FOCUSED/);
});

test("the rows of the other modes keep their names and defaults in the settings", () => {
  const { manual, context } = loadSettings({}).run.runTimeBudgets;
  assert.deepEqual({ manual, context }, { manual: 45 * 60_000, context: 60 * 60_000 });
  const loaded = loadSettings({ QA_RUN_TIME_BUDGET_MS_MANUAL: "90000", QA_RUN_TIME_BUDGET_MS_CONTEXT: "120000" }).run.runTimeBudgets;
  assert.deepEqual({ manual: loaded.manual, context: loaded.context }, { manual: 90_000, context: 120_000 });
});

test("a first-pass time cap of a diff tier is reported as retired and neither fails the load nor changes a setting, whatever the value", () => {
  const baseline = loadSettings({});
  for (const name of ["QA_DIFF_TIME_BUDGET_MS_TINY", "QA_DIFF_TIME_BUDGET_MS_FOCUSED", "QA_DIFF_TIME_BUDGET_MS_BROAD"]) {
    for (const value of ["1", "none", "soon"]) {
      const loaded = loadSettings({ [name]: value });
      assert.deepEqual(loaded.warnings.map((w) => w.split(" ")[0]), [name], `${name}=${value}`);
      assert.deepEqual(loaded.run, baseline.run, `${name}=${value}: the run settings are those of an environment without it`);
    }
  }
});

test("the retired campaign freeze variable warns whatever it holds, never fails the load and changes no setting", () => {
  const base = loadSettings({});
  for (const value of ["1", "true", "0", "maybe"]) {
    const loaded = loadSettings({ QA_CAMPAIGN_FREEZE: value });
    assert.deepEqual(loaded.warnings.map((w) => w.split(" ")[0]), ["QA_CAMPAIGN_FREEZE"], value);
    assert.deepEqual(loaded.run, base.run, value);
  }
  assert.deepEqual(base.warnings, []);
});
