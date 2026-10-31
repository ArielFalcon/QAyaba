/* What of a suite may leave its directory, and how a suite is walked: real files under a temporary directory. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertRealDirectory, assertSafeRelative, exclusionReason, looksLikeSessionState, walkTree } from "../../src/shared-infrastructure/suite-tree.ts";

test("what is left out is decided by path and content: credentials and sessions by any name, specs that merely sound like them are kept", () => {
  assert.equal(exclusionReason(".env.production", false) !== undefined, true);
  assert.equal(exclusionReason("a/b/.auth", true) !== undefined, true);
  assert.equal(exclusionReason("keys/server.pem", false) !== undefined, true);
  assert.equal(exclusionReason("flows/cookie-banner.spec.ts", false), undefined);
  assert.equal(exclusionReason("flows/session.spec.ts", false), undefined);
  assert.equal(exclusionReason("environment.ts", false), undefined);
  assert.equal(exclusionReason("flows", true), undefined);
  assert.equal(looksLikeSessionState("x.json", Buffer.from('{"cookies":[],"origins":[]}')), true);
  assert.equal(looksLikeSessionState("x.json", Buffer.from('{"cookies":"no"}')), false);
  assert.equal(looksLikeSessionState("x.json", Buffer.from("not json")), false);
  assert.equal(looksLikeSessionState("x.ts", Buffer.from('{"cookies":[],"origins":[]}')), false);
});

test("a walk lists parents before children, tells a link from a file, and enters only the directories it is told to", (t) => {
  const root = mkdtempSync(join(tmpdir(), "suite-tree-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "flows"));
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "flows", "a.spec.ts"), "x");
  writeFileSync(join(root, "node_modules", "dep.js"), "x");
  symlinkSync(join(root, "flows"), join(root, "link"));
  const seen = walkTree(root, (entry) => exclusionReason(entry.rel, true) === undefined);
  assert.deepEqual(seen.map((e) => `${e.kind}:${e.rel}`), ["dir:flows", "file:flows/a.spec.ts", "link:link", "dir:node_modules"]);
});

test("a directory that is a link, or no directory, is refused as a suite; a recorded path must be plain and relative", (t) => {
  const root = mkdtempSync(join(tmpdir(), "suite-tree-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  symlinkSync(root, join(root, "self"));
  writeFileSync(join(root, "file"), "x");
  assert.throws(() => assertRealDirectory(join(root, "self"), "the suite"), /symbolic link/);
  assert.throws(() => assertRealDirectory(join(root, "file"), "the suite"), /not a directory/);
  assert.throws(() => assertRealDirectory(join(root, "missing"), "the suite"), /does not exist/);
  for (const bad of ["", "/abs", "../up", "a/../b", "a//b", "a\\b", "./x"]) assert.throws(() => assertSafeRelative(bad), /unsafe path/, bad);
  assert.doesNotThrow(() => assertSafeRelative("flows/a.spec.ts"));
});
