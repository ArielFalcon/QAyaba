import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configExists, writeConfig } from "./onboard";

test("writeConfig creates the app config under the root and configExists detects it", () => {
  const root = mkdtempSync(join(tmpdir(), "onboard-"));
  const yaml = 'name: "tmp-test"\nrepo: "x/y"\n';
  try {
    const path = writeConfig("tmp-test", yaml, root);
    assert.equal(readFileSync(path, "utf8"), yaml);
    assert.ok(configExists("tmp-test", root));
    assert.equal(configExists("never-written", root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
