/* The engine sees tracing only through the TelemetryPort in shared-kernel/telemetry. The OpenTelemetry SDK (and any Langfuse client) is imported only by the shell, in src/telemetry/. The cruiser rule `no-telemetry-sdk-in-engine` enforces that for qa-engine/src; this file proves the rule fires on a synthetic violation, using a throwaway tree under os.tmpdir() like no-src-import.test.ts. */
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
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

/* A repo-shaped tree whose qa-engine/src module imports `specifier`, resolvable from a fake node_modules so the import is a real npm dependency. */
function treeImporting(packageDir: string, specifier: string): string {
  const treeRoot = mkdtempSync(join(tmpdir(), "no-telemetry-sdk-"));
  const tsconfig = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "ESNext", moduleResolution: "bundler", allowImportingTsExtensions: true } });
  const files: Record<string, string> = {
    "tsconfig.json": tsconfig,
    "qa-engine/tsconfig.json": tsconfig,
    [`node_modules/${packageDir}/package.json`]: JSON.stringify({ name: packageDir, version: "1.0.0", main: "index.js" }),
    [`node_modules/${packageDir}/index.js`]: "module.exports = {};\n",
    "qa-engine/src/traced-module.ts": `import * as sdk from "${specifier}";\nexport const probe = sdk;\n`,
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(treeRoot, rel)), { recursive: true });
    writeFileSync(join(treeRoot, rel), content);
  }
  copyFileSync(join(repoRoot, CONFIG_REL), join(treeRoot, CONFIG_REL));
  return treeRoot;
}

for (const [packageDir, specifier] of [
  ["@opentelemetry/api", "@opentelemetry/api"],
  ["@opentelemetry/sdk-trace-base", "@opentelemetry/sdk-trace-base"],
  ["langfuse", "langfuse"],
  ["langfuse-node", "langfuse-node"],
] as const) {
  test(`a qa-engine production file importing ${specifier} is caught by no-telemetry-sdk-in-engine`, () => {
    const treeRoot = treeImporting(packageDir, specifier);
    try {
      const { ok, output } = runDepcruise(treeRoot);
      assert.equal(ok, false, "depcruise must report a violation");
      assert.match(output, /no-telemetry-sdk-in-engine/, output);
    } finally {
      rmSync(treeRoot, { recursive: true, force: true });
    }
  });
}

test("a qa-engine production file importing an unrelated package is not flagged by the rule", () => {
  const treeRoot = treeImporting("zod", "zod");
  try {
    const { output } = runDepcruise(treeRoot);
    assert.doesNotMatch(output, /no-telemetry-sdk-in-engine/);
  } finally {
    rmSync(treeRoot, { recursive: true, force: true });
  }
});

test("no qa-engine production file imports the telemetry SDK today", () => {
  const { ok, output } = runDepcruise(repoRoot);
  assert.equal(ok, true, output);
});
