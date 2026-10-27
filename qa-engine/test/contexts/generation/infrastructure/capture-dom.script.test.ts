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
  ariaCycle?: string[];
  count?: number;
  text?: string | null;
  dataRequestInFlight?: boolean;
  anchors?: string[];
  requests?: { type: string; method?: string; url: string; failed?: boolean }[];
  responses?: { type?: string; method?: string; url: string; status?: number; contentType?: string; body?: string; bodyBytes?: number; bodyError?: boolean }[];
  elements?: { testId?: string; id?: string; tag?: string }[];
}

interface CaptureRun {
  lines: Record<string, unknown>[];
  newContext: Record<string, unknown>;
  innerTextTimeouts: number[];
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
      innerTextTimeouts: events.flatMap((event) => ("innerText" in event ? [event.innerText as number] : [])),
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

/* A declared data state with a result count, waiting only briefly so the polling ends fast. */
const COUNT_STATE = { routes: { "/": { resultSelector: ".card", timeoutMs: 450 } } };
const TEXT_STATE = { routes: { "/": { resultTextSelector: ".total", timeoutMs: 450 } } };
const stateEnv = (state: unknown) => ({ PW_CAPTURE_DATA_STATE: JSON.stringify(state) });

test("a count of 0 read twice on a page whose requests and tree stood still is a confirmed empty state, read once", () => {
  const { lines } = runCapture({ env: stateEnv(COUNT_STATE), page: { count: 0, aria: '- text: "0 resultados"' } });
  assert.equal(lines[0]!.resultCount, 0);
  assert.equal(lines[0]!.emptyConfirmed, true);
  assert.equal(lines[0]!.captureAttempts, 1, "a confirmed empty state is not read again");
});

test("a count of 0 on a tree that keeps changing is not a confirmed empty state and the route is read again", () => {
  const { lines } = runCapture({ env: stateEnv(COUNT_STATE), page: { count: 0, ariaCycle: ["- text: a", "- text: b"] } });
  assert.equal(lines[0]!.resultCount, 0);
  assert.notEqual(lines[0]!.emptyConfirmed, true);
  assert.equal(lines[0]!.captureAttempts, 2);
});

test("a count of 0 while a data request is still in flight is not a confirmed empty state", () => {
  const { lines } = runCapture({ env: stateEnv(COUNT_STATE), page: { count: 0, aria: "- text: loading", dataRequestInFlight: true } });
  assert.notEqual(lines[0]!.emptyConfirmed, true);
  assert.equal(lines[0]!.captureAttempts, 2);
});

test("a result text the page does not show leaves the count unread and the state unconfirmed", () => {
  const { lines } = runCapture({ env: stateEnv(TEXT_STATE), page: { text: null, aria: "- text: x" } });
  assert.equal("resultCount" in lines[0]!, false);
  assert.notEqual(lines[0]!.emptyConfirmed, true);
  assert.equal(lines[0]!.captureAttempts, 2);
});

test("a page with results is read once and is no empty state", () => {
  const { lines } = runCapture({ env: stateEnv(COUNT_STATE), page: { count: 5, aria: "- text: cards" } });
  assert.equal(lines[0]!.resultCount, 5);
  assert.notEqual(lines[0]!.emptyConfirmed, true);
  assert.equal(lines[0]!.captureAttempts, 1);
});

test("a result text read as 0 is a confirmed empty state", () => {
  const { lines } = runCapture({ env: stateEnv(TEXT_STATE), page: { text: "0 resultados", aria: "- text: empty" } });
  assert.equal(lines[0]!.resultCount, 0);
  assert.equal(lines[0]!.emptyConfirmed, true);
});

test("no read of the result text waits less than the floor, however little of the wait is left", () => {
  const { innerTextTimeouts } = runCapture({ env: stateEnv(TEXT_STATE), page: { text: "0 resultados", aria: "- text: empty" } });
  assert.ok(innerTextTimeouts.length >= 2);
  assert.ok(innerTextTimeouts.every((ms) => ms >= CAPTURE_LIMITS.minDataStateReadMs), `timeouts ${innerTextTimeouts.join(",")}`);
});

/* What a page asks the network on opening: its code's data requests, a style sheet and an image (assets, not asked of the network by the page's code), and a request that never completes. */
const STYLE_URL = "https://maps.example/styles/v1/owner/theme-a";
const REQUEST_PAGE: StubPage = {
  requests: [
    { type: "fetch", url: `${STYLE_URL}?access=sensitive-value#frag` },
    { type: "xhr", url: `${STYLE_URL}?access=another` },
    { type: "xhr", method: "POST", url: `${BASE_URL}/api/orders` },
    { type: "stylesheet", url: `${BASE_URL}/theme.css` },
    { type: "image", url: "https://cdn.example/logo.png" },
    { type: "fetch", url: "https://blocked.example/ping", failed: true },
    { type: "fetch", url: "data:text/plain,hello" },
  ],
};

test("a route reports the data requests its page made as method, origin and path with a count, never the query or the fragment", () => {
  const requests = runCapture({ page: REQUEST_PAGE }).lines[0]!.requests as Record<string, unknown>[];
  assert.deepEqual(requests, [
    { method: "GET", url: STYLE_URL, count: 2 },
    { method: "POST", url: `${BASE_URL}/api/orders`, count: 1 },
    { method: "GET", url: "https://blocked.example/ping", count: 1, failed: true },
  ]);
  assert.equal(JSON.stringify(requests).includes("sensitive-value"), false);
});

test("a route whose page made no data request reports none", () => {
  const line = runCapture({ page: { requests: [{ type: "image", url: "https://cdn.example/a.png" }] } }).lines[0]!;
  assert.equal("requests" in line, false);
  assert.equal("requestsOmitted" in line, false);
});

test("the requests of one route are not carried into the next", () => {
  const { lines } = runCapture({ input: { routes: ["/", "/shop"] }, page: { requests: [{ type: "fetch", url: `${BASE_URL}/api/a` }] } });
  assert.deepEqual(lines.map((line) => (line.requests as unknown[]).length), [1, 1]);
  assert.deepEqual((lines[1]!.requests as { count: number }[]).map((r) => r.count), [1]);
});

test("a page that asks for more distinct requests than the limit is held to it and the rest is counted", () => {
  const requests = Array.from({ length: 5 }, (_, i) => ({ type: "fetch", url: `${BASE_URL}/api/r${i}` }));
  const line = runCapture({ page: { requests }, limits: { maxRequestsPerRoute: 3 } }).lines[0]!;
  assert.equal((line.requests as unknown[]).length, 3);
  assert.equal(line.requestsOmitted, 2);
});

test("an address longer than the limit is cut by the script before it is reported", () => {
  const long = `${BASE_URL}/${"x".repeat(60)}`;
  const requests = runCapture({ page: { requests: [{ type: "fetch", url: long }] }, limits: { maxHrefChars: 40 } }).lines[0]!.requests as { url: string }[];
  assert.ok(requests[0]!.url.length <= 40 + BASE_URL.length);
});

/* What a page's code read as JSON: the shape of each answer (its operation, how many items, the names of the keys its items carry), never a value. */
const json = (value: unknown): string => JSON.stringify(value);
const answer = (path: string, value: unknown, extra: Record<string, unknown> = {}): { url: string; body: string } & Record<string, unknown> => ({ url: `${BASE_URL}${path}`, body: json(value), ...extra });
type Shape = { method: string; url: string; items: number; keys: string[]; names: string[]; complete: boolean };
const shapesOf = (page: StubPage, limits?: Record<string, unknown>): Shape[] | undefined => runCapture({ page, ...(limits ? { limits } : {}) }).lines[0]!.shapes as Shape[] | undefined;

test("a route reports the keys and the item count of each JSON answer its page read, never a value or a query", () => {
  const items = [{ id: 1, name: "private-value-1", category: "k1" }, { id: 2, name: "private-value-2", extra: true }];
  const line = runCapture({ page: { responses: [answer("/api/items?lat=40.1&token=sensitive-value", items)] } }).lines[0]!;
  assert.deepEqual(line.shapes, [{ method: "GET", url: `${BASE_URL}/api/items`, items: 2, keys: ["category", "extra", "id", "name"], names: ["category", "extra", "id", "name"], complete: true }]);
  assert.equal(JSON.stringify(line).includes("private-value"), false);
  assert.equal(JSON.stringify(line.shapes).includes("sensitive-value"), false);
});

test("a key whose value is null is a key the items carry", () => {
  assert.deepEqual(shapesOf({ responses: [answer("/api/items", [{ id: 1, category: null }])] })?.[0]?.keys, ["category", "id"]);
});

test("the items of an answer are the root array, the array a root object holds, or the array an object one level down holds, else the root object itself", () => {
  const rows = [{ a: 1 }, { b: 2 }];
  const shaped = shapesOf({ responses: [answer("/root-array", rows), answer("/wrapped", { total: 2, data: rows }), answer("/nested", { meta: { page: 1 }, payload: { list: rows } }), answer("/single", { id: 1, name: "x" })] })!;
  assert.deepEqual(shaped.map((s) => [s.items, s.keys]), [[2, ["a", "b"]], [2, ["a", "b"]], [2, ["a", "b"]], [1, ["id", "name"]]]);
});

test("of several arrays of objects, the one with the most elements is the items", () => {
  const shaped = shapesOf({ responses: [answer("/many", { featured: [{ f: 1 }], all: [{ a: 1 }, { a: 2 }, { a: 3 }] })] })!;
  assert.deepEqual([shaped[0]!.items, shaped[0]!.keys], [3, ["a"]]);
});

test("an answer that is an empty list reports no item, and no key", () => {
  assert.deepEqual(shapesOf({ responses: [answer("/api/items", [])] }), [{ method: "GET", url: `${BASE_URL}/api/items`, items: 0, keys: [], names: [], complete: true }]);
});

test("answers to one operation with different queries are one shape: their items added up and their keys joined", () => {
  const shaped = shapesOf({ responses: [answer("/api/items?page=1", [{ id: 1 }]), answer("/api/items?page=2", [{ id: 2, extra: 1 }, { id: 3 }])] })!;
  assert.deepEqual(shaped, [{ method: "GET", url: `${BASE_URL}/api/items`, items: 3, keys: ["extra", "id"], names: ["extra", "id"], complete: true }]);
});

test("only a successful JSON answer to a GET the page's code made is read", () => {
  const shaped = shapesOf({
    responses: [
      answer("/api/post", [{ a: 1 }], { method: "POST" }),
      answer("/api/missing", [{ a: 1 }], { status: 404 }),
      answer("/api/text", [{ a: 1 }], { contentType: "text/html" }),
      answer("/api/script.js", [{ a: 1 }], { type: "script" }),
      answer("/api/ok", [{ a: 1 }], { contentType: "application/problem+json; charset=utf-8" }),
    ],
  })!;
  assert.deepEqual(shaped.map((s) => s.url), [`${BASE_URL}/api/ok`]);
});

test("a body that is not JSON, or cannot be read, reports no shape", () => {
  assert.equal(shapesOf({ responses: [{ url: `${BASE_URL}/api/bad`, body: "{not json" }, { url: `${BASE_URL}/api/gone`, bodyError: true }] }), undefined);
});

test("an answer is read from every origin the browser reached", () => {
  assert.equal(shapesOf({ responses: [{ url: "https://api.example/v1/items?x=1", body: json([{ id: 1 }]) }] })?.[0]?.url, "https://api.example/v1/items");
});

/* The names of the fields a response carries at every depth: what lets a field a consumer expects be told absent from the whole answer, not only from the top level of its items. */
const COLLECTION = { type: "Collection", total: 1, items: [{ id: 1, geometry: { type: "Point", coordinates: [1, 2] }, properties: { title: "private-value", detail: { nested: [{ deep: true }] } } }] };

test("a response reports the names of the fields it carries at every depth, envelope and items alike, never a value", () => {
  const [shape] = shapesOf({ responses: [answer("/api/collection", COLLECTION)] })!;
  assert.deepEqual(shape!.keys, ["geometry", "id", "properties"]);
  assert.deepEqual(shape!.names, ["coordinates", "deep", "detail", "geometry", "id", "items", "nested", "properties", "title", "total", "type"]);
  assert.equal(shape!.complete, true);
  assert.equal(JSON.stringify(shape).includes("private-value"), false);
});

test("a name that only a later item or a later answer to the operation carries is in the names", () => {
  const [shape] = shapesOf({ responses: [answer("/api/items?page=1", [{ id: 1 }, { id: 2, extra: { late: 1 } }]), answer("/api/items?page=2", [{ id: 3, other: { more: 1 } }])] })!;
  assert.deepEqual(shape!.names, ["extra", "id", "late", "more", "other"]);
});

test("more names than the limit keep the limit and say the names are not all of them", () => {
  const item = { id: 1, nested: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`n${i}`, i])) };
  const [shape] = shapesOf({ responses: [answer("/api/items", [item])] }, { maxShapeNames: 4 })!;
  assert.equal(shape!.names.length, 4);
  assert.equal(shape!.complete, false);
});

test("a response nested deeper than the limit is read down to it and says its names are not all of them", () => {
  const [shape] = shapesOf({ responses: [answer("/api/items", [{ a: { b: { c: { d: 1 } } } }])] }, { maxShapeDepth: 3 })!;
  assert.deepEqual(shape!.names, ["a", "b", "c"]);
  assert.equal(shape!.complete, false);
});

test("a name longer than the limit is not kept in the names and they are said to be incomplete", () => {
  const [shape] = shapesOf({ responses: [answer("/api/items", [{ id: 1, inner: { [`k${"x".repeat(80)}`]: 1 } }])] }, { maxShapeKeyChars: 20 })!;
  assert.deepEqual(shape!.names, ["id", "inner"]);
  assert.equal(shape!.complete, false);
});

test("a page that read more distinct operations than the limit is held to it and the rest is counted", () => {
  const responses = Array.from({ length: 5 }, (_, i) => answer(`/api/r${i}`, [{ id: i }]));
  const line = runCapture({ page: { responses }, limits: { maxShapesPerRoute: 3 } }).lines[0]!;
  assert.equal((line.shapes as unknown[]).length, 3);
  assert.equal(line.shapesOmitted, 2);
});

test("an answer with more keys than the limit keeps the limit and says its keys are not all of them", () => {
  const item = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`k${i}`, i]));
  const [shape] = shapesOf({ responses: [answer("/api/items", [item])] }, { maxShapeKeys: 4 })!;
  assert.equal(shape!.keys.length, 4);
  assert.equal(shape!.complete, false);
});

test("a key longer than the limit is not kept and the keys are said to be incomplete", () => {
  const [shape] = shapesOf({ responses: [answer("/api/items", [{ id: 1, [`k${"x".repeat(80)}`]: 1 }])] }, { maxShapeKeyChars: 20 })!;
  assert.deepEqual(shape!.keys, ["id"]);
  assert.equal(shape!.complete, false);
});

test("an answer with more items than the limit reads the first ones and says its keys are not all of them, with the true count", () => {
  const items = Array.from({ length: 10 }, (_, i) => (i === 9 ? { id: i, late: true } : { id: i }));
  const [shape] = shapesOf({ responses: [answer("/api/items", items)] }, { maxShapeItems: 4 })!;
  assert.equal(shape!.items, 10);
  assert.deepEqual(shape!.keys, ["id"]);
  assert.equal(shape!.complete, false);
});

test("a body over the limit is not read and is counted as left out", () => {
  const line = runCapture({ page: { responses: [{ url: `${BASE_URL}/api/big`, bodyBytes: 500 }] }, limits: { maxShapeBodyBytes: 100 } }).lines[0]!;
  assert.equal("shapes" in line, false);
  assert.equal(line.shapesOmitted, 1);
});

test("the shapes of one route are not carried into the next, and a page that read no JSON reports none", () => {
  const { lines } = runCapture({ input: { routes: ["/", "/shop"] }, page: { responses: [answer("/api/a", [{ id: 1 }])] } });
  assert.deepEqual(lines.map((l) => (l.shapes as unknown[]).length), [1, 1]);
  const quiet = runCapture({ page: { requests: [{ type: "fetch", url: `${BASE_URL}/api/a` }] } }).lines[0]!;
  assert.equal("shapes" in quiet, false);
  assert.equal("shapesOmitted" in quiet, false);
});
