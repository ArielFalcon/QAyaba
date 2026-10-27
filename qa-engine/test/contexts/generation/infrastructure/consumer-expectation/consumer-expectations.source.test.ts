/* The consumer's sources of the working copy, read through the confined reader, answer what they expect of a request. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConsumerExpectations } from "@contexts/generation/infrastructure/consumer-expectation/consumer-expectations.source.ts";
import type { ServiceLink } from "@kernel/service-links.ts";

const MODELS = "export interface Item { id: number; x?: string }\n";
const API = "import { Item } from './models';\nexport function list(): Promise<Item[]> { return http.get('/things'); }\n";
const VIEW = "export const show = (item: { x?: string }) => item.x;\n";

function withMirror(files: Record<string, string>, run: (dir: string, outside: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "consumer-expectations-"));
  const outside = mkdtempSync(join(tmpdir(), "consumer-expectations-outside-"));
  try {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    run(dir, outside);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}

const fieldsOf = (dir: string, extra: Parameters<typeof loadConsumerExpectations>[0] extends infer O ? Partial<O> : never = {}): string[] | undefined =>
  loadConsumerExpectations({ mirrorDir: dir, ...extra })?.({ method: "GET", path: "/things" })?.fields.map((field) => field.name);

test("the sources of the working copy answer which fields the consumer expects of a request", () => {
  withMirror({ "src/models.ts": MODELS, "src/api.ts": API, "src/view.ts": VIEW }, (dir) => {
    assert.deepEqual(fieldsOf(dir), ["x"]);
  });
});

test("the suite the engine delivers, a dependency and a build directory are not the consumer", () => {
  withMirror({ "src/models.ts": MODELS, "src/api.ts": API, "e2e/view.ts": VIEW, "node_modules/pkg/view.ts": VIEW, "dist/view.ts": VIEW }, (dir) => {
    assert.deepEqual(fieldsOf(dir, { excludeDir: join(dir, "e2e") }), []);
  });
});

test("a link outside the mirror is not followed and a repository with no source of a declared language has no expectation", () => {
  withMirror({ "README.md": "# nothing\n" }, (dir, outside) => {
    writeFileSync(join(outside, "view.ts"), VIEW);
    symlinkSync(join(outside, "view.ts"), join(dir, "linked.ts"));
    assert.equal(fieldsOf(dir), undefined);
  });
  withMirror({ "src/models.ts": MODELS, "src/api.ts": API }, (dir, outside) => {
    writeFileSync(join(outside, "view.ts"), VIEW);
    symlinkSync(join(outside, "view.ts"), join(dir, "src", "view.ts"));
    assert.deepEqual(fieldsOf(dir), []);
  });
});

test("the links the resolver made reach the extractor: an HTTP link names the function that issues the call", () => {
  const api = "import { Item } from './models';\nexport function list(path: string): Promise<Item[]> { return http.get(path); }\n";
  withMirror({ "src/models.ts": MODELS, "src/api.ts": api, "src/view.ts": VIEW }, (dir) => {
    assert.equal(fieldsOf(dir), undefined);
    const link: ServiceLink = { from: { repo: "o/front", file: "src/api.ts", symbol: "list" }, to: { repo: "o/back", file: "openapi.yaml", symbol: "listThings" }, transport: "http", operation: { verb: "GET", path: "/things" }, confidence: 1, source: "openapi-http" };
    assert.deepEqual(fieldsOf(dir, { links: [link] }), ["x"]);
  });
});
