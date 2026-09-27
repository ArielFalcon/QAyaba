/* docker-compose.yml previously published the orchestrator's port on ALL
   interfaces ("${PORT:-458}:${PORT:-458}" — Docker's default publish address is 0.0.0.0), while
   the tracked, auto-loaded docker-compose.override.yml defaults QA_WEB_AUTO_LOGIN=true. Combined,
   a plain `docker compose up` exposed the control-plane's auto-login bootstrap to the whole host
   network. This test pins that the published port instead binds to BIND_ADDR, defaulting to
   loopback-only (127.0.0.1) — turning the docker-compose.yml comment into an executable check,
   the same pattern as agent-credential-isolation.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

function loadCompose(): unknown {
  return parse(readFileSync(join(process.cwd(), "docker-compose.yml"), "utf8"));
}

function getService(compose: unknown, name: string): Record<string, unknown> | undefined {
  if (!compose || typeof compose !== "object") return undefined;
  const services = (compose as Record<string, unknown>).services;
  if (!services || typeof services !== "object") return undefined;
  const svc = (services as Record<string, unknown>)[name];
  return svc && typeof svc === "object" ? (svc as Record<string, unknown>) : undefined;
}

test("the orchestrator's published port binds to BIND_ADDR, defaulting to loopback (127.0.0.1)", () => {
  const orchestrator = getService(loadCompose(), "orchestrator");
  assert.ok(orchestrator, "docker-compose.yml must define an `orchestrator` service");
  const ports = orchestrator.ports;
  assert.ok(Array.isArray(ports) && ports.length > 0, "orchestrator must publish at least one port");
  const portMapping = String(ports[0]);
  assert.match(
    portMapping,
    /^\$\{BIND_ADDR:-127\.0\.0\.1\}:/,
    "the published port must bind to BIND_ADDR (default 127.0.0.1), not Docker's default 0.0.0.0",
  );
});
