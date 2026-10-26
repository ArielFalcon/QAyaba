/* A route is tied to the files that implement it by the context map. A page whose template and styles are separate files is changed through those, so the files an implementation file declares by relative path join the route's own; nothing is added by a name that merely looks alike. */

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreGenerationGroundingPortAdapter } from "@contexts/generation/infrastructure/adapters/pre-generation-grounding-port.adapter.ts";
import { MAX_DECLARED_RESOURCE_SOURCE_BYTES } from "@contexts/generation/infrastructure/adapters/implementation-resources.ts";
import { rankRoutesWithRelevance } from "@contexts/generation/domain/route-ranking.ts";

import type { ArchitectureContext } from "@contexts/generation/domain/generation-input.ts";

const routesOf = (...args: Parameters<typeof rankRoutesWithRelevance>): string[] => rankRoutesWithRelevance(...args).map((entry) => entry.route);

const PAGE_DIR = "src/app/restaurant-list";
const PAGE = `${PAGE_DIR}/restaurant-list.page.ts`;

function mapWith(implementationFiles: string[]): ArchitectureContext {
  return { builtAtSha: "abc1234", routes: [{ path: "/about", implementationFiles: ["src/app/about/about.page.ts"] }, { path: "/restaurants", implementationFiles }], api: [], feBe: [] };
}

/* <tmp>/app is the mirror, <tmp>/app/e2e the spec directory, <tmp>/outside what no read may reach. */
async function withMirror(run: (mirror: string, outside: string) => Promise<void>): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "qa-declared-resources-"));
  const mirror = join(tmp, "app");
  mkdirSync(join(mirror, "e2e"), { recursive: true });
  mkdirSync(join(mirror, PAGE_DIR), { recursive: true });
  mkdirSync(join(tmp, "outside"));
  mock.method(console, "warn", () => {});
  try {
    await run(mirror, join(tmp, "outside"));
  } finally {
    mock.restoreAll();
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function groundedMap(mirror: string, map: ArchitectureContext): Promise<ArchitectureContext | undefined> {
  let seen: ArchitectureContext | undefined;
  const adapter = new PreGenerationGroundingPortAdapter(
    { e2eDir: join(mirror, "e2e"), mirrorDir: mirror, contextMap: map },
    {
      loadContextMap: () => undefined,
      buildContextPack: async (input) => {
        seen = input.contextMap;
        return { text: undefined, domBytes: 0, contractBytes: 0 };
      },
    },
  );
  await adapter.ground(join(mirror, "e2e"), undefined, undefined);
  return seen;
}

const filesOf = (map: ArchitectureContext | undefined, route = "/restaurants"): string[] | undefined => map?.routes.find((r) => r.path === route)?.implementationFiles;

test("a template-only change ranks the route whose implementation file declares that template", async () => {
  await withMirror(async (mirror) => {
    writeFileSync(join(mirror, PAGE), "@Component({ templateUrl: './restaurant-list.page.html', styleUrls: ['./restaurant-list.page.scss'] }) export class P {}");
    writeFileSync(join(mirror, PAGE_DIR, "restaurant-list.page.html"), "<h1>x</h1>");
    writeFileSync(join(mirror, PAGE_DIR, "restaurant-list.page.scss"), "h1 {}");

    const map = await groundedMap(mirror, mapWith([PAGE]));

    assert.deepEqual(filesOf(map), [PAGE, `${PAGE_DIR}/restaurant-list.page.html`, `${PAGE_DIR}/restaurant-list.page.scss`]);
    assert.deepEqual(routesOf(["/about", "/restaurants"], map, { changedFiles: [`${PAGE_DIR}/restaurant-list.page.html`] }), ["/restaurants", "/about"]);
  });
});

test("a file that only looks like a declared one by its name does not rank the route", async () => {
  await withMirror(async (mirror) => {
    writeFileSync(join(mirror, PAGE), "@Component({ templateUrl: './restaurant-list.page.html' }) export class P {}");
    writeFileSync(join(mirror, PAGE_DIR, "restaurant-list.page.html"), "<h1>x</h1>");
    writeFileSync(join(mirror, PAGE_DIR, "restaurant-list.page.css"), "h1 {}");

    const map = await groundedMap(mirror, mapWith([PAGE]));

    assert.deepEqual(routesOf(["/about", "/restaurants"], map, { changedFiles: [`${PAGE_DIR}/restaurant-list.page.css`] }), ["/about", "/restaurants"]);
  });
});

test("a declared file that is not in the repository is not added, and neither is a source file", async () => {
  await withMirror(async (mirror) => {
    writeFileSync(join(mirror, PAGE), "import '../../../run-orchestration/infrastructure/adapters/helper.ts'; const a = './missing.html'; const b = './present.html';");
    writeFileSync(join(mirror, PAGE_DIR, "helper.ts"), "export {}");
    writeFileSync(join(mirror, PAGE_DIR, "present.html"), "<p/>");

    assert.deepEqual(filesOf(await groundedMap(mirror, mapWith([PAGE]))), [PAGE, `${PAGE_DIR}/present.html`]);
  });
});

test("a declared path that climbs out of the repository adds nothing, even when a file is there", async () => {
  await withMirror(async (mirror, outside) => {
    writeFileSync(join(outside, "secret.html"), "<p/>");
    writeFileSync(join(mirror, PAGE), "const a = '../../../../outside/secret.html'; const b = '../../../../../outside/secret.html';");

    assert.deepEqual(filesOf(await groundedMap(mirror, mapWith([PAGE]))), [PAGE]);
  });
});

test("a declared file that is a symlink, or sits behind one, adds nothing", async () => {
  await withMirror(async (mirror, outside) => {
    writeFileSync(join(outside, "leak.html"), "<p/>");
    writeFileSync(join(mirror, PAGE_DIR, "real.html"), "<p/>");
    symlinkSync(join(mirror, PAGE_DIR, "real.html"), join(mirror, PAGE_DIR, "inside-link.html"));
    symlinkSync(join(outside, "leak.html"), join(mirror, PAGE_DIR, "outside-link.html"));
    symlinkSync(outside, join(mirror, PAGE_DIR, "linked-dir"));
    writeFileSync(join(mirror, PAGE), "'./inside-link.html'; './outside-link.html'; './linked-dir/leak.html'; './real.html';");

    assert.deepEqual(filesOf(await groundedMap(mirror, mapWith([PAGE]))), [PAGE, `${PAGE_DIR}/real.html`]);
  });
});

test("an implementation file that is a symlink, or larger than the cap, is not read", async () => {
  await withMirror(async (mirror, outside) => {
    writeFileSync(join(outside, "page.ts"), "'./x.html'");
    writeFileSync(join(mirror, PAGE_DIR, "x.html"), "<p/>");
    symlinkSync(join(outside, "page.ts"), join(mirror, PAGE_DIR, "linked.page.ts"));
    writeFileSync(join(mirror, PAGE_DIR, "big.page.ts"), `'./x.html'${" ".repeat(MAX_DECLARED_RESOURCE_SOURCE_BYTES)}`);
    const map = mapWith([`${PAGE_DIR}/linked.page.ts`, `${PAGE_DIR}/big.page.ts`, `${PAGE_DIR}/absent.page.ts`]);

    assert.deepEqual(filesOf(await groundedMap(mirror, map)), [`${PAGE_DIR}/linked.page.ts`, `${PAGE_DIR}/big.page.ts`, `${PAGE_DIR}/absent.page.ts`]);
  });
});

test("a route without implementation files, and a map without a mirror to read, stay as they are", async () => {
  await withMirror(async (mirror) => {
    writeFileSync(join(mirror, PAGE), "'./x.html'");
    writeFileSync(join(mirror, PAGE_DIR, "x.html"), "<p/>");
    const bare: ArchitectureContext = { builtAtSha: "abc1234", routes: [{ path: "/restaurants" }], api: [], feBe: [] };
    assert.deepEqual(await groundedMap(mirror, bare), bare);

    let seen: ArchitectureContext | undefined;
    const map = mapWith([PAGE]);
    await new PreGenerationGroundingPortAdapter(
      { e2eDir: join(mirror, "e2e"), contextMap: map },
      { loadContextMap: () => undefined, buildContextPack: async (input) => { seen = input.contextMap; return { text: undefined, domBytes: 0, contractBytes: 0 }; } },
    ).ground(join(mirror, "e2e"), undefined, undefined);
    assert.deepEqual(seen, map);
  });
});

test("a file declared by two implementation files, or already listed, is added once", async () => {
  await withMirror(async (mirror) => {
    writeFileSync(join(mirror, PAGE), "'./shared.html'; './shared.scss';");
    writeFileSync(join(mirror, PAGE_DIR, "other.ts"), "'./shared.html';");
    writeFileSync(join(mirror, PAGE_DIR, "shared.html"), "<p/>");
    writeFileSync(join(mirror, PAGE_DIR, "shared.scss"), "p {}");

    const map = await groundedMap(mirror, mapWith([PAGE, `${PAGE_DIR}/other.ts`, `${PAGE_DIR}/shared.scss`]));

    assert.deepEqual(filesOf(map), [PAGE, `${PAGE_DIR}/other.ts`, `${PAGE_DIR}/shared.scss`, `${PAGE_DIR}/shared.html`]);
  });
});
