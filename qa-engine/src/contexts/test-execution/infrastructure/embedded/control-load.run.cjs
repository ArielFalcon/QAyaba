// @ts-check
/* The control load of a counted run_spec call: the one test the control config runs. The page loads the launch URL in the context Playwright makes for the project (the same saved session and options a spec's page gets) with no spec action, until the network is idle, and the mutating requests DEV answered while it did are written to `control-<project>.json` in QA_FAILURE_CAPTURE_DIR (method, origin + pathname, count; never a query, a body or a header). The orchestrator charges a spec's page requests only beyond what its project's control saw. It runs in a Playwright process of its own, started by the orchestrator before the spec child, so no code of the spec has run in the process or the browser it uses. CONTROL_MAX_REQUESTS is prepended; PW_CONTROL_TIMEOUT_MS is the call's time, which bounds the load. */
(() => {
  const { createHash } = require("node:crypto");
  const { renameSync, writeFileSync } = require("node:fs");
  const { createRequire } = require("node:module");
  const { join } = require("node:path");
  const { test } = createRequire(join(process.cwd(), "noop.js"))("@playwright/test");
  const MUTATING = /^(?:POST|PUT|PATCH|DELETE)$/;
  const MAX_ADDRESS_CHARS = 300;
  const MAX_PROJECT_CHARS = 200;

  /* origin + pathname, cut where the ledger cuts it, so a request is the same key in both; empty when the address cannot be read. */
  function addressOf(/** @type {string} */ raw) {
    try {
      const url = new URL(raw);
      const address = url.origin + url.pathname;
      return address.length > MAX_ADDRESS_CHARS ? address.slice(0, MAX_ADDRESS_CHARS) : address;
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
    const project = testInfo.project.name.slice(0, MAX_PROJECT_CHARS);
    try {
      await page.goto(launch, { waitUntil: "networkidle", timeout });
    } finally {
      /* A load that failed or never went idle still leaves the writes it saw: the control may say less than the page does, never more. */
      const name = createHash("sha1").update(project).digest("hex").slice(0, 12);
      const temp = join(dir, `.control-${name}.tmp`);
      writeFileSync(temp, JSON.stringify({ v: 1, project, requests: seen }));
      renameSync(temp, join(dir, `control-${name}.json`));
    }
  });
})();
