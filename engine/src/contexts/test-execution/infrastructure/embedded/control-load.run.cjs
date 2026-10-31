// @ts-check
/* The control load of a counted run_spec call: the one test the control config runs. The page loads the launch URL in the context Playwright makes for the project (the same saved session and options a spec's page gets) with no spec action, until the network is idle or the load's bound is spent, and the mutating requests DEV answered while it did are written to `control-<project>.json` in QA_FAILURE_CAPTURE_DIR (method, origin + pathname, count; never a query, a body or a header). A page that never goes idle (a stream, a poll) ends the load at its bound: the control then ran and saw less, which charges more, so it keeps what it saw and ends cleanly. Any other failure of the load fails the test and leaves no file: a control that did not run exempts nothing. The orchestrator charges a spec's page requests only beyond what its project's control saw. It runs in a Playwright process of its own, started by the orchestrator before the spec child, so no code of the spec has run in the process or the browser it uses. CONTROL_MAX_REQUESTS, CONTROL_MAX_ADDRESS_CHARS and CONTROL_MAX_PROJECT_CHARS are prepended; PW_CONTROL_TIMEOUT_MS is the bound of the load, a share of the call's time. */
(() => {
  const { createHash } = require("node:crypto");
  const { renameSync, writeFileSync } = require("node:fs");
  const { createRequire } = require("node:module");
  const { join } = require("node:path");
  const { test } = createRequire(join(process.cwd(), "noop.js"))("@playwright/test");
  const MUTATING = /^(?:POST|PUT|PATCH|DELETE)$/;

  /* origin + pathname, cut where the ledger cuts it, so a request is the same key in both; empty when the address cannot be read. */
  function addressOf(/** @type {string} */ raw) {
    try {
      const url = new URL(raw);
      const address = url.origin + url.pathname;
      return address.length > CONTROL_MAX_ADDRESS_CHARS ? address.slice(0, CONTROL_MAX_ADDRESS_CHARS) : address;
    } catch {
      return "";
    }
  }

  test("control load", async (/** @type {{ page: { goto(url: string, options: { waitUntil: string, timeout: number }): Promise<unknown> }, context: { on(event: string, listener: (request: { method(): string, url(): string }) => void): void } }} */ { page, context }, /** @type {{ project: { name: string } }} */ testInfo) => {
    const dir = process.env.QA_FAILURE_CAPTURE_DIR;
    const launch = process.env.PW_BASE_URL;
    const timeout = Number(process.env.PW_CONTROL_TIMEOUT_MS);
    if (!dir || !launch || !Number.isFinite(timeout) || timeout <= 0) throw new Error("the control load needs QA_FAILURE_CAPTURE_DIR, PW_BASE_URL and PW_CONTROL_TIMEOUT_MS");
    /** @type {Array<{ method: string, url: string, count: number }>} */
    const seen = [];
    context.on("requestfinished", (request) => {
      try {
        const method = request.method();
        if (!MUTATING.test(method)) return;
        const url = addressOf(request.url());
        if (!url) return;
        const same = seen.find((entry) => entry.method === method && entry.url === url);
        if (same) same.count++;
        else if (seen.length < CONTROL_MAX_REQUESTS) seen.push({ method, url, count: 1 });
      } catch {
        /* a request that cannot be read is left out: the control may only say less, which charges more */
      }
    });
    const project = testInfo.project.name.slice(0, CONTROL_MAX_PROJECT_CHARS);
    try {
      await page.goto(launch, { waitUntil: "networkidle", timeout });
    } catch (err) {
      /* The bound of the load is not a failure of the control: it keeps what it saw. Playwright names its time-out error. */
      if (!(err instanceof Error) || err.name !== "TimeoutError") throw err;
    }
    const name = createHash("sha1").update(project).digest("hex").slice(0, 12);
    const temp = join(dir, `.control-${name}.tmp`);
    writeFileSync(temp, JSON.stringify({ v: 1, project, requests: seen }));
    renameSync(temp, join(dir, `control-${name}.json`));
  });
})();
