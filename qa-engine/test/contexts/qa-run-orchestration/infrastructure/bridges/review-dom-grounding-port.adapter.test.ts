/* Review DOM grounding uses generation/infrastructure/dom-snapshot.ts. This suite fakes the
   browser (no real Playwright) — dom-snapshot.ts's own tests already cover render/format behavior.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewDomGroundingPortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/review-dom-grounding-port.adapter.ts";

test("capture(): reads each spec's on-disk content and forwards it to captureDom", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-review-dom-"));
  try {
    mkdirSync(join(dir, "flows"), { recursive: true });
    writeFileSync(join(dir, "flows", "checkout.spec.ts"), `await page.goto("/checkout");`);

    const capturedInputs: unknown[] = [];
    const adapter = new ReviewDomGroundingPortAdapter(
      { e2eDir: "/mirrors/org/app/e2e", mirrorDir: dir, baseUrl: "https://dev.example.com", testIdAttribute: "data-cy" },
      {
        captureDom: async (input) => {
          capturedInputs.push(input);
          return "route /checkout:\n  heading: Checkout";
        },
      },
    );

    const result = await adapter.capture(dir, ["flows/checkout.spec.ts"]);

    assert.equal(result, "route /checkout:\n  heading: Checkout");
    assert.equal(capturedInputs.length, 1);
    const input = capturedInputs[0] as { specContents: string[]; baseUrl: string; testIdAttribute?: string };
    assert.deepEqual(input.specContents, [`await page.goto("/checkout");`]);
    assert.equal(input.baseUrl, "https://dev.example.com");
    assert.equal(input.testIdAttribute, "data-cy");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capture(): an unreadable spec file contributes an empty string, never throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-review-dom-missing-"));
  try {
    const capturedInputs: unknown[] = [];
    const adapter = new ReviewDomGroundingPortAdapter(
      { e2eDir: "/mirrors/org/app/e2e", mirrorDir: dir, baseUrl: "https://dev.example.com" },
      {
        captureDom: async (input) => {
          capturedInputs.push(input);
          return undefined;
        },
      },
    );

    const result = await adapter.capture(dir, ["missing.spec.ts"]);

    assert.equal(result, undefined);
    const input = capturedInputs[0] as { specContents: string[] };
    assert.deepEqual(input.specContents, [""]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capture(): absent baseUrl short-circuits to undefined without calling captureDom", async () => {
  let called = false;
  const adapter = new ReviewDomGroundingPortAdapter(
    { e2eDir: "/mirrors/org/app/e2e", mirrorDir: "/mirrors/org/app" },
    { captureDom: async () => { called = true; return "should not be reached"; } },
  );

  const result = await adapter.capture("/tmp/qa-golden/e2e", ["a.spec.ts"]);

  assert.equal(result, undefined);
  assert.equal(called, false);
});

test("capture(): an empty specs list short-circuits to undefined without calling captureDom", async () => {
  let called = false;
  const adapter = new ReviewDomGroundingPortAdapter(
    { e2eDir: "/mirrors/org/app/e2e", mirrorDir: "/mirrors/org/app", baseUrl: "https://dev.example.com" },
    { captureDom: async () => { called = true; return "should not be reached"; } },
  );

  const result = await adapter.capture("/tmp/qa-golden/e2e", []);

  assert.equal(result, undefined);
  assert.equal(called, false);
});

test("capture(): a captureDom throw is non-fatal — resolves undefined, never rejects (mirrors legacy's .catch(() => undefined))", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-review-dom-throw-"));
  try {
    writeFileSync(join(dir, "a.spec.ts"), `await page.goto("/x");`);
    const adapter = new ReviewDomGroundingPortAdapter(
      { e2eDir: "/mirrors/org/app/e2e", mirrorDir: dir, baseUrl: "https://dev.example.com" },
      { captureDom: async () => { throw new Error("Playwright render crashed"); } },
    );

    const result = await adapter.capture(dir, ["a.spec.ts"]);

    assert.equal(result, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capture(): an already-aborted signal skips the capture entirely — resolves undefined without calling captureDom", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-review-dom-abort-precheck-"));
  try {
    writeFileSync(join(dir, "a.spec.ts"), `await page.goto("/x");`);
    let called = false;
    const adapter = new ReviewDomGroundingPortAdapter(
      { e2eDir: "/mirrors/org/app/e2e", mirrorDir: dir, baseUrl: "https://dev.example.com" },
      { captureDom: async () => { called = true; return "should not be reached"; } },
    );
    const controller = new AbortController();
    controller.abort();

    const result = await adapter.capture(dir, ["a.spec.ts"], controller.signal);

    assert.equal(result, undefined);
    assert.equal(called, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capture(): an in-flight abort unblocks the caller promptly, even when captureDom never resolves", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-review-dom-abort-inflight-"));
  try {
    writeFileSync(join(dir, "a.spec.ts"), `await page.goto("/x");`);
    const adapter = new ReviewDomGroundingPortAdapter(
      { e2eDir: "/mirrors/org/app/e2e", mirrorDir: dir, baseUrl: "https://dev.example.com" },
      { captureDom: () => new Promise(() => {}) }, /* never resolves — simulates a hung render */
    );
    const controller = new AbortController();

    const capturePromise = adapter.capture(dir, ["a.spec.ts"], controller.signal);
    queueMicrotask(() => controller.abort());
    const result = await capturePromise;

    /* The adapter's own contract (never rejects) still holds — abort degrades to undefined, NOT a
       throw, so a caller without a signal?.aborted check after this call is not broken.
     */
    assert.equal(result, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* The specs come from the generator's verdict, so a name can lead anywhere the agent pointed it. What a spec that leaves the spec directory points at is never handed to the capture: it contributes an empty string, exactly like a spec that cannot be read. */
test("capture(): a spec that is a symlink out of the spec directory, or climbs out of it, contributes an empty string, never its target's content", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "qa-review-dom-confinement-"));
  try {
    const mirror = join(tmp, "mirror");
    const specDir = join(mirror, "e2e");
    mkdirSync(join(specDir, "flows"), { recursive: true });
    writeFileSync(join(tmp, "secret.txt"), `await page.goto("/leaked");`);
    writeFileSync(join(specDir, "flows", "ok.spec.ts"), `await page.goto("/ok");`);
    symlinkSync(join(tmp, "secret.txt"), join(specDir, "flows", "leak.spec.ts"));

    const capturedInputs: Array<{ specContents: string[] }> = [];
    const adapter = new ReviewDomGroundingPortAdapter(
      { e2eDir: specDir, mirrorDir: mirror, baseUrl: "https://dev.example.com" },
      { captureDom: async (input) => { capturedInputs.push(input as { specContents: string[] }); return undefined; } },
    );

    await adapter.capture(specDir, ["flows/ok.spec.ts", "flows/leak.spec.ts", "../../secret.txt"]);

    assert.deepEqual(capturedInputs[0]?.specContents, [`await page.goto("/ok");`, "", ""]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("capture(): every spec contributes an empty string when the spec directory's real path leaves the mirror through a symlinked parent", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "qa-review-dom-confinement-anchor-"));
  try {
    const mirror = join(tmp, "mirror");
    mkdirSync(mirror);
    mkdirSync(join(tmp, "elsewhere", "e2e"), { recursive: true });
    writeFileSync(join(tmp, "elsewhere", "e2e", "planted.spec.ts"), `await page.goto("/planted");`);
    symlinkSync(join(tmp, "elsewhere"), join(mirror, "hop"));
    const specDir = join(mirror, "hop", "e2e");

    const capturedInputs: Array<{ specContents: string[] }> = [];
    const adapter = new ReviewDomGroundingPortAdapter(
      { e2eDir: specDir, mirrorDir: mirror, baseUrl: "https://dev.example.com" },
      { captureDom: async (input) => { capturedInputs.push(input as { specContents: string[] }); return undefined; } },
    );

    await adapter.capture(specDir, ["planted.spec.ts"]);

    assert.deepEqual(capturedInputs[0]?.specContents, [""], "the anchor is the mirror: a spec directory that is a real directory but lives outside it is refused");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("capture(): every spec contributes an empty string when the spec directory is a symlink out of the mirror", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "qa-review-dom-confinement-dir-"));
  try {
    const mirror = join(tmp, "mirror");
    mkdirSync(mirror);
    mkdirSync(join(tmp, "elsewhere"));
    writeFileSync(join(tmp, "elsewhere", "planted.spec.ts"), `await page.goto("/planted");`);
    symlinkSync(join(tmp, "elsewhere"), join(mirror, "e2e"));

    const capturedInputs: Array<{ specContents: string[] }> = [];
    const adapter = new ReviewDomGroundingPortAdapter(
      { e2eDir: join(mirror, "e2e"), mirrorDir: mirror, baseUrl: "https://dev.example.com" },
      { captureDom: async (input) => { capturedInputs.push(input as { specContents: string[] }); return undefined; } },
    );

    await adapter.capture(join(mirror, "e2e"), ["planted.spec.ts"]);

    assert.deepEqual(capturedInputs[0]?.specContents, [""]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
