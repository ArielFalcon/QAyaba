import { test } from "node:test";
import assert from "node:assert/strict";
import { RunGeolocation } from "@contexts/qa-run-orchestration/domain/run-geolocation.ts";

const MADRID = { latitude: 40.4168, longitude: -3.7038 };
const BARCELONA = { latitude: 41.3874, longitude: 2.1686 };

function state(): RunGeolocation {
  return new RunGeolocation({ default: MADRID, places: { barcelona: BARCELONA, madrid: MADRID } });
}

test("the run starts at the app's default, with its places named and sorted", () => {
  const geo = state();
  assert.deepEqual(geo.facts(), { default: MADRID, current: MADRID, places: { barcelona: BARCELONA, madrid: MADRID }, scope: "run" });
  assert.deepEqual(geo.placeNames(), ["barcelona", "madrid"]);
});

test("the lead moves the run's value by a declared place or by a point, and the answer names the scope", () => {
  const geo = state();
  assert.deepEqual(geo.set(undefined, { place: "Barcelona" }), { ok: true, location: BARCELONA, scope: "run", place: "barcelona" });
  assert.deepEqual(geo.facts().current, BARCELONA);
  assert.deepEqual(geo.set(undefined, { latitude: 10, longitude: 20 }), { ok: true, location: { latitude: 10, longitude: 20 }, scope: "run" });
  assert.deepEqual(geo.facts().current, { latitude: 10, longitude: 20 });
});

test("an unknown place or an invalid point is refused, and the run keeps its value", () => {
  const geo = state();
  const place = geo.set(undefined, { place: "atlantis" });
  assert.equal(place.ok, false);
  if (!place.ok) {
    assert.equal(place.code, "unknown-place");
    assert.match(place.message, /barcelona, madrid/);
  }
  const point = geo.set(undefined, { latitude: 91, longitude: 0 });
  assert.equal(point.ok, false);
  if (!point.ok) assert.equal(point.code, "invalid-location");
  assert.deepEqual(geo.facts().current, MADRID);
});

test("a flow inherits the lead's value when it opens, and each scope moves only itself", () => {
  const geo = state();
  geo.set(undefined, { place: "barcelona" });
  geo.openFlow("run-1-flow-a");
  assert.deepEqual(geo.flowFacts("run-1-flow-a")?.current, BARCELONA);

  const flow = geo.set("run-1-flow-a", { latitude: 0, longitude: 0 });
  assert.equal(flow.ok, true);
  assert.deepEqual(geo.currentFor("run-1-flow-a"), { latitude: 0, longitude: 0 });
  assert.deepEqual(geo.facts().current, BARCELONA, "the flow's change does not move the lead");

  geo.set(undefined, { latitude: 5, longitude: 5 });
  assert.deepEqual(geo.currentFor("run-1-flow-a"), { latitude: 0, longitude: 0 }, "the lead's change does not move an open flow");
});

test("a flow opened with a plan's location starts there; a closed flow can no longer be moved", () => {
  const geo = state();
  geo.openFlow("run-1-flow-a", BARCELONA);
  assert.deepEqual(geo.flowFacts("run-1-flow-a")?.current, BARCELONA);
  geo.closeFlow("run-1-flow-a");
  assert.equal(geo.flowFacts("run-1-flow-a"), undefined);
  const refused = geo.set("run-1-flow-a", { place: "madrid" });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.code, "unknown-scope");
});

test("a closed run accepts no change and reports no scope", () => {
  const geo = state();
  geo.close();
  assert.equal(geo.currentFor(undefined), undefined);
  const refused = geo.set(undefined, { place: "barcelona" });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.code, "closed");
});

test("a place name is matched without case and must be a slug", () => {
  const geo = state();
  assert.equal(geo.set(undefined, { place: "  BARCELONA  " }).ok, true);
  assert.throws(() => new RunGeolocation({ default: MADRID, places: { "Not A Slug": BARCELONA } }), /invalid place/);
});
