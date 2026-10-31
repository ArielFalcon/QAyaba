/*
 * The worked example of the consumer expectation gaps, end to end over fixture sources: a consumer method returning an observable of
 * a collection of items whose type declares an optional field that two non-test files read and none writes, against live responses of
 * that operation, classified by the provider's OpenAPI document. Generic names: nothing here knows an app or a framework.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { createTypeScriptExpectations } from "@contexts/generation/infrastructure/consumer-expectation/typescript-expectations.ts";
import { findExpectationGaps, type PageShapes } from "@contexts/generation/domain/expectation-gaps.ts";
import { responseFieldNames } from "@contexts/service-topology/application/index.ts";
import type { DataShape } from "@contexts/generation/domain/route-snapshot.ts";
import { LanguageRegistry } from "@kernel/language-id.ts";

const MODELS = `
export interface Collection<T> { type: string; items: T[] }
export interface Item { id: number; x?: string; label: string }
`;
const API = `
import { Observable } from "rxjs";
import { HttpClient } from "@client/http";
import { Collection, Item } from "./models";
export class ThingsApi {
  constructor(private http: HttpClient, private base: string) {}
  list(): Observable<Collection<Item>> { return this.http.get(\`\${this.base}/things\`); }
}
`;
const FILES = {
  "src/models.ts": MODELS,
  "src/api.ts": API,
  "src/view-a.ts": "export const label = (item: { x?: string }) => item.x ?? '';\n",
  "src/view-b.ts": "export function again(item: { x?: string }) { const { x } = item; return x; }\n",
};

const THINGS = "https://app.example/api/things";
const live = (names: string[], items = 3): PageShapes => {
  const shape: DataShape = { method: "GET", url: THINGS, items, keys: ["geometry", "id"], names, complete: true };
  return { route: "/browse", shapes: { listed: [shape], omitted: 0 } };
};

const gapsOf = (files: Record<string, string>, page: PageShapes, document?: string) => {
  const expectationsOf = createTypeScriptExpectations({ files: new Map(Object.entries(files)), isTestFile: (file) => LanguageRegistry.isTestFile(file) });
  const parsed = document === undefined ? undefined : parse(document);
  const fieldsOf = parsed === undefined ? undefined : (method: string, url: string) => responseFieldNames(parsed, method, new URL(url).pathname);
  return findExpectationGaps([page], { expectationsOf, ...(fieldsOf ? { fieldsOf } : {}) }).facts;
};

const DOCUMENT = (properties: string): string => `
openapi: 3.0.0
paths:
  /things:
    get:
      responses:
        "200":
          content:
            application/json:
              schema:
                type: object
                properties:
                  items:
                    type: array
                    items: { type: object, properties: { ${properties} } }
`;

test("a field the consumer's declared type holds and two files read, absent from live responses of the operation at every depth, is one gap", () => {
  const facts = gapsOf(FILES, live(["geometry", "id", "items", "properties", "type"]));
  assert.equal(facts.length, 1);
  const [gap] = facts;
  assert.equal(gap!.key, "x");
  assert.equal(gap!.operation, `GET ${THINGS}`);
  assert.deepEqual(gap!.consumer.reads, ["src/view-a.ts:1", "src/view-b.ts:1"]);
  assert.equal(gap!.consumer.callSite, "src/api.ts:7");
  assert.match(gap!.consumer.declaredType, /Observable<Collection<Item>>/);
});

test("the same field carried at any depth of a live response is no gap", () => {
  assert.deepEqual(gapsOf(FILES, live(["geometry", "id", "items", "properties", "type", "x"])), []);
});

test("a field the consumer writes is client-owned: no gap", () => {
  assert.deepEqual(gapsOf({ ...FILES, "src/fill.ts": "export function fill(item: { x?: string }) { item.x = 'computed'; }\n" }, live(["id"])), []);
});

test("the provider's document classifies the gap: it does not declare the field, declares it, or there is none", () => {
  const provider = (document?: string): string | undefined => gapsOf(FILES, live(["id"]), document)[0]?.provider;
  assert.equal(provider(DOCUMENT("id: {}, label: {}")), "provider-undeclared");
  assert.equal(provider(DOCUMENT("id: {}, x: {}")), "provider-declared-absent");
  assert.equal(provider(), "no-provider-contract");
});

test("nothing of the app's name, of GeoJSON or of a threshold decides: the same fixture under other names gives the same gap", () => {
  const renamed = Object.fromEntries(Object.entries(FILES).map(([file, text]) => [file, text.replaceAll("Collection", "Bundle").replaceAll("Item", "Entry").replaceAll("things", "stuff").replaceAll("Things", "Stuff")]));
  const page = live(["id"]);
  const shape: DataShape = { ...page.shapes.listed[0]!, url: "https://app.example/api/stuff" };
  const facts = gapsOf(renamed, { ...page, shapes: { listed: [shape], omitted: 0 } });
  assert.deepEqual(facts.map((f) => f.key), ["x"]);
});
