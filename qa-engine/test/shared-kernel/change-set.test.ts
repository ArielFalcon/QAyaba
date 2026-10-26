import { test } from "node:test";
import assert from "node:assert/strict";
import { Sha } from "@kernel/sha.ts";
import { ChangeSet, anchorProjection, type ChangeEntry } from "@kernel/change-set.ts";

const entry = (repo: string, role: ChangeEntry["role"], extra: Partial<ChangeEntry> = {}): ChangeEntry => ({ repo, role, headSha: Sha.of("abcd1234"), ...extra });

test("a change set without entries is rejected", () => {
  assert.throws(() => ChangeSet.of("shop", []), /at least one entry/);
});

test("a change set names each repo once", () => {
  assert.throws(() => ChangeSet.of("shop", [entry("org/front", "primary"), entry("org/front", "service")]), /org\/front/);
});

test("an entry carries a base or a commit count, never both", () => {
  assert.throws(() => ChangeSet.of("shop", [entry("org/front", "primary", { baseSha: Sha.of("1111"), commits: 3 })]), /baseSha and commits/);
});

test("a commit count below one is rejected", () => {
  assert.throws(() => ChangeSet.of("shop", [entry("org/front", "primary", { commits: 0 })]), /commits/);
});

test("the anchor is the primary entry when there is one, the first entry otherwise", () => {
  const withPrimary = ChangeSet.of("shop", [entry("org/svc", "service"), entry("org/front", "primary")]);
  assert.equal(withPrimary.anchor.repo, "org/front");
  const servicesOnly = ChangeSet.of("shop", [entry("org/svc-a", "service"), entry("org/svc-b", "service")]);
  assert.equal(servicesOnly.anchor.repo, "org/svc-a");
});

test("the projection of a primary anchor has no trigger repo and keeps the base", () => {
  const set = ChangeSet.of("shop", [entry("org/front", "primary", { baseSha: Sha.of("1111") })]);
  const p = anchorProjection(set);
  assert.equal(p.sha.value, "abcd1234");
  assert.equal(p.baseSha?.value, "1111");
  assert.equal(p.triggerRepo, undefined);
});

test("the projection of a service anchor names its repo as the trigger repo", () => {
  const set = ChangeSet.of("shop", [entry("org/svc", "service")]);
  const p = anchorProjection(set);
  assert.equal(p.triggerRepo, "org/svc");
  assert.equal(p.baseSha, undefined);
});
