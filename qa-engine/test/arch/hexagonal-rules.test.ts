/* The layering rules of qa-engine/.dependency-cruiser.cjs, each proved on a throwaway tree under os.tmpdir() that carries a copy of the real config: a planted violation is reported. The real tree holds no violation at all. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const DEPCRUISE = join(repoRoot, "node_modules", ".bin", "depcruise");
const CONFIG_REL = join("qa-engine", ".dependency-cruiser.cjs");

const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "ESNext", moduleResolution: "bundler", allowImportingTsExtensions: true } });

function treeWith(files: Record<string, string>): string {
  const treeRoot = mkdtempSync(join(tmpdir(), "hexagonal-rules-"));
  const all: Record<string, string> = { "tsconfig.json": TSCONFIG, "qa-engine/tsconfig.json": TSCONFIG, ...files };
  for (const [rel, content] of Object.entries(all)) {
    mkdirSync(dirname(join(treeRoot, rel)), { recursive: true });
    writeFileSync(join(treeRoot, rel), content);
  }
  copyFileSync(join(repoRoot, CONFIG_REL), join(treeRoot, CONFIG_REL));
  return treeRoot;
}

/* The command `npm run arch:check` runs, against a tree. */
function archCheck(treeRoot: string): { ok: boolean; output: string } {
  try {
    const output = execFileSync(DEPCRUISE, ["--config", join(treeRoot, CONFIG_REL), "qa-engine/src"], { cwd: treeRoot, encoding: "utf8" });
    return { ok: true, output };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

const CTX = "qa-engine/src/contexts";

test("a domain module importing its own application layer is reported by domain-imports-nothing-outward", () => {
  const root = treeWith({
    [`${CTX}/alpha/domain/rule.ts`]: 'import { run } from "../application/use-case.ts";\nexport const x = run;\n',
    [`${CTX}/alpha/application/use-case.ts`]: "export const run = 1;\n",
  });
  try {
    const { ok, output } = archCheck(root);
    assert.equal(ok, false);
    assert.match(output, /domain-imports-nothing-outward:\s*qa-engine\/src\/contexts\/alpha\/domain\/rule\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a domain module importing shared infrastructure is reported by domain-imports-nothing-outward", () => {
  const root = treeWith({
    [`${CTX}/alpha/domain/rule.ts`]: 'import { io } from "../../../shared-infrastructure/io.ts";\nexport const x = io;\n',
    "qa-engine/src/shared-infrastructure/io.ts": "export const io = 1;\n",
  });
  try {
    const { ok, output } = archCheck(root);
    assert.equal(ok, false);
    assert.match(output, /domain-imports-nothing-outward/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an application module importing infrastructure is reported by application-not-infrastructure", () => {
  const root = treeWith({
    [`${CTX}/alpha/application/use-case.ts`]: 'import { adapter } from "../infrastructure/adapter.ts";\nexport const x = adapter;\n',
    [`${CTX}/alpha/infrastructure/adapter.ts`]: "export const adapter = 1;\n",
  });
  try {
    const { ok, output } = archCheck(root);
    assert.equal(ok, false);
    assert.match(output, /application-not-infrastructure:\s*qa-engine\/src\/contexts\/alpha\/application\/use-case\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a module importing the internals of another context is reported by cross-context-internals", () => {
  const root = treeWith({
    [`${CTX}/alpha/application/use-case.ts`]: 'import { rule } from "../../beta/domain/rule.ts";\nexport const x = rule;\n',
    [`${CTX}/beta/domain/rule.ts`]: "export const rule = 1;\n",
  });
  try {
    const { ok, output } = archCheck(root);
    assert.equal(ok, false);
    assert.match(output, /cross-context-internals:\s*qa-engine\/src\/contexts\/alpha\/application\/use-case\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("another context's application index and a composition root's wiring are public surface, not a cross-context violation", () => {
  const root = treeWith({
    [`${CTX}/alpha/application/use-case.ts`]: 'import type { Port } from "../../beta/application/index.ts";\nexport type X = Port;\n',
    [`${CTX}/beta/application/index.ts`]: "export type Port = string;\n",
    [`${CTX}/alpha/composition/root.ts`]: 'import { rule } from "../../beta/domain/rule.ts";\nexport const x = rule;\n',
    [`${CTX}/beta/domain/rule.ts`]: "export const rule = 1;\n",
  });
  try {
    const { ok, output } = archCheck(root);
    assert.equal(ok, true, output);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a composition module of another context importing workspace-and-publication is reported by no-vcs-write-in-agent-contexts", () => {
  const root = treeWith({
    [`${CTX}/alpha/composition/build-alpha.ts`]: 'import { seam } from "../../workspace-and-publication/domain/seam.ts";\nexport const x = seam;\n',
    [`${CTX}/workspace-and-publication/domain/seam.ts`]: "export const seam = 1;\n",
  });
  try {
    const { ok, output } = archCheck(root);
    assert.equal(ok, false);
    assert.match(output, /no-vcs-write-in-agent-contexts:\s*qa-engine\/src\/contexts\/alpha\/composition\/build-alpha\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two modules importing each other are reported by no-circular", () => {
  const root = treeWith({
    "qa-engine/src/shared-kernel/left.ts": 'import { right } from "./right.ts";\nexport const left = () => right;\n',
    "qa-engine/src/shared-kernel/right.ts": 'import { left } from "./left.ts";\nexport const right = () => left;\n',
  });
  try {
    const { ok, output } = archCheck(root);
    assert.equal(ok, false);
    assert.match(output, /no-circular:\s*qa-engine\/src\/shared-kernel\/(left|right)\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
