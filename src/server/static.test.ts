import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDashboardDir, serveDashboard } from "./static";

function mkRes(): {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
  writeHead: (s: number, h?: Record<string, string>) => void;
  end: (b?: Buffer | string) => void;
} {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(s, h) {
      this.status = s;
      if (h) this.headers = h;
    },
    end(b) {
      this.body = b ?? "";
    },
  };
}

test("the console is served from web/public, never from a leftover web/dist build", () => {
  const root = mkdtempSync(join(tmpdir(), "dash-resolve-"));
  try {
    mkdirSync(join(root, "web", "dist"), { recursive: true });
    writeFileSync(join(root, "web", "dist", "index.html"), "<p>stale build</p>");
    assert.equal(resolveDashboardDir(root), join(root, "web", "public"), "no web/public yet — still not the stale build");

    mkdirSync(join(root, "web", "public"), { recursive: true });
    writeFileSync(join(root, "web", "public", "index.html"), "<p>console</p>");
    assert.equal(resolveDashboardDir(root), join(root, "web", "public"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("serveDashboard serves the console index from its directory and rejects path traversal", async () => {
  const dist = mkdtempSync(join(tmpdir(), "dash-serve-"));
  try {
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>ok</title>");
    const res = mkRes();
    const handled = await serveDashboard({ url: "/app", method: "GET" } as never, res as never, { dir: dist });
    assert.equal(handled, true);
    assert.equal(res.status, 200);
    assert.match(String(res.body), /ok/);

    const denied = mkRes();
    await serveDashboard({ url: "/app/../../etc/passwd", method: "GET" } as never, denied as never, { dir: dist });
    assert.equal(denied.status, 403);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test("serveDashboard returns the placeholder when index.html is missing", async () => {
  const dist = mkdtempSync(join(tmpdir(), "dash-empty-"));
  try {
    const res = mkRes();
    await serveDashboard({ url: "/app", method: "GET" } as never, res as never, { dir: dist });
    assert.equal(res.status, 200);
    assert.match(String(res.body), /web\/public/, "the placeholder says where the console is expected");
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test("serveDashboard re-reads an asset when its mtime changes (bind-mount edits)", async () => {
  const dist = mkdtempSync(join(tmpdir(), "dash-mtime-"));
  try {
    mkdirSync(join(dist, "js"));
    writeFileSync(join(dist, "index.html"), "<!doctype html>");
    const asset = join(dist, "js", "format.js");
    writeFileSync(asset, "v1");
    const first = mkRes();
    await serveDashboard({ url: "/app/js/format.js", method: "GET" } as never, first as never, { dir: dist });
    assert.equal(String(first.body), "v1");

    writeFileSync(asset, "v2-uniqueAbbrevs");
    const later = new Date(Date.now() + 2000);
    utimesSync(asset, later, later);

    const second = mkRes();
    await serveDashboard({ url: "/app/js/format.js", method: "GET" } as never, second as never, { dir: dist });
    assert.equal(String(second.body), "v2-uniqueAbbrevs");
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});
