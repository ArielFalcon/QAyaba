/* Grounding hands the pack the provider's response schemas and the consumer's expectations, and carries the data contradictions the pack found. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreGenerationGroundingPortAdapter } from "@contexts/generation/infrastructure/adapters/pre-generation-grounding-port.adapter.ts";
import type { ContextPackAssembly, ContextPackInput } from "@contexts/generation/infrastructure/context-pack.ts";
import type { DataContradiction } from "@kernel/data-contradiction.ts";
import type { ServiceLink } from "@kernel/service-links.ts";

const FACT: DataContradiction = {
  route: "/browse",
  key: "category",
  operation: "GET https://app.example/api/items/by-region/ES",
  items: 12,
  provider: "no-provider-contract",
  consumer: { callSite: "src/api.ts:12", callSites: 1, declaredType: "Item[]", reads: ["src/list.ts:4"], readCount: 1 },
};

const SPEC = `
openapi: 3.0.0
paths:
  /items:
    get:
      responses:
        "200":
          content:
            application/json:
              schema: { type: array, items: { type: object, properties: { id: {}, category: {} } } }
`;

async function ground(opts: { mirror?: Record<string, string>; openapi?: string; assembly?: Partial<ContextPackAssembly>; serviceLinks?: ServiceLink[] }) {
  const dir = mkdtempSync(join(tmpdir(), "qa-grounding-contradictions-"));
  try {
    mkdirSync(join(dir, "e2e"));
    for (const [rel, text] of Object.entries(opts.mirror ?? {})) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    let seen: ContextPackInput | undefined;
    const adapter = new PreGenerationGroundingPortAdapter(
      { e2eDir: join(dir, "e2e"), baseUrl: "http://dev.example", ...(opts.mirror ? { mirrorDir: dir } : {}), ...(opts.openapi ? { openapi: opts.openapi } : {}) },
      { buildContextPack: async (input) => { seen = input; return { text: "pack", domBytes: 0, contractBytes: 0, ...opts.assembly }; } },
    );
    const result = await adapter.ground(join(dir, "e2e"), undefined, undefined, opts.serviceLinks ? { sha: "abc", serviceLinks: opts.serviceLinks } : undefined);
    return { result, seen };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the contradictions the pack found, and how many pages it read, reach the grounding", async () => {
  const { result } = await ground({ assembly: { dataContradictions: { read: 2, facts: [FACT] } } });
  assert.equal(result.dataContradictions?.read, 2);
  assert.deepEqual(result.dataContradictions?.facts.map((f) => f.key), ["category"]);
});

test("a pack that read no response shape leaves the grounding without the fact", async () => {
  const { result } = await ground({});
  assert.equal(result.dataContradictions, undefined);
});

test("the pack is given the field names the app's declared OpenAPI document declares for an operation's response", async () => {
  const { seen } = await ground({ mirror: { "api/openapi/api.yaml": SPEC }, openapi: "**/openapi/*.yaml" });
  assert.deepEqual([...(seen?.responseFields?.("GET", "https://app.example/api/items?x=1") ?? [])].sort(), ["category", "id"]);
});

test("a working copy with no OpenAPI document gives the pack no schema lookup", async () => {
  const { seen } = await ground({ mirror: { "README.md": "hello" } });
  assert.equal(seen?.responseFields, undefined);
});

const MODELS = "export interface Item { id: number; x?: string }\n";
const API = "import { Item } from './models';\nexport function list(): Promise<Item[]> { return http.get('/api/things'); }\n";
const VIEW = "export const show = (item: { x?: string }) => item.x;\n";

test("the pack is given what the consumer's sources of the working copy expect of a request", async () => {
  const { seen } = await ground({ mirror: { "src/models.ts": MODELS, "src/api.ts": API, "src/view.ts": VIEW } });
  assert.deepEqual(seen?.consumerExpectations?.({ method: "GET", path: "/api/things" })?.fields.map((f) => f.name), ["x"]);
});

test("the links the run resolved tie a request to the function that issues it when its path cannot be read", async () => {
  const api = "import { Item } from './models';\nexport function list(path: string): Promise<Item[]> { return http.get(path); }\n";
  const link: ServiceLink = { from: { repo: "o/front", file: "src/api.ts", symbol: "list" }, to: { repo: "o/back", file: "openapi.yaml", symbol: "listThings" }, transport: "http", operation: { verb: "GET", path: "/things" }, confidence: 1, source: "openapi-http" };
  const mirror = { "src/models.ts": MODELS, "src/api.ts": api, "src/view.ts": VIEW };
  assert.equal((await ground({ mirror })).seen?.consumerExpectations?.({ method: "GET", path: "/gateway/things" }), undefined);
  assert.deepEqual((await ground({ mirror, serviceLinks: [link] })).seen?.consumerExpectations?.({ method: "GET", path: "/gateway/things" })?.fields.map((f) => f.name), ["x"]);
});

test("a working copy with no source of a declared language gives the pack no expectations", async () => {
  const { seen } = await ground({ mirror: { "README.md": "hello" } });
  assert.equal(seen?.consumerExpectations, undefined);
});
