/* qa-engine production code must not import src/. Parity tests under qa-engine/test/ are the
   sanctioned exception (they import src/ by design). depcruise may miss dynamic import() and
   barrel re-exports — audit those by hand.

   The real tree is only ever scanned read-only. The synthetic-violation cases build a throwaway tree
   under os.tmpdir() that carries a copy of the real .dependency-cruiser.cjs at qa-engine/ (so its
   `baseDir: path.resolve(__dirname, "..")` pins that tree's root exactly as it pins the repository
   root) — a probe planted in the real qa-engine/src would be visible to every concurrently running
   test file that scans the tree. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const DEPCRUISE = join(repoRoot, "node_modules", ".bin", "depcruise");
const CONFIG_REL = join("qa-engine", ".dependency-cruiser.cjs");

/* The --config argument is always absolute, so the same call resolves identically from any cwd; the
   target stays baseDir-relative ("qa-engine/src"), the canonical `npm run arch:check` form. */
function runDepcruise(treeRoot: string, target: string, cwd: string): { ok: boolean; output: string } {
  try {
    const output = execFileSync(DEPCRUISE, ["--config", join(treeRoot, CONFIG_REL), target], { cwd, encoding: "utf8" });
    return { ok: true, output };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: string | number };
    const combined = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    if (err.code === "ENOENT") {
      assert.fail(`dependency-cruiser not found at ${DEPCRUISE} — run \`npm install\`:\n${combined}`);
    }
    return { ok: false, output: combined };
  }
}

/* A minimal repo-shaped tree: the real depcruise config at qa-engine/, a src/ module, and a
   qa-engine/src/ production file importing it. tsconfig.json sits at both the root and qa-engine/
   because depcruise resolves the config's tsConfig.fileName against the invoking cwd. */
function treeWithSrcImportViolation(): string {
  const treeRoot = mkdtempSync(join(tmpdir(), "no-src-import-"));
  const tsconfig = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "ESNext", moduleResolution: "bundler", allowImportingTsExtensions: true } });
  const files: Record<string, string> = {
    "tsconfig.json": tsconfig,
    "qa-engine/tsconfig.json": tsconfig,
    "src/types.ts": "export type TestTarget = string;\n",
    "qa-engine/src/leaky-module.ts": 'import type { TestTarget } from "../../src/types.ts";\nexport type Probe = TestTarget;\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(treeRoot, rel)), { recursive: true });
    writeFileSync(join(treeRoot, rel), content);
  }
  copyFileSync(join(repoRoot, CONFIG_REL), join(treeRoot, CONFIG_REL));
  return treeRoot;
}

test("no qa-engine production file imports src/ today", () => {
  const { ok, output } = runDepcruise(repoRoot, "qa-engine/src", repoRoot);
  assert.equal(ok, true, `dependency-cruiser reported a src/ boundary violation:\n${output}`);
});

test("a qa-engine production file importing src/ is caught by the boundary rule", () => {
  const treeRoot = treeWithSrcImportViolation();
  try {
    const { ok, output } = runDepcruise(treeRoot, "qa-engine/src", treeRoot);
    assert.equal(ok, false, "depcruise must report a violation for the src/ import");
    assert.match(output, /no-src-import-in-qa-engine:\s*qa-engine\/src\/leaky-module\.ts/, `expected the boundary rule to name the offending module, got:\n${output}`);
  } finally {
    rmSync(treeRoot, { recursive: true, force: true });
  }
});

/* The config pins options.baseDir to the repo root; without it the rule's "^qa-engine/src/" and
   "^src/" patterns never match the cwd-relative module ids generated from inside qa-engine/ and the
   rule silently never fires. */
test("the boundary rule still fires when depcruise is invoked from inside qa-engine/", () => {
  const treeRoot = treeWithSrcImportViolation();
  try {
    const { ok, output } = runDepcruise(treeRoot, "qa-engine/src", join(treeRoot, "qa-engine"));
    assert.equal(ok, false, "depcruise must report the violation even when invoked with cwd=qa-engine/");
    assert.match(output, /no-src-import-in-qa-engine/, `expected the boundary rule to fire, got:\n${output}`);
  } finally {
    rmSync(treeRoot, { recursive: true, force: true });
  }
});

/* Known pitfall, out of the gate: with baseDir pinned to the root, a bare `src` target resolves to the
   ROOT src/ tree even from cwd=qa-engine/, so it silently scans the wrong tree and reports clean. The
   gate therefore always passes the baseDir-relative target ("qa-engine/src"). */
test("a bare 'src' target from cwd=qa-engine/ scans the root src/ tree and misses the violation", () => {
  const treeRoot = treeWithSrcImportViolation();
  try {
    const { ok } = runDepcruise(treeRoot, "src", join(treeRoot, "qa-engine"));
    assert.equal(ok, true, "a bare 'src' target from cwd=qa-engine/ scans the root src/ tree, which has no qa-engine/src module to flag");
  } finally {
    rmSync(treeRoot, { recursive: true, force: true });
  }
});
