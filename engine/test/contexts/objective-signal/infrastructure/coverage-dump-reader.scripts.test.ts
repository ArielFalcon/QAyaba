/*
 * A worker of the suite keeps each script it saw once, with its source map, in `<sha256 of the source>.script.json` beside the dumps,
 * and a test's dump names the script by that fingerprint instead of carrying it again (RFC-0015). The reader reads both forms: a dump
 * that carries its script inline, as older fixtures write it, and one that names it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readV8Coverage } from "@contexts/objective-signal/infrastructure/coverage-dump-reader.ts";
import { inThreadDecoder } from "../support/in-thread-decoder.ts";

/* "export function f() {\n" is bytes 0..21 (line 1), "  return 1;\n" is 22..33 (line 2), "}\n" is 34..35 (line 3). */
const SOURCE = "export function f() {\n  return 1;\n}\n";
const URL_ = "https://dev/src/svc.ts";
const SHA = createHash("sha256").update(SOURCE, "utf8").digest("hex");

const named = (...ranges: Array<[number, number]>): string => JSON.stringify([{ url: URL_, sha256: SHA, functions: [{ ranges: ranges.map(([startOffset, endOffset]) => ({ startOffset, endOffset, count: 1 })) }] }]);
const inline = (...ranges: Array<[number, number]>): string => JSON.stringify([{ url: URL_, source: SOURCE, functions: [{ ranges: ranges.map(([startOffset, endOffset]) => ({ startOffset, endOffset, count: 1 })) }] }]);
const kept = JSON.stringify([{ url: URL_, sha256: SHA, source: SOURCE }]);

async function withDumps<T>(files: Record<string, string>, fn: (e2eDir: string) => Promise<T>): Promise<T> {
  const e2eDir = mkdtempSync(join(tmpdir(), "engine-coverage-scripts-"));
  try {
    const dir = join(e2eDir, ".qa", "coverage", "qa-abc");
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return await fn(e2eDir);
  } finally {
    rmSync(e2eDir, { recursive: true, force: true });
  }
}

const lines = (dumps: Array<Map<string, Set<number>>>): number[][] => dumps.map((d) => [...(d.get("src/svc.ts") ?? [])].sort());

test("a dump that names its script by fingerprint is read with the source the worker kept once for it, and the script file is no dump", async () => {
  await withDumps({ [`${SHA}.script.json`]: kept, "flows-a-spec-ts-x-0-0.json": named([0, 22]), "flows-a-spec-ts-y-0-0.json": named([22, 34]) }, async (e2eDir) => {
    const ranBy = new Map<string, Set<string>>();
    const dumps = await readV8Coverage(e2eDir, "qa-abc", ["src/svc.ts"], undefined, inThreadDecoder, undefined, undefined, undefined, undefined, undefined, undefined, ranBy);

    assert.deepEqual(lines(dumps), [[1], [2]]);
    assert.deepEqual([...(ranBy.get("src/svc.ts") ?? [])], ["flows-a-spec-ts-x-0-0.json", "flows-a-spec-ts-y-0-0.json"]);
  });
});

test("an older dump that carries its script inline is read beside one that names it", async () => {
  await withDumps({ [`${SHA}.script.json`]: kept, "flows-a-spec-ts-x-0-0.json": inline([0, 22]), "flows-a-spec-ts-y-0-0.json": named([22, 34]) }, async (e2eDir) => {
    assert.deepEqual(lines(await readV8Coverage(e2eDir, "qa-abc", ["src/svc.ts"], undefined, inThreadDecoder)), [[1], [2]]);
  });
});

test("a filter by test never leaves out the scripts the dumps it keeps name", async () => {
  await withDumps({ [`${SHA}.script.json`]: kept, "flows-a-spec-ts-x-0-0.json": named([0, 22]), "flows-b-spec-ts-y-0-0.json": named([22, 34]) }, async (e2eDir) => {
    const dumps = await readV8Coverage(e2eDir, "qa-abc", ["src/svc.ts"], undefined, inThreadDecoder, undefined, undefined, undefined, (name) => name.startsWith("flows-a-"));
    assert.deepEqual(lines(dumps), [[1]]);
  });
});

test("a dump that names a script the run did not keep cannot be read, so no dump of the set is used", async () => {
  await withDumps({ "flows-a-spec-ts-x-0-0.json": named([0, 22]), "flows-a-spec-ts-y-0-0.json": inline([22, 34]) }, async (e2eDir) => {
    assert.deepEqual(await readV8Coverage(e2eDir, "qa-abc", ["src/svc.ts"], undefined, inThreadDecoder), []);
  });
});

test("a kept script whose source is not the one its name fingerprints is no script of the run, so no dump of the set is used", async () => {
  const forged = JSON.stringify([{ url: URL_, sha256: SHA, source: "export function g() {}\n" }]);
  await withDumps({ [`${SHA}.script.json`]: forged, "flows-a-spec-ts-x-0-0.json": named([0, 22]) }, async (e2eDir) => {
    assert.deepEqual(await readV8Coverage(e2eDir, "qa-abc", ["src/svc.ts"], undefined, inThreadDecoder), []);
  });
});
