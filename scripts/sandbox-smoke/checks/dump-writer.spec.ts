// Runs INSIDE the execution sandbox. PASSES when the coverage dump folder behaves as the suite's fixtures need it (a dump can be
// written below the run's namespace) and as an attacker cannot use it (nothing else in `.qa` can be created, replaced or removed).
// The harness (scripts/sandbox-smoke-checks.ts) then judges what reached the mirror.
import { test, expect } from "@playwright/test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const namespace = process.env.PW_NAMESPACE as string;
const coverage = join(process.cwd(), ".qa", "coverage");

function codeOf(action: () => unknown): string {
  try {
    action();
    return "succeeded";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? "failed";
  }
}

test("a dump and a planted file are written where the fixtures write", () => {
  const dir = join(coverage, namespace);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "w0-0.json"), JSON.stringify([{ url: "https://dev.example/a.js", source: "x\n", exfil: "SMOKE_EXFIL_MARKER" }]));
  writeFileSync(join(dir, "stolen-session.txt"), "SMOKE_EXFIL_MARKER");
});

test("nothing else can be made in the mirror's dump folder", () => {
  expect(codeOf(() => mkdirSync(join(coverage, "another-namespace")))).toMatch(/^(EACCES|EPERM|EROFS)$/);
  expect(codeOf(() => writeFileSync(join(coverage, "planted.json"), "x"))).toMatch(/^(EACCES|EPERM|EROFS)$/);
  expect(codeOf(() => writeFileSync(join(process.cwd(), ".qa", "planted.json"), "x"))).toMatch(/^(EACCES|EPERM|EROFS)$/);
});

test("the link to the run's dump folder cannot be removed or replaced", () => {
  expect(codeOf(() => rmSync(join(coverage, namespace)))).toMatch(/^(EACCES|EPERM|EROFS)$/);
  expect(codeOf(() => rmSync(coverage, { recursive: true }))).toMatch(/^(EACCES|EPERM|EROFS)$/);
});
