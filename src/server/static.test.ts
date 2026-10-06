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

/* The console page is where the LLM gateway key is pasted: whatever the browser may load, run or send
   from there is decided by these headers. */
function header(res: { headers: Record<string, string> }, name: string): string | undefined {
  return Object.entries(res.headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(";").map((part) => part.trim().split(/\s+/)).filter((parts) => parts[0] !== "").map(([name, ...sources]) => [name!, sources]),
  );
}

async function serveEach(): Promise<Array<[string, ReturnType<typeof mkRes>]>> {
  const dist = mkdtempSync(join(tmpdir(), "dash-headers-"));
  const empty = mkdtempSync(join(tmpdir(), "dash-headers-empty-"));
  try {
    mkdirSync(join(dist, "js"));
    writeFileSync(join(dist, "index.html"), "<!doctype html>");
    writeFileSync(join(dist, "js", "format.js"), "1");
    const out: Array<[string, ReturnType<typeof mkRes>]> = [];
    for (const [label, url, dir] of [
      ["the console page", "/app", dist],
      ["a script", "/app/js/format.js", dist],
      ["a refused path", "/app/../../etc/passwd", dist],
      ["the placeholder", "/app", empty],
    ] as const) {
      const res = mkRes();
      await serveDashboard({ url, method: "GET" } as never, res as never, { dir });
      out.push([label, res]);
    }
    return out;
  } finally {
    rmSync(dist, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
}

test("every console response forbids sniffing and sends no referrer", async () => {
  for (const [label, res] of await serveEach()) {
    assert.equal(header(res, "x-content-type-options"), "nosniff", label);
    assert.equal(header(res, "referrer-policy"), "no-referrer", label);
  }
});

test("every console response carries a policy that keeps the page to its own origin", async () => {
  for (const [label, res] of await serveEach()) {
    const policy = directives(header(res, "content-security-policy") ?? "");
    assert.ok(policy.size > 0, `${label} has a content security policy`);
    for (const name of ["default-src", "script-src", "connect-src"]) {
      assert.deepEqual(policy.get(name), ["'self'"], `${label}: ${name} allows only the console's own origin`);
    }
    for (const [name, sources] of policy) {
      assert.ok(!sources.some((source) => /^(https?:|\*|wss?:)/.test(source)), `${label}: ${name} names no foreign origin`);
    }
  }
});

test("the policy never lets a script run inline or from a string", async () => {
  for (const [label, res] of await serveEach()) {
    const scripts = directives(header(res, "content-security-policy") ?? "").get("script-src") ?? [];
    assert.ok(scripts.length > 0, `${label} restricts scripts`);
    assert.ok(!scripts.some((source) => /unsafe|data:|blob:/.test(source)), label);
  }
});

test("the policy keeps the page out of frames, forbids a rebased URL and plugins, and posts forms only home", async () => {
  for (const [label, res] of await serveEach()) {
    const policy = directives(header(res, "content-security-policy") ?? "");
    assert.deepEqual(policy.get("frame-ancestors"), ["'none'"], label);
    assert.deepEqual(policy.get("base-uri"), ["'none'"], label);
    assert.deepEqual(policy.get("object-src"), ["'none'"], label);
    assert.deepEqual(policy.get("form-action"), ["'self'"], label);
  }
});

test("the policy lets the console's own images, inline images and fonts load", async () => {
  for (const [label, res] of await serveEach()) {
    const policy = directives(header(res, "content-security-policy") ?? "");
    assert.ok(policy.get("img-src")?.includes("'self'") && policy.get("img-src")?.includes("data:"), label);
    assert.ok(policy.get("font-src")?.includes("'self'"), label);
  }
});
