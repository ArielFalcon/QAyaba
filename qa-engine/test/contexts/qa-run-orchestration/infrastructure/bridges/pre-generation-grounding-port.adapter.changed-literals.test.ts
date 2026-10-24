/* The labels a diff changed reach the context pack with how many unchanged lines of their file already hold each. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreGenerationGroundingPortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/pre-generation-grounding-port.adapter.ts";

const LABEL_FILE = "src/app/list.page.html";
const labelDiff = [
  `diff --git a/${LABEL_FILE} b/${LABEL_FILE}`,
  `--- a/${LABEL_FILE}`,
  `+++ b/${LABEL_FILE}`,
  "@@ -3,3 +3,3 @@",
  " <app-list",
  '-  endActionLabel="Cambiar filtro"',
  '+  endActionLabel="Cambiar filtros"',
  " />",
].join("\n");
const labelSource = ['<app-button label="Cambiar filtros" />', "<p>x</p>", "<app-list", '  endActionLabel="Cambiar filtros"', " />", '<app-empty cta="Cambiar filtros" />'].join("\n");

type PackInput = { changedLiterals?: Array<{ value: string; side: string; unchangedLines?: number }>; changedElements?: Array<{ text?: string; unchangedLines?: number }> };

async function packInputFor(statics: { mirrorDir?: string; stagedRoots?: string[] }, diff: string): Promise<PackInput> {
  let seen: PackInput = {};
  const adapter = new PreGenerationGroundingPortAdapter(
    { e2eDir: "/mirrors/org/app/e2e", ...statics },
    { buildContextPack: async (input) => { seen = input as PackInput; return { text: undefined, domBytes: 0, contractBytes: 0 }; } },
  );
  await adapter.ground("/tmp/qa-golden/e2e", undefined, diff, { sha: "abc1234" });
  return seen;
}

async function withMirror<T>(prefix: string, populate: (mirror: string) => void, run: (mirror: string) => Promise<T>): Promise<T> {
  const mirror = mkdtempSync(join(tmpdir(), prefix));
  try {
    populate(mirror);
    return await run(mirror);
  } finally {
    rmSync(mirror, { recursive: true, force: true });
  }
}

test("ground(): each changed label carries how many unchanged lines of its file, as it is on the working copy, already hold it", async () => {
  await withMirror(
    "qa-grounding-literals-",
    (mirror) => {
      mkdirSync(join(mirror, "src/app"), { recursive: true });
      writeFileSync(join(mirror, LABEL_FILE), labelSource);
    },
    async (mirror) => {
      const input = await packInputFor({ mirrorDir: mirror }, labelDiff);
      const added = input.changedLiterals?.find((l) => l.side === "added");
      const removed = input.changedLiterals?.find((l) => l.side === "removed");
      assert.equal(added?.value, "Cambiar filtros");
      assert.equal(added?.unchangedLines, 2);
      assert.equal(removed?.value, "Cambiar filtro");
      assert.equal(removed?.unchangedLines, 0, "the old value is a part of the new label, which is not the old value");
      assert.equal(input.changedElements?.[0]?.text, "Cambiar filtros");
      assert.equal(input.changedElements?.[0]?.unchangedLines, 2);
    },
  );
});

test("ground(): a changed file that is not on the working copy gives its labels with no count of unchanged lines", async () => {
  await withMirror("qa-grounding-literals-absent-", () => {}, async (mirror) => {
    const input = await packInputFor({ mirrorDir: mirror }, labelDiff);
    assert.equal(input.changedLiterals?.length, 2);
    assert.ok(input.changedLiterals?.every((l) => l.unchangedLines === undefined));
    assert.equal(input.changedElements?.[0]?.unchangedLines, undefined);
  });
});

test("ground(): a changed file that is a link out of the working copy is not read for the count", async () => {
  const outside = mkdtempSync(join(tmpdir(), "qa-grounding-literals-outside-"));
  try {
    await withMirror(
      "qa-grounding-literals-link-",
      (mirror) => {
        mkdirSync(join(mirror, "src/app"), { recursive: true });
        writeFileSync(join(outside, "secret.html"), labelSource);
        symlinkSync(join(outside, "secret.html"), join(mirror, LABEL_FILE));
      },
      async (mirror) => {
        const input = await packInputFor({ mirrorDir: mirror }, labelDiff);
        assert.ok(input.changedLiterals?.every((l) => l.unchangedLines === undefined));
      },
    );
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

const twoFileDiff = [
  `diff --git a/${LABEL_FILE} b/${LABEL_FILE}`,
  `--- a/${LABEL_FILE}`,
  `+++ b/${LABEL_FILE}`,
  "@@ -1,1 +1,2 @@",
  " <app-list",
  '+  endActionLabel="Cambiar filtros"',
  "diff --git a/src/util/messages.ts b/src/util/messages.ts",
  "--- a/src/util/messages.ts",
  "+++ b/src/util/messages.ts",
  "@@ -1,1 +1,2 @@",
  " export const a = 1;",
  '+export const m = "Mensaje interno";',
].join("\n");

async function packInputWithMap(map: unknown, diff: string, statics: { stagedRoots?: string[] } = {}): Promise<PackInput> {
  let seen: PackInput = {};
  const adapter = new PreGenerationGroundingPortAdapter(
    { e2eDir: "/mirrors/org/app/e2e", ...statics },
    {
      loadContextMap: () => map as never,
      buildContextPack: async (input) => { seen = input as PackInput; return { text: undefined, domBytes: 0, contractBytes: 0 }; },
    },
  );
  await adapter.ground("/tmp/qa-golden/e2e", undefined, diff, { sha: "abc1234" });
  return seen;
}

const PAGE_MAP = { builtAtSha: "abc1234", routes: [{ path: "/restaurantes", implementationFiles: [LABEL_FILE] }], api: [], feBe: [] };

test("ground(): with a map, the labels of the files it links to pages are the ones the pack states", async () => {
  const input = await packInputWithMap(PAGE_MAP, twoFileDiff);
  assert.deepEqual(input.changedLiterals?.map((l) => l.value), ["Cambiar filtros"]);
});

test("ground(): the labels of other files are used when no linked file has one", async () => {
  const map = { ...PAGE_MAP, routes: [{ path: "/restaurantes", implementationFiles: ["src/app/other.page.html"] }] };
  const input = await packInputWithMap(map, twoFileDiff);
  assert.deepEqual(input.changedLiterals?.map((l) => l.value).sort(), ["Cambiar filtros", "Mensaje interno"]);
});

test("ground(): without a map every file counts", async () => {
  const input = await packInputWithMap(undefined, twoFileDiff);
  assert.equal(input.changedLiterals?.length, 2);
});

test("ground() hands the run the added labels the pack states with more nodes than unchanged lines, and nothing when it states none", async () => {
  const diff = labelDiff;
  const withLines = (changedValuesWithMoreNodes?: string[]): PreGenerationGroundingPortAdapter =>
    new PreGenerationGroundingPortAdapter(
      { e2eDir: "/mirrors/org/app/e2e" },
      { buildContextPack: async () => ({ text: "## Context Pack", domBytes: 1, contractBytes: 0, ...(changedValuesWithMoreNodes ? { changedValuesWithMoreNodes } : {}) }) },
    );
  assert.deepEqual((await withLines(["Cambiar filtros"]).ground("/tmp/qa-golden/e2e", undefined, diff, { sha: "abc1234" })).changedValuesWithMoreNodes, ["Cambiar filtros"]);
  assert.equal("changedValuesWithMoreNodes" in (await withLines().ground("/tmp/qa-golden/e2e", undefined, diff, { sha: "abc1234" })), false);
});

test("ground(): a diff with no changed label gives the pack no literals", async () => {
  const diff = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,1 +1,1 @@", "-const a = 1;", "+const a = 2;"].join("\n");
  const input = await packInputFor({}, diff);
  assert.equal("changedLiterals" in input, false);
});

test("ground() hands the run the pages the pack read with results under the declared data state, by pathname, and nothing when it read none", async () => {
  const withPages = (pages: unknown[]): PreGenerationGroundingPortAdapter =>
    new PreGenerationGroundingPortAdapter(
      { e2eDir: "/mirrors/org/app/e2e" },
      { buildContextPack: async () => ({ text: "## Context Pack", domBytes: 1, contractBytes: 0, trace: { rankedRoutes: [], capturablePages: pages.length, pages, pageDeliveries: [], changedTestIds: [], contractIds: [], omittedLines: 0 } as never }) },
    );
  const pages = [
    { route: "/restaurantes/madrid", finalUrl: "https://dev.example/restaurantes/madrid", resultExpected: true, resultCount: 3 },
    { route: "/restaurantes", finalUrl: "https://dev.example/restaurantes", resultExpected: true, resultCount: 0 },
    { route: "/home", finalUrl: "https://dev.example/home" },
  ];
  const grounded = await withPages(pages).ground("/tmp/qa-golden/e2e", undefined, labelDiff, { sha: "abc1234" });
  assert.deepEqual(grounded.packConfirmedDataRoutes, [{ path: "/restaurantes/madrid", resultCount: 3 }]);
  const none = await withPages([pages[1], pages[2]]).ground("/tmp/qa-golden/e2e", undefined, labelDiff, { sha: "abc1234" });
  assert.equal("packConfirmedDataRoutes" in none, false);
});

test("ground() hands the run the pages of the map the change is linked to, in the pack's order, and nothing when it linked none", async () => {
  const withRelevant = (relevantRoutes: string[]): PreGenerationGroundingPortAdapter =>
    new PreGenerationGroundingPortAdapter(
      { e2eDir: "/mirrors/org/app/e2e" },
      { buildContextPack: async () => ({ text: "## Context Pack", domBytes: 1, contractBytes: 0, trace: { rankedRoutes: [], relevantRoutes, capturablePages: 0, pages: [], pageDeliveries: [], changedTestIds: [], contractIds: [], omittedLines: 0 } as never }) },
    );
  const grounded = await withRelevant(["/order", "/upload-menu/:step"]).ground("/tmp/qa-golden/e2e", undefined, labelDiff, { sha: "abc1234" });
  assert.deepEqual(grounded.changeRoutes, ["/order", "/upload-menu/:step"]);
  const none = await withRelevant([]).ground("/tmp/qa-golden/e2e", undefined, labelDiff, { sha: "abc1234" });
  assert.equal("changeRoutes" in none, false);
});
