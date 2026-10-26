import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPTURE_LIMITS, buildCaptureScript } from "../../../../src/contexts/generation/infrastructure/dom-snapshot.ts";

/* The capture script runs as its own node process against a stand-in for the playwright package: the stand-in records what the script asks of the browser and answers from the page STUB_PAGE describes. */
const STUB_PLAYWRIGHT = fileURLToPath(new URL("./__fixtures__/stub-playwright.cjs", import.meta.url));
const BASE_URL = "https://dev.example";

interface StubPage {
  aria?: string;
  anchors?: string[];
  elements?: { testId?: string; id?: string; tag?: string }[];
}

interface CaptureRun {
  lines: Record<string, unknown>[];
  newContext: Record<string, unknown>;
}

function runCapture(opts: { input?: Record<string, unknown>; env?: Record<string, string>; page?: StubPage; limits?: Record<string, unknown> }): CaptureRun {
  const work = mkdtempSync(join(tmpdir(), "capture-dom-script-"));
  try {
    const script = join(work, "capture.cjs");
    writeFileSync(script, buildCaptureScript(STUB_PLAYWRIGHT));
    const record = join(work, "record.jsonl");
    const input = { baseUrl: BASE_URL, routes: ["/"], ...opts.input, limits: { ...CAPTURE_LIMITS, ...opts.limits } };
    const result = spawnSync("node", [script], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", PW_CAPTURE_INPUT: JSON.stringify(input), STUB_PAGE: JSON.stringify(opts.page ?? {}), STUB_RECORD: record, ...opts.env },
    });
    assert.equal(result.status, 0, result.stderr);
    const events = readFileSync(record, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const created = events.find((event) => "newContext" in event);
    return {
      lines: result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>),
      newContext: (created?.newContext ?? {}) as Record<string, unknown>,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

test("the gate's credentials reach the browser context scoped to the base URL's origin", () => {
  const { newContext } = runCapture({ env: { DEV_ENV_USER: "gate-user", DEV_ENV_PASS: "gate-pass" }, input: { baseUrl: "https://dev.example/app/home" } });
  assert.deepEqual(newContext.httpCredentials, { username: "gate-user", password: "gate-pass", origin: "https://dev.example" });
});

test("a gate with a user and no password sends an empty password", () => {
  const { newContext } = runCapture({ env: { DEV_ENV_USER: "gate-user" } });
  assert.deepEqual(newContext.httpCredentials, { username: "gate-user", password: "", origin: BASE_URL });
});

test("without a gate user the context carries no credentials", () => {
  const { newContext } = runCapture({ env: { DEV_ENV_PASS: "orphan" } });
  assert.equal("httpCredentials" in newContext, false);
});

test("the app's browser position reaches the context as a geolocation with its permission", () => {
  const { newContext } = runCapture({ env: { PW_GEO_LAT: "40.4818", PW_GEO_LNG: "-3.3643" } });
  assert.deepEqual(newContext.geolocation, { latitude: 40.4818, longitude: -3.3643 });
  assert.deepEqual(newContext.permissions, ["geolocation"]);
});

test("without a position the context carries no geolocation", () => {
  assert.equal("geolocation" in runCapture({}).newContext, false);
});

test("the saved session and the client certificate reach the context", () => {
  const { newContext } = runCapture({ env: { PW_STORAGE_STATE: "/run/session.json", PW_CLIENT_CERT_PATH: "/run/client.p12", DEV_CLIENT_CERT_PASS: "pass" } });
  assert.equal(newContext.storageState, "/run/session.json");
  assert.deepEqual(newContext.clientCertificates, [{ origin: BASE_URL, pfxPath: "/run/client.p12", passphrase: "pass" }]);
});

test("the links reported are the site's own, each once, and no more than the limit", () => {
  const anchors = ["https://dev.example/a", "https://other.example/x", "https://dev.example/a", "https://dev.example/b", "https://dev.example/c"];
  assert.deepEqual(runCapture({ page: { anchors } }).lines[0]!.hrefs, ["https://dev.example/a", "https://dev.example/b", "https://dev.example/c"]);
  assert.deepEqual(runCapture({ page: { anchors }, limits: { maxLinksPerPage: 2 } }).lines[0]!.hrefs, ["https://dev.example/a", "https://dev.example/b"]);
});

test("a link longer than the limit is not reported", () => {
  const long = `https://dev.example/${"x".repeat(40)}`;
  assert.deepEqual(runCapture({ page: { anchors: [long, "https://dev.example/ok"] }, limits: { maxHrefChars: 30 } }).lines[0]!.hrefs, ["https://dev.example/ok"]);
});

test("a name the page shows twice is reported with the containers that tell the occurrences apart, within the limits", () => {
  const page: StubPage = { aria: '- button "Save"\n- button "Save"', elements: [{ testId: "card", tag: "section" }, { id: "panel", tag: "aside" }] };
  const { lines } = runCapture({ page });
  const repeated = lines[0]!.repeated as { group: string; of: number; scope: string[] }[];
  assert.ok(repeated.length > 0);
  assert.ok(repeated.every((entry) => entry.group === "button|save" && entry.of === 2));
  assert.ok(repeated.some((entry) => entry.scope.includes("#panel")));
  assert.equal((runCapture({ page, limits: { maxRepeatedPerRoute: 1 } }).lines[0]!.repeated as unknown[]).length, 1);
});

test("a container of the change that the page shows none of is reported absent, and a shown one is not", () => {
  const page: StubPage = { elements: [{ testId: "card", tag: "section" }, { tag: "my-widget" }] };
  const { lines } = runCapture({ page, input: { probe: ['[data-testid="card"]', "my-widget", "#gone", 7] } });
  assert.deepEqual(lines[0]!.absent, ["#gone"]);
});

test("a route is read once and answered with one JSON line carrying its address", () => {
  const { lines } = runCapture({ input: { routes: ["/", "/shop"] } });
  assert.deepEqual(lines.map((line) => line.finalUrl), [`${BASE_URL}/`, `${BASE_URL}/shop`]);
});
