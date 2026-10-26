/* The seed attaches to each covered script only the part of its source map the coverage reader uses, so a dump stays within the orchestrator's cap on an app whose maps embed their sources. The seed cannot be imported (it needs the test runner's package), so the code between its `qa-source-maps` markers is transpiled from its source and run here. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const SEED = readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "..", "config", "e2e", "fixtures.ts"), "utf8");

interface Entry { url?: string; source?: string; map?: unknown }
interface Request { get(url: string): Promise<{ ok(): boolean; text(): Promise<string> }> }
const attachSourceMaps = (() => {
  const start = SEED.indexOf("// >>> qa-source-maps");
  const end = SEED.indexOf("// <<< qa-source-maps <<<");
  assert.ok(start >= 0 && end > start, "the seed marks its source-map code");
  const js = ts.transpileModule(SEED.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(`${js}\nreturn attachSourceMaps;`)() as (entries: Entry[], request: Request) => Promise<void>;
})();

const MAP = { version: 3, file: "main.js", sourceRoot: "webpack:///", sources: ["src/app/a.ts", "src/app/b.ts"], sourcesContent: ["export const a = 1;\n", "export const b = 2;\n"], names: ["a", "b"], mappings: "AAAA;AACA" };
const READ_FIELDS = { sourceRoot: "webpack:///", sources: ["src/app/a.ts", "src/app/b.ts"], mappings: "AAAA;AACA" };

const serving = (bodies: Record<string, string>): Request & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    get: async (url: string) => {
      asked.push(url);
      const body = bodies[url];
      return { ok: () => body !== undefined, text: async () => body ?? "" };
    },
  };
};

test("a fetched map is attached with its sources, root and mappings only: embedded sources, names and the rest are left out", async () => {
  const entries: Entry[] = [{ url: "https://dev.example.com/main.js", source: "console.log(1);\n//# sourceMappingURL=main.js.map" }];
  await attachSourceMaps(entries, serving({ "https://dev.example.com/main.js.map": JSON.stringify(MAP) }));
  assert.deepEqual(entries[0]!.map, READ_FIELDS);
});

test("a script that names no map gets `<script>.map`, kept to the same fields, and a map without a root has none", async () => {
  const { sourceRoot: _root, ...rootless } = MAP;
  const entries: Entry[] = [{ url: "https://dev.example.com/chunk-A.js?v=1", source: "console.log(2);" }];
  const request = serving({ "https://dev.example.com/chunk-A.js.map": JSON.stringify(rootless) });
  await attachSourceMaps(entries, request);
  assert.deepEqual(request.asked, ["https://dev.example.com/chunk-A.js.map"]);
  assert.deepEqual(entries[0]!.map, { sources: READ_FIELDS.sources, mappings: READ_FIELDS.mappings });
});

test("an inline map is kept to the same fields", async () => {
  const inline = `data:application/json;base64,${Buffer.from(JSON.stringify(MAP)).toString("base64")}`;
  const entries: Entry[] = [{ url: "https://dev.example.com/inline.js", source: `console.log(3);\n//# sourceMappingURL=${inline}` }];
  await attachSourceMaps(entries, serving({}));
  assert.deepEqual(entries[0]!.map, READ_FIELDS);
});

test("what is not a source map is no map", async () => {
  const entries: Entry[] = [{ url: "https://dev.example.com/spa.js", source: "console.log(4);" }];
  await attachSourceMaps(entries, serving({ "https://dev.example.com/spa.js.map": "<!doctype html><html></html>" }));
  assert.equal(entries[0]!.map, undefined);
});
