/* Every child process that runs code an agent influenced starts through the execution launcher. The structural guarantee is the import: a module that does not import child_process cannot start a child as the orchestrator, so the rule forbids the import everywhere in qa-engine/src, in the shell's src/ and in scripts/ (but the frozen tooling list) except the launcher, the few modules that start only trusted binaries (git, chown, the code graph) and the shell's three named sites. A type-only import (ChildProcess) starts nothing and is allowed, and so is a test file of the shell.

   The real tree is only ever scanned read-only; the synthetic violations are built under os.tmpdir() with a copy of the real .dependency-cruiser.cjs, so no probe file is ever visible to a concurrently running test. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const DEPCRUISE = join(repoRoot, "node_modules", ".bin", "depcruise");
const CONFIG_REL = join("qa-engine", ".dependency-cruiser.cjs");
const SPAWNERS_REL = join("qa-engine", ".dependency-cruiser-tooling-spawners.json");

/** Entries the frozen list of tooling scripts holds today; a shrinking commit lowers it, raising it is a visible review event. */
export const TOOLING_SPAWNERS_CEILING = 8;

function runDepcruise(treeRoot: string): { ok: boolean; output: string } {
  try {
    const output = execFileSync(DEPCRUISE, ["--config", join(treeRoot, CONFIG_REL), "qa-engine/src", "src", "scripts"], { cwd: treeRoot, encoding: "utf8" });
    return { ok: true, output };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: string | number };
    if (err.code === "ENOENT") assert.fail(`dependency-cruiser not found at ${DEPCRUISE} — run \`npm install\``);
    return { ok: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

function inSyntheticTree(files: Record<string, string>): { ok: boolean; output: string } {
  const treeRoot = mkdtempSync(join(tmpdir(), "exec-launcher-sites-"));
  try {
    const tsconfig = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "ESNext", moduleResolution: "bundler", allowImportingTsExtensions: true, types: ["node"] } });
    const all: Record<string, string> = { "tsconfig.json": tsconfig, "qa-engine/tsconfig.json": tsconfig, "qa-engine/src/empty.ts": "export {};\n", "src/empty.ts": "export {};\n", "scripts/empty.ts": "export {};\n", ...files };
    for (const [rel, content] of Object.entries(all)) {
      mkdirSync(dirname(join(treeRoot, rel)), { recursive: true });
      writeFileSync(join(treeRoot, rel), content);
    }
    copyFileSync(join(repoRoot, CONFIG_REL), join(treeRoot, CONFIG_REL));
    copyFileSync(join(repoRoot, SPAWNERS_REL), join(treeRoot, SPAWNERS_REL));
    return runDepcruise(treeRoot);
  } finally {
    rmSync(treeRoot, { recursive: true, force: true });
  }
}

test("no module of the engine or the shell outside the launcher and the named sites starts a child process", () => {
  const { ok, output } = runDepcruise(repoRoot);
  assert.equal(ok, true, `dependency-cruiser reported a violation:\n${output}`);
});

test("an engine module that imports spawn is caught by the rule", () => {
  const { ok, output } = inSyntheticTree({
    "qa-engine/src/contexts/probe/runs-agent-code.ts": 'import { spawn } from "node:child_process";\nexport const go = (): unknown => spawn("npx", ["playwright", "test"]);\n',
  });
  assert.equal(ok, false, "depcruise must report a violation for the module starting a child itself");
  assert.match(output, /no-child-process-outside-launchers:\s*qa-engine\/src\/contexts\/probe\/runs-agent-code\.ts/, `expected the rule to name the offending module, got:\n${output}`);
});

test("the other ways to start a child (execFileSync, exec, fork) are caught by the same rule", () => {
  for (const [name, source] of [
    ["sync", 'import { execFileSync } from "node:child_process";\nexport const go = (): unknown => execFileSync("npx", []);\n'],
    ["exec", 'import { exec } from "child_process";\nexport const go = (): unknown => exec("npx playwright test");\n'],
    ["fork", 'import * as cp from "node:child_process";\nexport const go = (): unknown => cp.fork("x.js");\n'],
  ] as const) {
    const { ok, output } = inSyntheticTree({ [`qa-engine/src/contexts/probe/${name}.ts`]: source });
    assert.equal(ok, false, `${name} must be caught`);
    assert.match(output, /no-child-process-outside-launchers/, `${name}: ${output}`);
  }
});

test("a type-only import of ChildProcess starts nothing and is allowed", () => {
  const { ok, output } = inSyntheticTree({
    "qa-engine/src/contexts/probe/types-only.ts": 'import type { ChildProcess } from "node:child_process";\nexport type Handle = ChildProcess;\n',
  });
  assert.equal(ok, true, output);
});

test("the launcher itself may import spawn", () => {
  const { ok, output } = inSyntheticTree({
    "qa-engine/src/shared-infrastructure/process-sandbox/exec-sandbox.ts": 'import { spawn } from "node:child_process";\nexport const launch = (): unknown => spawn("npx", []);\n',
  });
  assert.equal(ok, true, output);
});

test("a module of the shell that imports a child-process function is caught by the rule", () => {
  const { ok, output } = inSyntheticTree({
    "src/server/probe-spawn.ts": 'import { execSync } from "node:child_process";\nexport const go = (): unknown => execSync("npm test");\n',
  });
  assert.equal(ok, false, "depcruise must report a violation for a shell module starting a child itself");
  assert.match(output, /no-child-process-outside-launchers:\s*src\/server\/probe-spawn\.ts/, `expected the rule to name the offending module, got:\n${output}`);
});

test("the shell's three named sites and its test files may import child_process", () => {
  const spawning = 'import { execFileSync } from "node:child_process";\nexport const go = (): unknown => execFileSync("git", []);\n';
  const { ok, output } = inSyntheticTree({
    "src/integrations/repo-mirror.ts": spawning,
    "src/server/run-engine-factory.ts": spawning,
    "src/entrypoints/file-boundary-check.ts": spawning,
    "src/server/probe-spawn.test.ts": spawning,
  });
  assert.equal(ok, true, output);
});

test("a script that imports a child-process function is caught by the rule", () => {
  const { ok, output } = inSyntheticTree({
    "scripts/new-tool.ts": 'import { spawnSync } from "node:child_process";\nexport const go = (): unknown => spawnSync("npm", ["test"]);\n',
  });
  assert.equal(ok, false, "depcruise must report a violation for a script starting a child itself");
  assert.match(output, /no-child-process-outside-launchers:\s*scripts\/new-tool\.ts/, `expected the rule to name the offending script, got:\n${output}`);
});

test("a script's type-only import and its test files start nothing the rule forbids", () => {
  const { ok, output } = inSyntheticTree({
    "scripts/types-only.ts": 'import type { ChildProcess } from "node:child_process";\nexport type Handle = ChildProcess;\n',
    "scripts/new-tool.test.ts": 'import { execFileSync } from "node:child_process";\nexport const go = (): unknown => execFileSync("npm", []);\n',
  });
  assert.equal(ok, true, output);
});

test("a tooling script of the frozen list may import child_process", () => {
  const listed = Object.keys(JSON.parse(readFileSync(join(repoRoot, SPAWNERS_REL), "utf8")) as Record<string, string>);
  /* Valid in a .ts, .mjs or spec file alike. */
  const spawning = 'import { execFileSync } from "node:child_process";\nexport const go = () => execFileSync("git", []);\n';
  const { ok, output } = inSyntheticTree(Object.fromEntries(listed.map((entry) => [entry, spawning])));
  assert.equal(ok, true, output);
});

test("the frozen list of tooling scripts is exactly as long as its ceiling, every entry still starts a child and carries its reason", () => {
  const entries = JSON.parse(readFileSync(join(repoRoot, SPAWNERS_REL), "utf8")) as Record<string, string>;
  const paths = Object.keys(entries);
  assert.equal(paths.length, TOOLING_SPAWNERS_CEILING, "the ceiling is the list length: lower it in the commit that removes an entry");
  assert.deepEqual(paths, [...paths].sort());
  const VALUE_IMPORT = /import\s+(?!type\b)[^;]*from\s+["'](?:node:)?child_process["']/;
  for (const path of paths) {
    assert.match(path, /^scripts\//, `${path} is not a script`);
    assert.ok(existsSync(join(repoRoot, path)), `${path} no longer exists: delete its entry`);
    assert.match(readFileSync(join(repoRoot, path), "utf8"), VALUE_IMPORT, `${path} no longer imports child_process: delete its entry`);
    assert.ok((entries[path] ?? "").trim().length > 0, `${path} has no reason`);
  }
});
