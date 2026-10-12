// Runs INSIDE the execution sandbox (the sandbox uid, through the real runner). Every test PASSES when the isolation holds:
// a read that succeeds is the failure. See docs/execution-sandbox.md and `npm run sandbox:smoke`.
import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";

function codeOf(action: () => unknown): string {
  try {
    action();
    return "succeeded";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? "failed";
  }
}

test("the orchestrator's process environment is unreadable (/proc/1/environ)", () => {
  expect(codeOf(() => readFileSync("/proc/1/environ"))).toMatch(/^(EACCES|EPERM)$/);
});

test("the data directory (run history, auth material) cannot be listed", () => {
  expect(codeOf(() => readdirSync("/app/data"))).toMatch(/^(EACCES|EPERM)$/);
});

test("the auth directory of an app cannot be read", () => {
  expect(codeOf(() => readdirSync("/app/data/auth"))).toMatch(/^(EACCES|EPERM)$/);
});

test("the API token is unreadable, where the service keeps it and where an earlier version did", () => {
  expect(codeOf(() => readFileSync("/app/data/.api_token"))).toMatch(/^(EACCES|EPERM)$/);
  expect(codeOf(() => readFileSync("/app/config/.api_token"))).toMatch(/^(EACCES|EPERM|ENOENT)$/);
});

test("the code graph of the indexed repos cannot be listed", () => {
  expect(codeOf(() => readdirSync("/app/.codebase-memory"))).toMatch(/^(EACCES|EPERM)$/);
});

test("the config directory (app configs) cannot be listed", () => {
  expect(codeOf(() => readdirSync("/app/config"))).toMatch(/^(EACCES|EPERM)$/);
  expect(codeOf(() => readdirSync("/app/config/apps"))).toMatch(/^(EACCES|EPERM)$/);
});

test("none of the orchestrator's secrets or its test account is in this process's environment", () => {
  for (const name of ["DEV_TEST_USER", "DEV_TEST_PASS", "GITHUB_TOKEN", "QA_API_TOKEN", "OPENCODE_API_KEY", "OPENCODE_SERVER_PASSWORD", "WEBHOOK_SECRET", "CODEX_API_KEY", "DOPPLER_TOKEN"]) {
    expect(process.env[name], name).toBeUndefined();
  }
});
