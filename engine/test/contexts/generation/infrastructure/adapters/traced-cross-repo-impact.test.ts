/* The traced cross-repo impact port keeps the later-hop surface of the port it wraps: wrapping must not hide a hop the inner port answers. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NoopTelemetry } from "@kernel/telemetry/noop-telemetry.ts";
import { TracedCrossRepoImpactPort } from "@contexts/generation/infrastructure/adapters/context-trace.ts";
import type { CrossRepoImpactPort } from "@contexts/service-topology/application/index.ts";

test("a later hop passes through the traced port when the inner port answers one", async () => {
  const asked: string[] = [];
  const inner: CrossRepoImpactPort = {
    resolve: async () => null,
    resolveUpstreamHop: async (request) => {
      asked.push(request.repo);
      return { links: [], stops: [{ repo: request.repo, direction: "upstream", reason: "walk: not indexed" }] };
    },
  };
  const hop = await new TracedCrossRepoImpactPort(inner, new NoopTelemetry()).resolveUpstreamHop?.({ repo: "org/b", repoDir: "/m/b", links: [], fed: [] });
  assert.deepEqual(asked, ["org/b"]);
  assert.equal(hop?.stops[0]?.reason, "walk: not indexed");
});

test("the traced port answers no later hop when the inner port answers none", () => {
  const traced = new TracedCrossRepoImpactPort({ resolve: async () => null }, new NoopTelemetry());
  assert.equal(traced.resolveUpstreamHop, undefined);
});
