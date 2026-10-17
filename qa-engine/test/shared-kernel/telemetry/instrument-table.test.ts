import { test } from "node:test";
import assert from "node:assert/strict";
import { INSTRUMENTS, checkInstrumentTable, type InstrumentTable } from "@kernel/telemetry/instrument-table.ts";

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
