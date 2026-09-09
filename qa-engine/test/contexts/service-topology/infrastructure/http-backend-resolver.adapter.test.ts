// test/contexts/service-topology/infrastructure/http-backend-resolver.adapter.test.ts
// TDD (strict): write failing tests first, then implement.
// HttpBackendResolver: config-driven BE→BE HTTP boundary resolver. Scans backend repos
// (system, plus front if not already in system) — FE HTTP stays OpenApiHttpResolver.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HttpBackendResolver } from "@contexts/service-topology/infrastructure/http-backend-resolver.adapter.ts";
import type { HttpBackendBoundaryProfile, RepoRef, ServiceLink } from "@contexts/service-topology/domain/index.ts";

const OPENAPI_PATH = "src/main/resources/openapi/api-definition.yaml";

const PROFILE: HttpBackendBoundaryProfile = {
  transport: "http-backend",
  sourceFiles: "**/*.java",
  callPattern: { kind: "rest-template-exchange", receiver: "restTemplate" },
  servicePrefixTemplate: "name-{service}-api",
  serviceRepoTemplate: "ms-name-{service}",
  openApiPath: OPENAPI_PATH,
};

const ORDERS_OPENAPI = `openapi: "3.0.3"
info:
  title: Orders API
  version: "1.0"
paths:
  /api/orders:
    get:
      operationId: listOrders
      responses:
        "200":
          description: OK
  /api/orders/active:
    get:
      operationId: getActiveOrders
      responses:
        "200":
          description: OK
  /api/orders/{id}:
    get:
      operationId: getOrderById
      responses:
        "200":
          description: OK
`;

const REST_TEMPLATE_CLIENT = `package com.example.payments;

import org.springframework.http.HttpMethod;
import org.springframework.web.client.RestTemplate;

public class OrderGateway {
  private final RestTemplate restTemplate;

  public OrderGateway(RestTemplate restTemplate) {
    this.restTemplate = restTemplate;
  }

  public String listOrders() {
    return restTemplate.exchange("/api/orders", HttpMethod.GET, null, String.class).getBody();
  }
}
`;

function writeFile(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

async function withTempDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "http-backend-"));
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("resolveLinks: RestTemplate.exchange(\"/api/orders\", GET) joins to OpenAPI listOrders", async () => {
  await withTempDir(async (root) => {
    const ordersDir = join(root, "orders");
    const paymentsDir = join(root, "payments");
    writeFile(ordersDir, OPENAPI_PATH, ORDERS_OPENAPI);
    writeFile(paymentsDir, "src/main/java/com/example/OrderGateway.java", REST_TEMPLATE_CLIENT);

    const orders: RepoRef = { repo: "org/ms-name-orders", mirrorDir: ordersDir };
    const payments: RepoRef = { repo: "org/ms-name-payments", mirrorDir: paymentsDir };

    const resolver = new HttpBackendResolver(PROFILE);
    const result = await resolver.resolveLinks([orders, payments], payments);

    assert.equal(result.links.length, 1, `expected one link, got ${JSON.stringify(result.links)}`);
    const link = result.links[0] as ServiceLink;
    assert.equal(link.transport, "http");
    assert.equal(link.source, "http-backend-resolver");
    assert.equal(link.confidence, 1.0);
    assert.equal(link.contractRef, "listOrders");
    assert.equal(link.from.repo, payments.repo);
    assert.equal(link.from.file, "src/main/java/com/example/OrderGateway.java");
    assert.equal(link.from.symbol, "listOrders");
    assert.equal(link.to.repo, orders.repo);
    assert.equal(link.to.file, OPENAPI_PATH);
    assert.equal(link.to.symbol, "listOrders");
  });
});

test("resolveLinks: scans front when the caller repo is only passed as front (not in system)", async () => {
  await withTempDir(async (root) => {
    const ordersDir = join(root, "orders");
    const paymentsDir = join(root, "payments");
    writeFile(ordersDir, OPENAPI_PATH, ORDERS_OPENAPI);
    writeFile(paymentsDir, "src/main/java/com/example/OrderGateway.java", REST_TEMPLATE_CLIENT);

    const orders: RepoRef = { repo: "org/ms-name-orders", mirrorDir: ordersDir };
    const payments: RepoRef = { repo: "org/ms-name-payments", mirrorDir: paymentsDir };

    const resolver = new HttpBackendResolver(PROFILE);
    const result = await resolver.resolveLinks([orders], payments);

    assert.equal(result.links.length, 1);
    assert.equal(result.links[0]?.from.repo, payments.repo);
    assert.equal(result.links[0]?.to.symbol, "listOrders");
    assert.equal(result.links[0]?.source, "http-backend-resolver");
  });
});

test("resolveLinks: a prefixed path name-{service}-api/... strips the prefix and joins by service", async () => {
  await withTempDir(async (root) => {
    const ordersDir = join(root, "orders");
    const paymentsDir = join(root, "payments");
    writeFile(ordersDir, OPENAPI_PATH, `openapi: "3.0.3"
info: { title: Orders, version: "1.0" }
paths:
  /orders:
    get:
      operationId: listOrders
      responses: { "200": { description: OK } }
`);
    writeFile(
      paymentsDir,
      "src/main/java/com/example/OrderGateway.java",
      `public class OrderGateway {
  public String listOrders() {
    return restTemplate.exchange("/name-orders-api/orders", HttpMethod.GET, null, String.class).getBody();
  }
}
`,
    );

    const orders: RepoRef = { repo: "org/ms-name-orders", mirrorDir: ordersDir };
    const payments: RepoRef = { repo: "org/ms-name-payments", mirrorDir: paymentsDir };
    const resolver = new HttpBackendResolver(PROFILE);
    const result = await resolver.resolveLinks([orders, payments], payments);

    assert.equal(result.links.length, 1);
    assert.equal(result.links[0]?.to.symbol, "listOrders");
    assert.equal(result.links[0]?.to.repo, orders.repo);
    assert.equal(result.links[0]?.source, "http-backend-resolver");
  });
});

test("findOp: /api/orders/active prefers the all-literal op over /api/orders/{id}", async () => {
  await withTempDir(async (root) => {
    const ordersDir = join(root, "orders");
    const paymentsDir = join(root, "payments");
    writeFile(ordersDir, OPENAPI_PATH, ORDERS_OPENAPI);
    writeFile(
      paymentsDir,
      "src/main/java/com/example/OrderGateway.java",
      `public class OrderGateway {
  public String active() {
    return restTemplate.exchange("/api/orders/active", HttpMethod.GET, null, String.class).getBody();
  }
}
`,
    );

    const orders: RepoRef = { repo: "org/ms-name-orders", mirrorDir: ordersDir };
    const payments: RepoRef = { repo: "org/ms-name-payments", mirrorDir: paymentsDir };
    const resolver = new HttpBackendResolver(PROFILE);
    const result = await resolver.resolveLinks([orders, payments], payments);

    assert.equal(result.links.length, 1);
    assert.equal(result.links[0]?.to.symbol, "getActiveOrders");
    assert.equal(result.links[0]?.contractRef, "getActiveOrders");
  });
});

test("resolveLinks: unmatched declared call goes to drift", async () => {
  await withTempDir(async (root) => {
    const ordersDir = join(root, "orders");
    const paymentsDir = join(root, "payments");
    writeFile(ordersDir, OPENAPI_PATH, ORDERS_OPENAPI);
    writeFile(
      paymentsDir,
      "src/main/java/com/example/OrderGateway.java",
      `public class OrderGateway {
  public String missing() {
    return restTemplate.exchange("/api/widgets", HttpMethod.GET, null, String.class).getBody();
  }
}
`,
    );

    const orders: RepoRef = { repo: "org/ms-name-orders", mirrorDir: ordersDir };
    const payments: RepoRef = { repo: "org/ms-name-payments", mirrorDir: paymentsDir };
    const resolver = new HttpBackendResolver(PROFILE);
    const result = await resolver.resolveLinks([orders, payments], payments);

    assert.equal(result.links.length, 0);
    assert.equal(result.drift.length, 1);
    assert.equal(result.drift[0]?.verb, "GET");
    assert.ok(result.drift[0]?.path.includes("/api/widgets"));
  });
});

test("resolveLinks: unknown service prefix goes to external", async () => {
  await withTempDir(async (root) => {
    const ordersDir = join(root, "orders");
    const paymentsDir = join(root, "payments");
    writeFile(ordersDir, OPENAPI_PATH, ORDERS_OPENAPI);
    writeFile(
      paymentsDir,
      "src/main/java/com/example/OrderGateway.java",
      `public class OrderGateway {
  public String other() {
    return restTemplate.exchange("/name-unknown-api/widgets", HttpMethod.GET, null, String.class).getBody();
  }
}
`,
    );

    const orders: RepoRef = { repo: "org/ms-name-orders", mirrorDir: ordersDir };
    const payments: RepoRef = { repo: "org/ms-name-payments", mirrorDir: paymentsDir };
    const resolver = new HttpBackendResolver(PROFILE);
    const result = await resolver.resolveLinks([orders, payments], payments);

    assert.equal(result.links.length, 0);
    assert.equal(result.external.length, 1);
    assert.ok(result.external[0]?.path.includes("name-unknown-api"));
  });
});

test("resolveLinks: dynamic path goes to unresolved", async () => {
  await withTempDir(async (root) => {
    const ordersDir = join(root, "orders");
    const paymentsDir = join(root, "payments");
    writeFile(ordersDir, OPENAPI_PATH, ORDERS_OPENAPI);
    writeFile(
      paymentsDir,
      "src/main/java/com/example/OrderGateway.java",
      `public class OrderGateway {
  public String dyn(String url) {
    return restTemplate.exchange(url, HttpMethod.GET, null, String.class).getBody();
  }
}
`,
    );

    const orders: RepoRef = { repo: "org/ms-name-orders", mirrorDir: ordersDir };
    const payments: RepoRef = { repo: "org/ms-name-payments", mirrorDir: paymentsDir };
    const resolver = new HttpBackendResolver(PROFILE);
    const result = await resolver.resolveLinks([orders, payments], payments);

    assert.equal(result.links.length, 0);
    assert.ok(result.unresolved.length >= 1);
    assert.ok(result.unresolved.some((u) => u.rawArg === "url"));
  });
});

test("resolveLinks: a frontend *.api.ts file is NOT scanned (BE→BE only; FE HTTP stays OpenApiHttpResolver)", async () => {
  await withTempDir(async (root) => {
    const ordersDir = join(root, "orders");
    const frontDir = join(root, "webapp");
    writeFile(ordersDir, OPENAPI_PATH, ORDERS_OPENAPI);
    writeFile(
      frontDir,
      "src/app/orders.api.ts",
      `export class OrdersApi { list() { return this.rest.get('/api/orders'); } }`,
    );

    const orders: RepoRef = { repo: "org/ms-name-orders", mirrorDir: ordersDir };
    const front: RepoRef = { repo: "org/name-webapp", mirrorDir: frontDir };
    const resolver = new HttpBackendResolver(PROFILE);
    const result = await resolver.resolveLinks([orders], front);

    assert.deepEqual(result, { links: [], drift: [], external: [], unresolved: [] });
  });
});

test("resolveLinks: a call-site inside node_modules is NOT extracted", async () => {
  await withTempDir(async (root) => {
    const ordersDir = join(root, "orders");
    const paymentsDir = join(root, "payments");
    writeFile(ordersDir, OPENAPI_PATH, ORDERS_OPENAPI);
    writeFile(paymentsDir, "src/main/java/com/example/OrderGateway.java", REST_TEMPLATE_CLIENT);
    writeFile(
      paymentsDir,
      "node_modules/evil/EvilGateway.java",
      `public class EvilGateway {
  public String listOrders() {
    return restTemplate.exchange("/api/orders", HttpMethod.GET, null, String.class).getBody();
  }
}
`,
    );

    const orders: RepoRef = { repo: "org/ms-name-orders", mirrorDir: ordersDir };
    const payments: RepoRef = { repo: "org/ms-name-payments", mirrorDir: paymentsDir };
    const resolver = new HttpBackendResolver(PROFILE);
    const result = await resolver.resolveLinks([orders, payments], payments);

    assert.equal(result.links.length, 1);
    assert.ok(!result.links[0]?.from.file.includes("node_modules"));
  });
});

test("resolveLinks: malformed OpenAPI returns empty links without throwing", async () => {
  await withTempDir(async (root) => {
    const ordersDir = join(root, "orders");
    const paymentsDir = join(root, "payments");
    writeFile(ordersDir, OPENAPI_PATH, "this is not: [ valid: yaml: {{{");
    writeFile(paymentsDir, "src/main/java/com/example/OrderGateway.java", REST_TEMPLATE_CLIENT);

    const orders: RepoRef = { repo: "org/ms-name-orders", mirrorDir: ordersDir };
    const payments: RepoRef = { repo: "org/ms-name-payments", mirrorDir: paymentsDir };
    const resolver = new HttpBackendResolver(PROFILE);
    const result = await resolver.resolveLinks([orders, payments], payments);

    assert.equal(result.links.length, 0);
  });
});

test("resolveLinks: unknown callPattern.kind returns empty without throwing", async () => {
  await withTempDir(async (root) => {
    const ordersDir = join(root, "orders");
    const paymentsDir = join(root, "payments");
    writeFile(ordersDir, OPENAPI_PATH, ORDERS_OPENAPI);
    writeFile(paymentsDir, "src/main/java/com/example/OrderGateway.java", REST_TEMPLATE_CLIENT);

    const orders: RepoRef = { repo: "org/ms-name-orders", mirrorDir: ordersDir };
    const payments: RepoRef = { repo: "org/ms-name-payments", mirrorDir: paymentsDir };
    const bad: HttpBackendBoundaryProfile = {
      ...PROFILE,
      callPattern: { kind: "mystery-shape", receiver: "restTemplate" },
    };
    const resolver = new HttpBackendResolver(bad);
    const result = await resolver.resolveLinks([orders, payments], payments);

    assert.deepEqual(result, { links: [], drift: [], external: [], unresolved: [] });
  });
});

test("resolveLinks: empty scan (no matching source files) returns empty without throwing", async () => {
  await withTempDir(async (root) => {
    const ordersDir = join(root, "orders");
    const paymentsDir = join(root, "payments");
    writeFile(ordersDir, OPENAPI_PATH, ORDERS_OPENAPI);
    writeFile(paymentsDir, "README.md", "no java here");

    const orders: RepoRef = { repo: "org/ms-name-orders", mirrorDir: ordersDir };
    const payments: RepoRef = { repo: "org/ms-name-payments", mirrorDir: paymentsDir };
    const resolver = new HttpBackendResolver(PROFILE);
    const result = await resolver.resolveLinks([orders, payments], payments);

    assert.deepEqual(result, { links: [], drift: [], external: [], unresolved: [] });
  });
});

test("resolveLinks: missing OpenAPI / unreadable repo does not throw", async () => {
  const resolver = new HttpBackendResolver(PROFILE);
  const missing: RepoRef = { repo: "org/nonexistent", mirrorDir: "/nonexistent/path/xyz" };
  const result = await resolver.resolveLinks([missing], missing);
  assert.deepEqual(result, { links: [], drift: [], external: [], unresolved: [] });
});
