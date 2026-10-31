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
import { resolveListenHost } from "./port";

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

/* Inside the container the process must listen on every interface, or the published port (and the
   other compose services) cannot reach it; exposure beyond the host is still decided by BIND_ADDR. */
test("the orchestrator container listens on every interface; BIND_ADDR alone limits what is published", () => {
  const orchestrator = getService(loadCompose(), "orchestrator");
  const environment = orchestrator?.environment as Record<string, unknown> | undefined;
  assert.equal(String(environment?.LISTEN_HOST), "0.0.0.0");
});

/* The environment a bare `docker run -p 458:458 <image>` gives the process: the image's ENV lines. */
function imageEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [, key, value] of readFileSync(join(process.cwd(), "Dockerfile"), "utf8").matchAll(/^ENV\s+(\w+)[=\s]\s*(.*?)\s*$/gm)) {
    env[key!] = value!;
  }
  return env;
}

/* A container run without compose must still be reachable through its published port: the image
   itself listens on every interface, and `-p`/BIND_ADDR decide what is exposed. A bare run outside
   the image keeps the loopback default (port.test.ts). */
test("the image listens on every interface, so a port published without compose reaches it", () => {
  assert.equal(resolveListenHost(imageEnv()), "0.0.0.0");
});
