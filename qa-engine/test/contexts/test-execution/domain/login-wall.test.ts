import { test } from "node:test";
import assert from "node:assert/strict";
import { endedOnLoginWall } from "@contexts/test-execution/domain/login-wall.ts";

test("a failure that ends on the login page, by its address, is a lost session", () => {
  assert.equal(endedOnLoginWall([{ status: "fail", finalUrl: "https://dev.example/login?next=%2Fdash" }]), true);
  assert.equal(endedOnLoginWall([{ status: "fail", finalUrl: "https://dev.example/auth/sign-in" }]), true);
});

test("a failure whose page shows a password field is a lost session, whatever its address", () => {
  assert.equal(endedOnLoginWall([{ status: "fail", failureDom: "heading: Welcome\ntextbox: Email\ntextbox: Password\nbutton: Log in" }]), true);
});

test("a failure on an ordinary page, a pass, or no evidence is not", () => {
  assert.equal(endedOnLoginWall([{ status: "fail", finalUrl: "https://dev.example/orders", failureDom: "heading: Orders\ntextbox: Search" }]), false);
  assert.equal(endedOnLoginWall([{ status: "pass", finalUrl: "https://dev.example/login" }]), false);
  assert.equal(endedOnLoginWall([{ status: "fail" }]), false);
  assert.equal(endedOnLoginWall([]), false);
});

test("a route that merely contains the word is not a login page", () => {
  assert.equal(endedOnLoginWall([{ status: "fail", finalUrl: "https://dev.example/blogin-stats" }]), false);
});
