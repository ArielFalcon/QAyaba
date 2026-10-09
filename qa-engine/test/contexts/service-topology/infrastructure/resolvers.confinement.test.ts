/* The boundary resolvers read the sources and the OpenAPI document of every repository of a system, from mirrors the agent can write into: the front's own mirror (its working copy, with the service contexts staged in it) and the mirrors of the services. Whatever the agent plants there must cost a resolver nothing but a count: a named pipe named like a source would hold the whole single-threaded orchestrator for ever, a link would put a file outside the mirror in the links found (or send the walk round a loop), and a file of any size would fill its memory. The sources are listed by the one walk of the files of a repository and read through the strict, capped read (see shared-infrastructure/repo-reader.ts); what could not be used is skipped, as a file a resolver cannot parse is, and said once for the repository, naming no file. Every case runs against real files, links and pipes under os.tmpdir(), for each of the three resolvers; the pipe cases run under the watch of test/support/named-pipe-watch.ts. */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EventResolver } from "@contexts/service-topology/infrastructure/event-resolver.adapter.ts";
import { HttpBackendResolver } from "@contexts/service-topology/infrastructure/http-backend-resolver.adapter.ts";
import { OpenApiHttpResolver } from "@contexts/service-topology/infrastructure/openapi-http-resolver.adapter.ts";
import { MAX_TOPOLOGY_OPENAPI_BYTES, MAX_TOPOLOGY_SOURCE_BYTES } from "@contexts/service-topology/infrastructure/repo-walk.ts";
import type { ServiceBoundaryResolverPort } from "@contexts/service-topology/application/ports/index.ts";
import type { RepoRef } from "@contexts/service-topology/domain/index.ts";
import { withoutWaitingOnNamedPipe } from "../../../support/named-pipe-watch.ts";

const FIXTURES = join(import.meta.dirname, "../fixtures");
const SECRET_MARK = "SECRETv1-hunter2";

function canMakeNamedPipes(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "qa-resolvers-fifo-probe-"));
  try {
    execFileSync("mkfifo", [join(dir, "probe")]);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const NO_NAMED_PIPES = canMakeNamedPipes() ? false : "mkfifo is not available on this platform, so the named-pipe cases are not exercised";

function put(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

/* A text of exactly `bytes` that still reads as `head`: the head, then whitespace. */
function padded(head: string, bytes: number): string {
  return head + " ".repeat(bytes - Buffer.byteLength(head));
}

/* What the resolvers say on the way, which goes to logs. */
async function capturing<T>(run: () => Promise<T>): Promise<{ value: T; warnings: string[] }> {
  const warnings: string[] = [];
  const warn = mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  try {
    return { value: await run(), warnings };
  } finally {
    warn.mock.restore();
  }
}

/* One system as a resolver sees it. */
interface System {
  name: string;
  resolver: ServiceBoundaryResolverPort;
  /* The repositories, made fresh under `tmp`. */
  build(tmp: string): { system: RepoRef[]; front: RepoRef };
  /* The repository the agent plants sources into (a directory below `tmp`), the directory of its sources and the extension of one. */
  planted: { repoDir: string; dir: string; ext: string };
  /* A source that adds one link of its own when it is read. */
  extraSource: string;
  /* The OpenAPI document of the repository that has one (a path below `tmp`) and what it holds. */
  openApi: { path: string; text: string };
}

const EVENT_PROFILE = {
  transport: "event" as const,
  files: "**/*.java",
  eventPattern: { kind: "class-based-domain-events" as const, listenerBaseType: "ListenerMessageDelegate", listenerEventCall: "convertMsgToSpecificType", subscriberBaseType: "DomainEventSubscriber", publishCall: "publishGenericMessage" },
};

const OPENAPI_PATH = "src/main/resources/openapi/api-definition.yaml";
const ORDERS_OPENAPI = `openapi: "3.0.3"
info: { title: Orders, version: "1.0" }
paths:
  /api/orders:
    get:
      operationId: listOrders
      responses: { "200": { description: OK } }
  /api/orders/active:
    get:
      operationId: getActiveOrders
      responses: { "200": { description: OK } }
`;
const GATEWAY = (cls: string, path: string): string =>
  `package com.example;\npublic class ${cls} {\n  private final RestTemplate restTemplate;\n  public String call() {\n    return restTemplate.exchange("${path}", HttpMethod.GET, null, String.class).getBody();\n  }\n}\n`;

const eventSystem: System = {
  name: "EventResolver",
  resolver: new EventResolver(EVENT_PROFILE),
  build: (tmp) => {
    cpSync(join(FIXTURES, "event-cross-repo", "service-a"), join(tmp, "a"), { recursive: true });
    cpSync(join(FIXTURES, "event-cross-repo", "service-b"), join(tmp, "b"), { recursive: true });
    const a: RepoRef = { repo: "org/service-a", mirrorDir: join(tmp, "a") };
    const b: RepoRef = { repo: "org/service-b", mirrorDir: join(tmp, "b") };
    return { system: [a, b], front: a };
  },
  planted: { repoDir: "a", dir: "src/main/java/listener", ext: "java" },
  extraSource: "public class ExtraListener extends ListenerMessageDelegate {\n  public void onMessage(Message m) {\n    FooCreatedEvent e = messengerClient.convertMsgToSpecificType(m, FooCreatedEvent.class);\n  }\n}\n",
  /* The event resolver reads no document: the cases below that are about one use the other two. */
  openApi: { path: "", text: "" },
};

const backendSystem: System = {
  name: "HttpBackendResolver",
  resolver: new HttpBackendResolver({
    transport: "http-backend",
    sourceFiles: "**/*.java",
    callPattern: { kind: "rest-template-exchange", receiver: "restTemplate" },
    servicePrefixTemplate: "name-{service}-api",
    serviceRepoTemplate: "ms-name-{service}",
    openApiPath: OPENAPI_PATH,
  }),
  build: (tmp) => {
    put(join(tmp, "orders"), OPENAPI_PATH, ORDERS_OPENAPI);
    put(join(tmp, "payments"), "src/main/java/com/example/OrderGateway.java", GATEWAY("OrderGateway", "/api/orders"));
    const orders: RepoRef = { repo: "org/ms-name-orders", mirrorDir: join(tmp, "orders") };
    const payments: RepoRef = { repo: "org/ms-name-payments", mirrorDir: join(tmp, "payments") };
    return { system: [orders, payments], front: payments };
  },
  planted: { repoDir: "payments", dir: "src/main/java/com/example", ext: "java" },
  extraSource: GATEWAY("ActiveGateway", "/api/orders/active"),
  openApi: { path: `orders/${OPENAPI_PATH}`, text: ORDERS_OPENAPI },
};

const frontSystem: System = {
  name: "OpenApiHttpResolver",
  resolver: new OpenApiHttpResolver({
    transport: "http",
    frontFiles: "**/*.api.ts",
    frontCallSite: { kind: "receiver-verb-call", receiver: "this.rest" },
    servicePrefixTemplate: "name-{service}-api",
    serviceRepoTemplate: "ms-name-{service}",
    openApiPath: OPENAPI_PATH,
  }),
  build: (tmp) => {
    cpSync(join(FIXTURES, "backend"), join(tmp, "backend"), { recursive: true });
    cpSync(join(FIXTURES, "frontend"), join(tmp, "frontend"), { recursive: true });
    const backend: RepoRef = { repo: "org/ms-name-orders", mirrorDir: join(tmp, "backend") };
    const front: RepoRef = { repo: "org/name-webapp", mirrorDir: join(tmp, "frontend") };
    return { system: [backend], front };
  },
  planted: { repoDir: "frontend", dir: "src/app/orders/api", ext: "api.ts" },
  extraSource: "const extra = { go() { return this.rest.get(`name-orders-api/orders/zz9`); } };\nexport default extra;\n",
  openApi: { path: `backend/${OPENAPI_PATH}`, text: readFileSync(join(FIXTURES, "backend", OPENAPI_PATH), "utf8") },
};

for (const s of [eventSystem, backendSystem, frontSystem]) {
  /* A system on disk with `plant` done to it, resolved: the links it has (as text, in an order that does not depend on how they were found) and what was said. `around` is what the resolution runs inside of. */
  async function resolveWith(
    plant: (tmp: string) => void,
    around: <T>(tmp: string, run: () => Promise<T>) => Promise<T> = (_tmp, run) => run(),
  ): Promise<{ links: string[]; warnings: string[] }> {
    const tmp = mkdtempSync(join(tmpdir(), "qa-resolvers-"));
    try {
      const repos = s.build(tmp);
      plant(tmp);
      const { value, warnings } = await around(tmp, () => capturing(() => s.resolver.resolveLinks(repos.system, repos.front)));
      return { links: value.links.map((l) => `${l.from.repo}:${l.from.file}:${l.from.symbol}->${l.to.repo}:${l.to.symbol}`).sort(), warnings };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  const baselineOf = async (): Promise<string[]> => {
    const { links, warnings } = await resolveWith(() => {});
    assert.ok(links.length > 0, `${s.name}: the system has links to lose`);
    assert.deepEqual(warnings, [], "and nothing to say of an ordinary system");
    return links;
  };
  const sourcePath = (tmp: string, name: string): string => join(tmp, s.planted.repoDir, s.planted.dir, `${name}.${s.planted.ext}`);
  const plantExtra = (bytes: number) => (tmp: string): void => put(join(tmp, s.planted.repoDir), `${s.planted.dir}/Extra.${s.planted.ext}`, padded(s.extraSource, bytes));

  test(`${s.name}: a source that is a named pipe is not waited on, the other sources are still read, and the pipe is counted without a name`, { skip: NO_NAMED_PIPES, timeout: 60_000 }, async () => {
    const baseline = await baselineOf();

    const { links, warnings } = await resolveWith(
      (tmp) => {
        mkdirSync(dirname(sourcePath(tmp, "Planted")), { recursive: true });
        execFileSync("mkfifo", [sourcePath(tmp, "Planted")]);
      },
      (tmp, run) => withoutWaitingOnNamedPipe(sourcePath(tmp, "Planted"), run),
    );

    assert.deepEqual(links, baseline);
    assert.equal(warnings.length, 1, "said once, for the repository");
    assert.ok(warnings[0]!.includes(s.planted.repoDir === "a" ? "org/service-a" : s.planted.repoDir === "payments" ? "org/ms-name-payments" : "org/name-webapp"), `the repository is named: ${warnings[0]}`);
    assert.ok(!warnings[0]!.includes("Planted"), "and no file is");
  });

  test(`${s.name}: a source that is a link is not read, whatever it points at, and nothing of the file behind it is in the links or the log`, async () => {
    const baseline = await baselineOf();

    const { links, warnings } = await resolveWith((tmp) => {
      const outside = join(tmp, "outside");
      put(outside, `Leak.${s.planted.ext}`, `${s.extraSource}\n// ${SECRET_MARK}\n`);
      symlinkSync(join(outside, `Leak.${s.planted.ext}`), sourcePath(tmp, "Leak"));
    });

    assert.deepEqual(links, baseline, "the source behind the link adds no link");
    assert.ok(!warnings.join("\n").includes(SECRET_MARK), "and quotes nothing of it");
    assert.ok(!warnings.join("\n").includes("Leak"), "nor its name");
  });

  test(`${s.name}: links back to a mirror cannot make the walk run away: it ends, and finds what it found without them`, { timeout: 60_000 }, async () => {
    const baseline = await baselineOf();

    const { links } = await resolveWith((tmp) => {
      const root = join(tmp, s.planted.repoDir);
      symlinkSync(".", join(root, "loop1"));
      symlinkSync(".", join(root, "loop2"));
      symlinkSync(root, join(root, s.planted.dir, "up"));
    });

    assert.deepEqual(links, baseline);
  });

  test(`${s.name}: a source of exactly the cap is read and one byte more is skipped and counted, and nothing else is lost`, async () => {
    const baseline = await baselineOf();

    const exact = await resolveWith(plantExtra(MAX_TOPOLOGY_SOURCE_BYTES));
    const over = await resolveWith(plantExtra(MAX_TOPOLOGY_SOURCE_BYTES + 1));

    assert.equal(exact.links.length, baseline.length + 1, "the source of exactly the cap adds its link");
    assert.deepEqual(exact.warnings, []);
    assert.deepEqual(over.links, baseline, "one byte more, and it is not read");
    assert.equal(over.warnings.length, 1);
    assert.ok(/\b1 file/.test(over.warnings[0]!), over.warnings[0]);
  });

  if (s.openApi.path !== "") {
    const doc = s.openApi;

    test(`${s.name}: an OpenAPI document that is a named pipe is not waited on and is no document: the service has none`, { skip: NO_NAMED_PIPES, timeout: 60_000 }, async () => {
      const { links, warnings } = await resolveWith(
        (tmp) => { rmSync(join(tmp, doc.path)); execFileSync("mkfifo", [join(tmp, doc.path)]); },
        (tmp, run) => withoutWaitingOnNamedPipe(join(tmp, doc.path), run),
      );

      assert.deepEqual(links, [], "no document, no service to link to");
      assert.ok(warnings.some((w) => /\b1 file/.test(w)), JSON.stringify(warnings));
    });

    test(`${s.name}: an OpenAPI document that is a link is not read, whatever it points at`, async () => {
      const { links, warnings } = await resolveWith((tmp) => {
        put(join(tmp, "outside"), "doc.yaml", doc.text);
        rmSync(join(tmp, doc.path));
        symlinkSync(join(tmp, "outside", "doc.yaml"), join(tmp, doc.path));
      });

      assert.deepEqual(links, [], "the document behind the link is not the service's");
      assert.ok(warnings.some((w) => /\b1 file/.test(w)), JSON.stringify(warnings));
    });

    test(`${s.name}: an OpenAPI document of exactly its cap is read and one byte more is not`, async () => {
      const baseline = await baselineOf();

      const exact = await resolveWith((tmp) => writeFileSync(join(tmp, doc.path), padded(doc.text, MAX_TOPOLOGY_OPENAPI_BYTES)));
      const over = await resolveWith((tmp) => writeFileSync(join(tmp, doc.path), padded(doc.text, MAX_TOPOLOGY_OPENAPI_BYTES + 1)));

      assert.deepEqual(exact.links, baseline, "a document of exactly the cap is the document");
      assert.deepEqual(over.links, [], "past the cap it is no document");
      assert.ok(over.warnings.some((w) => /\b1 file/.test(w)), JSON.stringify(over.warnings));
    });
  }
}
