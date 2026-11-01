import { test } from "node:test";
import assert from "node:assert/strict";
import { readVerdict } from "@contexts/generation/domain/verdict-parse.ts";
import { NOOP_KIND } from "@kernel/noop-kind";

const verdict = (noop: unknown): Record<string, unknown> => ({ specs: [], noop });

test("a declared no-op carries the kind it names", () => {
  assert.equal(readVerdict(verdict({ kind: "unobservable", reason: "the end-of-list button was not on the page: DEV listed no rows" })).noopKind, NOOP_KIND.UNOBSERVABLE);
  assert.equal(readVerdict(verdict({ kind: "not-worth", reason: "a renamed helper" })).noopKind, NOOP_KIND.NOT_WORTH);
});

test("a no-op without a kind, or with one the contract does not name, is read as unspecified", () => {
  assert.equal(readVerdict(verdict({ reason: "a renamed helper" })).noopKind, NOOP_KIND.UNSPECIFIED);
  assert.equal(readVerdict(verdict({ kind: "whatever", reason: "a renamed helper" })).noopKind, NOOP_KIND.UNSPECIFIED);
});

test("the reason of an unobservable no-op is kept as the agent wrote it, trimmed", () => {
  const reason = "  the button 'Cambiar filtros' needs rows; the captured tree showed none  ";
  assert.equal(readVerdict(verdict({ kind: "unobservable", reason })).noopReason, reason.trim());
});

test("a kind without a reason is no declared no-op and records no kind", () => {
  const read = readVerdict(verdict({ kind: "unobservable" }));
  assert.equal(read.noopReason, undefined);
  assert.equal(read.noopKind, undefined);
});

test("a verdict that declares no no-op records no kind", () => {
  assert.equal(readVerdict({ specs: ["flows/a.spec.ts"] }).noopKind, undefined);
});
