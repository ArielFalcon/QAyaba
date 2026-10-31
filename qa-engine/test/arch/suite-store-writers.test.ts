/* The suite store has one writer, the adapter, and the modules that locate its directory are a frozen list. A module reaches the directory
   by naming the helper that derives it (appSuiteStoreDir, under any import name: the identifier is in the import, the destructuring or the
   re-export), or by building the path itself (a join or resolve with a "suites" segment, or the text data/suites). A new module that does
   either fails here; an entry that no longer does is stale and fails too, so the list only shrinks.
   The real tree is only read; the synthetic violations are built under os.tmpdir(). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const SCANNED_ROOTS = ["src", "qa-engine/src", "scripts", "agents", "bin", "packages"];
const SOURCE_FILE = /\.(?:[cm]?ts|[cm]?js)$/;
const TEST_FILE = /\.test\.(?:[cm]?ts|[cm]?js)$/;
const STORE_DIR_HELPER = "appSuiteStoreDir";
const STORE_DIR_TEXT = /data[\\/]+suites\b/;
const SUITES_SEGMENT = /(["'`])suites\1/;

const STORE_DIR_CALLERS: readonly string[] = [
  "scripts/warm-suite.ts",
  "src/composition/login-bootstrap-wiring.ts",
  "src/composition/run-engine-factory.ts",
  "src/composition/wire-app.ts",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name) ? [path] : [];
  });
}

/* The argument text of every join( or resolve( call, parentheses balanced, so a nested call such as join(qayabaDataDir(), "suites", app) is read whole. */
function pathCallArguments(text: string): string[] {
  const out: string[] = [];
  for (const call of text.matchAll(/\b(?:join|resolve)\s*\(/g)) {
    let depth = 1;
    let end = call.index + call[0].length;
    for (; end < text.length && depth > 0; end++) {
      if (text[end] === "(") depth++;
      else if (text[end] === ")") depth--;
    }
    out.push(text.slice(call.index + call[0].length, end));
  }
  return out;
}

function reachesStoreDir(text: string): boolean {
  return new RegExp(`\\b${STORE_DIR_HELPER}\\b`).test(text) || STORE_DIR_TEXT.test(text) || pathCallArguments(text).some((args) => SUITES_SEGMENT.test(args));
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
    .filter((file) => reachesStoreDir(readFileSync(file, "utf8")))
    .map((file) => relative(treeRoot, file).split("\\").join("/"))
    .sort();
}

test("only the frozen list of modules derives the suite store's directory", () => {
  assert.deepEqual(storeDirCallers(repoRoot), [...STORE_DIR_CALLERS]);
});

function plant(files: ReadonlyArray<readonly [string, string]>): string[] {
  const tree = mkdtempSync(join(tmpdir(), "suite-store-writers-"));
  try {
    for (const [rel, text] of files) {
      mkdirSync(dirname(join(tree, rel)), { recursive: true });
      writeFileSync(join(tree, rel), text);
    }
    return storeDirCallers(tree);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

test("a module outside the list that derives the store's directory is caught", () => {
  assert.deepEqual(plant([["src/server/new-writer.ts", `export const dir = ${STORE_DIR_HELPER}("/root", "app");\n`], ["src/server/unrelated.ts", "export const x = 1;\n"]]), ["src/server/new-writer.ts"]);
});

test("the helper is caught under any name it is imported by", () => {
  for (const text of [
    `import { ${STORE_DIR_HELPER} as storeDirOf } from "./run-engine-factory";\nexport const dir = storeDirOf("/root", "app");\n`,
    `import * as factory from "./run-engine-factory";\nexport const dir = factory.${STORE_DIR_HELPER}("/root", "app");\n`,
    `const { ${STORE_DIR_HELPER}: dirOf } = await import("./run-engine-factory");\nexport const dir = dirOf("/root", "app");\n`,
    `export { ${STORE_DIR_HELPER} as suiteDirectory } from "./run-engine-factory";\n`,
  ]) {
    assert.deepEqual(plant([["src/server/aliased.ts", text]]), ["src/server/aliased.ts"], text);
  }
});

test("the store's path segment is caught wherever it is joined, and an unrelated \"suites\" is not", () => {
  for (const text of [
    `import { join } from "node:path";\nexport const dir = join(root, "data", "suites", app);\n`,
    `import path from "node:path";\nexport const dir = path.join(qayabaDataDir(), 'suites', app.name);\n`,
    `import { resolve } from "node:path";\nexport const dir = resolve(\`\${root}/data/suites/\${app}\`);\n`,
    `export const dir = \`\${root}/data/suites/\${app}\`;\n`,
  ]) {
    assert.deepEqual(plant([["scripts/new-reader.ts", text]]), ["scripts/new-reader.ts"], text);
  }
  assert.deepEqual(plant([["src/report.ts", `export const isReport = (r: object) => "suites" in r || "stats" in r;\n`]]), []);
});
