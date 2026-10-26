import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_FAULT_COUNTER_KEY_CHARS, MAX_FAULT_COUNTER_OPERATIONS, MAX_FAULT_COUNTER_TEST_CHARS, sanitizeFaultCounter, sanitizeV8Dump } from "@contexts/objective-signal/domain/dump-sanitizers.ts";

const bytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));
const parse = (buffer: Buffer): unknown => JSON.parse(buffer.toString("utf8"));

test("a V8 coverage dump keeps what the reader reads and nothing else", () => {
  const dump = [{
    url: "https://dev.example/app.js",
    scriptId: "12",
    source: "function a() {}\n",
    functions: [{ functionName: "a", isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 14, count: 1 }] }],
    map: { version: 3, sources: ["src/a.ts"], sourceRoot: "", mappings: "AAAA", sourcesContent: ["a very large original"], names: ["x"], file: "app.js", exfiltrated: "SECRET" },
    extra: "SECRET",
  }];
  const out = parse(sanitizeV8Dump(bytes(dump))) as Array<Record<string, unknown>>;
  assert.deepEqual(out, [{
    url: "https://dev.example/app.js",
    source: "function a() {}\n",
    functions: [{ ranges: [{ startOffset: 0, endOffset: 14, count: 1 }] }],
    map: { version: 3, sources: ["src/a.ts"], sourceRoot: "", mappings: "AAAA" },
  }]);
});

test("an entry without a map or functions is kept as it is", () => {
  assert.deepEqual(parse(sanitizeV8Dump(bytes([{ url: "u", source: "s" }]))), [{ url: "u", source: "s" }]);
  assert.deepEqual(parse(sanitizeV8Dump(bytes([]))), []);
});

test("a V8 dump that is not a list of entries of the expected shape is refused", () => {
  for (const bad of [
    { not: "a list" },
    "text",
    [1],
    [null],
    [{ url: 5 }],
    [{ source: {} }],
    [{ functions: "x" }],
    [{ functions: [{ ranges: [{ startOffset: "0", endOffset: 1, count: 1 }] }] }],
    [{ functions: [{ ranges: [{ startOffset: 0.5, endOffset: 1, count: 1 }] }] }],
    [{ functions: [{ ranges: [{ startOffset: 0, endOffset: 1, count: Number.MAX_SAFE_INTEGER + 2 }] }] }],
    [{ map: { sources: "x", mappings: "" } }],
    [{ map: { sources: [1], mappings: "" } }],
    [{ map: { sources: [], mappings: 5 } }],
    [{ map: "x" }],
  ]) {
    assert.throws(() => sanitizeV8Dump(bytes(bad)), RangeError, JSON.stringify(bad).slice(0, 60));
  }
  assert.throws(() => sanitizeV8Dump(Buffer.from("{not json")), RangeError);
});

test("a fault-injection counter is a count and nothing but a count", () => {
  assert.deepEqual(parse(sanitizeFaultCounter(bytes({ corrupted: 7, secret: "x" }))), { corrupted: 7 });
  assert.deepEqual(parse(sanitizeFaultCounter(bytes({ corrupted: 0 }))), { corrupted: 0 });
});

test("a counter keeps its per-operation counts and its test, rebuilt and bounded, and drops every other key", () => {
  const rebuilt = parse(sanitizeFaultCounter(bytes({ corrupted: 3, byOperation: { "GET ^/a$": 2, "POST ^/b$": 1 }, test: "flows/a.spec.ts::lists", secret: "x" })));
  assert.deepEqual(rebuilt, { corrupted: 3, byOperation: { "GET ^/a$": 2, "POST ^/b$": 1 }, test: "flows/a.spec.ts::lists" });
  assert.equal(String((parse(sanitizeFaultCounter(bytes({ corrupted: 1, test: "t".repeat(MAX_FAULT_COUNTER_TEST_CHARS + 50) }))) as { test: string }).test).length, MAX_FAULT_COUNTER_TEST_CHARS);
});

test("a counter with an oversized operation key, too many operations or a count that is not an integer is refused whole", () => {
  const tooMany = Object.fromEntries(Array.from({ length: MAX_FAULT_COUNTER_OPERATIONS + 1 }, (_, i) => [`GET ^/${i}$`, 1]));
  for (const bad of [
    { corrupted: 1, byOperation: { ["G".repeat(MAX_FAULT_COUNTER_KEY_CHARS + 1)]: 1 } },
    { corrupted: 1, byOperation: tooMany },
    { corrupted: 1, byOperation: { "GET ^/a$": 1.5 } },
    { corrupted: 1, byOperation: { "GET ^/a$": -1 } },
    { corrupted: 1, byOperation: { "GET ^/a$": "2" } },
    { corrupted: 1, byOperation: [] },
    { corrupted: 1, test: 7 },
  ]) {
    assert.throws(() => sanitizeFaultCounter(bytes(bad)), RangeError, JSON.stringify(bad).slice(0, 80));
  }
});

test("a counter that is not a small non-negative integer is refused", () => {
  for (const bad of [{ corrupted: -1 }, { corrupted: 1.5 }, { corrupted: "3" }, { corrupted: 1e12 }, {}, [], "x", null]) {
    assert.throws(() => sanitizeFaultCounter(bytes(bad)), RangeError, JSON.stringify(bad));
  }
  assert.throws(() => sanitizeFaultCounter(Buffer.from("nope")), RangeError);
});
