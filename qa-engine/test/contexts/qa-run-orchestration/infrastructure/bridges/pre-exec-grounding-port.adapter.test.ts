/* PreExecGroundingPort reads the spec sources of the suite and hands them to the route capture. The suite's files are enumerated by name from a directory the agent writes into, so a name can be a symlink the agent planted: it reads as an empty string, never as what it points at, and neither the sources nor the capture are ever given that content. The capture itself is faked (no browser); every fixture lives under os.tmpdir(). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreExecGroundingPortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/pre-exec-grounding-port.adapter.ts";
import type { CaptureDomInput } from "@contexts/generation/infrastructure/dom-snapshot.ts";

const LEAKED = `await page.goto("/leaked-route");`;

/* <tmp>/mirror/e2e is the suite; <tmp>/outside holds a spec-shaped file whose route must never be captured. */
interface Suite {
  tmp: string;
  mirror: string;
  specDir: string;
}

async function withSuite(run: (suite: Suite) => Promise<void>): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "qa-preexec-grounding-"));
  const mirror = join(tmp, "mirror");
  const specDir = join(mirror, "e2e");
  mkdirSync(join(specDir, "flows", "deep"), { recursive: true });
  mkdirSync(join(tmp, "outside"));
  writeFileSync(join(tmp, "outside", "secret.txt"), LEAKED);
  writeFileSync(join(tmp, "outside", "planted.spec.ts"), LEAKED);
  const warn = console.warn;
  try {
    await run({ tmp, mirror, specDir });
  } finally {
    console.warn = warn;
    rmSync(tmp, { recursive: true, force: true });
  }
}

/* An adapter whose capture records what it is given and sees one route. */
function adapterFor(suite: Suite, inputs: CaptureDomInput[], opts: { baseUrl?: string } = { baseUrl: "https://dev.example.com" }): PreExecGroundingPortAdapter {
  return new PreExecGroundingPortAdapter(
    { e2eDir: suite.specDir, mirrorDir: suite.mirror, ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}) },
    {
      captureRouteTrees: async (input) => {
        inputs.push(input);
        return [{ route: "/ok", nodes: ["heading: Ok"] }];
      },
    },
  );
}

function sourceOf(result: { specFiles: string[]; specSources: string[] }, file: string): string | undefined {
  return result.specSources[result.specFiles.indexOf(file)];
}

test("capture() returns the suite's spec files with their sources, index-aligned, and the routes the capture saw", async () => {
  await withSuite(async (suite) => {
    writeFileSync(join(suite.specDir, "a.spec.ts"), "// a\n");
    writeFileSync(join(suite.specDir, "flows", "b.spec.ts"), "// b, a little longer\n");
    writeFileSync(join(suite.specDir, "flows", "deep", "c.spec.ts"), "// c\n");
    writeFileSync(join(suite.specDir, "notes.txt"), "not a spec");
    mkdirSync(join(suite.specDir, "node_modules"));
    writeFileSync(join(suite.specDir, "node_modules", "dep.spec.ts"), "// installed package");
    const inputs: CaptureDomInput[] = [];

    const result = await adapterFor(suite, inputs).capture(suite.specDir);

    assert.deepEqual([...result.specFiles].sort(), ["a.spec.ts", "flows/b.spec.ts", "flows/deep/c.spec.ts"]);
    assert.equal(result.specSources.length, result.specFiles.length, "one source per file");
    assert.equal(sourceOf(result, "a.spec.ts"), "// a\n");
    assert.equal(sourceOf(result, "flows/b.spec.ts"), "// b, a little longer\n");
    assert.equal(sourceOf(result, "flows/deep/c.spec.ts"), "// c\n");
    assert.deepEqual(inputs[0]?.specContents, result.specSources, "the capture is given exactly the sources that are returned");
    assert.deepEqual(result.routes.map((r) => r.route), ["/ok"]);
  });
});

test("capture() reads a spec that is a symlink out of the spec directory as an empty string, keeps it listed, and gives neither the sources nor the capture what it points at", async () => {
  await withSuite(async (suite) => {
    writeFileSync(join(suite.specDir, "ok.spec.ts"), "// ok\n");
    symlinkSync(join(suite.tmp, "outside", "secret.txt"), join(suite.specDir, "leak.spec.ts"));
    symlinkSync("../../../outside/planted.spec.ts", join(suite.specDir, "flows", "relative-leak.spec.ts"));
    const inputs: CaptureDomInput[] = [];

    const result = await adapterFor(suite, inputs).capture(suite.specDir);

    assert.equal(sourceOf(result, "ok.spec.ts"), "// ok\n");
    assert.equal(sourceOf(result, "leak.spec.ts"), "", "listed, and aligned with an empty source");
    assert.equal(sourceOf(result, "flows/relative-leak.spec.ts"), "");
    assert.equal(result.specSources.length, result.specFiles.length);
    assert.ok(!result.specSources.join("\n").includes("leaked-route"), "the target of a planted link is in no source");
    assert.ok(!(inputs[0]?.specContents ?? []).join("\n").includes("leaked-route"), "nor in what the DOM capture is given");
  });
});

test("capture() gives no source and no capture input for the specs under a symlinked directory that leads out of the spec directory", async () => {
  await withSuite(async (suite) => {
    writeFileSync(join(suite.specDir, "ok.spec.ts"), "// ok\n");
    symlinkSync(join(suite.tmp, "outside"), join(suite.specDir, "hop"));
    const inputs: CaptureDomInput[] = [];

    const result = await adapterFor(suite, inputs).capture(suite.specDir);

    assert.equal(sourceOf(result, "ok.spec.ts"), "// ok\n");
    assert.ok(!result.specSources.join("\n").includes("leaked-route"));
    assert.ok(!(inputs[0]?.specContents ?? []).join("\n").includes("leaked-route"));
  });
});

test("capture() reads every spec as an empty string when the spec directory's real path leaves the mirror through a symlinked parent", async () => {
  await withSuite(async (suite) => {
    mkdirSync(join(suite.tmp, "elsewhere", "e2e"), { recursive: true });
    writeFileSync(join(suite.tmp, "elsewhere", "e2e", "planted.spec.ts"), LEAKED);
    symlinkSync(join(suite.tmp, "elsewhere"), join(suite.mirror, "hop"));
    const specDir = join(suite.mirror, "hop", "e2e");
    const inputs: CaptureDomInput[] = [];

    const result = await adapterFor({ ...suite, specDir }, inputs).capture(specDir);

    assert.deepEqual(result.specFiles, ["planted.spec.ts"], "the file is there to be listed");
    assert.deepEqual(result.specSources, [""], "but its spec directory is not the mirror's");
    assert.deepEqual(inputs[0]?.specContents, [""]);
  });
});

test("capture() resolves empty, with no spec files either, when the signal is already aborted", async () => {
  await withSuite(async (suite) => {
    writeFileSync(join(suite.specDir, "a.spec.ts"), "// a\n");
    const inputs: CaptureDomInput[] = [];
    const controller = new AbortController();
    controller.abort();

    const result = await adapterFor(suite, inputs).capture(suite.specDir, controller.signal);

    assert.deepEqual(result, { specFiles: [], specSources: [], routes: [] });
    assert.equal(inputs.length, 0, "the capture never ran");
  });
});

test("capture() returns the spec files and sources, with no routes and no capture, when there is no DEV url", async () => {
  await withSuite(async (suite) => {
    writeFileSync(join(suite.specDir, "a.spec.ts"), "// a\n");
    const inputs: CaptureDomInput[] = [];

    const result = await adapterFor(suite, inputs, {}).capture(suite.specDir);

    assert.deepEqual(result, { specFiles: ["a.spec.ts"], specSources: ["// a\n"], routes: [] });
    assert.equal(inputs.length, 0);
  });
});

test("capture() returns the spec files and sources, with no routes, when the capture fails or is aborted mid-flight", async () => {
  await withSuite(async (suite) => {
    writeFileSync(join(suite.specDir, "a.spec.ts"), "// a\n");
    console.warn = () => undefined;
    const failing = new PreExecGroundingPortAdapter(
      { e2eDir: suite.specDir, mirrorDir: suite.mirror, baseUrl: "https://dev.example.com" },
      { captureRouteTrees: async () => { throw new Error("render crashed"); } },
    );
    assert.deepEqual(await failing.capture(suite.specDir), { specFiles: ["a.spec.ts"], specSources: ["// a\n"], routes: [] });

    const hanging = new PreExecGroundingPortAdapter(
      { e2eDir: suite.specDir, mirrorDir: suite.mirror, baseUrl: "https://dev.example.com" },
      { captureRouteTrees: () => new Promise(() => {}) },
    );
    const controller = new AbortController();
    const pending = hanging.capture(suite.specDir, controller.signal);
    queueMicrotask(() => controller.abort());
    assert.deepEqual(await pending, { specFiles: ["a.spec.ts"], specSources: ["// a\n"], routes: [] });
  });
});
