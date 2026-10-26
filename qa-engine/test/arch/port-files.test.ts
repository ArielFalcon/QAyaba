/* Ports are declared one per file under a context's application/ports/, and the data they carry lives in
   the context's domain/. The cases check the real tree and, with the same checker, small synthetic trees
   that break each rule, so a rule that stopped matching would fail here. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const PORTS_FILE = /^qa-engine\/src\/contexts\/[^/]+\/application\/ports\/([^/]+)\.ts$/;
const DOMAIN_FILE = /^qa-engine\/src\/contexts\/[^/]+\/domain\/.+\.ts$/;
const EXPORTED_PORT = /^export interface [A-Za-z0-9]*Port\b/gm;
const APPLICATION_IMPORT = /\bfrom\s+["'](?:[^"']*\/application\/[^"']*|\.\.\/application\/[^"']*|@contexts\/[^/"']+\/application\/[^"']*)["']/;

/** Violations of the port-file rules over `files` (repo-relative path to source text). */
function portFileViolations(files: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [file, text] of Object.entries(files)) {
    const m = file.match(PORTS_FILE);
    if (m) {
      if (m[1] === "index") out.push(`${file}: a ports/index.ts file does not exist; the context's application/index.ts is its public surface`);
      else {
        const count = (text.match(EXPORTED_PORT) ?? []).length;
        if (count !== 1) out.push(`${file}: declares ${count} exported *Port interfaces, expected exactly one`);
      }
    }
    if (DOMAIN_FILE.test(file) && APPLICATION_IMPORT.test(text)) out.push(`${file}: a domain file imports the application layer`);
  }
  return out;
}

function realTree(): Record<string, string> {
  const listed = execFileSync("git", ["ls-files", "-z", "--", "qa-engine/src/contexts"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 26 }).split("\0").filter(Boolean);
  const files: Record<string, string> = {};
  for (const f of listed) if (PORTS_FILE.test(f) || DOMAIN_FILE.test(f)) files[f] = readFileSync(join(repoRoot, f), "utf8");
  return files;
}

const CTX = "qa-engine/src/contexts/x";

test("every file under application/ports declares exactly one exported *Port interface", () => {
  const violations = portFileViolations(realTree()).filter((v) => v.includes("exported *Port"));
  assert.deepEqual(violations, []);
});

test("no context keeps an application/ports/index.ts", () => {
  const violations = portFileViolations(realTree()).filter((v) => v.includes("ports/index.ts file"));
  assert.deepEqual(violations, []);
});

test("no domain file imports an application layer", () => {
  const violations = portFileViolations(realTree()).filter((v) => v.includes("domain file imports"));
  assert.deepEqual(violations, []);
});

test("the checker rejects a port file with two ports, a port file with none, and a ports barrel", () => {
  const two = portFileViolations({ [`${CTX}/application/ports/a.port.ts`]: "export interface APort {}\nexport interface BPort {}\n" });
  assert.equal(two.length, 1);
  const none = portFileViolations({ [`${CTX}/application/ports/a.port.ts`]: "export interface Shape {}\n" });
  assert.equal(none.length, 1);
  const barrel = portFileViolations({ [`${CTX}/application/ports/index.ts`]: "export type { APort } from \"./a.port.ts\";\n" });
  assert.equal(barrel.length, 1);
  assert.deepEqual(portFileViolations({ [`${CTX}/application/ports/a.port.ts`]: "export interface APort {}\nexport interface Shape {}\n" }), []);
});

test("the checker rejects a domain file that imports the application layer, by relative path or alias", () => {
  assert.equal(portFileViolations({ [`${CTX}/domain/a.ts`]: 'import type { APort } from "../application/ports/a.port.ts";\n' }).length, 1);
  assert.equal(portFileViolations({ [`${CTX}/domain/a.ts`]: 'import type { Y } from "@contexts/y/application/index.ts";\n' }).length, 1);
  assert.deepEqual(portFileViolations({ [`${CTX}/domain/a.ts`]: 'import type { Y } from "./b.ts";\n' }), []);
});
