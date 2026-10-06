import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isVisibleChallenge,
  type ChallengeCandidate,
} from "@contexts/qa-run-orchestration/infrastructure/login-discovery/login-discovery.page-readers.ts";

const candidate = (over: Partial<ChallengeCandidate> = {}): ChallengeCandidate => ({ tag: "div", role: null, inBadge: false, showing: true, ...over });

test("a captcha iframe or a plain container that is showing is a visible challenge", () => {
  assert.equal(isVisibleChallenge(candidate({ tag: "iframe" })), true);
  assert.equal(isVisibleChallenge(candidate({ tag: "div" })), true);
  assert.equal(isVisibleChallenge(candidate({ tag: "span" })), true);
});

for (const [label, over] of [
  ["a button", { tag: "button" }],
  ["an input", { tag: "input" }],
  ["a link", { tag: "a" }],
  ["a container with the button role", { tag: "div", role: "button" }],
] as const) {
  test(`${label} that carries a site key is a trigger, never a visible challenge`, () => {
    assert.equal(isVisibleChallenge(candidate(over)), false);
  });
}

test("a challenge inside the floating badge is not visible, and neither is one that is not showing", () => {
  assert.equal(isVisibleChallenge(candidate({ tag: "iframe", inBadge: true })), false);
  assert.equal(isVisibleChallenge(candidate({ tag: "iframe", showing: false })), false);
});

test("a role other than button does not make a container a control", () => {
  assert.equal(isVisibleChallenge(candidate({ role: "region" })), true);
});
