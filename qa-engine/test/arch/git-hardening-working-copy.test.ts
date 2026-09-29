/* Every git call the engine makes runs in a working copy whose git dir the hardening verified. The one variant that
   verifies nothing (a clone, an ls-remote has no working copy yet) lives in its own module, and the engine may not
   import it: only the shell, which owns such calls, does. The allowlist of engine importers is deliberately empty.

   The real tree is only ever scanned read-only; the synthetic violation is built under os.tmpdir() with a copy of the
   real .dependency-cruiser.cjs, so no probe file is ever visible to a concurrently running test. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("no engine module uses the git hardening that verifies no working copy", () => {
  const { ok, output } = runDepcruise(repoRoot);
  assert.equal(ok, true, `dependency-cruiser reported a violation:\n${output}`);
});

test("no engine module builds git hardening flags of its own outside the two hardening modules", () => {
  const { ok, output } = runDepcruise(repoRoot);
  assert.equal(ok, true, `dependency-cruiser reported a violation:\n${output}`);
});

test("an engine module importing the git hardening that verifies no working copy is caught by the rule", () => {
  const treeRoot = mkdtempSync(join(tmpdir(), "git-hardening-working-copy-"));
  try {
    const tsconfig = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "ESNext", moduleResolution: "bundler", allowImportingTsExtensions: true } });
    const files: Record<string, string> = {
      "tsconfig.json": tsconfig,
      "qa-engine/tsconfig.json": tsconfig,
      "qa-engine/src/shared-infrastructure/process-sandbox/detached-git-hardening.ts": "export const hardenDetachedGitArgs = (args: string[]): string[] => args;\n",
      "qa-engine/src/contexts/probe/leaky-git-call.ts": 'import { hardenDetachedGitArgs } from "../../shared-infrastructure/process-sandbox/detached-git-hardening.ts";\nexport const argv = hardenDetachedGitArgs(["status"]);\n',
    };
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(treeRoot, rel)), { recursive: true });
      writeFileSync(join(treeRoot, rel), content);
    }
    copyFileSync(join(repoRoot, CONFIG_REL), join(treeRoot, CONFIG_REL));

    const { ok, output } = runDepcruise(treeRoot);

    assert.equal(ok, false, "depcruise must report a violation for the engine module using the unverified hardening");
    assert.match(output, /no-detached-git-hardening-in-engine:\s*qa-engine\/src\/contexts\/probe\/leaky-git-call\.ts/, `expected the rule to name the offending module, got:\n${output}`);
  } finally {
    rmSync(treeRoot, { recursive: true, force: true });
  }
});

/* The flags alone are the hardening minus the working-copy verification: an engine module holding them can run git on a
   sandbox-touched working copy without the git dir ever being judged. */
test("an engine module importing the bare git hardening flags is caught by the rule, and the two hardening modules may", () => {
  const treeRoot = mkdtempSync(join(tmpdir(), "git-hardening-flags-"));
  try {
    const tsconfig = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "ESNext", moduleResolution: "bundler", allowImportingTsExtensions: true } });
    const sandbox = "qa-engine/src/shared-infrastructure/process-sandbox";
    const files: Record<string, string> = {
      "tsconfig.json": tsconfig,
      "qa-engine/tsconfig.json": tsconfig,
      [`${sandbox}/git-hardening-flags.ts`]: "export const baseGitHardeningFlags = (): string[] => [];\n",
      [`${sandbox}/git-hardening.ts`]: 'import { baseGitHardeningFlags } from "./git-hardening-flags.ts";\nexport const hardenGitArgs = (args: string[]): string[] => [...baseGitHardeningFlags(), ...args];\n',
      [`${sandbox}/detached-git-hardening.ts`]: 'import { baseGitHardeningFlags } from "./git-hardening-flags.ts";\nexport const hardenDetachedGitArgs = (args: string[]): string[] => [...baseGitHardeningFlags(), ...args];\n',
      "qa-engine/src/contexts/probe/leaky-flags-call.ts": 'import { baseGitHardeningFlags } from "../../shared-infrastructure/process-sandbox/git-hardening-flags.ts";\nexport const argv = [...baseGitHardeningFlags(), "status"];\n',
    };
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(treeRoot, rel)), { recursive: true });
      writeFileSync(join(treeRoot, rel), content);
    }
    copyFileSync(join(repoRoot, CONFIG_REL), join(treeRoot, CONFIG_REL));

    const { ok, output } = runDepcruise(treeRoot);

    assert.equal(ok, false, "depcruise must report a violation for the engine module using the bare flags");
    assert.match(output, /no-git-hardening-flags-outside-hardening:\s*qa-engine\/src\/contexts\/probe\/leaky-flags-call\.ts/, `expected the rule to name the offending module, got:\n${output}`);
    assert.doesNotMatch(output, /no-git-hardening-flags-outside-hardening:\s*qa-engine\/src\/shared-infrastructure\/process-sandbox\/(detached-)?git-hardening\.ts/, "the two hardening modules are the flags' only legitimate importers");
  } finally {
    rmSync(treeRoot, { recursive: true, force: true });
  }
});
