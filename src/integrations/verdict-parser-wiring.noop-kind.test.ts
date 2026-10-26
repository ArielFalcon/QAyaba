import { test } from "node:test";
import assert from "node:assert/strict";
import { VerdictParserAdapter } from "@contexts/generation/infrastructure/verdict-parser.adapter";
import { parseVerdict } from "./verdict-parse";
import { parseReviewerVerdict } from "./verdict-validate";
import { NOOP_KIND } from "@kernel/noop-kind";

const adapter = new VerdictParserAdapter({ parseVerdict, parseReviewerVerdict });

test("the deliverable of a declared no-op carries its kind and its reason", () => {
  const got = adapter.parseGenerator(JSON.stringify({ specs: [], noop: { kind: "unobservable", reason: "no rows on DEV, so the end-of-list button never rendered" } }));
  assert.equal(got.noopKind, NOOP_KIND.UNOBSERVABLE);
  assert.match(got.noopReason ?? "", /no rows on DEV/);
});

test("a no-op written before the kind existed is delivered as unspecified", () => {
  assert.equal(adapter.parseGenerator('{"specs":[],"noop":{"reason":"nothing worth a test"}}').noopKind, NOOP_KIND.UNSPECIFIED);
});

test("a deliverable that declares no no-op carries no kind", () => {
  assert.equal("noopKind" in adapter.parseGenerator('{"specs":["flows/a.spec.ts"]}'), false);
});
