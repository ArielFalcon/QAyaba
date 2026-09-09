import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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

test("resolveDashboardDir prefers web/public when it has index.html, else web/dist", () => {
  const root = mkdtempSync(join(tmpdir(), "dash-resolve-"));
  try {
    mkdirSync(join(root, "web", "dist"), { recursive: true });
    writeFileSync(join(root, "web", "dist", "index.html"), "<p>dist</p>");
    assert.equal(resolveDashboardDir(root), join(root, "web", "dist"));

    mkdirSync(join(root, "web", "public"), { recursive: true });
    writeFileSync(join(root, "web", "public", "index.html"), "<p>public</p>");
    assert.equal(resolveDashboardDir(root), join(root, "web", "public"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("serveDashboard serves the SPA index from distDir and rejects path traversal", async () => {
  const dist = mkdtempSync(join(tmpdir(), "dash-serve-"));
  try {
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>ok</title>");
    const res = mkRes();
    const handled = await serveDashboard({ url: "/app", method: "GET" } as never, res as never, { distDir: dist });
    assert.equal(handled, true);
    assert.equal(res.status, 200);
    assert.match(String(res.body), /ok/);

    const denied = mkRes();
    await serveDashboard({ url: "/app/../../etc/passwd", method: "GET" } as never, denied as never, { distDir: dist });
    assert.equal(denied.status, 403);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test("serveDashboard returns the placeholder when index.html is missing", async () => {
  const dist = mkdtempSync(join(tmpdir(), "dash-empty-"));
  try {
    const res = mkRes();
    await serveDashboard({ url: "/app", method: "GET" } as never, res as never, { distDir: dist });
    assert.equal(res.status, 200);
    assert.match(String(res.body), /not built yet/);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});
