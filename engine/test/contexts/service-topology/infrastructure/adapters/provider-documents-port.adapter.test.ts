/* The provider documents the link resolver read are handed on, through the same confined reader, to whoever classifies a response field by the provider's contract. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderDocumentsPortAdapter } from "@contexts/service-topology/infrastructure/adapters/provider-documents-port.adapter.ts";
import type { ServiceLink } from "@kernel/service-links.ts";
import type { MirrorRegistryPort } from "@kernel/ports/mirror-registry.port.ts";

const DOC = "openapi: 3.0.0\npaths:\n  /things:\n    get:\n      responses:\n        '200':\n          content:\n            application/json:\n              schema: { type: array, items: { type: object, properties: { id: {} } } }\n";
const FILE = "src/main/resources/openapi/api-definition.yaml";

const link = (repo: string, file = FILE, transport: ServiceLink["transport"] = "http"): ServiceLink => ({
  from: { repo: "o/front", file: "src/api.ts", symbol: "list" },
  to: { repo, file, symbol: "listThings" },
  transport,
  operation: { verb: "GET", path: "/things" },
  confidence: 1,
  source: "openapi-http",
});

function withMirrors(run: (mirrors: MirrorRegistryPort, root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "provider-documents-"));
  const registry: MirrorRegistryPort = { mirrorDir: async (repo) => join(root, repo.replaceAll("/", "__")) };
  return run(registry, root).finally(() => rmSync(root, { recursive: true, force: true }));
}

function mirror(root: string, repo: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, repo.replaceAll("/", "__"), rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  }
}

test("the document a link points at is read from the service's mirror once, however many links point at it", () =>
  withMirrors(async (mirrors, root) => {
    mirror(root, "o/back", { [FILE]: DOC });
    const documents = await new ProviderDocumentsPortAdapter(mirrors, [{ repo: "o/back" }]).read([link("o/back"), link("o/back")]);
    assert.equal(documents.length, 1);
    assert.deepEqual(Object.keys((documents[0] as { paths: object }).paths), ["/things"]);
  }));

test("a link to a repo that is not a declared service, a link that is not HTTP, a missing file and one that does not parse yield no document", () =>
  withMirrors(async (mirrors, root) => {
    mirror(root, "o/back", { [FILE]: DOC, "broken.yaml": "paths: [unclosed" });
    mirror(root, "o/stranger", { [FILE]: DOC });
    const adapter = new ProviderDocumentsPortAdapter(mirrors, [{ repo: "o/back" }]);
    assert.deepEqual(await adapter.read([link("o/stranger"), link("service:orders"), link("o/back", FILE, "event"), link("o/back", "absent.yaml"), link("o/back", "broken.yaml")]), []);
    assert.deepEqual(await adapter.read([]), []);
  }));

test("a document that is a link out of the mirror is not followed", () =>
  withMirrors(async (mirrors, root) => {
    mirror(root, "o/back", { "keep.txt": "x" });
    mirror(root, "o/outside", { "secret.yaml": DOC });
    symlinkSync(join(root, "o__outside", "secret.yaml"), join(root, "o__back", "linked.yaml"));
    assert.deepEqual(await new ProviderDocumentsPortAdapter(mirrors, [{ repo: "o/back" }]).read([link("o/back", "linked.yaml")]), []);
  }));

test("a mirror registry that fails costs the documents and nothing else", async () => {
  const failing: MirrorRegistryPort = { mirrorDir: async () => { throw new Error("no registry"); } };
  assert.deepEqual(await new ProviderDocumentsPortAdapter(failing, [{ repo: "o/back" }]).read([link("o/back")]), []);
});
