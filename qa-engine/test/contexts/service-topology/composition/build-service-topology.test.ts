/* buildServiceTopology: each optional port is built only when its dependencies are supplied, and the cross-repo impact reads history through the reader it was given. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServiceTopology } from "@contexts/service-topology/composition/build-service-topology.ts";

const runner = { run: async () => ({ code: 0, stdout: "", stderr: "" }) } as never;

test("a run that supplies no dependency gets no port", () => {
  assert.deepEqual(buildServiceTopology({}), {});
});

test("service links are built from the declared services", () => {
  const api = buildServiceTopology({
    links: { appName: "app", primaryRepo: "o/app", mirrorRoot: "/mirrors", services: [{ repo: "o/svc" }], boundaryProfiles: { get: async () => undefined } as never },
  });

  assert.equal(typeof api.serviceLinks?.resolve, "function");
  assert.equal(api.crossRepoImpact, undefined);
});

test("cross-repo impact is built when its dependencies are supplied", () => {
  const api = buildServiceTopology({
    impact: { mirrorRoot: "/mirrors", runner, makeVcs: () => ({}) as never },
  });

  assert.ok(api.crossRepoImpact);
});
