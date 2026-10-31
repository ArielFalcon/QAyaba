/* The shell (src/, scripts/) reaches a context only through its application/index.ts, and only src/composition/engine-root.ts imports a
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
export const SHELL_INFRASTRUCTURE_EXCEPTIONS_CEILING = 27;

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
  assert.equal(cruise(treeWith({ ...context, "src/composition/engine-root.ts": build })).ok, true);
  const r = cruise(treeWith({ ...context, "src/server/other.ts": build }));
  assert.equal(r.ok, false);
  assert.match(r.output, /composition-only-from-shell-root/);
});

test("the composition root may import a context's infrastructure, never its domain", () => {
  const infra = cruise(treeWith({ ...context, "src/composition/wiring.ts": 'import { x } from "../../qa-engine/src/contexts/a/infrastructure/x.ts";\nexport const y = x;\n' }));
  assert.equal(infra.ok, true, infra.output);
  const domain = cruise(treeWith({ ...context, "src/composition/wiring.ts": 'import { d } from "../../qa-engine/src/contexts/a/domain/d.ts";\nexport const y = d;\n' }));
  assert.equal(domain.ok, false);
  assert.match(domain.output, /composition-builds-adapters-from-infrastructure/);
});

test("no platform folder but composition imports the composition root; a test may", () => {
  const root = { ...context, "src/composition/loader.ts": "export const load = () => 1;\n" };
  for (const folder of ["entrypoints", "persistence", "telemetry", "agent-runtime", "settings"]) {
    const r = cruise(treeWith({ ...root, [`src/${folder}/x.ts`]: 'import { load } from "../composition/loader.ts";\nexport const y = load;\n' }));
    assert.equal(r.ok, false, folder);
    assert.match(r.output, /platform-composition-is-the-root/);
  }
  const test = cruise(treeWith({ ...root, "src/entrypoints/x.test.ts": 'import { load } from "../composition/loader.ts";\nexport const y = load;\n' }));
  assert.equal(test.ok, true, test.output);
});

test("settings imports no other platform folder, and every folder may read settings", () => {
  const telemetry = { ...context, "src/telemetry/config.ts": "export const c = 1;\n", "src/settings/s.ts": "export const s = 1;\n" };
  const r = cruise(treeWith({ ...telemetry, "src/settings/x.ts": 'import { c } from "../telemetry/config.ts";\nexport const y = c;\n' }));
  assert.equal(r.ok, false);
  assert.match(r.output, /platform-settings-reads-no-other-folder/);
  assert.equal(cruise(treeWith({ ...telemetry, "src/telemetry/x.ts": 'import { s } from "../settings/s.ts";\nexport const y = s;\n' })).ok, true);
});

test("no production module imports the test-support root", () => {
  const harness = { ...context, "src/test-support/harness.ts": "export const h = 1;\n" };
  const r = cruise(treeWith({ ...harness, "src/entrypoints/x.ts": 'import { h } from "../test-support/harness.ts";\nexport const y = h;\n' }));
  assert.equal(r.ok, false);
  assert.match(r.output, /platform-production-imports-no-test-support/);
  assert.equal(cruise(treeWith({ ...harness, "src/entrypoints/x.test.ts": 'import { h } from "../test-support/harness.ts";\nexport const y = h;\n' })).ok, true);
});

test("the frozen exception list is exactly as long as its ceiling and every entry still imports an infrastructure file", () => {
  const entries = JSON.parse(readFileSync(join(repoRoot, EXCEPTIONS_REL), "utf8")) as string[];
  assert.equal(entries.length, SHELL_INFRASTRUCTURE_EXCEPTIONS_CEILING, "the ceiling is the list length: lower it in the commit that removes an entry");
  assert.deepEqual(entries, [...entries].sort());
  const INFRASTRUCTURE_IMPORT = /["'][^"']*contexts\/[^/"']+\/(infrastructure|bridges|adapters)\//;
  for (const entry of entries) {
    assert.ok(existsSync(join(repoRoot, entry)), `${entry} no longer exists: delete its entry`);
    assert.match(readFileSync(join(repoRoot, entry), "utf8"), INFRASTRUCTURE_IMPORT, `${entry} imports no infrastructure file: delete its entry`);
  }
});
