/* Which spec file wrote a coverage dump, told by the dump's name: the seed names a dump after its test's title path, which starts with the spec file's path, every run of other characters one dash, cut at sixty characters. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isDumpOfSpecFile } from "@contexts/objective-signal/domain/dump-names.ts";

test("a dump belongs to the spec file its name starts with, and not to one whose path is a prefix of another", () => {
  assert.equal(isDumpOfSpecFile("flows-a-spec-ts-search-shows-results-0-0.json", "flows/a.spec.ts"), true);
  assert.equal(isDumpOfSpecFile("flows-ab-spec-ts-x-0-0.json", "flows/a.spec.ts"), false, "flows/a is not flows/ab");
  assert.equal(isDumpOfSpecFile("flows-b-spec-ts-y-1-0.json", "flows/a.spec.ts"), false);
});

test("a spec path longer than a dump's title is told by its first characters", () => {
  const long = "flows/restaurant-detail/restaurant-detail-missing-state-after-load.spec.ts";
  const dump = `${long.replace(/[^a-z0-9]+/gi, "-")}-test`.slice(0, 60) + "-0-0.json";
  assert.equal(isDumpOfSpecFile(dump, long), true);
  assert.equal(isDumpOfSpecFile(dump, "flows/b.spec.ts"), false);
});
