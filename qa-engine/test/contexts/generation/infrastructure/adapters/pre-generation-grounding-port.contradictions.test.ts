/* Grounding hands the pack the app's response schemas and carries the data contradictions the pack found. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreGenerationGroundingPortAdapter } from "@contexts/generation/infrastructure/adapters/pre-generation-grounding-port.adapter.ts";
import type { ContextPackAssembly, ContextPackInput } from "@contexts/generation/infrastructure/context-pack.ts";
import type { DataContradiction } from "@kernel/data-contradiction.ts";

const FACT: DataContradiction = {
  route: "/browse",
  key: "category",
  carriedBy: { operation: "GET https://app.example/api/items", items: 40 },
  missingFrom: { operation: "GET https://app.example/api/items/by-region/ES", items: 12 },
  schemaBacked: false,
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

async function ground(opts: { mirror?: Record<string, string>; openapi?: string; assembly?: Partial<ContextPackAssembly> }) {
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
    const result = await adapter.ground(join(dir, "e2e"));
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

test("the pack is given the fields the app's declared OpenAPI document declares for an operation's items", async () => {
  const { seen } = await ground({ mirror: { "api/openapi/api.yaml": SPEC }, openapi: "**/openapi/*.yaml" });
  assert.deepEqual([...(seen?.responseFields?.("GET", "https://app.example/api/items?x=1") ?? [])].sort(), ["category", "id"]);
});

test("a working copy with no OpenAPI document gives the pack no schema lookup", async () => {
  const { seen } = await ground({ mirror: { "README.md": "hello" } });
  assert.equal(seen?.responseFields, undefined);
});
