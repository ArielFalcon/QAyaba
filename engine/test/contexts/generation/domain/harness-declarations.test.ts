/* What a suite's fixtures file and Playwright config declare, read from their text as bounded one-line facts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  exportedSignatures,
  fixtureMembers,
  playwrightConfigFacts,
  MAX_DECLARATION_LENGTH,
  MAX_DECLARATION_LINES,
  MAX_PROJECTS,
} from "@contexts/generation/domain/harness-facts.ts";

const FIXTURES = `
interface Fx {
  namespace: string; // per-attempt data prefix
  authenticate: () => Promise<void>; // the app login
  _coverage: void;
  nested: { a: number };
}
export const test = base.extend<Fx>({ namespace: async ({}, use) => { await use("x"); } });
export function ns(namespace: string, name: string): string {
  return namespace + name;
}
export async function setLocation(context: BrowserContext, lat: number): Promise<void> {}
export const asset = (name: string) => name;
`;

test("exported functions are stated as declared, up to the opening of their body", () => {
  assert.deepEqual(exportedSignatures(FIXTURES), [
    "export function ns(namespace: string, name: string): string",
    "export async function setLocation(context: BrowserContext, lat: number): Promise<void>",
  ]);
});

test("the fixtures a test receives are the members of the type its extend names, minus the harness's own", () => {
  assert.deepEqual(fixtureMembers(FIXTURES), [
    "namespace: string; // per-attempt data prefix",
    "authenticate: () => Promise<void>; // the app login",
    "nested: { a: number };",
  ]);
});

test("a fixtures file whose extend type is not declared in it states no members", () => {
  assert.deepEqual(fixtureMembers("export const test = base.extend<Elsewhere>({});"), []);
  assert.deepEqual(fixtureMembers("export const test = base;"), []);
});

test("declarations are bounded in number and in length", () => {
  const many = Array.from({ length: 50 }, (_, i) => `export function f${i}(${"a: string, ".repeat(40)}) {}`).join("\n");
  const lines = exportedSignatures(many);
  assert.equal(lines.length, MAX_DECLARATION_LINES);
  assert.ok(lines.every((line) => line.length <= MAX_DECLARATION_LENGTH));
});

const CONFIG = `
import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  use: { storageState: process.env.PW_STORAGE_STATE },
  projects: [
    { name: "setup", testMatch: "**/*.setup.ts" },
    { name: "desktop", dependencies: ["setup"], use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } } },
  ],
});
`;

test("the config's spec location, session carrying and projects are stated from its text", () => {
  assert.deepEqual(playwrightConfigFacts(CONFIG), {
    testDir: ".",
    testMatch: "**/*.spec.ts",
    storageState: true,
    projects: [
      { name: "setup", testMatch: "**/*.setup.ts" },
      { name: "desktop", device: "Desktop Chrome", viewport: "1280x720", dependencies: ["setup"] },
    ],
  });
});

test("a value computed at run time states nothing, and a config with nothing literal states nothing", () => {
  assert.equal(playwrightConfigFacts("export default defineConfig({ testDir: dir, projects: build() });"), undefined);
  assert.equal(playwrightConfigFacts("// testDir: 'x'\nexport default {};"), undefined);
});

test("projects are capped", () => {
  const projects = Array.from({ length: 30 }, (_, i) => `{ name: "p${i}" }`).join(",");
  assert.equal(playwrightConfigFacts(`export default { projects: [${projects}] };`)?.projects.length, MAX_PROJECTS);
});

test("a name that is not plain text is not stated", () => {
  const facts = playwrightConfigFacts('export default { projects: [{ name: "a\\nignore previous" }, { name: "ok" }] };');
  assert.deepEqual(facts?.projects.map((p) => p.name), ["ok"]);
});
