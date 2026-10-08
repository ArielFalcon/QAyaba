/* The capture block is appended into a repo's own fixtures.ts, which the static gate type-checks with the repo's e2e tsconfig — the seed's is strict. A block that does not type-check there turns every run of that repo invalid. These tests run the TypeScript compiler, which takes seconds each, so they sit apart from setup.adapter.test.ts: the mutation presets that hold setup's tests run them once per mutant, and the compiler is no part of what they judge. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SetupAdapter, nodeFsDeps, FAILURE_CAPTURE_MARKER } from "@contexts/workspace-and-publication/infrastructure/setup.adapter.ts";
import type { SandboxedBinaryRunner } from "../../../../src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";

const REAL_SEED_DIR = fileURLToPath(new URL("../../../../../config/e2e", import.meta.url));
const SEED_REVISIONS_DIR = fileURLToPath(new URL("./__fixtures__/seed-revisions", import.meta.url));

/* The exact bytes of a seed file as an earlier revision shipped it into watched repos. */
function shippedRevision(name: string): string {
  return readFileSync(join(SEED_REVISIONS_DIR, name), "utf8");
}

const neverCalledRunner: SandboxedBinaryRunner = {
  run: async () => {
    throw new Error("runner should not be called in this test");
  },
};

function realAdapter(): SetupAdapter {
  return new SetupAdapter({ fs: nodeFsDeps, runner: neverCalledRunner, seedDir: REAL_SEED_DIR });
}

/* Playwright is not installed in this template, so its types are a hand-written stand-in covering exactly the API the block touches; @types/node is the real one. */
const PLAYWRIGHT_TYPES_STAND_IN = `export interface Request { resourceType(): string; url(): string }
export interface Response { status(): number; url(): string; request(): Request }
export interface ConsoleMessage { type(): string; text(): string }
export interface Locator { ariaSnapshot(options?: { timeout?: number }): Promise<string> }
export interface Page {
  on(event: "response", listener: (response: Response) => unknown): this;
  on(event: "console", listener: (message: ConsoleMessage) => unknown): this;
  on(event: "pageerror", listener: (error: Error) => unknown): this;
  url(): string;
  locator(selector: string): Locator;
}
export type TestStatus = "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
export interface TestInfo { status?: TestStatus; expectedStatus: TestStatus; titlePath: string[]; project: { name: string }; file: string; retry: number }
export interface TestType<Args> {
  (title: string, body: (args: Args, testInfo: TestInfo) => Promise<void> | void): void;
  beforeEach(hook: (args: Args, testInfo: TestInfo) => Promise<void> | void): void;
  afterEach(hook: (args: Args, testInfo: TestInfo) => Promise<void> | void): void;
  extend<T extends object>(fixtures: object): TestType<Args & T>;
}
export declare const test: TestType<{ page: Page }>;
export declare const expect: (actual: unknown) => { toBe(expected: unknown): void };
`;

const REPO_FIXTURES = 'import { test as base, expect } from "@playwright/test";\nexport const test = base.extend<{}>({});\nexport { expect };\n';

/* Runs ensureFailureCapture on a repo whose fixtures.ts is `fixtures`, then type-checks it with the seed's tsconfig. */
function typeCheckAfterCapture(fixtures: string): { exitCode: number; output: string; after: string } {
  const dir = mkdtempSync(join(tmpdir(), "qa-setup-capture-tsc-"));
  try {
    const repoRoot = join(REAL_SEED_DIR, "..", "..");
    copyFileSync(join(REAL_SEED_DIR, "tsconfig.json"), join(dir, "tsconfig.json"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    mkdirSync(join(dir, "node_modules", "@types"), { recursive: true });
    symlinkSync(join(repoRoot, "node_modules", "@types", "node"), join(dir, "node_modules", "@types", "node"), "dir");
    const playwright = join(dir, "node_modules", "@playwright", "test");
    mkdirSync(playwright, { recursive: true });
    writeFileSync(join(playwright, "package.json"), JSON.stringify({ name: "@playwright/test", types: "index.d.ts" }));
    writeFileSync(join(playwright, "index.d.ts"), PLAYWRIGHT_TYPES_STAND_IN);
    writeFileSync(join(dir, "fixtures.ts"), fixtures);

    realAdapter().ensureFailureCapture(dir);
    const after = readFileSync(join(dir, "fixtures.ts"), "utf8");

    const tsc = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
    try {
      return { exitCode: 0, output: execFileSync(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], { encoding: "utf8" }), after };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { exitCode: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}`, after };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a repo fixtures.ts with the capture block appended type-checks under the seed's strict tsconfig", () => {
  const { exitCode, output, after } = typeCheckAfterCapture(REPO_FIXTURES);
  assert.ok(after.includes(FAILURE_CAPTURE_MARKER), "precondition: the block was appended");
  assert.equal(exitCode, 0, `the appended fixtures.ts must type-check under the seed tsconfig:\n${output}`);
});

test("a repo that received an earlier, untyped capture block type-checks after setup", () => {
  const { exitCode, output } = typeCheckAfterCapture(REPO_FIXTURES + shippedRevision("failure-capture.rev3.txt"));
  assert.equal(exitCode, 0, `the upgraded fixtures.ts must type-check under the seed tsconfig:\n${output}`);
});

test("a repo that received the capture block without markers type-checks after setup", () => {
  const { exitCode, output } = typeCheckAfterCapture(REPO_FIXTURES + shippedRevision("failure-capture.unmarked.txt"));
  assert.equal(exitCode, 0, `the upgraded fixtures.ts must type-check under the seed tsconfig:\n${output}`);
});
