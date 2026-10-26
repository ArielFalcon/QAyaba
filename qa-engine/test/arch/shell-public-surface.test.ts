/* The shell (src/, scripts/) reaches a context only through its application/index.ts, and only src/server/engine-root.ts imports a
   composition builder. The rule cases build a throwaway tree under os.tmpdir() that carries a copy of the real config, so a probe is never
   planted in the real tree. The exception list is frozen: every entry still imports an infrastructure file and the list never grows. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const DEPCRUISE = join(repoRoot, "node_modules", ".bin", "depcruise");
const CONFIG_REL = join("qa-engine", ".dependency-cruiser.cjs");
const EXCEPTIONS_REL = join("qa-engine", ".dependency-cruiser-shell-exceptions.json");

/** Entries the frozen list holds today; a shrinking commit lowers it, raising it is a visible review event. */
export const SHELL_INFRASTRUCTURE_EXCEPTIONS_CEILING = 57;

function treeWith(files: Record<string, string>, exceptions: string[] = []): string {
  const treeRoot = mkdtempSync(join(tmpdir(), "shell-surface-"));
  const tsconfig = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "ESNext", moduleResolution: "bundler", allowImportingTsExtensions: true } });
  /* Every directory the real command names exists, empty or not. */
  const all: Record<string, string> = { "tsconfig.json": tsconfig, "qa-engine/tsconfig.json": tsconfig, "src/empty.ts": "export {};\n", "scripts/empty.ts": "export {};\n", ...files };
  for (const [rel, content] of Object.entries(all)) {
    mkdirSync(dirname(join(treeRoot, rel)), { recursive: true });
    writeFileSync(join(treeRoot, rel), content);
  }
  copyFileSync(join(repoRoot, CONFIG_REL), join(treeRoot, CONFIG_REL));
  writeFileSync(join(treeRoot, EXCEPTIONS_REL), JSON.stringify(exceptions));
  return treeRoot;
}

function cruise(treeRoot: string): { ok: boolean; output: string } {
  try {
    return { ok: true, output: execFileSync(DEPCRUISE, ["--config", join(treeRoot, CONFIG_REL), "qa-engine/src", "src", "scripts"], { cwd: treeRoot, encoding: "utf8" }) };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

const A = "qa-engine/src/contexts/a";
const context = {
  [`${A}/domain/d.ts`]: "export const d = 1;\n",
  [`${A}/infrastructure/x.ts`]: "export const x = 1;\n",
  [`${A}/composition/build-a.ts`]: "export const buildA = () => 1;\n",
  [`${A}/application/index.ts`]: 'export { d } from "../domain/d.ts";\n',
};

test("a shell module importing a context's domain file fails the shell rule", () => {
  const r = cruise(treeWith({ ...context, "src/server/x.ts": 'import { d } from "../../qa-engine/src/contexts/a/domain/d.ts";\nexport const y = d;\n' }));
  assert.equal(r.ok, false);
  assert.match(r.output, /shell-public-surface/);
});

test("a script importing a context's infrastructure file fails the shell rule", () => {
  const r = cruise(treeWith({ ...context, "scripts/x.ts": 'import { x } from "../qa-engine/src/contexts/a/infrastructure/x.ts";\nexport const y = x;\n' }));
  assert.equal(r.ok, false);
  assert.match(r.output, /shell-public-surface/);
});

test("a shell module importing a context's application/index.ts passes", () => {
  const r = cruise(treeWith({ ...context, "src/server/x.ts": 'import { d } from "../../qa-engine/src/contexts/a/application/index.ts";\nexport const y = d;\n' }));
  assert.equal(r.ok, true, r.output);
});

test("a shell module on the frozen exception list may import an infrastructure file, another may not", () => {
  const files = { ...context, "src/server/listed.ts": 'import { x } from "../../qa-engine/src/contexts/a/infrastructure/x.ts";\nexport const y = x;\n' };
  assert.equal(cruise(treeWith(files, ["src/server/listed.ts"])).ok, true);
  const r = cruise(treeWith(files, []));
  assert.equal(r.ok, false);
  assert.match(r.output, /shell-public-surface/);
});

test("only the engine root imports a composition builder", () => {
  const build = 'import { buildA } from "../../qa-engine/src/contexts/a/composition/build-a.ts";\nexport const y = buildA();\n';
  assert.equal(cruise(treeWith({ ...context, "src/server/engine-root.ts": build })).ok, true);
  const r = cruise(treeWith({ ...context, "src/server/other.ts": build }));
  assert.equal(r.ok, false);
  assert.match(r.output, /composition-only-from-shell-root/);
});

test("the frozen exception list only shrinks and every entry still imports an infrastructure file", () => {
  const entries = JSON.parse(readFileSync(join(repoRoot, EXCEPTIONS_REL), "utf8")) as string[];
  assert.ok(entries.length <= SHELL_INFRASTRUCTURE_EXCEPTIONS_CEILING, `${entries.length} entries, ceiling ${SHELL_INFRASTRUCTURE_EXCEPTIONS_CEILING}`);
  assert.deepEqual(entries, [...entries].sort());
  const INFRASTRUCTURE_IMPORT = /["'][^"']*contexts\/[^/"']+\/(infrastructure|bridges|adapters)\//;
  for (const entry of entries) {
    assert.ok(existsSync(join(repoRoot, entry)), `${entry} no longer exists: delete its entry`);
    assert.match(readFileSync(join(repoRoot, entry), "utf8"), INFRASTRUCTURE_IMPORT, `${entry} imports no infrastructure file: delete its entry`);
  }
});
