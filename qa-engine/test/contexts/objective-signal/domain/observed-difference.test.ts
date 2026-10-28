/* What a mutation moved: the requests and the accessible tree of the same tests run with and without it, compared per test against two unmutated runs, whose own differences are noise. A fact handed to the author, never a gate. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { diffObservations, MAX_MOVED_ITEMS, movedBySpecFile } from "@contexts/objective-signal/domain/observed-difference.ts";
import type { ObservedPage } from "@contexts/objective-signal/domain/observed-page.ts";

const STYLE_LIGHT = "https://api.maps.example/styles/v1/acme/light";
const STYLE_DARK = "https://api.maps.example/styles/v1/acme/dark";

const page = (name: string, requests: Array<[string, string, number?]>, dom: string[] = ["heading: Map"]): ObservedPage => ({
  name,
  requests: requests.map(([method, url, count]) => ({ method, url, count: count ?? 1 })),
  dom,
});

/* Two unmutated runs that observed the same pages: no noise between them. */
const twice = (pages: ObservedPage[] | undefined): [ObservedPage[] | undefined, ObservedPage[] | undefined] => [pages, pages];

test("a request only the mutated run made, and one only the unmutated runs made, are the observable that moved", () => {
  const baseline = [page("map.spec.ts › theme", [["GET", STYLE_LIGHT], ["GET", "https://dev.example.com/api/places"]])];
  const mutant = [page("map.spec.ts › theme", [["GET", STYLE_DARK], ["GET", "https://dev.example.com/api/places"]])];

  const moved = diffObservations(twice(baseline), mutant, new Set(["map.spec.ts › theme"]));

  assert.deepEqual(moved, {
    kind: "moved",
    requests: { added: [`GET ${STYLE_DARK}`], removed: [`GET ${STYLE_LIGHT}`] },
    dom: { added: [], removed: [] },
    tests: ["map.spec.ts › theme"],
  });
});

test("a line of the accessible tree only one side showed is the observable that moved", () => {
  const baseline = [page("a.spec.ts › t", [], ["heading: Map", "button: Light theme"])];
  const mutant = [page("a.spec.ts › t", [], ["heading: Map", "button: Dark theme [pressed]"])];

  const moved = diffObservations(twice(baseline), mutant, new Set(["a.spec.ts › t"]));

  assert.equal(moved.kind, "moved");
  assert.deepEqual(moved.kind === "moved" && moved.dom, { added: ["button: Dark theme [pressed]"], removed: ["button: Light theme"] });
});

test("the same requests and the same tree under the mutation are stated as nothing moved, with how many tests were compared", () => {
  const same = (name: string) => page(name, [["GET", STYLE_LIGHT, 2]]);
  const moved = diffObservations(twice([same("a.spec.ts › one"), same("a.spec.ts › two")]), [same("a.spec.ts › one"), same("a.spec.ts › two")], new Set(["a.spec.ts › one", "a.spec.ts › two"]));
  assert.deepEqual(moved, { kind: "unmoved", tests: 2 });
});

test("how many times a request was made is not an observable that moved: a poll that ran once more is noise, a new request is not", () => {
  const moved = diffObservations(twice([page("a.spec.ts › t", [["GET", STYLE_LIGHT, 1]])]), [page("a.spec.ts › t", [["GET", STYLE_LIGHT, 3]])], new Set(["a.spec.ts › t"]));
  assert.deepEqual(moved, { kind: "unmoved", tests: 1 });
});

test("only the tests every run observed and that are comparable are compared: a test that failed in any run says nothing of the mutation", () => {
  const baseline = [page("a.spec.ts › kept", [["GET", STYLE_LIGHT]]), page("a.spec.ts › flaky", [["GET", STYLE_LIGHT]]), page("a.spec.ts › baseline only", [])];
  const mutant = [page("a.spec.ts › kept", [["GET", STYLE_LIGHT]]), page("a.spec.ts › flaky", [["GET", STYLE_DARK]])];

  const moved = diffObservations(twice(baseline), mutant, new Set(["a.spec.ts › kept", "a.spec.ts › baseline only"]));

  assert.deepEqual(moved, { kind: "unmoved", tests: 1 });
});

test("with no observation of one run, or no test every run observed, nothing is claimed either way", () => {
  const some = [page("a.spec.ts › t", [])];
  assert.deepEqual(diffObservations(twice(undefined), some, new Set(["a.spec.ts › t"])), { kind: "unobserved", reason: "baseline" });
  assert.deepEqual(diffObservations(twice(some), undefined, new Set(["a.spec.ts › t"])), { kind: "unobserved", reason: "mutant" });
  assert.deepEqual(diffObservations(twice(some), [page("a.spec.ts › other", [])], new Set(["a.spec.ts › t"])), { kind: "unobserved", reason: "no-common-test" });
});

test("what moved is bounded and cut: past the cap the rest is counted, a long line is cut, and a request seen in several tests is listed once", () => {
  const many = Array.from({ length: MAX_MOVED_ITEMS + 5 }, (_, i): [string, string] => ["GET", `https://dev.example.com/api/item/${i}`]);
  const long = `link: ${"x".repeat(500)}`;
  const moved = diffObservations(
    twice([page("a.spec.ts › one", [], []), page("a.spec.ts › two", [], [])]),
    [page("a.spec.ts › one", many, [long]), page("a.spec.ts › two", many.slice(0, 2), [])],
    new Set(["a.spec.ts › one", "a.spec.ts › two"]),
  );

  assert.equal(moved.kind, "moved");
  if (moved.kind !== "moved") return;
  assert.equal(moved.requests.added.length, MAX_MOVED_ITEMS);
  assert.equal(new Set(moved.requests.added).size, MAX_MOVED_ITEMS);
  assert.equal(moved.omitted, 5, "the requests past the cap are counted");
  assert.ok(moved.dom.added[0]!.length < 300 && moved.dom.added[0]!.endsWith("…"));
  assert.deepEqual(moved.tests, ["a.spec.ts › one", "a.spec.ts › two"]);
});

/* ── The noise floor: what differs between two unmutated runs of the same tests is run-to-run noise, never what a mutation moved ── */

const TOKEN = "https://auth.example/token";
const TILE_Z12 = "https://tiles.example/12/4/7";
const TILE_Z13 = "https://tiles.example/13/8/14";

test("a request or a tree line that differs between the two unmutated runs is noise and is never reported as moved; one both showed that the mutated run lacks moved", () => {
  const name = "map.spec.ts › theme";
  const first = [page(name, [["GET", STYLE_LIGHT], ["POST", TOKEN], ["GET", TILE_Z12]], ["heading: Map", "text: 11 €"])];
  const second = [page(name, [["GET", STYLE_LIGHT], ["GET", TILE_Z13]], ["heading: Map", "text: 12 €"])];
  const mutant = [page(name, [["GET", STYLE_DARK], ["GET", TILE_Z12]], ["heading: Map", "text: 12 €"])];

  const moved = diffObservations([first, second], mutant, new Set([name]));

  assert.deepEqual(moved, {
    kind: "moved",
    requests: { added: [`GET ${STYLE_DARK}`], removed: [`GET ${STYLE_LIGHT}`] },
    dom: { added: [], removed: [] },
    tests: [name],
  });
});

test("a mutated run whose every difference is noise moved nothing", () => {
  const name = "map.spec.ts › theme";
  const first = [page(name, [["POST", TOKEN]], ["heading: Map", "text: 11 €"])];
  const second = [page(name, [], ["heading: Map", "text: 12 €"])];
  const moved = diffObservations([first, second], [page(name, [["POST", TOKEN]], ["heading: Map", "text: 12 €"])], new Set([name]));
  assert.deepEqual(moved, { kind: "unmoved", tests: 1 });
});

test("without the second unmutated observation there is no noise floor, so nothing is claimed; a test only one unmutated run observed is not compared", () => {
  const name = "a.spec.ts › t";
  const some = [page(name, [])];
  assert.deepEqual(diffObservations([some, undefined], [page(name, [["GET", STYLE_DARK]])], new Set([name])), { kind: "unobserved", reason: "baseline" });
  assert.deepEqual(diffObservations([some, [page("a.spec.ts › other", [])]], [page(name, [["GET", STYLE_DARK]])], new Set([name])), { kind: "unobserved", reason: "no-common-test" });
});

test("what moved is told per spec file: each file is compared over its own tests only, so a file whose pages show nothing of the mutant is unmoved", () => {
  const map = "flows/map.spec.ts › theme";
  const list = "flows/list.spec.ts › rows";
  const files = new Map([[map, "flows/map.spec.ts"], [list, "flows/list.spec.ts"]]);
  const plain = [page(map, [["GET", STYLE_LIGHT]]), page(list, [["GET", "https://dev.example.com/api/places"]])];
  const mutant = [page(map, [["GET", STYLE_DARK]]), page(list, [["GET", "https://dev.example.com/api/places"]])];

  const bySpec = movedBySpecFile(twice(plain), mutant, new Set([map, list]), (name) => files.get(name), ["flows/list.spec.ts", "flows/map.spec.ts", "flows/other.spec.ts"]);

  assert.deepEqual(bySpec, [
    { spec: "flows/list.spec.ts", moved: { kind: "unmoved", tests: 1 } },
    { spec: "flows/map.spec.ts", moved: { kind: "moved", requests: { added: [`GET ${STYLE_DARK}`], removed: [`GET ${STYLE_LIGHT}`] }, dom: { added: [], removed: [] }, tests: [map] } },
    { spec: "flows/other.spec.ts", moved: { kind: "unobserved", reason: "no-common-test" } },
  ]);
});
