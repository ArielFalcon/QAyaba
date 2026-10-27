/* What a mutation moved: the requests and the accessible tree of the same tests run with and without it, compared per test. A fact handed to the author, never a gate. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { diffObservations, MAX_MOVED_ITEMS } from "@contexts/objective-signal/domain/observed-difference.ts";
import type { ObservedPage } from "@contexts/objective-signal/domain/observed-page.ts";

const STYLE_LIGHT = "https://api.maps.example/styles/v1/acme/light";
const STYLE_DARK = "https://api.maps.example/styles/v1/acme/dark";

const page = (name: string, requests: Array<[string, string, number?]>, dom: string[] = ["heading: Map"]): ObservedPage => ({
  name,
  requests: requests.map(([method, url, count]) => ({ method, url, count: count ?? 1 })),
  dom,
});

test("a request only the mutated run made, and one only the unmutated run made, are the observable that moved", () => {
  const baseline = [page("map.spec.ts › theme", [["GET", STYLE_LIGHT], ["GET", "https://dev.example.com/api/places"]])];
  const mutant = [page("map.spec.ts › theme", [["GET", STYLE_DARK], ["GET", "https://dev.example.com/api/places"]])];

  const moved = diffObservations(baseline, mutant, new Set(["map.spec.ts › theme"]));

  assert.deepEqual(moved, {
    kind: "moved",
    requests: { added: [`GET ${STYLE_DARK}`], removed: [`GET ${STYLE_LIGHT}`] },
    dom: { added: [], removed: [] },
    tests: ["map.spec.ts › theme"],
  });
});

test("a line of the accessible tree only one run showed is the observable that moved", () => {
  const baseline = [page("a.spec.ts › t", [], ["heading: Map", "button: Light theme"])];
  const mutant = [page("a.spec.ts › t", [], ["heading: Map", "button: Dark theme [pressed]"])];

  const moved = diffObservations(baseline, mutant, new Set(["a.spec.ts › t"]));

  assert.equal(moved.kind, "moved");
  assert.deepEqual(moved.kind === "moved" && moved.dom, { added: ["button: Dark theme [pressed]"], removed: ["button: Light theme"] });
});

test("the same requests and the same tree under the mutation are stated as nothing moved, with how many tests were compared", () => {
  const same = (name: string) => page(name, [["GET", STYLE_LIGHT, 2]]);
  const moved = diffObservations([same("a.spec.ts › one"), same("a.spec.ts › two")], [same("a.spec.ts › one"), same("a.spec.ts › two")], new Set(["a.spec.ts › one", "a.spec.ts › two"]));
  assert.deepEqual(moved, { kind: "unmoved", tests: 2 });
});

test("how many times a request was made is not an observable that moved: a poll that ran once more is noise, a new request is not", () => {
  const moved = diffObservations([page("a.spec.ts › t", [["GET", STYLE_LIGHT, 1]])], [page("a.spec.ts › t", [["GET", STYLE_LIGHT, 3]])], new Set(["a.spec.ts › t"]));
  assert.deepEqual(moved, { kind: "unmoved", tests: 1 });
});

test("only the tests both runs observed and that are comparable are compared: a test that failed in either run says nothing of the mutation", () => {
  const baseline = [page("a.spec.ts › kept", [["GET", STYLE_LIGHT]]), page("a.spec.ts › flaky", [["GET", STYLE_LIGHT]]), page("a.spec.ts › baseline only", [])];
  const mutant = [page("a.spec.ts › kept", [["GET", STYLE_LIGHT]]), page("a.spec.ts › flaky", [["GET", STYLE_DARK]])];

  const moved = diffObservations(baseline, mutant, new Set(["a.spec.ts › kept", "a.spec.ts › baseline only"]));

  assert.deepEqual(moved, { kind: "unmoved", tests: 1 });
});

test("with no observation of one run, or no test both observed, nothing is claimed either way", () => {
  const some = [page("a.spec.ts › t", [])];
  assert.deepEqual(diffObservations(undefined, some, new Set(["a.spec.ts › t"])), { kind: "unobserved", reason: "baseline" });
  assert.deepEqual(diffObservations(some, undefined, new Set(["a.spec.ts › t"])), { kind: "unobserved", reason: "mutant" });
  assert.deepEqual(diffObservations(some, [page("a.spec.ts › other", [])], new Set(["a.spec.ts › t"])), { kind: "unobserved", reason: "no-common-test" });
});

test("what moved is bounded and cut: past the cap the rest is counted, a long line is cut, and a request seen in several tests is listed once", () => {
  const many = Array.from({ length: MAX_MOVED_ITEMS + 5 }, (_, i): [string, string] => ["GET", `https://dev.example.com/api/item/${i}`]);
  const long = `link: ${"x".repeat(500)}`;
  const moved = diffObservations(
    [page("a.spec.ts › one", [], []), page("a.spec.ts › two", [], [])],
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
