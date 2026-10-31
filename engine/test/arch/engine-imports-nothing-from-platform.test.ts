/* engine production code must not import src/. Parity tests under engine/test/ are the
   sanctioned exception (they import src/ by design). depcruise may miss dynamic import() and
   barrel re-exports — audit those by hand.

   The real tree is only ever scanned read-only. The synthetic-violation cases build a throwaway tree
   under os.tmpdir() that carries a copy of the real .dependency-cruiser.cjs at engine/ (so its
   `baseDir: path.resolve(__dirname, "..")` pins that tree's root exactly as it pins the repository
   root) — a probe planted in the real engine/src would be visible to every concurrently running
   test file that scans the tree. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const DEPCRUISE = join(repoRoot, "node_modules", ".bin", "depcruise");
const CONFIG_REL = join("engine", ".dependency-cruiser.cjs");

/* The --config argument is always absolute, so the same call resolves identically from any cwd; the
   target stays baseDir-relative ("engine/src"), the canonical `npm run arch:check` form. */
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

/* A minimal repo-shaped tree: the real depcruise config at engine/, a src/ module, and a
   engine/src/ production file importing it. tsconfig.json sits at both the root and engine/
   because depcruise resolves the config's tsConfig.fileName against the invoking cwd. */
function treeWithSrcImportViolation(): string {
  const treeRoot = mkdtempSync(join(tmpdir(), "engine-imports-nothing-from-platform-"));
  const tsconfig = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "ESNext", moduleResolution: "bundler", allowImportingTsExtensions: true } });
  const files: Record<string, string> = {
    "tsconfig.json": tsconfig,
    "engine/tsconfig.json": tsconfig,
    "platform/persistence/types.ts": "export type TestTarget = string;\n",
    "engine/src/leaky-module.ts": 'import type { TestTarget } from "../../platform/persistence/types.ts";\nexport type Probe = TestTarget;\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(treeRoot, rel)), { recursive: true });
    writeFileSync(join(treeRoot, rel), content);
  }
  copyFileSync(join(repoRoot, CONFIG_REL), join(treeRoot, CONFIG_REL));
  return treeRoot;
}

test("no engine production file imports src/ today", () => {
  const { ok, output } = runDepcruise(repoRoot, "engine/src", repoRoot);
  assert.equal(ok, true, `dependency-cruiser reported a src/ boundary violation:\n${output}`);
});

test("a engine production file importing src/ is caught by the boundary rule", () => {
  const treeRoot = treeWithSrcImportViolation();
  try {
    const { ok, output } = runDepcruise(treeRoot, "engine/src", treeRoot);
    assert.equal(ok, false, "depcruise must report a violation for the src/ import");
    assert.match(output, /engine-imports-nothing-from-platform:\s*engine\/src\/leaky-module\.ts/, `expected the boundary rule to name the offending module, got:\n${output}`);
  } finally {
    rmSync(treeRoot, { recursive: true, force: true });
  }
});

/* The config pins options.baseDir to the repo root; without it the rule's "^engine/src/" and
   "^src/" patterns never match the cwd-relative module ids generated from inside engine/ and the
   rule silently never fires. */
test("the boundary rule still fires when depcruise is invoked from inside engine/", () => {
  const treeRoot = treeWithSrcImportViolation();
  try {
    const { ok, output } = runDepcruise(treeRoot, "engine/src", join(treeRoot, "engine"));
    assert.equal(ok, false, "depcruise must report the violation even when invoked with cwd=engine/");
    assert.match(output, /engine-imports-nothing-from-platform/, `expected the boundary rule to fire, got:\n${output}`);
  } finally {
    rmSync(treeRoot, { recursive: true, force: true });
  }
});

/* Known pitfall, out of the gate: with baseDir pinned to the root, a bare `src` target resolves to the
   ROOT src/ tree even from cwd=engine/, so it silently scans the wrong tree and reports clean. The
   gate therefore always passes the baseDir-relative target ("engine/src"). */
test("a bare 'src' target from cwd=engine/ scans the root src/ tree and misses the violation", () => {
  const treeRoot = treeWithSrcImportViolation();
  try {
    const { ok } = runDepcruise(treeRoot, "platform", join(treeRoot, "engine"));
    assert.equal(ok, true, "a bare 'src' target from cwd=engine/ scans the root src/ tree, which has no engine/src module to flag");
  } finally {
    rmSync(treeRoot, { recursive: true, force: true });
  }
});
