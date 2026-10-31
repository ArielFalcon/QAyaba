import { test } from "node:test";
import assert from "node:assert/strict";
import { appCreationDefaults, isValidAppName } from "@contexts/app-catalog/application/index.ts";

const REPO = { fullName: "Org/shop-front", defaultBranch: "develop" };

test("an app name starts with a lowercase letter or digit and continues with those or dashes", () => {
  for (const name of ["shop", "a", "0shop", "shop-2-front", "a-"]) assert.equal(isValidAppName(name), true, name);
  for (const name of ["", "Shop", "-shop", "sh op", "../evil", "a/b", "shop_front", "shop\n", "shop.yaml"]) assert.equal(isValidAppName(name), false, JSON.stringify(name));
});

test("a creation that chooses nothing takes the repo's own name and branch, the repo page, review and shadow on, and the qa-bot prefix", () => {
  assert.deepEqual(appCreationDefaults({}, REPO), {
    repo: "Org/shop-front",
    baseBranch: "develop",
    baseUrl: "https://github.com/Org/shop-front",
    versionUrl: undefined,
    needsReview: true,
    shadow: true,
    testDataPrefix: "qa-bot",
  });
});

test("a creation keeps every choice it makes, false included, and reads an empty url or prefix as no choice", () => {
  const chosen = { baseUrl: "https://dev.shop.io", versionUrl: "https://dev.shop.io/version", needsReview: false, shadow: false, testDataPrefix: "qa-shop" };
  assert.deepEqual(appCreationDefaults(chosen, REPO), { repo: "Org/shop-front", baseBranch: "develop", ...chosen });
  assert.deepEqual(appCreationDefaults({ baseUrl: "", versionUrl: "", testDataPrefix: "" }, REPO), appCreationDefaults({}, REPO));
});
