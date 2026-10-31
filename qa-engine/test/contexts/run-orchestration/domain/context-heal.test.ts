import { test } from "node:test";
import assert from "node:assert/strict";
import { staleFlagHeal, staleMapHeal } from "@contexts/run-orchestration/domain/context-heal.ts";

const primary = { mode: "diff", triggeredByService: false, frozen: false } as const;

test("a primary-repo run that meets the audit's stale flag asks for a rebuild, and a frozen one withholds the request", () => {
  assert.equal(staleFlagHeal(primary, () => true), "request");
  assert.equal(staleFlagHeal({ ...primary, frozen: true }, () => true), "withhold");
  assert.equal(staleFlagHeal(primary, () => false), "none");
  assert.equal(staleFlagHeal({ ...primary, frozen: true }, () => false), "none");
});

test("a context run, which is the rebuild, and a service-triggered run, whose sha is not the primary's, never act on the flag nor read it", () => {
  const unread = () => assert.fail("the flag is read only for a run that can act on it");
  assert.equal(staleFlagHeal({ ...primary, mode: "context" }, unread), "none");
  assert.equal(staleFlagHeal({ ...primary, triggeredByService: true }, unread), "none");
  for (const mode of ["diff", "manual"] as const) assert.equal(staleFlagHeal({ ...primary, mode }, () => true), "request", mode);
});

test("a stale map asks for its rebuild once per commit: a second ask, or a frozen run, withholds it", () => {
  assert.equal(staleMapHeal(primary, { stale: true }, false), "request");
  assert.equal(staleMapHeal(primary, { stale: true }, true), "withhold");
  assert.equal(staleMapHeal({ ...primary, frozen: true }, { stale: true }, false), "withhold");
});

test("a map that is not stale, no map at all, and a context run ask for nothing", () => {
  assert.equal(staleMapHeal(primary, { stale: false }, false), "none");
  assert.equal(staleMapHeal(primary, {}, false), "none");
  assert.equal(staleMapHeal(primary, undefined, false), "none");
  assert.equal(staleMapHeal({ ...primary, mode: "context" }, { stale: true }, false), "none");
  assert.equal(staleMapHeal({ ...primary, mode: "context", frozen: true }, { stale: true }, true), "none");
});
