import { test } from "node:test";
import assert from "node:assert/strict";
import { VerdictParserAdapter } from "@contexts/generation/infrastructure/verdict-parser.adapter";
import { readVerdict } from "@contexts/generation/domain/verdict-parse.ts";
import { NOOP_KIND } from "@kernel/noop-kind";

const adapter = new VerdictParserAdapter({ readVerdict });
const deliver = (answer: Record<string, unknown>) => adapter.readGenerator({ answer, output: "" });

test("the deliverable of a declared no-op carries its kind and its reason", () => {
  const got = deliver({ specs: [], noop: { kind: "unobservable", reason: "no rows on DEV, so the end-of-list button never rendered" } });
  assert.equal(got.noopKind, NOOP_KIND.UNOBSERVABLE);
  assert.match(got.noopReason ?? "", /no rows on DEV/);
});

test("a no-op written before the kind existed is delivered as unspecified", () => {
  assert.equal(deliver({ specs: [], noop: { reason: "nothing worth a test" } }).noopKind, NOOP_KIND.UNSPECIFIED);
});

test("a deliverable that declares no no-op carries no kind", () => {
  assert.equal("noopKind" in deliver({ specs: ["flows/a.spec.ts"] }), false);
});
