import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSnapshot, loadSnapshot } from "./warm-suite.ts";
import { saveSuiteFiles, specsOf, suiteDelta } from "./campaign-suite.ts";

interface Scratch {
  mirror: string;
  e2e: string;
  label: string;
  done(): void;
}

function scratch(): Scratch {
  const dir = mkdtempSync(join(tmpdir(), "campaign-suite-"));
  const mirror = join(dir, "mirror");
  const e2e = join(mirror, "e2e");
  mkdirSync(e2e, { recursive: true });
  return { mirror, e2e, label: join(dir, "snap"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

const put = (e2e: string, rel: string, text: string): void => {
  mkdirSync(join(e2e, rel, ".."), { recursive: true });
  writeFileSync(join(e2e, rel), text, "utf8");
};

function snapshotOf(s: Scratch) {
  createSnapshot({ mirrorDir: s.mirror, e2eDir: s.e2e, labelDir: s.label, app: "demo", repo: "org/demo", label: "w", now: new Date("2026-10-12T00:00:00Z") });
  return loadSnapshot(s.label, "w");
}

test("the delta holds what an arm added or changed since the snapshot, and nothing the snapshot already had", () => {
  const s = scratch();
  try {
    put(s.e2e, "auth.setup.ts", "login");
    put(s.e2e, "keep.spec.ts", "same");
    put(s.e2e, "edit.spec.ts", "before");
    const snapshot = snapshotOf(s);
    put(s.e2e, "edit.spec.ts", "after");
    put(s.e2e, "flows/new.spec.ts", "fresh");
    put(s.e2e, "pages/new.page.ts", "helper");
    const delta = suiteDelta({ mirrorDir: s.mirror, e2eDir: s.e2e }, snapshot.manifest);
    assert.deepEqual(delta.files.map((f) => f.path).sort(), ["edit.spec.ts", "flows/new.spec.ts", "pages/new.page.ts"]);
    assert.equal(delta.files.find((f) => f.path === "flows/new.spec.ts")!.bytes.toString("utf8"), "fresh");
  } finally {
    s.done();
  }
});

test("install and run output, the login session and credentials never enter the delta", () => {
  const s = scratch();
  try {
    put(s.e2e, "auth.setup.ts", "login");
    const snapshot = snapshotOf(s);
    put(s.e2e, "node_modules/pkg/index.js", "x");
    put(s.e2e, "test-results/a.txt", "x");
    put(s.e2e, ".auth/state.json", "{}");
    put(s.e2e, ".env", "SECRET=1");
    put(s.e2e, "state.json", JSON.stringify({ cookies: [], origins: [] }));
    put(s.e2e, "ok.spec.ts", "real");
    const delta = suiteDelta({ mirrorDir: s.mirror, e2eDir: s.e2e }, snapshot.manifest);
    assert.deepEqual(delta.files.map((f) => f.path), ["ok.spec.ts"]);
  } finally {
    s.done();
  }
});

test("files the caller says belong to its own harness are left out of the delta", () => {
  const s = scratch();
  try {
    put(s.e2e, "playwright.config.ts", "repo");
    const snapshot = snapshotOf(s);
    put(s.e2e, "playwright.config.ts", "wrapper");
    put(s.e2e, "playwright.repo.config.ts", "repo");
    put(s.e2e, "mine.spec.ts", "real");
    const delta = suiteDelta({ mirrorDir: s.mirror, e2eDir: s.e2e }, snapshot.manifest, new Set(["playwright.config.ts", "playwright.repo.config.ts"]));
    assert.deepEqual(delta.files.map((f) => f.path), ["mine.spec.ts"]);
  } finally {
    s.done();
  }
});

test("a file the snapshot had that is gone is reported as removed", () => {
  const s = scratch();
  try {
    put(s.e2e, "gone.spec.ts", "x");
    const snapshot = snapshotOf(s);
    rmSync(join(s.e2e, "gone.spec.ts"));
    const delta = suiteDelta({ mirrorDir: s.mirror, e2eDir: s.e2e }, snapshot.manifest);
    assert.deepEqual(delta.removed, ["gone.spec.ts"]);
  } finally {
    s.done();
  }
});

test("specsOf keeps the spec files and leaves helpers and the cleanup spec out", () => {
  const files = ["a.spec.ts", "flows/b.spec.ts", "pages/c.ts", "cleanup.spec.ts", "sub/cleanup.spec.ts", "x.spec.ts.bak"].map((path) => ({ path, bytes: Buffer.from("") }));
  assert.deepEqual(specsOf(files), ["a.spec.ts", "flows/b.spec.ts"]);
});

test("saved files keep their relative paths under the destination", () => {
  const s = scratch();
  try {
    const dest = join(s.mirror, "out");
    saveSuiteFiles(dest, [{ path: "flows/new.spec.ts", bytes: Buffer.from("fresh") }, { path: "top.spec.ts", bytes: Buffer.from("t") }]);
    assert.equal(readFileSync(join(dest, "flows", "new.spec.ts"), "utf8"), "fresh");
    assert.equal(readFileSync(join(dest, "top.spec.ts"), "utf8"), "t");
  } finally {
    s.done();
  }
});

test("a path that would leave the destination is refused", () => {
  const s = scratch();
  try {
    assert.throws(() => saveSuiteFiles(join(s.mirror, "out"), [{ path: "../escape.spec.ts", bytes: Buffer.from("x") }]), /unsafe/);
  } finally {
    s.done();
  }
});
