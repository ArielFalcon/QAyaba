import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVerdict } from "./verdict-parse";
import { repairInstruction } from "./verdict-validate";
import { NOOP_KIND } from "@kernel/noop-kind";

const verdict = (noop: unknown): string => JSON.stringify({ specs: [], noop });

test("a declared no-op carries the kind it names", () => {
  assert.equal(parseVerdict(verdict({ kind: "unobservable", reason: "the end-of-list button was not on the page: DEV listed no rows" })).noopKind, NOOP_KIND.UNOBSERVABLE);
  assert.equal(parseVerdict(verdict({ kind: "not-worth", reason: "a renamed helper" })).noopKind, NOOP_KIND.NOT_WORTH);
});

test("a no-op without a kind, or with one the contract does not name, is read as unspecified", () => {
  assert.equal(parseVerdict(verdict({ reason: "a renamed helper" })).noopKind, NOOP_KIND.UNSPECIFIED);
  assert.equal(parseVerdict(verdict({ kind: "whatever", reason: "a renamed helper" })).noopKind, NOOP_KIND.UNSPECIFIED);
});

test("the reason of an unobservable no-op is kept as the agent wrote it, trimmed", () => {
  const reason = "  the button 'Cambiar filtros' needs rows; the captured tree showed none  ";
  assert.equal(parseVerdict(verdict({ kind: "unobservable", reason })).noopReason, reason.trim());
});

test("a kind without a reason is no declared no-op and records no kind", () => {
  const read = parseVerdict(verdict({ kind: "unobservable" }));
  assert.equal(read.noopReason, undefined);
  assert.equal(read.noopKind, undefined);
});

test("the repair of a generator verdict names the kind a no-op carries", () => {
  const instruction = repairInstruction("generator", ["no closing verdict"]);
  assert.ok(instruction.includes(NOOP_KIND.NOT_WORTH) && instruction.includes(NOOP_KIND.UNOBSERVABLE));
});

test("a verdict that declares no no-op records no kind", () => {
  assert.equal(parseVerdict('{"specs":["flows/a.spec.ts"]}').noopKind, undefined);
});
