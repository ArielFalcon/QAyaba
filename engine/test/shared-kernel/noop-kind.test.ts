import { test } from "node:test";
import assert from "node:assert/strict";
import { NOOP_KIND, readNoopKind } from "@kernel/noop-kind.ts";

test("a no-op names one of its two reasons, and anything else is recorded as unspecified", () => {
  assert.equal(readNoopKind("not-worth"), NOOP_KIND.NOT_WORTH);
  assert.equal(readNoopKind("unobservable"), NOOP_KIND.UNOBSERVABLE);
  for (const other of [undefined, null, "", "Unobservable", "not worth", 3, {}, ["unobservable"]]) {
    assert.equal(readNoopKind(other), NOOP_KIND.UNSPECIFIED, JSON.stringify(other));
  }
});
