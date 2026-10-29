/* The suite store has one writer, the adapter, and the modules that locate its directory are a frozen list. A new module that derives the
   store's directory with appSuiteStoreDir( fails here; an entry that no longer does is stale and fails too, so the list only shrinks.
   The real tree is only read; the synthetic violation is built under os.tmpdir(). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const SCANNED_ROOTS = ["src", "qa-engine/src", "scripts"];
const STORE_DIR_CALL = "appSuiteStoreDir(";

const STORE_DIR_CALLERS: readonly string[] = [
  "scripts/warm-suite.ts",
  "src/server/login-bootstrap-wiring.ts",
  "src/server/run-engine-factory.ts",
  "src/server/wire-app.ts",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

function storeDirCallers(treeRoot: string): string[] {
  return SCANNED_ROOTS.flatMap((root) => {
    try {
      return sourceFiles(join(treeRoot, root));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  })
    .filter((file) => readFileSync(file, "utf8").includes(STORE_DIR_CALL))
    .map((file) => relative(treeRoot, file).split("\\").join("/"))
    .sort();
}

test("only the frozen list of modules derives the suite store's directory", () => {
  assert.deepEqual(storeDirCallers(repoRoot), [...STORE_DIR_CALLERS]);
});

test("a module outside the list that derives the store's directory is caught", () => {
  const tree = mkdtempSync(join(tmpdir(), "suite-store-writers-"));
  try {
    for (const [rel, text] of [["src/server/new-writer.ts", `export const dir = ${STORE_DIR_CALL}"/root", "app");\n`], ["src/server/unrelated.ts", "export const x = 1;\n"]] as const) {
      mkdirSync(dirname(join(tree, rel)), { recursive: true });
      writeFileSync(join(tree, rel), text);
    }
    assert.deepEqual(storeDirCallers(tree), ["src/server/new-writer.ts"]);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});
