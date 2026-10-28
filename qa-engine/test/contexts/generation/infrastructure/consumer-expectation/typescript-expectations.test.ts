/*
 * What a consumer's own TypeScript expects of the answer to a request: the fields of the type the call site declares for the answer
 * that non-test code reads and nothing writes. Fixture sources only, the names are generic (a collection of items with an optional
 * field), the extractor knows no app and no framework: an HTTP client it cannot resolve is just a call with a path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTypeScriptExpectations, type ExpectationLink } from "@contexts/generation/infrastructure/consumer-expectation/typescript-expectations.ts";
import type { OperationExpectation } from "@contexts/generation/domain/consumer-expectation.ts";
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
  list(): Observable<Collection<Item>> {
    return this.http.get<Collection<Item>>(\`\${this.base}/things\`);
  }
}
`;

const READS_X = "export function showX(item: { x?: string }) { return item.x ?? ''; }\n";
const DESTRUCTURES_X = "export function showAgain(item: { x?: string }) { const { x } = item; return x; }\n";

const sources = (extra: Record<string, string> = {}): Map<string, string> =>
  new Map(Object.entries({ "src/models.ts": MODELS, "src/api.ts": API, "src/view-a.ts": READS_X, "src/view-b.ts": DESTRUCTURES_X, ...extra }));

const expect = (files: Map<string, string>, request = { method: "GET", path: "/things" }, links: readonly ExpectationLink[] = []): OperationExpectation | undefined =>
  createTypeScriptExpectations({ files, isTestFile: (file) => LanguageRegistry.isTestFile(file), links })(request);

const names = (expectation: OperationExpectation | undefined): string[] => expectation?.fields.map((field) => field.name) ?? [];

test("a field the declared answer type holds, read in two files and written nowhere, is expected, with where it is read", () => {
  const expectation = expect(sources());
  assert.deepEqual(names(expectation), ["x"]);
  const x = expectation!.fields[0]!;
  assert.deepEqual(x.reads.map((site) => site.file), ["src/view-a.ts", "src/view-b.ts"]);
  assert.equal(x.readCount, 2);
  assert.deepEqual(expectation!.callSites.map((c) => [c.site.file, c.symbol]), [["src/api.ts", "list"]]);
});

test("a field that is never read is not expected, however the type declares it", () => {
  assert.deepEqual(names(expect(sources({ "src/view-a.ts": "export const a = 1;\n", "src/view-b.ts": "export const b = 2;\n" }))), []);
});

test("a field a non-test file writes is client-owned and not expected: an assignment, an object-literal key, a spread override", () => {
  for (const writer of ["export function w(item: { x?: string }) { item.x = 'v'; }\n", "export const w = { x: 'v', id: 1 };\n", "export const w = (base: object) => ({ ...base, x: 'v' });\n", "export function w(item: Record<string, string>) { item['x'] = 'v'; }\n"]) {
    assert.deepEqual(names(expect(sources({ "src/writer.ts": writer }))), [], writer);
  }
});

test("a read or a write in a test file counts for nothing", () => {
  assert.deepEqual(names(expect(sources({ "src/view-a.ts": "export const a = 1;\n", "src/view-b.ts": "export const b = 2;\n", "src/view.spec.ts": READS_X }))), []);
  assert.deepEqual(names(expect(sources({ "src/writer.spec.ts": "export const w = { x: 'v' };\n" }))), ["x"]);
});

test("a type argument of the call is the declared answer when the enclosing function declares none, and a utility type from the bundled library resolves", () => {
  const api = `
    import { Item } from "./models";
    export class ThingsApi {
      list() { return this.http.get<Partial<Pick<Item, "x" | "id">>>("/things"); }
    }
  `;
  assert.deepEqual(names(expect(sources({ "src/api.ts": api }))), ["x"]);
});

test("a package that is not installed contributes the properties of its type arguments: the enclosing function's declared answer, and a generic with two arguments of which one cannot be resolved", () => {
  const wrapped = `
    import { Observable } from "rxjs";
    import { Collection, Item } from "./models";
    export class ThingsApi {
      list(): Observable<Collection<Item>> { return this.http.get(\`\${this.base}/things\`); }
    }
  `;
  assert.deepEqual(names(expect(sources({ "src/api.ts": wrapped }))), ["x"]);
  const geo = `
    import { FeatureCollection, Point } from "geojson";
    import { Item } from "./models";
    export function load(): Promise<FeatureCollection<Point, Item>> { return http.get("/things"); }
  `;
  assert.deepEqual(names(expect(sources({ "src/api.ts": geo }))), ["x"]);
});

test("a path built from a template, a constant of another file and an unresolved base is matched by its literal segments", () => {
  const api = `
    import { Item } from "./models";
    import { ITEMS } from "./paths";
    export function load(id: string): Promise<Item> { return fetchJson(\`\${process.env.API}\${ITEMS}/\${id}/detail\`); }
  `;
  const files = sources({ "src/api.ts": api, "src/paths.ts": "export const ITEMS = '/items';\n" });
  assert.deepEqual(names(expect(files, { method: "GET", path: "/v1/items/42/detail" })), ["x"]);
  assert.equal(expect(files, { method: "GET", path: "/things" }), undefined);
});

test("a call that names another verb does not serve a request of this one", () => {
  const api = `
    import { Item } from "./models";
    export function save(): Promise<Item> { return http.post("/things", {}); }
  `;
  assert.equal(expect(sources({ "src/api.ts": api })), undefined);
});

test("a declared type it cannot resolve yields no expectation, and so does an operation one of whose call sites it cannot read", () => {
  const unresolved = `
    import { Unknown } from "./nowhere";
    export function load(): Promise<Unknown> { return http.get("/things"); }
  `;
  assert.equal(expect(sources({ "src/api.ts": unresolved })), undefined);
  const two = `${API}\nexport function again(): Promise<Unknown2> { return http.get("/things"); }\n`;
  assert.equal(expect(sources({ "src/api.ts": two.replace("import { Observable }", "import { Unknown2 } from './nowhere';\nimport { Observable }") })), undefined);
});

test("several call sites that serve one operation share only the fields all of them expect", () => {
  const second = `
    export interface Narrow { id: number; label: string }
    export function narrow(): Promise<Narrow> { return http.get("/things"); }
  `;
  assert.deepEqual(names(expect(sources({ "src/narrow.ts": second }))), []);
  const same = `
    import { Item } from "./models";
    export function again(): Promise<Item[]> { return http.get("/things"); }
  `;
  const expectation = expect(sources({ "src/again.ts": same }));
  assert.deepEqual(names(expectation), ["x"]);
  assert.equal(expectation!.callSites.length, 2);
});

test("with a link the resolver made, the function it names serves the operation even when its path cannot be read", () => {
  const api = `
    import { Item } from "./models";
    export class ThingsApi {
      list(path: string): Promise<Item[]> { return this.http.get(path); }
    }
  `;
  const files = sources({ "src/api.ts": api });
  assert.equal(expect(files), undefined);
  const link: ExpectationLink = { file: "src/api.ts", symbol: "list", operation: { verb: "GET", path: "/things" } };
  assert.deepEqual(names(expect(files, { method: "GET", path: "/gateway/things" }, [link])), ["x"]);
  assert.equal(expect(files, { method: "GET", path: "/gateway/other" }, [link]), undefined);
});

test("an import the repository's module configuration maps is followed to its declaration", () => {
  const files = sources({
    "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@models/*": ["src/*"] } } }),
    "src/api.ts": API.replace('"./models"', '"@models/models"'),
  });
  assert.deepEqual(names(expect(files)), ["x"]);
});

test("a local alias, a generic alias and an interface that extend a generic of an uninstalled package contribute what the types they are given are", () => {
  const alias = `
    import { Observable } from "rxjs";
    import { Bundle, Marker } from "geojson";
    import { Item } from "./models";
    export type ItemBundle = Bundle<Marker, Item>;
    export type Wrapped<T> = Bundle<Marker, T>;
    export interface ItemBundleOf extends Bundle<Marker, Item> { extra: string }
    export class A { one(): Observable<ItemBundle> { return this.http.get("/aliased"); } }
    export class B { two(): Observable<Wrapped<Item>> { return this.http.get("/generic"); } }
    export class C { three(): Observable<ItemBundleOf> { return this.http.get("/extended"); } }
  `;
  const files = sources({ "src/api.ts": alias });
  for (const path of ["/aliased", "/generic", "/extended"]) assert.deepEqual(names(expect(files, { method: "GET", path })), ["x"], path);
});

test("an alias that refers to itself, or to a chain of aliases, is followed once and ends", () => {
  const looping = `
    import { Bundle } from "geojson";
    export type A = B;
    export type B = A | Bundle<string, A>;
    export function load(): Promise<A> { return http.get("/loop"); }
  `;
  assert.equal(expect(sources({ "src/api.ts": looping }), { method: "GET", path: "/loop" }), undefined);
});

test("the methods of a primitive, a literal or a date a field holds are not fields the provider is expected to serve", () => {
  const view = `
    export function show(item: { label: string; price: number; at: Date; kind: "a" | "b"; id: number }) {
      return item.label.trim() + item.label.charAt(0) + item.price.toFixed(2) + item.at.getTime() + item.kind.toUpperCase() + item.id;
    }
  `;
  const models = "export interface Item { id: number; label: string; price: number; at: Date; kind: 'a' | 'b'; note: string | null }\n";
  const api = "import { Item } from './models';\nexport function list(): Promise<Item[]> { return http.get('/things'); }\n";
  assert.deepEqual(names(expect(sources({ "src/models.ts": models, "src/api.ts": api, "src/view-a.ts": view, "src/view-b.ts": "export const b = 1;\n" }))), ["at", "id", "kind", "label", "price"]);
});

test("a path with no leading slash is a path relative to the base address, as long as it has more than one segment", () => {
  const api = (call: string): string => `
    import { Item } from "./models";
    export function load(code: string): Promise<Item[]> { return ${call}; }
  `;
  const files = (call: string) => sources({ "src/api.ts": api(call) });
  assert.deepEqual(names(expect(files("http.get('api/things')"), { method: "GET", path: "/api/things" })), ["x"]);
  assert.deepEqual(names(expect(files("rest.get(`service-api/things/by/${code}`)"), { method: "GET", path: "/service-api/things/by/ES" })), ["x"]);
  assert.equal(expect(files("translate.get('things')"), { method: "GET", path: "/things" }), undefined, "a bare word is no path");
  assert.equal(expect(files("log.info('hello world/again')"), { method: "GET", path: "/hello world/again" }), undefined, "a sentence is no path");
});

test("a call that only names the address (to resolve it, to invalidate a cache entry) is no call site of the request", () => {
  const api = `
    import { Item } from "./models";
    export const THINGS_PATH = "service-api/things";
    export function load(): Promise<Item[]> { return rest.get(THINGS_PATH); }
  `;
  const naming = `
    import { THINGS_PATH } from "./api";
    export function urlOfThings() { return rest.resolveUrl(THINGS_PATH); }
    export function forget() { cache.invalidate(THINGS_PATH); }
  `;
  const found = expect(sources({ "src/api.ts": api, "src/naming.ts": naming }), { method: "GET", path: "/service-api/things" });
  assert.deepEqual(names(found), ["x"]);
  assert.equal(found?.callSites.length, 1);
});

test("a test file is not part of the program: a type only a test declares is not followed, and a read or write in it counts for nothing", () => {
  const api = "import { Item } from './item.spec';\nexport function load(): Promise<Item[]> { return http.get('/things'); }\n";
  assert.equal(expect(sources({ "src/api.ts": api, "src/item.spec.ts": "export interface Item { x?: string }\n" })), undefined);
});
