import { test } from "node:test";
import assert from "node:assert/strict";
import { INSTRUMENTS, checkInstrumentTable, type InstrumentTable } from "./instrument-table";

test("the shipped instrument table has no undeclared or denylisted attribute key", () => {
  assert.deepEqual(checkInstrumentTable(INSTRUMENTS), []);
});

test("an attribute key that is not in the registry fails the guard", () => {
  const table: InstrumentTable = { "x.count": { type: "counter", attrs: ["qayaba.never.registered" as "qayaba.app"] } };
  assert.match(checkInstrumentTable(table).join("\n"), /qayaba\.never\.registered.*registry/);
});

test("high-cardinality and denylisted keys fail the guard", () => {
  for (const key of ["qayaba.run.id", "qayaba.commit.sha", "qayaba.parent_run.id", "qayaba.egress.denied_cotemporal"] as const) {
    const table: InstrumentTable = { "x.count": { type: "counter", attrs: [key] } };
    assert.notDeepEqual(checkInstrumentTable(table), [], key);
  }
});

test("the denylist matches by name segment, not only by registry class", () => {
  const table = { "x.count": { type: "counter", attrs: ["a.url", "b.selector", "c.host", "d.path", "e.id"] } } as unknown as InstrumentTable;
  const out = checkInstrumentTable(table);
  for (const key of ["a.url", "b.selector", "c.host", "d.path", "e.id"]) assert.match(out.join("\n"), new RegExp(`${key.replace(".", "\\.")}.*denylist`));
});

test("the evaluation instruments are a gauge per score and a counter per closed class", () => {
  assert.deepEqual((INSTRUMENTS as InstrumentTable)["qayaba.eval.score"], {
    type: "gauge",
    attrs: ["qayaba.eval.name", "qayaba.eval.source", "qayaba.eval.data_type", "qayaba.app", "qayaba.verdict"],
  });
  assert.deepEqual((INSTRUMENTS as InstrumentTable)["qayaba.eval.class"], {
    type: "counter",
    attrs: ["qayaba.eval.name", "qayaba.eval.value"],
  });
});

test("the host-health instruments are declared with their types and only the closed stat attribute", () => {
  const expected = {
    "qayaba.host.suspend.count": "counter",
    "qayaba.host.suspend.duration": "histogram",
    "qayaba.host.event_loop.delay": "histogram",
    "qayaba.host.event_loop.blocked": "counter",
    "qayaba.sandbox.zombies": "gauge",
  } as const;
  for (const [name, type] of Object.entries(expected)) {
    const spec = (INSTRUMENTS as InstrumentTable)[name];
    assert.equal(spec?.type, type, name);
    assert.deepEqual(spec?.attrs, name === "qayaba.host.event_loop.delay" ? ["qayaba.event_loop.stat"] : [], name);
  }
});

test("the context metric instruments carry only the closed-set labels the design names", () => {
  const declared = {
    "qayaba.context.bytes": { type: "histogram", attrs: ["qayaba.context.source", "qayaba.context.stage"] },
    "qayaba.context.items": { type: "histogram", attrs: ["qayaba.context.source", "qayaba.context.stage"] },
    "qayaba.context.cut": { type: "counter", attrs: ["qayaba.context.source", "qayaba.context.cut_class", "qayaba.context.cut_reason"] },
    "qayaba.context.cut_items": { type: "histogram", attrs: ["qayaba.context.source", "qayaba.context.cut_class", "qayaba.context.cut_reason"] },
    "qayaba.context.freshness.age": { type: "histogram", attrs: ["qayaba.context.source"] },
    "qayaba.context.stale": { type: "counter", attrs: ["qayaba.context.source", "qayaba.context.stale_reason"] },
    "qayaba.context.recapture": { type: "counter", attrs: ["qayaba.context.source", "qayaba.context.recapture.outcome"] },
  } as const;
  for (const [name, spec] of Object.entries(declared)) {
    assert.deepEqual((INSTRUMENTS as InstrumentTable)[name], spec, name);
  }
  /* No ids, routes, paths or hosts may become a context metric label. */
  assert.deepEqual(checkInstrumentTable(INSTRUMENTS), []);
});
