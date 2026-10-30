// @ts-check
/* The Playwright config the control load of a counted run_spec call runs under, written by the orchestrator beside the call and started as a Playwright child of its own before the spec child. It is the project's own config with the one test of the control in place of the suite: every project keeps its `use` options, so the control's context is made exactly as a spec's is (saved session, DEV gate, certificate, viewport), and what selects, orders or prepares the suite (testMatch, dependencies, global setup, a web server, retries, sharding) is replaced or dropped. CONTROL_TEST (the path of the control's test file) is prepended; PW_CONTROL_TIMEOUT_MS is the call's time, which bounds the control. */
(() => {
  const { existsSync } = require("node:fs");
  const { basename, dirname, join } = require("node:path");
  const { pathToFileURL } = require("node:url");
  const timeout = Number(process.env.PW_CONTROL_TIMEOUT_MS);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("the control load needs the time of its call in PW_CONTROL_TIMEOUT_MS");
  module.exports = (async () => {
    const file = ["ts", "js", "mjs", "cjs", "mts", "cts"].map((ext) => join(process.cwd(), `playwright.config.${ext}`)).find((candidate) => existsSync(candidate));
    if (file === undefined) throw new Error("the control load found no playwright.config in the project");
    const loaded = await import(pathToFileURL(file).href);
    const base = loaded.default ?? loaded;
    const dir = dirname(CONTROL_TEST);
    const only = { testDir: dir, testMatch: basename(CONTROL_TEST), testIgnore: undefined, grep: undefined, grepInvert: undefined, retries: 0, repeatEach: 1, dependencies: undefined, teardown: undefined };
    const kept = { ...base };
    for (const key of ["globalSetup", "globalTeardown", "webServer"]) delete kept[key];
    return {
      ...kept,
      ...only,
      workers: 1,
      fullyParallel: false,
      forbidOnly: false,
      maxFailures: 0,
      shard: null,
      timeout,
      globalTimeout: timeout,
      reporter: [["null"]],
      ...(Array.isArray(base.projects) ? { projects: base.projects.map((/** @type {Record<string, unknown>} */ project) => ({ ...project, ...only })) } : {}),
    };
  })();
})();
