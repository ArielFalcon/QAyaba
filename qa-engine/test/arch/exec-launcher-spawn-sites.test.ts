/* Every child process that runs code an agent influenced starts through the execution launcher. The structural guarantee is the import: a module that does not import child_process cannot start a child as the orchestrator, so the rule forbids the import everywhere in qa-engine/src except the launcher and the few modules that start only trusted binaries (git, chown, the code graph). A type-only import (ChildProcess) starts nothing and is allowed.

   The real tree is only ever scanned read-only; the synthetic violations are built under os.tmpdir() with a copy of the real .dependency-cruiser.cjs, so no probe file is ever visible to a concurrently running test. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const DEPCRUISE = join(repoRoot, "node_modules", ".bin", "depcruise");
const CONFIG_REL = join("qa-engine", ".dependency-cruiser.cjs");

function runDepcruise(treeRoot: string): { ok: boolean; output: string } {
  try {
    const output = execFileSync(DEPCRUISE, ["--config", join(treeRoot, CONFIG_REL), "qa-engine/src"], { cwd: treeRoot, encoding: "utf8" });
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
    const all: Record<string, string> = { "tsconfig.json": tsconfig, "qa-engine/tsconfig.json": tsconfig, ...files };
    for (const [rel, content] of Object.entries(all)) {
      mkdirSync(dirname(join(treeRoot, rel)), { recursive: true });
      writeFileSync(join(treeRoot, rel), content);
    }
    copyFileSync(join(repoRoot, CONFIG_REL), join(treeRoot, CONFIG_REL));
    return runDepcruise(treeRoot);
  } finally {
    rmSync(treeRoot, { recursive: true, force: true });
  }
}

test("no engine module outside the launcher and the trusted-binary modules starts a child process", () => {
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
