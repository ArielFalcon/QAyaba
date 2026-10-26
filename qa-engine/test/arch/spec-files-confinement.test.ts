/* The confined reader of agent-influenced paths is reached by a use case only through SpecFilesPort. Nothing in a
   context's application/ or domain/ imports spec-path-confinement.ts, and the rule that enforces it is the
   hexagonal one: the cases plant the import in a throwaway tree that carries a copy of the real
   .dependency-cruiser.cjs. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const DEPCRUISE = join(repoRoot, "node_modules", ".bin", "depcruise");
const CONFIG_REL = join("qa-engine", ".dependency-cruiser.cjs");
const CONFINEMENT = /spec-path-confinement(\.ts)?["']/;
const INNER_LAYER = /^qa-engine\/src\/(contexts\/[^/]+\/(application|domain)|shared-kernel)\/.+\.ts$/;

function treeWith(files: Record<string, string>): string {
  const treeRoot = mkdtempSync(join(tmpdir(), "spec-files-confinement-"));
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

const READER = { "qa-engine/src/shared-infrastructure/spec-path-confinement.ts": "export function readConfinedSpecFile(): string { return \"\"; }\n" };

test("an application file importing the confined reader fails the layering rule", () => {
  const r = cruise(treeWith({ ...READER, "qa-engine/src/contexts/x/application/use.ts": 'import { readConfinedSpecFile } from "../../../shared-infrastructure/spec-path-confinement.ts";\nexport const u = readConfinedSpecFile;\n' }));
  assert.equal(r.ok, false);
  assert.match(r.output, /application-not-infrastructure/);
});

test("a domain file importing the confined reader fails the layering rule", () => {
  const r = cruise(treeWith({ ...READER, "qa-engine/src/contexts/x/domain/d.ts": 'import { readConfinedSpecFile } from "../../../shared-infrastructure/spec-path-confinement.ts";\nexport const d = readConfinedSpecFile;\n' }));
  assert.equal(r.ok, false);
  assert.match(r.output, /domain-imports-nothing-outward/);
});

test("no application, domain or kernel file imports the confined reader", () => {
  const listed = execFileSync("git", ["ls-files", "-z", "--", "qa-engine/src"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 26 }).split("\0").filter(Boolean);
  const offenders = listed.filter((f) => INNER_LAYER.test(f) && CONFINEMENT.test(readFileSync(join(repoRoot, f), "utf8")));
  assert.deepEqual(offenders, []);
});
