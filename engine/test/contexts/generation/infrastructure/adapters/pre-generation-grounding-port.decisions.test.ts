/* Grounding lists the decisions on the change's own changed lines, read from the working copy through the strict reader: app test files are not the change's code, a file that does not parse is named, a link is never followed, and a cross-repo run (whose diff is not of this working copy) lists nothing. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreGenerationGroundingPortAdapter } from "@contexts/generation/infrastructure/adapters/pre-generation-grounding-port.adapter.ts";

function fileDiff(path: string, start: number, added: string[]): string {
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -${start},0 +${start},${added.length} @@`, ...added.map((line) => `+${line}`), ""].join("\n");
}

async function withMirror(run: (mirror: string, outside: string) => Promise<void>): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "qa-decisions-"));
  const mirror = join(tmp, "app");
  mkdirSync(join(mirror, "e2e"), { recursive: true });
  mkdirSync(join(mirror, "src"), { recursive: true });
  mkdirSync(join(tmp, "outside"));
  try {
    await run(mirror, join(tmp, "outside"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const adapterFor = (mirror: string, extra: { stagedRoots?: string[] } = {}) =>
  new PreGenerationGroundingPortAdapter({ e2eDir: join(mirror, "e2e"), mirrorDir: mirror, contextPack: false, ...extra }, { loadContextMap: () => undefined });

test("the decisions on the changed lines of the working copy's own code are listed with their arms", async () => {
  await withMirror(async (mirror) => {
    writeFileSync(join(mirror, "src/cart.ts"), ["export function label(n: number) {", "  if (n > 0) return `${n}`;", "  return 'empty';", "}"].join("\n"));
    writeFileSync(join(mirror, "src/cart.test.ts"), ["if (x) y();"].join("\n"));
    const diff = fileDiff("src/cart.ts", 2, ["  if (n > 0) return `${n}`;"]) + fileDiff("src/cart.test.ts", 1, ["if (x) y();"]);
    const result = await adapterFor(mirror).ground(join(mirror, "e2e"), undefined, diff);
    assert.deepEqual(result.changedDecisions, {
      decisions: [{ file: "src/cart.ts", line: 2, kind: "if", arms: [{ label: "then", line: 2 }, { label: "else" }] }],
      unparsed: [],
    });
  });
});

test("a changed file that does not parse lists nothing and is named", async () => {
  await withMirror(async (mirror) => {
    writeFileSync(join(mirror, "src/broken.ts"), "if (a { b();");
    const result = await adapterFor(mirror).ground(join(mirror, "e2e"), undefined, fileDiff("src/broken.ts", 1, ["if (a { b();"]));
    assert.deepEqual(result.changedDecisions, { decisions: [], unparsed: ["src/broken.ts"] });
  });
});

test("a changed path that is a link out of the working copy is never read", async () => {
  await withMirror(async (mirror, outside) => {
    writeFileSync(join(outside, "secret.ts"), "if (a) b();");
    symlinkSync(join(outside, "secret.ts"), join(mirror, "src/linked.ts"));
    const result = await adapterFor(mirror).ground(join(mirror, "e2e"), undefined, fileDiff("src/linked.ts", 1, ["if (a) b();"]));
    assert.deepEqual(result.changedDecisions, { decisions: [], unparsed: [] });
  });
});

test("a cross-repo run lists no decision: its diff is not of this working copy", async () => {
  await withMirror(async (mirror) => {
    writeFileSync(join(mirror, "src/cart.ts"), "if (a) b();");
    const result = await adapterFor(mirror, { stagedRoots: [] }).ground(join(mirror, "e2e"), undefined, fileDiff("src/cart.ts", 1, ["if (a) b();"]));
    assert.equal(result.changedDecisions, undefined);
  });
});
