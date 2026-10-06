/*
 * The real console, served through the same handler the orchestrator uses, must stand on its own:
 * everything the page and its stylesheets load comes from the console's own origin, and nothing in
 * the page needs a script to run inline (which the content security policy forbids). The page is the
 * one where the LLM gateway key is pasted, so it must not call out to a CDN either.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDashboardDir, serveDashboard } from "../static";

const consoleDir = resolveDashboardDir(join(import.meta.dirname, "..", "..", ".."));
const ORIGIN = "http://console.test";

async function serve(pathname: string): Promise<{ status: number; type: string; body: string }> {
  let status = 0;
  let type = "";
  let body: Buffer | string = "";
  const res = {
    writeHead(s: number, headers?: Record<string, string>) {
      status = s;
      type = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "";
    },
    end(b?: Buffer | string) { body = b ?? ""; },
  };
  await serveDashboard({ url: pathname, method: "GET" } as never, res as never, { dir: consoleDir });
  return { status, type, body: String(body) };
}

/* References that the browser would fetch, as absolute URLs against the document that holds them. */
function references(source: string, pattern: RegExp, base: string): URL[] {
  return [...source.matchAll(pattern)].map((m) => m[1]!).filter((ref) => !ref.startsWith("data:")).map((ref) => new URL(ref, base));
}

/* The URL the operator is told to open: no trailing slash, so a relative reference resolves beside /app, not under it. */
const PAGE = `${ORIGIN}/app`;
const PAGE_RESOURCES = /<(?:script|link)\b[^>]*?\b(?:src|href)="([^"]+)"/g;
const STYLE_RESOURCES = /(?:url\(\s*['"]?|@import\s+(?:url\(\s*)?['"])([^'")\s]+)/g;

test("every script, stylesheet and font the console loads is served by the console itself", async () => {
  const page = await serve("/app");
  assert.equal(page.status, 200);
  const fromPage = references(page.body, PAGE_RESOURCES, PAGE);
  assert.ok(fromPage.length > 0, "the page loads something");

  const stylesheets = fromPage.filter((url) => url.pathname.endsWith(".css"));
  const fromStyles = (await Promise.all(stylesheets.map(async (sheet) => references((await serve(sheet.pathname)).body, STYLE_RESOURCES, sheet.href)))).flat();

  for (const url of [...fromPage, ...fromStyles]) {
    assert.equal(url.origin, ORIGIN, `${url.href} comes from another origin`);
    assert.match(url.pathname, /^\/app\//, `${url.pathname} is outside /app, the only path the orchestrator serves the console from`);
    const served = await serve(url.pathname);
    assert.equal(served.status, 200, url.pathname);
    assert.doesNotMatch(served.type, /text\/html/, `${url.pathname} is not a file the console ships (the handler fell back to the page)`);
  }
});

test("the console page runs no inline script and wires no inline event handler", async () => {
  const page = await serve("/app");

  for (const tag of page.body.match(/<script\b[^>]*>/g) ?? []) assert.match(tag, /\bsrc="/, `inline script: ${tag}`);
  assert.doesNotMatch(page.body, /<[a-z][^>]*\son[a-z]+\s*=/i);
});

test("the console's scripts build no markup with an inline event handler", () => {
  for (const file of readdirSync(join(consoleDir, "js"))) {
    assert.doesNotMatch(readFileSync(join(consoleDir, "js", file), "utf8"), /<[a-z][^>]*\son[a-z]+\s*=\s*['"\\]/i, file);
  }
});
