/* The shared kernel holds only what several parties share. A kernel module counts the parties that reach it:
   the contexts, shared-infrastructure, the interface layer and the shell import it directly, or through another
   kernel module. A module reached by one party belongs to that party. The cases check the real tree and, with
   the same checker, small synthetic trees, so a checker that stopped matching would fail here. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const KERNEL = "qa-engine/src/shared-kernel/";
const IMPORT = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*(["'])([^"'\n]+)\1/g;

function partyOf(file: string): string {
  const context = file.match(/^qa-engine\/src\/contexts\/([^/]+)\//);
  if (context) return context[1]!;
  if (file.startsWith(KERNEL)) return "kernel";
  if (file.startsWith("qa-engine/src/shared-infrastructure/")) return "shared-infrastructure";
  if (file.startsWith("qa-engine/src/interface/")) return "interface";
  if (file.startsWith("qa-engine/")) return "engine";
  return "shell";
}

function resolveKernelTarget(from: string, specifier: string, kernel: ReadonlySet<string>): string | undefined {
  let target: string;
  if (specifier.startsWith(".")) target = posix.normalize(posix.join(posix.dirname(from), specifier));
  else if (specifier.startsWith("@kernel/")) target = KERNEL + specifier.slice("@kernel/".length);
  else return undefined;
  return [target, `${target}.ts`, `${target}/index.ts`, target.replace(/\.js$/, ".ts")].find((candidate) => kernel.has(candidate));
}

/** Kernel modules reached by fewer than two parties that are not ports (repo-relative path to source text, production files only). */
function kernelOwnerViolations(files: Record<string, string>): string[] {
  const kernel = new Set(Object.keys(files).filter((f) => f.startsWith(KERNEL)));
  const importers = new Map<string, Set<string>>([...kernel].map((k) => [k, new Set<string>()]));
  for (const [file, text] of Object.entries(files)) {
    for (const m of text.matchAll(IMPORT)) {
      const target = resolveKernelTarget(file, m[2]!, kernel);
      if (target) importers.get(target)!.add(file);
    }
  }
  const parties = (module: string, seen = new Set<string>()): Set<string> => {
    const out = new Set<string>();
    if (seen.has(module)) return out;
    seen.add(module);
    for (const importer of importers.get(module) ?? []) {
      const party = partyOf(importer);
      if (party !== "kernel") out.add(party);
      else for (const p of parties(importer, seen)) out.add(p);
    }
    return out;
  };
  return [...kernel]
    .filter((module) => !module.includes("/ports/") || !module.endsWith(".port.ts"))
    .filter((module) => parties(module).size < 2)
    .map((module) => `${module}: reached by ${[...parties(module)].join(", ") || "no party"}, expected at least two`);
}

function realTree(): Record<string, string> {
  const listed = execFileSync("git", ["ls-files", "-z", "--", "qa-engine/src", "src", "scripts"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 26 })
    .split("\0")
    .filter((f) => /\.m?ts$/.test(f) && !/\.test\.ts$/.test(f));
  return Object.fromEntries(listed.map((f) => [f, readFileSync(join(repoRoot, f), "utf8")]));
}

test("every shared-kernel module is reached by at least two parties or is a port", () => {
  assert.deepEqual(kernelOwnerViolations(realTree()), []);
});

test("the checker rejects a kernel module that one context alone imports", () => {
  const violations = kernelOwnerViolations({
    [`${KERNEL}solo.ts`]: "export const a = 1;\n",
    "qa-engine/src/contexts/one/domain/a.ts": 'import { a } from "@kernel/solo.ts";\n',
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0]!, /solo\.ts: reached by one/);
});

test("the checker accepts a module two parties reach, directly or through another kernel module", () => {
  const violations = kernelOwnerViolations({
    [`${KERNEL}direct.ts`]: "export const a = 1;\n",
    [`${KERNEL}inner.ts`]: "export const b = 1;\n",
    [`${KERNEL}outer.ts`]: 'import { b } from "./inner.ts";\nexport const c = b;\n',
    "qa-engine/src/contexts/one/domain/a.ts": 'import { a } from "@kernel/direct.ts";\nimport { c } from "@kernel/outer.ts";\n',
    "src/server/s.ts": 'import { a } from "../../qa-engine/src/shared-kernel/direct";\nimport { c } from "../../qa-engine/src/shared-kernel/outer";\n',
  });
  assert.deepEqual(violations, []);
});

test("the checker exempts a port file", () => {
  const violations = kernelOwnerViolations({
    [`${KERNEL}ports/solo.port.ts`]: "export interface SoloPort {}\n",
  });
  assert.deepEqual(violations, []);
});
