/* A context is reached only through its application/index.ts, and that file declares nothing.
   The rule cases build a throwaway tree under os.tmpdir() that carries a copy of the real
   .dependency-cruiser.cjs, so a probe is never planted in the real qa-engine/src. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const DEPCRUISE = join(repoRoot, "node_modules", ".bin", "depcruise");
const CONFIG_REL = join("qa-engine", ".dependency-cruiser.cjs");
const CONTEXTS = join(repoRoot, "qa-engine", "src", "contexts");

function treeWith(files: Record<string, string>): string {
  const treeRoot = mkdtempSync(join(tmpdir(), "context-surface-"));
  const tsconfig = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "ESNext", moduleResolution: "bundler", allowImportingTsExtensions: true } });
  const all: Record<string, string> = { "tsconfig.json": tsconfig, "qa-engine/tsconfig.json": tsconfig, ...files };
  for (const [rel, content] of Object.entries(all)) {
    mkdirSync(dirname(join(treeRoot, rel)), { recursive: true });
    writeFileSync(join(treeRoot, rel), content);
  }
  copyFileSync(join(repoRoot, CONFIG_REL), join(treeRoot, CONFIG_REL));
  return treeRoot;
}

function cruise(treeRoot: string): { ok: boolean; output: string } {
  try {
    return { ok: true, output: execFileSync(DEPCRUISE, ["--config", join(treeRoot, CONFIG_REL), "qa-engine/src"], { cwd: treeRoot, encoding: "utf8" }) };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

const A = "qa-engine/src/contexts/a";
const B = "qa-engine/src/contexts/b";
const surface = { [`${A}/application/index.ts`]: 'export { x } from "../infrastructure/x.ts";\n', [`${A}/infrastructure/x.ts`]: "export const x = 1;\n" };

test("a context importing another context's infrastructure file fails the cross-context rule", () => {
  const tree = treeWith({ ...surface, [`${B}/application/y.ts`]: 'import { x } from "../../a/infrastructure/x.ts";\nexport const y = x;\n' });
  const r = cruise(tree);
  assert.equal(r.ok, false);
  assert.match(r.output, /cross-context-internals/);
});

test("a context importing another context's application/index.ts passes", () => {
  const tree = treeWith({ ...surface, [`${B}/application/y.ts`]: 'import { x } from "../../a/application/index.ts";\nexport const y = x;\n' });
  const r = cruise(tree);
  assert.doesNotMatch(r.output, /cross-context-internals/);
});

test("a context's infrastructure importing its own domain passes", () => {
  const tree = treeWith({ [`${A}/domain/d.ts`]: "export const d = 1;\n", [`${A}/infrastructure/x.ts`]: 'import { d } from "../domain/d.ts";\nexport const x = d;\n' });
  const r = cruise(tree);
  assert.doesNotMatch(r.output, /cross-context-internals/);
});

test("every application/index.ts holds only comments and export-from statements", () => {
  const indexes = readdirSync(CONTEXTS).map((c) => join(CONTEXTS, c, "application", "index.ts")).filter((p) => existsSync(p));
  assert.ok(indexes.length > 0);
  for (const file of indexes) {
    const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const statements = code.split(";").map((s) => s.trim()).filter(Boolean);
    for (const s of statements) assert.match(s, /^export\s+(type\s+)?(\{[^}]*\}|\*(\s+as\s+\w+)?)\s+from\s+"[^"]+"$/s, `${file}: ${s.slice(0, 80)}`);
  }
});
