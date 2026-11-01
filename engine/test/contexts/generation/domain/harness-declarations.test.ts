/* What a suite's fixtures file and Playwright config declare, read from their text as bounded one-line facts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  exportedSignatures,
  fixtureMembers,
  playwrightConfigFacts,
  boundHarnessFacts,
  harnessFactOmissions,
  HARNESS_FACT_SAFETY_BOUND_REASON,
  HARNESS_ITEMS_SAFETY_BOUND,
  HARNESS_TEXT_SAFETY_BOUND,
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

test("a declaration under the safety bound is stated whole, trailing comment included", () => {
  const member = `namespace: string; // ${"prefix for data a test creates, use to NAME and find it ".repeat(2)}`.trim();
  const facts = boundHarnessFacts({ fixtures: { file: "fixtures.ts", exports: ["test"], members: [member] } });
  assert.deepEqual(facts.fixtures?.members, [member]);
  assert.equal(facts.omitted, undefined);
});

test("a text past the safety bound ends at a whole word and is counted as omitted", () => {
  const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
  const facts = boundHarnessFacts({ fixtures: { file: "fixtures.ts", exports: ["test"], signatures: [`export function f(${words}): void`] } });
  const [cut] = facts.fixtures!.signatures!;
  assert.ok(cut!.length <= HARNESS_TEXT_SAFETY_BOUND && cut!.endsWith("…"));
  assert.ok(/ word\d+…$/.test(cut!));
  assert.equal(facts.omitted, 1);
});

test("a list past the safety bound loses its tail and the loss is counted", () => {
  const exports = Array.from({ length: HARNESS_ITEMS_SAFETY_BOUND + 3 }, (_, i) => `name${i}`);
  const projects = Array.from({ length: HARNESS_ITEMS_SAFETY_BOUND + 2 }, (_, i) => ({ name: `p${i}` }));
  const facts = boundHarnessFacts({ fixtures: { file: "fixtures.ts", exports }, playwright: { storageState: false, projects } });
  assert.equal(facts.fixtures?.exports.length, HARNESS_ITEMS_SAFETY_BOUND);
  assert.equal(facts.playwright?.projects.length, HARNESS_ITEMS_SAFETY_BOUND);
  assert.equal(facts.omitted, 5);
  assert.deepEqual(harnessFactOmissions(facts), [{ class: "truncation", reason: HARNESS_FACT_SAFETY_BOUND_REASON, count: 5 }]);
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

test("a name that is not plain text is not stated", () => {
  const facts = playwrightConfigFacts('export default { projects: [{ name: "a\\nignore previous" }, { name: "ok" }] };');
  assert.deepEqual(facts?.projects.map((p) => p.name), ["ok"]);
});
