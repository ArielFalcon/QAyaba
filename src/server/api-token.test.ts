import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiTokenPath, discoverApiToken, legacyApiTokenPath, loadOrCreateApiToken } from "./api-token";

function root(): string {
  return mkdtempSync(join(tmpdir(), "api-token-"));
}

const mode = (path: string): number => statSync(path).mode & 0o777;
const quiet = { log: () => {} };

test("the token lives in the data directory, not with the app configs", () => {
  assert.equal(apiTokenPath("/app"), "/app/data/.api_token");
  assert.equal(legacyApiTokenPath("/app"), "/app/config/.api_token");
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

test("a token left with the app configs is moved to the data directory once, and no copy stays behind", () => {
  const r = root();
  try {
    mkdirSync(join(r, "config"));
    writeFileSync(legacyApiTokenPath(r), "legacy-token\n", { mode: 0o644 });
    assert.equal(loadOrCreateApiToken(r, quiet), "legacy-token");
    assert.equal(existsSync(legacyApiTokenPath(r)), false);
    assert.equal(readFileSync(apiTokenPath(r), "utf8").trim(), "legacy-token");
    assert.equal(mode(apiTokenPath(r)), 0o600);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("with a token in both places the data directory's wins and the stale copy is removed", () => {
  const r = root();
  try {
    mkdirSync(join(r, "config"));
    mkdirSync(join(r, "data"));
    writeFileSync(apiTokenPath(r), "current");
    writeFileSync(legacyApiTokenPath(r), "stale");
    assert.equal(loadOrCreateApiToken(r, quiet), "current");
    assert.equal(existsSync(legacyApiTokenPath(r)), false);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("a client finds the token where the service keeps it, then where it used to, and the environment wins over both", () => {
  const r = root();
  try {
    assert.equal(discoverApiToken({}, r), undefined);
    mkdirSync(join(r, "config"));
    writeFileSync(legacyApiTokenPath(r), "legacy\n");
    assert.equal(discoverApiToken({}, r), "legacy");
    mkdirSync(join(r, "data"));
    writeFileSync(apiTokenPath(r), "current\n");
    assert.equal(discoverApiToken({}, r), "current");
    assert.equal(discoverApiToken({ QA_API_TOKEN: "pinned" }, r), "pinned");
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});
