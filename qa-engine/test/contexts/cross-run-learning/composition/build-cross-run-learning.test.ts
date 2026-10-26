/* buildCrossRunLearning: the learning port reads the repository it was built from, and each optional port is served only when supplied. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCrossRunLearning } from "@contexts/cross-run-learning/composition/build-cross-run-learning.ts";
import { Sha } from "@kernel/sha.ts";

test("a composition without a repository retrieves no rule and serves no optional port", async () => {
  const api = buildCrossRunLearning({ appName: "app" });

  assert.deepEqual(await api.learning.retrieve(Sha.of("abc1234")), []);
  assert.equal(api.reflector, undefined);
  assert.equal(api.curriculum, undefined);
  assert.equal(api.processAudit, undefined);
});

test("the learning port retrieves through the repository it was built from, for the app it was built for", async () => {
  const asked: string[] = [];
  const repo = { topRules: async (app: string) => { asked.push(app); return []; } } as never;
  const api = buildCrossRunLearning({ appName: "app-a", learningRepo: repo });

  await api.learning.retrieve(Sha.of("abc1234"));

  assert.deepEqual(asked, ["app-a"]);
});

test("the supplied optional ports are served as they are", () => {
  const reflector = {} as never;
  const curriculum = {} as never;
  const processAudit = {} as never;

  const api = buildCrossRunLearning({ appName: "app", reflector, curriculum, processAudit });

  assert.equal(api.reflector, reflector);
  assert.equal(api.curriculum, curriculum);
  assert.equal(api.processAudit, processAudit);
});
