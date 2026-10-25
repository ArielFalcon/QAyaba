import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiTokenPath, discoverApiToken, loadOrCreateApiToken, resolveApiToken } from "./api-token";

function root(): string {
  return mkdtempSync(join(tmpdir(), "api-token-"));
}

const mode = (path: string): number => statSync(path).mode & 0o777;
const quiet = { log: () => {} };

test("the token lives in the data directory, not with the app configs", () => {
  assert.equal(apiTokenPath("/app"), "/app/data/.api_token");
});

test("a token is generated into the data directory, owner-only, when there is none", () => {
  const r = root();
  try {
    const token = loadOrCreateApiToken(r, quiet);
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(readFileSync(apiTokenPath(r), "utf8"), token);
    assert.equal(mode(apiTokenPath(r)), 0o600);
    assert.equal(mode(join(r, "data")), 0o700);
    assert.equal(loadOrCreateApiToken(r, quiet), token, "the next boot reuses it");
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("a token file in the config folder is neither read nor removed", () => {
  const r = root();
  try {
    mkdirSync(join(r, "config"));
    const stray = join(r, "config", ".api_token");
    writeFileSync(stray, "stray-token\n");
    assert.equal(discoverApiToken({}, r), undefined);
    const token = loadOrCreateApiToken(r, quiet);
    assert.notEqual(token, "stray-token");
    assert.equal(readFileSync(stray, "utf8"), "stray-token\n");
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("a client finds the token where the service keeps it, and the environment wins", () => {
  const r = root();
  try {
    assert.equal(discoverApiToken({}, r), undefined);
    mkdirSync(join(r, "data"));
    writeFileSync(apiTokenPath(r), "current\n");
    assert.equal(discoverApiToken({}, r), "current");
    assert.equal(discoverApiToken({ QA_API_TOKEN: "pinned" }, r), "pinned");
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("the service's token is the pinned one when QA_API_TOKEN is set, and a generated one otherwise", () => {
  const r = root();
  try {
    assert.equal(resolveApiToken({ QA_API_TOKEN: "pinned" }, r, quiet), "pinned");
    assert.equal(existsSync(apiTokenPath(r)), false, "a pinned token writes no file");
    assert.match(resolveApiToken({}, r, quiet), /^[0-9a-f]{64}$/);
    assert.equal(mode(apiTokenPath(r)), 0o600);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("a token file a crashed start left half-written beside the real one is swept at the next start", () => {
  const r = root();
  try {
    mkdirSync(join(r, "data"));
    const stale = [join(r, "data", ".api_token.123.tmp"), join(r, "data", ".api_token.99999.tmp")];
    for (const file of stale) writeFileSync(file, "half");
    writeFileSync(join(r, "data", "other.tmp"), "kept");
    const token = loadOrCreateApiToken(r, quiet);
    for (const file of stale) assert.equal(existsSync(file), false, file);
    assert.equal(existsSync(join(r, "data", "other.tmp")), true);
    assert.equal(readFileSync(apiTokenPath(r), "utf8"), token);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});
